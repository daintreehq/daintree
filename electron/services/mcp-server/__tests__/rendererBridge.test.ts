import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../../ipc/channels.js";

const { mockIpcMain, mockWebContentsRegistry, mockProjectViews } = vi.hoisted(() => {
  class IpcMainMock {
    private listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    on(event: string, listener: (...args: unknown[]) => void): this {
      const set = this.listeners.get(event) ?? new Set();
      set.add(listener);
      this.listeners.set(event, set);
      return this;
    }
    removeListener(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.get(event)?.delete(listener);
      return this;
    }
    emit(event: string, ...args: unknown[]): boolean {
      const set = this.listeners.get(event);
      if (!set) return false;
      for (const fn of set) fn(...args);
      return set.size > 0;
    }
    removeAllListeners(): this {
      this.listeners.clear();
      return this;
    }
  }
  return {
    mockIpcMain: new IpcMainMock(),
    mockWebContentsRegistry: new Map<number, unknown>(),
    // workspaceId -> the live views registered for it (#11789). Drives
    // `getWebContentsForProject`, which is the only thing the workspace route
    // consults — deliberately, since it reads the registry without attaching,
    // thawing, focusing, or switching anything.
    mockProjectViews: new Map<string, unknown[]>(),
  };
});

vi.mock("electron", () => ({
  ipcMain: mockIpcMain,
  webContents: {
    fromId: (id: number) => mockWebContentsRegistry.get(id),
  },
}));

vi.mock("../../../window/windowRef.js", () => ({
  getProjectViewManager: () => null,
}));

vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWebContentsForProject: (projectId: string) => mockProjectViews.get(projectId) ?? [],
}));

// `unfreezeWebContents` is the only member the bridge imports. Mocked so the
// routed paths' thaw is observable and so the real CDP helper doesn't warn its
// way through every test against a WebContents fake with no `debugger`.
vi.mock("../../../utils/webContentsLifecycle.js", () => ({
  unfreezeWebContents: vi.fn().mockResolvedValue(undefined),
}));

import {
  createRendererBridge,
  SessionBindingError,
  WorkspaceBindingError,
  McpRouteBindingError,
} from "../rendererBridge.js";
import { unfreezeWebContents } from "../../../utils/webContentsLifecycle.js";
import { WorkspaceViewLeaseRegistry } from "../workspaceViewLease.js";
import type { PendingRequest, DispatchEnvelope } from "../shared.js";
import type { ActionManifestEntry } from "../../../../shared/types/actions.js";

/**
 * Drain the microtask chain a routed send awaits before it reaches
 * `webContents.send` (#11790). A routed operation thaws its target first — a
 * real await — so a test that answers as the renderer would before that
 * settles clears the pending entry, and the send then (correctly) never
 * happens. A macrotask hop drains the whole chain regardless of its length.
 */
const flushThaw = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface FakeWebContents {
  id: number;
  isDestroyed: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  triggerDestroyed: () => void;
  /** Live count of registered "destroyed" listeners (after cleanup removals). */
  destroyedListenerCount: () => number;
}

function makeWebContents(
  id: number,
  options?: { onSend?: (channel: string, payload: any) => void }
): FakeWebContents {
  const destroyedListeners = new Set<() => void>();
  const wc: FakeWebContents = {
    id,
    isDestroyed: vi.fn(() => false),
    send: vi.fn((channel: string, payload: unknown) => {
      options?.onSend?.(channel, payload);
    }),
    once: vi.fn((event: string, listener: () => void) => {
      if (event === "destroyed") destroyedListeners.add(listener);
    }),
    removeListener: vi.fn((event: string, listener: () => void) => {
      if (event === "destroyed") destroyedListeners.delete(listener);
    }),
    triggerDestroyed: () => {
      const listeners = Array.from(destroyedListeners);
      destroyedListeners.clear();
      for (const l of listeners) l();
    },
    destroyedListenerCount: () => destroyedListeners.size,
  };
  return wc;
}

describe("rendererBridge — per-session pinned dispatch (#7002)", () => {
  let pendingManifests: Map<string, PendingRequest<ActionManifestEntry[]>>;
  let pendingDispatches: Map<string, PendingRequest<DispatchEnvelope>>;
  let bridge: ReturnType<typeof createRendererBridge>;

  beforeEach(() => {
    mockIpcMain.removeAllListeners();
    mockWebContentsRegistry.clear();
    pendingManifests = new Map();
    pendingDispatches = new Map();
    bridge = createRendererBridge(pendingManifests, pendingDispatches, () => null);
    bridge.setupListeners([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("requestManifestForWebContents routes to the pinned WebContents and never writes the shared cache", async () => {
    const wcA = makeWebContents(101);
    const wcB = makeWebContents(202);
    mockWebContentsRegistry.set(101, wcA);
    mockWebContentsRegistry.set(202, wcB);

    expect(bridge.getCachedManifest()).toBeNull();

    // Hook send to reply with a manifest tagged by id, so we can assert routing.
    wcA.send.mockImplementation((channel: string, payload: { requestId: string }) => {
      if (channel !== CHANNELS.MCP_SERVER_GET_MANIFEST_REQUEST) return;
      queueMicrotask(() => {
        mockIpcMain.emit(
          CHANNELS.MCP_SERVER_GET_MANIFEST_RESPONSE,
          { sender: { id: 101 } },
          {
            requestId: payload.requestId,
            manifest: [{ id: "from-A" }],
          }
        );
      });
    });

    const manifest = await bridge.requestManifestForWebContents(101);
    expect(manifest).toEqual([{ id: "from-A" }]);
    // Pinned helpers must NOT touch the shared cache — caching window A's
    // manifest and serving it to a session pinned to window B would re-leak.
    expect(bridge.getCachedManifest()).toBeNull();
    expect(wcA.send).toHaveBeenCalledTimes(1);
    expect(wcB.send).not.toHaveBeenCalled();
  });

  it("dispatchActionForWebContents routes to the pinned WebContents — never the other window", async () => {
    const wcA = makeWebContents(301);
    const wcB = makeWebContents(302);
    mockWebContentsRegistry.set(301, wcA);
    mockWebContentsRegistry.set(302, wcB);

    wcA.send.mockImplementation((channel: string, payload: { requestId: string }) => {
      if (channel !== CHANNELS.MCP_SERVER_DISPATCH_ACTION_REQUEST) return;
      queueMicrotask(() => {
        mockIpcMain.emit(
          CHANNELS.MCP_SERVER_DISPATCH_ACTION_RESPONSE,
          { sender: { id: 301 } },
          {
            requestId: payload.requestId,
            result: { ok: true, result: "from-A" },
          }
        );
      });
    });

    const envelope = await bridge.dispatchActionForWebContents(301, "actions.list", {}, false);
    expect(envelope.result).toEqual({ ok: true, result: "from-A" });
    expect(wcA.send).toHaveBeenCalledTimes(1);
    expect(wcB.send).not.toHaveBeenCalled();
  });

  it("threads the bound ActionContext into the pinned dispatch IPC payload (#8317)", async () => {
    const wc = makeWebContents(701);
    mockWebContentsRegistry.set(701, wc);

    let sentPayload: { requestId: string; context?: unknown } | undefined;
    wc.send.mockImplementation((channel: string, payload: { requestId: string }) => {
      if (channel !== CHANNELS.MCP_SERVER_DISPATCH_ACTION_REQUEST) return;
      sentPayload = payload as { requestId: string; context?: unknown };
      queueMicrotask(() => {
        mockIpcMain.emit(
          CHANNELS.MCP_SERVER_DISPATCH_ACTION_RESPONSE,
          { sender: { id: 701 } },
          { requestId: payload.requestId, result: { ok: true, result: "ok" } }
        );
      });
    });

    const boundContext = { focusedWorktreeId: "wt-1", focusedTerminalId: "term-9" };
    await bridge.dispatchActionForWebContents(701, "terminal.inject", {}, false, boundContext);

    expect(sentPayload?.context).toEqual(boundContext);
  });

  it("sends context: undefined when no override is supplied — unpinned path is untouched (#8317)", async () => {
    const wc = makeWebContents(702);
    mockWebContentsRegistry.set(702, wc);

    let sentPayload: { requestId: string; context?: unknown } | undefined;
    wc.send.mockImplementation((channel: string, payload: { requestId: string }) => {
      if (channel !== CHANNELS.MCP_SERVER_DISPATCH_ACTION_REQUEST) return;
      sentPayload = payload as { requestId: string; context?: unknown };
      queueMicrotask(() => {
        mockIpcMain.emit(
          CHANNELS.MCP_SERVER_DISPATCH_ACTION_RESPONSE,
          { sender: { id: 702 } },
          { requestId: payload.requestId, result: { ok: true, result: "ok" } }
        );
      });
    });

    await bridge.dispatchActionForWebContents(702, "actions.list", {}, false);

    expect(sentPayload).toBeDefined();
    expect(sentPayload?.context).toBeUndefined();
  });

  it("threads the session's authenticated origin into the dispatch IPC payload (#11808)", async () => {
    const wc = makeWebContents(901);
    mockWebContentsRegistry.set(901, wc);

    const sentOrigins: unknown[] = [];
    wc.send.mockImplementation((channel: string, payload: { requestId: string }) => {
      if (channel !== CHANNELS.MCP_SERVER_DISPATCH_ACTION_REQUEST) return;
      sentOrigins.push((payload as { sessionOrigin?: unknown }).sessionOrigin);
      queueMicrotask(() => {
        mockIpcMain.emit(
          CHANNELS.MCP_SERVER_DISPATCH_ACTION_RESPONSE,
          { sender: { id: 901 } },
          { requestId: payload.requestId, result: { ok: true, result: "ok" } }
        );
      });
    });

    await bridge.dispatchActionForWebContents(
      901,
      "agent.launch",
      {},
      false,
      undefined,
      "assistant-pane"
    );
    // Omitted entirely — a WebContents route proves where to send, not who owns
    // the session, so only HttpLifecycle can positively establish that this is
    // one of Daintree's own surfaces. Everything else lands as external.
    await bridge.dispatchActionForWebContents(901, "agent.launch", {}, false);

    expect(sentOrigins).toEqual(["assistant-pane", "external"]);
  });

  it("fails closed when the pinned view has been destroyed (#7002 — never silently re-routes)", async () => {
    // No entry for id=999 → webContents.fromId returns undefined.
    await expect(bridge.requestManifestForWebContents(999)).rejects.toBeInstanceOf(
      SessionBindingError
    );
    await expect(bridge.requestManifestForWebContents(999)).rejects.toThrow(/Do not retry/);
    await expect(
      bridge.dispatchActionForWebContents(999, "actions.list", {}, false)
    ).rejects.toBeInstanceOf(SessionBindingError);
    await expect(
      bridge.dispatchActionForWebContents(999, "actions.list", {}, false)
    ).rejects.toThrow(/Do not retry/);
  });

  it("fails closed when the pinned view exists but reports isDestroyed", async () => {
    const wc = makeWebContents(404);
    wc.isDestroyed.mockReturnValue(true);
    mockWebContentsRegistry.set(404, wc);

    await expect(bridge.requestManifestForWebContents(404)).rejects.toBeInstanceOf(
      SessionBindingError
    );
    await expect(bridge.requestManifestForWebContents(404)).rejects.toThrow(/Do not retry/);
    await expect(
      bridge.dispatchActionForWebContents(404, "actions.list", {}, false)
    ).rejects.toBeInstanceOf(SessionBindingError);
    await expect(
      bridge.dispatchActionForWebContents(404, "actions.list", {}, false)
    ).rejects.toThrow(/Do not retry/);
    // Must not have attempted to send to a destroyed view.
    expect(wc.send).not.toHaveBeenCalled();
  });

  it("rejects pending pinned dispatch when the pinned view emits 'destroyed' mid-flight", async () => {
    const wc = makeWebContents(505);
    mockWebContentsRegistry.set(505, wc);

    // Send accepts but never replies — we'll trigger destroyed manually.
    const promise = bridge.dispatchActionForWebContents(505, "actions.list", {}, false);
    // Yield so the dispatch helper has registered the destroyed listener.
    await Promise.resolve();
    wc.triggerDestroyed();

    // Same classification as a view already gone before the send (#11790):
    // "destroyed a moment later" is still the route dying, so it must not
    // degrade to an opaque retriable EXECUTION_ERROR.
    await expect(promise).rejects.toBeInstanceOf(SessionBindingError);
    await expect(promise).rejects.toThrow(/Do not retry/);
  });
});

describe("rendererBridge — per-WebContents manifest cache (#9887)", () => {
  let pendingManifests: Map<string, PendingRequest<ActionManifestEntry[]>>;
  let pendingDispatches: Map<string, PendingRequest<DispatchEnvelope>>;
  let bridge: ReturnType<typeof createRendererBridge>;

  beforeEach(() => {
    mockIpcMain.removeAllListeners();
    mockWebContentsRegistry.clear();
    pendingManifests = new Map();
    pendingDispatches = new Map();
    bridge = createRendererBridge(pendingManifests, pendingDispatches, () => null);
    bridge.setupListeners([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Wires `wc.send` to reply with a fixed manifest after a microtask, capturing
   * each requestId so a test can choose to reply manually instead. Returns the
   * list of captured requestIds (in send order).
   */
  function autoReplyManifest(
    wc: FakeWebContents,
    manifest: ActionManifestEntry[],
    options?: { manual?: boolean }
  ): string[] {
    const requestIds: string[] = [];
    wc.send.mockImplementation((channel: string, payload: { requestId: string }) => {
      if (channel !== CHANNELS.MCP_SERVER_GET_MANIFEST_REQUEST) return;
      requestIds.push(payload.requestId);
      if (options?.manual) return;
      queueMicrotask(() => {
        mockIpcMain.emit(
          CHANNELS.MCP_SERVER_GET_MANIFEST_RESPONSE,
          { sender: { id: wc.id } },
          { requestId: payload.requestId, manifest }
        );
      });
    });
    return requestIds;
  }

  it("coalesces concurrent requestManifestForWebContents calls onto one IPC send", async () => {
    const wc = makeWebContents(111);
    mockWebContentsRegistry.set(111, wc);
    autoReplyManifest(wc, [{ id: "a" }] as ActionManifestEntry[]);

    const [m1, m2] = await Promise.all([
      bridge.requestManifestForWebContents(111),
      bridge.requestManifestForWebContents(111),
    ]);

    expect(m1).toEqual([{ id: "a" }]);
    expect(m2).toEqual([{ id: "a" }]);
    // Singleflight: the second concurrent caller rode the first fetch.
    expect(wc.send).toHaveBeenCalledTimes(1);
  });

  it("populates the per-WebContents cache and isolates it per id — never crossing windows", async () => {
    const wcA = makeWebContents(121);
    const wcB = makeWebContents(122);
    mockWebContentsRegistry.set(121, wcA);
    mockWebContentsRegistry.set(122, wcB);
    autoReplyManifest(wcA, [{ id: "from-A" }] as ActionManifestEntry[]);
    autoReplyManifest(wcB, [{ id: "from-B" }] as ActionManifestEntry[]);

    expect(bridge.getCachedManifestForWebContents(121)).toBeNull();

    await bridge.requestManifestForWebContents(121);
    await bridge.requestManifestForWebContents(122);

    // Each id reads only its own window's manifest.
    expect(bridge.getCachedManifestForWebContents(121)).toEqual([{ id: "from-A" }]);
    expect(bridge.getCachedManifestForWebContents(122)).toEqual([{ id: "from-B" }]);
    // The shared cache is never written by the pinned path.
    expect(bridge.getCachedManifest()).toBeNull();
  });

  it("always fetches fresh — a warm cache never short-circuits a new request (tools/list freshness)", async () => {
    const wc = makeWebContents(131);
    mockWebContentsRegistry.set(131, wc);
    let serial = 0;
    wc.send.mockImplementation((channel: string, payload: { requestId: string }) => {
      if (channel !== CHANNELS.MCP_SERVER_GET_MANIFEST_REQUEST) return;
      const value = `v${++serial}`;
      queueMicrotask(() => {
        mockIpcMain.emit(
          CHANNELS.MCP_SERVER_GET_MANIFEST_RESPONSE,
          { sender: { id: 131 } },
          { requestId: payload.requestId, manifest: [{ id: value }] }
        );
      });
    });

    const first = await bridge.requestManifestForWebContents(131);
    const second = await bridge.requestManifestForWebContents(131);

    // A resolved cache must NOT be returned — each sequential call re-fetches,
    // so runtime action-set changes (plugin enable/disable) stay reflected.
    expect(first).toEqual([{ id: "v1" }]);
    expect(second).toEqual([{ id: "v2" }]);
    expect(wc.send).toHaveBeenCalledTimes(2);
    // The cache reflects the latest fetch for the lookup hot path.
    expect(bridge.getCachedManifestForWebContents(131)).toEqual([{ id: "v2" }]);
  });

  it("evicts the cached manifest when the pinned WebContents is destroyed", async () => {
    const wc = makeWebContents(141);
    mockWebContentsRegistry.set(141, wc);
    autoReplyManifest(wc, [{ id: "live" }] as ActionManifestEntry[]);

    await bridge.requestManifestForWebContents(141);
    expect(bridge.getCachedManifestForWebContents(141)).toEqual([{ id: "live" }]);

    wc.triggerDestroyed();

    expect(bridge.getCachedManifestForWebContents(141)).toBeNull();
  });

  it("clearCache drops all per-WebContents manifests", async () => {
    const wc = makeWebContents(151);
    mockWebContentsRegistry.set(151, wc);
    autoReplyManifest(wc, [{ id: "cached" }] as ActionManifestEntry[]);

    await bridge.requestManifestForWebContents(151);
    expect(bridge.getCachedManifestForWebContents(151)).toEqual([{ id: "cached" }]);

    bridge.clearCache();

    expect(bridge.getCachedManifestForWebContents(151)).toBeNull();
  });

  it("resurrection guard: a fetch that resolves after clearCache does not repopulate the cache", async () => {
    const wc = makeWebContents(161);
    mockWebContentsRegistry.set(161, wc);
    // Manual mode: capture the requestId, reply only when we choose.
    const requestIds = autoReplyManifest(wc, [{ id: "stale" }] as ActionManifestEntry[], {
      manual: true,
    });

    // Kick off a fetch that stays in flight. The routed paths thaw before they
    // send (#11790), so the request only reaches the renderer a chain of
    // microtasks later.
    const inflight = bridge.requestManifestForWebContents(161);
    await flushThaw();
    expect(requestIds).toHaveLength(1);

    // The server clears all caches (stop/restart) while the fetch is pending.
    bridge.clearCache();

    // The original fetch now resolves late.
    mockIpcMain.emit(
      CHANNELS.MCP_SERVER_GET_MANIFEST_RESPONSE,
      { sender: { id: 161 } },
      { requestId: requestIds[0], manifest: [{ id: "stale" }] }
    );
    await inflight;

    // The late resolve must NOT repopulate the cleared cache.
    expect(bridge.getCachedManifestForWebContents(161)).toBeNull();
  });

  it("registers the teardown-eviction listener only once across repeated fetches", async () => {
    const wc = makeWebContents(171);
    mockWebContentsRegistry.set(171, wc);
    autoReplyManifest(wc, [{ id: "x" }] as ActionManifestEntry[]);

    // Three sequential fetches: each per-request destroyed listener is cleaned
    // up on resolve, so only the single per-WebContents eviction listener
    // should remain — the wired-id guard must not register a second one.
    await bridge.requestManifestForWebContents(171);
    await bridge.requestManifestForWebContents(171);
    await bridge.requestManifestForWebContents(171);

    expect(wc.destroyedListenerCount()).toBe(1);
  });

  it("rejects and caches nothing when the pinned view is destroyed mid-flight", async () => {
    const wc = makeWebContents(181);
    mockWebContentsRegistry.set(181, wc);
    // Manual mode: the fetch stays in flight until we act.
    autoReplyManifest(wc, [{ id: "never" }] as ActionManifestEntry[], { manual: true });

    const inflight = bridge.requestManifestForWebContents(181);
    await Promise.resolve();
    wc.triggerDestroyed();

    await expect(inflight).rejects.toBeInstanceOf(SessionBindingError);
    expect(bridge.getCachedManifestForWebContents(181)).toBeNull();
  });

  it("after clearCache, a fresh fetch repopulates the cache with the new manifest", async () => {
    const wc = makeWebContents(191);
    mockWebContentsRegistry.set(191, wc);
    autoReplyManifest(wc, [{ id: "first" }] as ActionManifestEntry[]);

    await bridge.requestManifestForWebContents(191);
    bridge.clearCache();
    expect(bridge.getCachedManifestForWebContents(191)).toBeNull();

    // A legitimate subsequent fetch must still succeed and populate the cache —
    // the resurrection guard only blocks stale writes, not new ones.
    autoReplyManifest(wc, [{ id: "second" }] as ActionManifestEntry[]);
    await bridge.requestManifestForWebContents(191);

    expect(bridge.getCachedManifestForWebContents(191)).toEqual([{ id: "second" }]);
  });
});

describe("rendererBridge — requesting-bearer identity passthrough (#9157)", () => {
  let pendingManifests: Map<string, PendingRequest<ActionManifestEntry[]>>;
  let pendingDispatches: Map<string, PendingRequest<DispatchEnvelope>>;

  beforeEach(() => {
    mockIpcMain.removeAllListeners();
    mockWebContentsRegistry.clear();
    pendingManifests = new Map();
    pendingDispatches = new Map();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Builds a bridge whose active-project resolver returns `wc`, exercising the
   * unpinned `dispatchAction` path (external/api-key clients) — the only path
   * that carries `callerInfo`.
   */
  function makeActiveBridge(wc: FakeWebContents) {
    const contexts = [
      {
        browserWindow: { isDestroyed: () => false },
        services: {
          projectViewManager: {
            getActiveView: () => ({ webContents: wc }),
            // Present but empty, so these tests exercise the real "no workspace
            // registered" path rather than a missing-method error path.
            getWorkspaceRefForWebContents: () => null,
          },
        },
      },
    ];
    const registry = {
      all: () => contexts,
      focusOrder: () => contexts,
      getByWebContentsId: (id: number) => (id === wc.id ? contexts[0] : undefined),
    };
    const bridge = createRendererBridge(
      pendingManifests,
      pendingDispatches,
      () => registry as never
    );
    bridge.setupListeners([]);
    return bridge;
  }

  it("includes callerInfo in the unpinned dispatch IPC payload when provided", async () => {
    const wc = makeWebContents(801);
    const bridge = makeActiveBridge(wc);

    let sentPayload: { requestId: string; callerInfo?: unknown } | undefined;
    wc.send.mockImplementation((channel: string, payload: { requestId: string }) => {
      if (channel !== CHANNELS.MCP_SERVER_DISPATCH_ACTION_REQUEST) return;
      sentPayload = payload as { requestId: string; callerInfo?: unknown };
      queueMicrotask(() => {
        mockIpcMain.emit(
          CHANNELS.MCP_SERVER_DISPATCH_ACTION_RESPONSE,
          { sender: { id: 801 } },
          { requestId: payload.requestId, result: { ok: true, result: "ok" } }
        );
      });
    });

    const callerInfo = { token4LastChars: "1234", userAgent: "Claude Code" };
    await bridge.dispatchAction("terminal.kill", {}, false, callerInfo);

    expect(sentPayload?.callerInfo).toEqual(callerInfo);
  });

  it("leaves callerInfo absent (undefined) when not provided", async () => {
    const wc = makeWebContents(802);
    const bridge = makeActiveBridge(wc);

    let sentPayload: { requestId: string; callerInfo?: unknown } | undefined;
    wc.send.mockImplementation((channel: string, payload: { requestId: string }) => {
      if (channel !== CHANNELS.MCP_SERVER_DISPATCH_ACTION_REQUEST) return;
      sentPayload = payload as { requestId: string; callerInfo?: unknown };
      queueMicrotask(() => {
        mockIpcMain.emit(
          CHANNELS.MCP_SERVER_DISPATCH_ACTION_RESPONSE,
          { sender: { id: 802 } },
          { requestId: payload.requestId, result: { ok: true, result: "ok" } }
        );
      });
    });

    await bridge.dispatchAction("actions.list", {}, false);

    expect(sentPayload).toBeDefined();
    expect(sentPayload?.callerInfo).toBeUndefined();
  });

  it("defaults the unpinned dispatch payload to an external origin (#11808)", async () => {
    const wc = makeWebContents(804);
    const bridge = makeActiveBridge(wc);

    let sentPayload: { requestId: string; sessionOrigin?: unknown } | undefined;
    wc.send.mockImplementation((channel: string, payload: { requestId: string }) => {
      if (channel !== CHANNELS.MCP_SERVER_DISPATCH_ACTION_REQUEST) return;
      sentPayload = payload as { requestId: string; sessionOrigin?: unknown };
      queueMicrotask(() => {
        mockIpcMain.emit(
          CHANNELS.MCP_SERVER_DISPATCH_ACTION_RESPONSE,
          { sender: { id: 804 } },
          { requestId: payload.requestId, result: { ok: true, result: "ok" } }
        );
      });
    });

    // Unlike `callerInfo`, which is legitimately absent, origin is never
    // absent — a caller that forgets it gets the least-privileged answer
    // rather than an undefined the renderer would have to interpret.
    await bridge.dispatchAction("actions.list", {}, false);

    expect(sentPayload?.sessionOrigin).toBe("external");
  });

  it("the pinned dispatch path leaves callerInfo undefined (provenance-free)", async () => {
    // Pinned (help-session) dispatch must stay provenance-free. Mirrors the
    // `context: undefined` convention — the key is present but undefined, which
    // structured clone strips at the IPC boundary so the renderer sees nothing.
    const wc = makeWebContents(803);
    mockWebContentsRegistry.set(803, wc);
    const bridge = createRendererBridge(pendingManifests, pendingDispatches, () => null);
    bridge.setupListeners([]);

    let sentPayload: { requestId: string; callerInfo?: unknown } | undefined;
    wc.send.mockImplementation((channel: string, payload: { requestId: string }) => {
      if (channel !== CHANNELS.MCP_SERVER_DISPATCH_ACTION_REQUEST) return;
      sentPayload = payload as { requestId: string; callerInfo?: unknown };
      queueMicrotask(() => {
        mockIpcMain.emit(
          CHANNELS.MCP_SERVER_DISPATCH_ACTION_RESPONSE,
          { sender: { id: 803 } },
          { requestId: payload.requestId, result: { ok: true, result: "ok" } }
        );
      });
    });

    await bridge.dispatchActionForWebContents(803, "actions.list", {}, false);

    expect(sentPayload).toBeDefined();
    expect(sentPayload?.callerInfo).toBeUndefined();
  });
});

describe("rendererBridge — unpinned routing follows focus order (#11536)", () => {
  let pendingManifests: Map<string, PendingRequest<ActionManifestEntry[]>>;
  let pendingDispatches: Map<string, PendingRequest<DispatchEnvelope>>;

  beforeEach(() => {
    mockIpcMain.removeAllListeners();
    mockWebContentsRegistry.clear();
    pendingManifests = new Map();
    pendingDispatches = new Map();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  interface FakeContextOptions {
    windowDestroyed?: boolean;
    /** Omitted entirely for a window with no active project view. */
    activeWebContents?: FakeWebContents | null;
    workspaceRef?: {
      kind: "project" | "scratch";
      workspaceId: string;
      workspacePath: string;
    } | null;
    /** Simulates a host whose manager predates getWorkspaceRefForWebContents. */
    omitWorkspaceRefAccessor?: boolean;
    /** Simulates a torn-down view whose accessor throws rather than returning. */
    throwFromWorkspaceRefAccessor?: boolean;
    /** Simulates the window lookup itself throwing, before any accessor call. */
    throwFromServices?: boolean;
  }

  function makeContext(options: FakeContextOptions) {
    const { windowDestroyed = false, activeWebContents = null, workspaceRef = null } = options;
    const getActiveView = () => (activeWebContents ? { webContents: activeWebContents } : null);
    // Spied so a test can assert the lookup happened per-sender at response
    // time, rather than eagerly at send time.
    const getWorkspaceRefForWebContents = vi.fn((id: number) => {
      if (options.throwFromWorkspaceRefAccessor) throw new Error("view torn down");
      return workspaceRef && activeWebContents && activeWebContents.id === id ? workspaceRef : null;
    });
    const projectViewManager = options.omitWorkspaceRefAccessor
      ? { getActiveView }
      : { getActiveView, getWorkspaceRefForWebContents };
    // Routing reads `projectViewManager` first, then response-time resolution
    // reads it again. Throwing only on the later reads models a window torn
    // down mid-dispatch, without breaking the routing that must happen first.
    let serviceReads = 0;
    const services = options.throwFromServices
      ? {
          get projectViewManager() {
            serviceReads += 1;
            if (serviceReads > 1) throw new Error("window torn down");
            return projectViewManager;
          },
        }
      : { projectViewManager };
    return {
      browserWindow: { isDestroyed: () => windowDestroyed },
      services,
      activeWebContentsId: activeWebContents?.id ?? null,
      /** Test-only handle on the spy — production reads it via `services`. */
      workspaceRefSpy: getWorkspaceRefForWebContents,
    };
  }

  /**
   * Registry double whose `all()` and `focusOrder()` deliberately disagree, so a
   * test that passes under either ordering proves nothing. `focusOrder` reads a
   * mutable ref to model focus moving between calls.
   */
  function makeRegistry(
    registrationOrder: ReturnType<typeof makeContext>[],
    focusRef: { current: ReturnType<typeof makeContext>[] }
  ) {
    return {
      all: () => registrationOrder,
      focusOrder: () => focusRef.current,
      getByWebContentsId: (id: number) =>
        registrationOrder.find((ctx) => ctx.activeWebContentsId === id),
    };
  }

  /** Auto-replies to a dispatch request as `wc`, so the promise settles. */
  function autoRespond(wc: FakeWebContents, senderId = wc.id) {
    wc.send.mockImplementation((channel: string, payload: { requestId: string }) => {
      if (channel !== CHANNELS.MCP_SERVER_DISPATCH_ACTION_REQUEST) return;
      queueMicrotask(() => {
        mockIpcMain.emit(
          CHANNELS.MCP_SERVER_DISPATCH_ACTION_RESPONSE,
          { sender: { id: senderId } },
          { requestId: payload.requestId, result: { ok: true, result: "ok" } }
        );
      });
    });
  }

  it("dispatches to the most-recently-focused window, not the first registered", async () => {
    const wcFirst = makeWebContents(901);
    const wcFocused = makeWebContents(902);
    const ctxFirst = makeContext({ activeWebContents: wcFirst });
    const ctxFocused = makeContext({ activeWebContents: wcFocused });
    autoRespond(wcFirst);
    autoRespond(wcFocused);

    // Registered first-to-last as [first, focused]; focus says the opposite.
    const focusRef = { current: [ctxFocused, ctxFirst] };
    const bridge = createRendererBridge(
      pendingManifests,
      pendingDispatches,
      () => makeRegistry([ctxFirst, ctxFocused], focusRef) as never
    );
    bridge.setupListeners([]);

    await bridge.dispatchAction("actions.list", {}, false);

    expect(wcFocused.send).toHaveBeenCalled();
    expect(wcFirst.send).not.toHaveBeenCalled();
  });

  it("re-resolves focus on every call, so a mid-session focus change retargets", async () => {
    const wcA = makeWebContents(911);
    const wcB = makeWebContents(912);
    const ctxA = makeContext({ activeWebContents: wcA });
    const ctxB = makeContext({ activeWebContents: wcB });
    autoRespond(wcA);
    autoRespond(wcB);

    const focusRef = { current: [ctxB, ctxA] };
    const bridge = createRendererBridge(
      pendingManifests,
      pendingDispatches,
      () => makeRegistry([ctxA, ctxB], focusRef) as never
    );
    bridge.setupListeners([]);

    await bridge.dispatchAction("actions.list", {}, false);
    expect(wcB.send).toHaveBeenCalledTimes(1);
    expect(wcA.send).not.toHaveBeenCalled();

    // User switches windows between calls.
    focusRef.current = [ctxA, ctxB];
    await bridge.dispatchAction("actions.list", {}, false);
    expect(wcA.send).toHaveBeenCalledTimes(1);
    expect(wcB.send).toHaveBeenCalledTimes(1);
  });

  it("skips destroyed windows and view-less windows ahead of a live one in focus order", async () => {
    const wcLive = makeWebContents(921);
    const wcInDestroyedWindow = makeWebContents(922);
    const wcDestroyedView = makeWebContents(923);
    wcDestroyedView.isDestroyed.mockReturnValue(true);
    autoRespond(wcLive);

    const ctxDestroyedWindow = makeContext({
      windowDestroyed: true,
      activeWebContents: wcInDestroyedWindow,
    });
    const ctxNoView = makeContext({ activeWebContents: null });
    const ctxDestroyedView = makeContext({ activeWebContents: wcDestroyedView });
    const ctxLive = makeContext({ activeWebContents: wcLive });

    const focusRef = {
      current: [ctxDestroyedWindow, ctxNoView, ctxDestroyedView, ctxLive],
    };
    const bridge = createRendererBridge(
      pendingManifests,
      pendingDispatches,
      () => makeRegistry([ctxLive], focusRef) as never
    );
    bridge.setupListeners([]);

    await bridge.dispatchAction("actions.list", {}, false);

    expect(wcLive.send).toHaveBeenCalled();
    expect(wcInDestroyedWindow.send).not.toHaveBeenCalled();
    expect(wcDestroyedView.send).not.toHaveBeenCalled();
  });

  it("manifest requests follow focus order too", async () => {
    const wcFirst = makeWebContents(931);
    const wcFocused = makeWebContents(932);
    const ctxFirst = makeContext({ activeWebContents: wcFirst });
    const ctxFocused = makeContext({ activeWebContents: wcFocused });
    wcFocused.send.mockImplementation((channel: string, payload: { requestId: string }) => {
      if (channel !== CHANNELS.MCP_SERVER_GET_MANIFEST_REQUEST) return;
      queueMicrotask(() => {
        mockIpcMain.emit(
          CHANNELS.MCP_SERVER_GET_MANIFEST_RESPONSE,
          { sender: { id: 932 } },
          { requestId: payload.requestId, manifest: [] }
        );
      });
    });

    const focusRef = { current: [ctxFocused, ctxFirst] };
    const bridge = createRendererBridge(
      pendingManifests,
      pendingDispatches,
      () => makeRegistry([ctxFirst, ctxFocused], focusRef) as never
    );
    bridge.setupListeners([]);

    await bridge.requestManifest();

    expect(wcFocused.send).toHaveBeenCalled();
    expect(wcFirst.send).not.toHaveBeenCalled();
  });

  it("stamps the dispatched workspace on the envelope, resolved from the responding sender", async () => {
    const wcA = makeWebContents(941);
    const wcB = makeWebContents(942);
    const refA = { kind: "project" as const, workspaceId: "proj-a", workspacePath: "/repos/a" };
    // A scratch is a legitimate target and carries no Project row, so the
    // stamp has to say so rather than labelling it a project.
    const refB = { kind: "scratch" as const, workspaceId: "scr-b", workspacePath: "/scratch/b" };
    const ctxA = makeContext({ activeWebContents: wcA, workspaceRef: refA });
    const ctxB = makeContext({ activeWebContents: wcB, workspaceRef: refB });
    autoRespond(wcA);
    autoRespond(wcB);

    const focusRef = { current: [ctxB, ctxA] };
    const bridge = createRendererBridge(
      pendingManifests,
      pendingDispatches,
      () => makeRegistry([ctxA, ctxB], focusRef) as never
    );
    bridge.setupListeners([]);

    const focusedEnvelope = await bridge.dispatchAction("actions.list", {}, false);
    expect(focusedEnvelope.dispatchedWorkspace).toEqual(refB);

    // Focus moves — the stamp must follow the window the call actually hit.
    focusRef.current = [ctxA, ctxB];
    const retargetedEnvelope = await bridge.dispatchAction("actions.list", {}, false);
    expect(retargetedEnvelope.dispatchedWorkspace).toEqual(refA);
  });

  it("resolves the workspace at response time, from the responding sender — not at send time", async () => {
    // Guards the seam: resolving when the request is SENT, or from whatever is
    // focused when the response arrives, would both pass the tests above.
    // Here two dispatches are in flight at once and settle in reverse order,
    // with focus moved in between — only per-sender, response-time resolution
    // gives each its own workspace.
    const wcA = makeWebContents(971);
    const wcB = makeWebContents(972);
    const refA = { kind: "project" as const, workspaceId: "proj-a", workspacePath: "/repos/a" };
    const refB = { kind: "project" as const, workspaceId: "proj-b", workspacePath: "/repos/b" };
    const ctxA = makeContext({ activeWebContents: wcA, workspaceRef: refA });
    const ctxB = makeContext({ activeWebContents: wcB, workspaceRef: refB });

    const pending: Array<{ id: number; requestId: string }> = [];
    for (const [wc, id] of [
      [wcB, 972],
      [wcA, 971],
    ] as const) {
      wc.send.mockImplementation((channel: string, payload: { requestId: string }) => {
        if (channel !== CHANNELS.MCP_SERVER_DISPATCH_ACTION_REQUEST) return;
        pending.push({ id, requestId: payload.requestId });
      });
    }

    const focusRef = { current: [ctxB, ctxA] };
    const bridge = createRendererBridge(
      pendingManifests,
      pendingDispatches,
      () => makeRegistry([ctxA, ctxB], focusRef) as never
    );
    bridge.setupListeners([]);

    // First call targets B (focused). Its response is deliberately withheld.
    const bCall = bridge.dispatchAction("actions.list", {}, false);
    // Focus moves; the second call targets A while B is still in flight.
    focusRef.current = [ctxA, ctxB];
    const aCall = bridge.dispatchAction("actions.list", {}, false);

    expect(pending).toHaveLength(2);
    const bRequest = pending[0];
    const aRequest = pending[1];
    expect(bRequest.id).toBe(972);
    expect(aRequest.id).toBe(971);

    // A spoofed response from the wrong sender must be ignored outright.
    mockIpcMain.emit(
      CHANNELS.MCP_SERVER_DISPATCH_ACTION_RESPONSE,
      { sender: { id: 971 } },
      { requestId: bRequest.requestId, result: { ok: true, result: "spoofed" } }
    );
    expect(ctxB.workspaceRefSpy).not.toHaveBeenCalled();
    expect(ctxA.workspaceRefSpy).not.toHaveBeenCalled();

    // Settle in reverse order: A (sent last) first, then B.
    mockIpcMain.emit(
      CHANNELS.MCP_SERVER_DISPATCH_ACTION_RESPONSE,
      { sender: { id: 971 } },
      { requestId: aRequest.requestId, result: { ok: true, result: "from-a" } }
    );
    mockIpcMain.emit(
      CHANNELS.MCP_SERVER_DISPATCH_ACTION_RESPONSE,
      { sender: { id: 972 } },
      { requestId: bRequest.requestId, result: { ok: true, result: "from-b" } }
    );

    // Each envelope reports its OWN sender's workspace, despite the focus
    // change and the out-of-order settlement.
    await expect(aCall).resolves.toMatchObject({
      result: { ok: true, result: "from-a" },
      dispatchedWorkspace: refA,
    });
    await expect(bCall).resolves.toMatchObject({
      result: { ok: true, result: "from-b" },
      dispatchedWorkspace: refB,
    });
  });

  it("omits dispatchedWorkspace when the sender has no registered workspace", async () => {
    const wc = makeWebContents(951);
    const ctx = makeContext({ activeWebContents: wc, workspaceRef: null });
    autoRespond(wc);

    const focusRef = { current: [ctx] };
    const bridge = createRendererBridge(
      pendingManifests,
      pendingDispatches,
      () => makeRegistry([ctx], focusRef) as never
    );
    bridge.setupListeners([]);

    const envelope = await bridge.dispatchAction("actions.list", {}, false);

    expect(envelope.result).toEqual({ ok: true, result: "ok" });
    expect(envelope.dispatchedWorkspace).toBeUndefined();
    expect("dispatchedWorkspace" in envelope).toBe(false);
  });

  it("omits the stamp, without logging, when the host manager has no accessor", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const wc = makeWebContents(961);
      const ctx = makeContext({ activeWebContents: wc, omitWorkspaceRefAccessor: true });
      autoRespond(wc);

      const focusRef = { current: [ctx] };
      const bridge = createRendererBridge(
        pendingManifests,
        pendingDispatches,
        () => makeRegistry([ctx], focusRef) as never
      );
      bridge.setupListeners([]);

      const envelope = await bridge.dispatchAction("actions.list", {}, false);

      expect(envelope.result).toEqual({ ok: true, result: "ok" });
      expect(envelope.dispatchedWorkspace).toBeUndefined();
      // An older/partial manager is an expected shape, not a failure.
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("settles the action and warns once when the workspace accessor throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const wc = makeWebContents(981);
      const ctx = makeContext({ activeWebContents: wc, throwFromWorkspaceRefAccessor: true });
      autoRespond(wc);

      const focusRef = { current: [ctx] };
      const bridge = createRendererBridge(
        pendingManifests,
        pendingDispatches,
        () => makeRegistry([ctx], focusRef) as never
      );
      bridge.setupListeners([]);

      // The action must still complete — identity is decoration, and the
      // pending entry's timer is already cleared by the time this runs, so an
      // escaping throw would strand the promise instead of losing the stamp.
      const first = await bridge.dispatchAction("actions.list", {}, false);
      expect(first.result).toEqual({ ok: true, result: "ok" });
      expect(first.dispatchedWorkspace).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);

      // Latched: a persistently broken lookup must not log on every dispatch.
      const second = await bridge.dispatchAction("actions.list", {}, false);
      expect(second.result).toEqual({ ok: true, result: "ok" });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("settles the action when the window lookup itself throws mid-dispatch", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const wc = makeWebContents(991);
      // The window is torn down between routing and the response, so reading
      // `services.projectViewManager` throws — outside any accessor call.
      const ctx = makeContext({ activeWebContents: wc, throwFromServices: true });
      autoRespond(wc);

      const focusRef = { current: [ctx] };
      const bridge = createRendererBridge(
        pendingManifests,
        pendingDispatches,
        () => makeRegistry([ctx], focusRef) as never
      );
      bridge.setupListeners([]);

      const envelope = await bridge.dispatchAction("actions.list", {}, false);

      expect(envelope.result).toEqual({ ok: true, result: "ok" });
      expect(envelope.dispatchedWorkspace).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("rendererBridge — workspace-bound routing (#11789)", () => {
  let pendingManifests: Map<string, PendingRequest<ActionManifestEntry[]>>;
  let pendingDispatches: Map<string, PendingRequest<DispatchEnvelope>>;
  let bridge: ReturnType<typeof createRendererBridge>;

  beforeEach(() => {
    mockIpcMain.removeAllListeners();
    mockWebContentsRegistry.clear();
    mockProjectViews.clear();
    pendingManifests = new Map();
    pendingDispatches = new Map();
    bridge = createRendererBridge(pendingManifests, pendingDispatches, () => null);
    bridge.setupListeners([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function registerView(workspaceId: string, id: number): FakeWebContents {
    const wc = makeWebContents(id);
    mockWebContentsRegistry.set(id, wc);
    mockProjectViews.set(workspaceId, [...(mockProjectViews.get(workspaceId) ?? []), wc]);
    return wc;
  }

  /** Settle whichever dispatch the bridge just sent, as the renderer would. */
  async function settleDispatch(): Promise<void> {
    await flushThaw();
    const [requestId] = [...pendingDispatches.keys()];
    mockIpcMain.emit(
      CHANNELS.MCP_SERVER_DISPATCH_ACTION_RESPONSE,
      { sender: { id: pendingDispatches.get(requestId!)!.webContentsId } },
      { requestId, result: { ok: true, result: "done" } }
    );
  }

  it("dispatches to the view that owns the workspace", async () => {
    const wc = registerView("ws-a", 101);
    registerView("ws-b", 202);

    const promise = bridge.dispatchActionForWorkspace("ws-a", "terminal.list", {}, false);
    await settleDispatch();
    await promise;

    expect(wc.send).toHaveBeenCalledWith(
      CHANNELS.MCP_SERVER_DISPATCH_ACTION_REQUEST,
      expect.objectContaining({ actionId: "terminal.list" })
    );
    expect((mockWebContentsRegistry.get(202) as FakeWebContents).send).not.toHaveBeenCalled();
  });

  it("forwards a supplied origin, and defaults to external without one (#11808)", async () => {
    const wc = registerView("ws-a", 101);

    // Workspace binding is refused for pinned bearers today, so this route only
    // ever sees external sessions — but httpLifecycle threads origin here
    // anyway rather than leaning on the default. That is a forward-compat
    // claim, so it gets asserted rather than just commented.
    const promiseOne = bridge.dispatchActionForWorkspace(
      "ws-a",
      "terminal.list",
      {},
      false,
      "assistant-pane"
    );
    await settleDispatch();
    await promiseOne;

    const promiseTwo = bridge.dispatchActionForWorkspace("ws-a", "terminal.list", {}, false);
    await settleDispatch();
    await promiseTwo;

    const origins = wc.send.mock.calls
      .filter(([channel]) => channel === CHANNELS.MCP_SERVER_DISPATCH_ACTION_REQUEST)
      .map(([, payload]) => (payload as { sessionOrigin?: unknown }).sessionOrigin);

    expect(origins).toEqual(["assistant-pane", "external"]);
  });

  it("keeps routing to its workspace after another workspace's view is registered", async () => {
    // The isolation the whole feature is for: nothing about workspace B
    // appearing (or being focused) may move workspace A's session.
    const wcA = registerView("ws-a", 101);
    const promiseOne = bridge.dispatchActionForWorkspace("ws-a", "terminal.list", {}, false);
    await settleDispatch();
    await promiseOne;

    registerView("ws-b", 202);
    const promiseTwo = bridge.dispatchActionForWorkspace("ws-a", "terminal.list", {}, false);
    await settleDispatch();
    await promiseTwo;

    expect(wcA.send).toHaveBeenCalledTimes(2);
  });

  it("follows the workspace to a replacement view rather than dying with the old one", async () => {
    // A WebContents id lives and dies with one view; the workspace id outlives
    // it. Binding to the id would leave the session permanently gone even after
    // its workspace came back — which is why the route re-resolves per call.
    registerView("ws-a", 101);
    mockProjectViews.set("ws-a", []);
    mockWebContentsRegistry.delete(101);

    await expect(
      bridge.dispatchActionForWorkspace("ws-a", "terminal.list", {}, false)
    ).rejects.toBeInstanceOf(WorkspaceBindingError);

    const replacement = registerView("ws-a", 303);
    const promise = bridge.dispatchActionForWorkspace("ws-a", "terminal.list", {}, false);
    await settleDispatch();
    await promise;

    expect(replacement.send).toHaveBeenCalled();
  });

  it("fails closed when the workspace has no live view, never falling back to another", async () => {
    registerView("ws-b", 202);

    await expect(
      bridge.dispatchActionForWorkspace("ws-a", "terminal.list", {}, false)
    ).rejects.toMatchObject({ code: "SESSION_BINDING_GONE", reason: "not-found" });
    expect((mockWebContentsRegistry.get(202) as FakeWebContents).send).not.toHaveBeenCalled();
  });

  it("fails closed when the workspace has more than one live view", async () => {
    // Two views own the workspace, so "the" target is undefined. Guessing here
    // would reintroduce exactly the ambiguity the binding removes.
    registerView("ws-a", 101);
    registerView("ws-a", 102);

    await expect(
      bridge.dispatchActionForWorkspace("ws-a", "terminal.list", {}, false)
    ).rejects.toMatchObject({ code: "SESSION_BINDING_GONE", reason: "ambiguous" });
  });

  it("reports both binding failures as one route-error family", async () => {
    // `sessionServer` narrows on the base class, so both must be caught by it
    // or a workspace failure would surface as an opaque EXECUTION_ERROR.
    await expect(bridge.requestManifestForWorkspace("ws-a")).rejects.toBeInstanceOf(
      McpRouteBindingError
    );
    expect(new SessionBindingError(1)).toBeInstanceOf(McpRouteBindingError);
  });

  it("reads the bound workspace's cached manifest, and nothing when it can't resolve one", async () => {
    registerView("ws-a", 101);
    const promise = bridge.requestManifestForWorkspace("ws-a");
    const [requestId] = [...pendingManifests.keys()];
    mockIpcMain.emit(
      CHANNELS.MCP_SERVER_GET_MANIFEST_RESPONSE,
      { sender: { id: 101 } },
      { requestId, manifest: [{ id: "terminal.list" }] }
    );
    await promise;

    expect(bridge.getCachedManifestForWorkspace("ws-a")).toEqual([{ id: "terminal.list" }]);
    // An unresolvable workspace must not silently fall through to the shared
    // cache — that would serve another workspace's tool surface.
    expect(bridge.getCachedManifestForWorkspace("ws-missing")).toBeNull();
  });

  it("resolveWorkspaceBinding refuses unknown and ambiguous workspaces", () => {
    registerView("ws-dup", 101);
    registerView("ws-dup", 102);

    expect(() => bridge.resolveWorkspaceBinding("ws-missing")).toThrow(WorkspaceBindingError);
    expect(() => bridge.resolveWorkspaceBinding("ws-dup")).toThrow(/more than one/);
  });

  it("resolveWorkspaceBinding returns the requested id even with no workspace-ref accessor", () => {
    // `getProjectViewManager` is mocked to null here, so the descriptive fields
    // are unresolvable — losing a label must never cost a working binding.
    registerView("ws-a", 101);
    expect(bridge.resolveWorkspaceBinding("ws-a")).toEqual({ workspaceId: "ws-a" });
  });
});

describe("rendererBridge — thaw and eviction lease for routed operations (#11790)", () => {
  let pendingManifests: Map<string, PendingRequest<ActionManifestEntry[]>>;
  let pendingDispatches: Map<string, PendingRequest<DispatchEnvelope>>;
  let leases: WorkspaceViewLeaseRegistry;
  let bridge: ReturnType<typeof createRendererBridge>;

  beforeEach(() => {
    mockIpcMain.removeAllListeners();
    mockWebContentsRegistry.clear();
    mockProjectViews.clear();
    vi.mocked(unfreezeWebContents).mockClear();
    vi.mocked(unfreezeWebContents).mockResolvedValue(undefined);
    pendingManifests = new Map();
    pendingDispatches = new Map();
    leases = new WorkspaceViewLeaseRegistry();
    bridge = createRendererBridge(pendingManifests, pendingDispatches, () => null, leases);
    bridge.setupListeners([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function registerView(workspaceId: string, id: number): FakeWebContents {
    const wc = makeWebContents(id);
    mockWebContentsRegistry.set(id, wc);
    mockProjectViews.set(workspaceId, [...(mockProjectViews.get(workspaceId) ?? []), wc]);
    return wc;
  }

  function settlePendingDispatch(webContentsId: number): void {
    const [requestId] = [...pendingDispatches.keys()];
    mockIpcMain.emit(
      CHANNELS.MCP_SERVER_DISPATCH_ACTION_RESPONSE,
      { sender: { id: webContentsId } },
      { requestId, result: { ok: true, result: "done" } }
    );
  }

  it("waits for the thaw to RESOLVE before the dispatch IPC, not merely to start", async () => {
    // The whole defect: a CDP-frozen renderer cannot run JS, so the dispatch
    // sits in Mojo unanswered until the 30s bridge deadline. Issuing the thaw
    // and sending in the same turn would not fix it — the send has to be
    // downstream of the thaw completing.
    const wc = registerView("ws-a", 101);
    let completeThaw: () => void = () => {};
    vi.mocked(unfreezeWebContents).mockReturnValue(
      new Promise<void>((resolve) => {
        completeThaw = resolve;
      })
    );

    const promise = bridge.dispatchActionForWorkspace("ws-a", "terminal.list", {}, false);
    await flushThaw();

    expect(vi.mocked(unfreezeWebContents)).toHaveBeenCalledWith(wc);
    expect(wc.send).not.toHaveBeenCalled();

    completeThaw();
    await flushThaw();

    expect(wc.send).toHaveBeenCalledWith(
      CHANNELS.MCP_SERVER_DISPATCH_ACTION_REQUEST,
      expect.objectContaining({ actionId: "terminal.list" })
    );

    settlePendingDispatch(101);
    await promise;
  });

  it("thaws a pinned view too — a help session's view is an ordinary cached view", async () => {
    const wc = makeWebContents(505);
    mockWebContentsRegistry.set(505, wc);

    const promise = bridge.dispatchActionForWebContents(505, "actions.list", {}, false);
    await flushThaw();

    expect(vi.mocked(unfreezeWebContents)).toHaveBeenCalledWith(wc);

    settlePendingDispatch(505);
    await promise;
  });

  it("thaws before the manifest IPC as well — tools/list has the shorter deadline", async () => {
    const wc = registerView("ws-a", 101);

    const promise = bridge.requestManifestForWorkspace("ws-a");
    await flushThaw();

    expect(vi.mocked(unfreezeWebContents)).toHaveBeenCalledWith(wc);

    const [requestId] = [...pendingManifests.keys()];
    mockIpcMain.emit(
      CHANNELS.MCP_SERVER_GET_MANIFEST_RESPONSE,
      { sender: { id: 101 } },
      { requestId, manifest: [] }
    );
    await promise;
  });

  it("does not thaw or lease the unpinned focused-window path, even with a live target", async () => {
    // That path resolves the ACTIVE view, which is never frozen and never an
    // eviction candidate. Thawing it would spend a CDP round trip per tool
    // call for nothing. The target must actually resolve, or an implementation
    // that thaws every resolved active view would pass this too.
    const activeWc = makeWebContents(707);
    const registryBridge = createRendererBridge(
      pendingManifests,
      pendingDispatches,
      () =>
        ({
          focusOrder: () => [
            {
              browserWindow: { isDestroyed: () => false },
              services: {
                projectViewManager: { getActiveView: () => ({ webContents: activeWc }) },
              },
            },
          ],
        }) as never,
      leases
    );
    registryBridge.setupListeners([]);

    const promise = registryBridge.dispatchAction("actions.list", {}, false);
    await flushThaw();

    expect(activeWc.send).toHaveBeenCalled();
    expect(vi.mocked(unfreezeWebContents)).not.toHaveBeenCalled();
    expect(leases.has(707)).toBe(false);

    settlePendingDispatch(707);
    await promise;
  });

  it("holds a lease for the life of the dispatch and releases it on the response", async () => {
    registerView("ws-a", 101);

    const promise = bridge.dispatchActionForWorkspace("ws-a", "terminal.list", {}, false);
    // Taken synchronously, before the thaw round trip — an eviction pass
    // landing inside that window would otherwise destroy the view we just
    // resolved.
    expect(leases.has(101)).toBe(true);

    await flushThaw();
    expect(leases.has(101)).toBe(true);

    settlePendingDispatch(101);
    await promise;

    expect(leases.has(101)).toBe(false);
  });

  it("releases the lease when the dispatch times out", async () => {
    vi.useFakeTimers();
    registerView("ws-a", 101);

    const promise = bridge.dispatchActionForWorkspace("ws-a", "terminal.list", {}, false);
    const assertion = expect(promise).rejects.toThrow(/Action dispatch timed out/);
    expect(leases.has(101)).toBe(true);

    await vi.advanceTimersByTimeAsync(31_000);
    await assertion;

    // A leaked lease would pin the view for the rest of the session, quietly
    // recreating the permanent eviction floor this design avoids.
    expect(leases.has(101)).toBe(false);
  });

  it("names the unreachable workspace in the timeout message", async () => {
    vi.useFakeTimers();
    registerView("ws-a", 101);

    const promise = bridge.dispatchActionForWorkspace("ws-a", "terminal.list", {}, false);
    const assertion = expect(promise).rejects.toThrow(
      /Action dispatch timed out: terminal\.list.*workspace ws-a.*30s/
    );
    await vi.advanceTimersByTimeAsync(31_000);
    await assertion;
  });

  it("releases the lease when the view is destroyed mid-dispatch", async () => {
    const wc = registerView("ws-a", 101);

    const promise = bridge.dispatchActionForWorkspace("ws-a", "terminal.list", {}, false);
    expect(leases.has(101)).toBe(true);

    wc.triggerDestroyed();

    await expect(promise).rejects.toBeInstanceOf(WorkspaceBindingError);
    expect(leases.has(101)).toBe(false);
  });

  it("reports a view destroyed mid-dispatch as a workspace route loss, not a dead pin", async () => {
    // "Do not retry" is right for a help session whose window closed, and wrong
    // for a workspace binding: the workspace id outlives the view, so reopening
    // it makes the very same call work.
    const wc = registerView("ws-a", 101);
    const promise = bridge.dispatchActionForWorkspace("ws-a", "terminal.list", {}, false);
    wc.triggerDestroyed();

    await expect(promise).rejects.toMatchObject({
      code: "SESSION_BINDING_GONE",
      reason: "not-found",
    });
    await expect(promise).rejects.toThrow(/Reopen that workspace and retry/);
  });

  it("reports a workspace manifest fetch destroyed mid-flight as a workspace route loss", async () => {
    const wc = registerView("ws-a", 101);
    const promise = bridge.requestManifestForWorkspace("ws-a");
    wc.triggerDestroyed();

    await expect(promise).rejects.toBeInstanceOf(WorkspaceBindingError);
    await expect(promise).rejects.toThrow(/Reopen that workspace and retry/);
  });

  it("releases the lease when the send throws", async () => {
    const wc = registerView("ws-a", 101);
    wc.send.mockImplementation(() => {
      throw new Error("send blew up");
    });

    const promise = bridge.dispatchActionForWorkspace("ws-a", "terminal.list", {}, false);
    // `normalizeError` passes a real Error straight through, so the renderer's
    // own failure is what surfaces — the fallback text is for non-Error throws.
    await expect(promise).rejects.toThrow(/send blew up/);
    expect(leases.has(101)).toBe(false);
  });

  it("keeps the view leased until the last of several concurrent dispatches settles", async () => {
    registerView("ws-a", 101);

    const first = bridge.dispatchActionForWorkspace("ws-a", "terminal.list", {}, false);
    const second = bridge.dispatchActionForWorkspace("ws-a", "worktree.list", {}, false);
    await flushThaw();

    const [firstId, secondId] = [...pendingDispatches.keys()];
    mockIpcMain.emit(
      CHANNELS.MCP_SERVER_DISPATCH_ACTION_RESPONSE,
      { sender: { id: 101 } },
      { requestId: firstId, result: { ok: true, result: "one" } }
    );
    await first;
    expect(leases.has(101)).toBe(true);

    mockIpcMain.emit(
      CHANNELS.MCP_SERVER_DISPATCH_ACTION_RESPONSE,
      { sender: { id: 101 } },
      { requestId: secondId, result: { ok: true, result: "two" } }
    );
    await second;
    expect(leases.has(101)).toBe(false);
  });

  it("takes no lease when the target cannot be resolved at all", async () => {
    await expect(
      bridge.dispatchActionForWorkspace("ws-missing", "terminal.list", {}, false)
    ).rejects.toBeInstanceOf(WorkspaceBindingError);
    expect(vi.mocked(unfreezeWebContents)).not.toHaveBeenCalled();
  });

  it("does not send after a deadline that fired while the thaw was outstanding", async () => {
    vi.useFakeTimers();
    const wc = registerView("ws-a", 101);
    // A thaw that never settles until we let it — the window in which the
    // request can time out underneath.
    let releaseThaw: () => void = () => {};
    vi.mocked(unfreezeWebContents).mockReturnValue(
      new Promise<void>((resolve) => {
        releaseThaw = resolve;
      })
    );

    const promise = bridge.dispatchActionForWorkspace("ws-a", "terminal.list", {}, false);
    const assertion = expect(promise).rejects.toThrow(/Action dispatch timed out/);
    await vi.advanceTimersByTimeAsync(31_000);
    await assertion;

    releaseThaw();
    await vi.advanceTimersByTimeAsync(0);

    // Sending now would emit an IPC for a requestId nothing is waiting on.
    expect(wc.send).not.toHaveBeenCalled();
    expect(leases.has(101)).toBe(false);
  });

  it("still sends when the thaw itself fails — a hiccup must not guarantee a timeout", async () => {
    const wc = registerView("ws-a", 101);
    vi.mocked(unfreezeWebContents).mockRejectedValue(new Error("CDP exploded"));

    const promise = bridge.dispatchActionForWorkspace("ws-a", "terminal.list", {}, false);
    await flushThaw();

    expect(wc.send).toHaveBeenCalled();

    settlePendingDispatch(101);
    await promise;
  });

  it("still dispatches when built without a lease registry, taking no lease", async () => {
    // Differential against the leased bridge on the same workspace, so the
    // "no lease" half is pinned to the missing registry rather than being
    // trivially true of an object nothing writes to.
    const wc = registerView("ws-bare", 909);

    const leasedRun = bridge.dispatchActionForWorkspace("ws-bare", "terminal.list", {}, false);
    await flushThaw();
    expect(leases.has(909)).toBe(true);
    settlePendingDispatch(909);
    await leasedRun;
    expect(leases.has(909)).toBe(false);

    const bare = createRendererBridge(pendingManifests, pendingDispatches, () => null);
    bare.setupListeners([]);
    wc.send.mockClear();

    const bareRun = bare.dispatchActionForWorkspace("ws-bare", "terminal.list", {}, false);
    await flushThaw();

    // Same call, same target, no registry: dispatch still works and the thaw
    // still happens — only the lease is absent.
    expect(wc.send).toHaveBeenCalled();
    expect(vi.mocked(unfreezeWebContents)).toHaveBeenCalledWith(wc);
    expect(leases.has(909)).toBe(false);

    settlePendingDispatch(909);
    await bareRun;
  });

  it("keeps the lease when a spoofed sender answers, and releases it on the real response", async () => {
    // The mismatch branch deliberately leaves the pending entry alone so the
    // legitimate renderer can still answer. Releasing the lease there would let
    // any wrong-sender message expose the view mid-call.
    const wc = registerView("ws-a", 101);
    const promise = bridge.dispatchActionForWorkspace("ws-a", "terminal.list", {}, false);
    await flushThaw();

    const [requestId] = [...pendingDispatches.keys()];
    mockIpcMain.emit(
      CHANNELS.MCP_SERVER_DISPATCH_ACTION_RESPONSE,
      { sender: { id: 999 } },
      { requestId, result: { ok: true, result: "spoofed" } }
    );

    expect(leases.has(101)).toBe(true);
    expect(pendingDispatches.has(requestId)).toBe(true);

    mockIpcMain.emit(
      CHANNELS.MCP_SERVER_DISPATCH_ACTION_RESPONSE,
      { sender: { id: wc.id } },
      { requestId, result: { ok: true, result: "real" } }
    );
    const envelope = await promise;

    expect(envelope.result).toEqual({ ok: true, result: "real" });
    expect(leases.has(101)).toBe(false);
  });

  it("releases the lease when server teardown rejects the pending request", async () => {
    // What HttpLifecycle does on stop and on unexpected close: it reaches into
    // the pending maps and settles them itself, so the release has to ride the
    // pending entry's own cleanup rather than the bridge's normal paths.
    registerView("ws-a", 101);
    const promise = bridge.dispatchActionForWorkspace("ws-a", "terminal.list", {}, false);
    const assertion = expect(promise).rejects.toThrow(/MCP server stopped/);
    expect(leases.has(101)).toBe(true);

    for (const [id, pending] of pendingDispatches) {
      clearTimeout(pending.timer);
      pending.destroyedCleanup?.();
      pending.reject(new Error("MCP server stopped"));
      pendingDispatches.delete(id);
    }
    await assertion;

    expect(leases.has(101)).toBe(false);
  });

  it("holds and releases a lease around a workspace manifest fetch", async () => {
    registerView("ws-a", 101);

    const promise = bridge.requestManifestForWorkspace("ws-a");
    expect(leases.has(101)).toBe(true);
    await flushThaw();

    const [requestId] = [...pendingManifests.keys()];
    mockIpcMain.emit(
      CHANNELS.MCP_SERVER_GET_MANIFEST_RESPONSE,
      { sender: { id: 101 } },
      { requestId, manifest: [] }
    );
    await promise;

    expect(leases.has(101)).toBe(false);
  });

  it("releases the manifest lease when the 5s deadline fires", async () => {
    vi.useFakeTimers();
    registerView("ws-a", 101);

    const promise = bridge.requestManifestForWorkspace("ws-a");
    const assertion = expect(promise).rejects.toThrow(/Manifest request timed out/);
    expect(leases.has(101)).toBe(true);

    await vi.advanceTimersByTimeAsync(6_000);
    await assertion;

    expect(leases.has(101)).toBe(false);
  });

  it("releases the manifest lease when the view is destroyed mid-fetch", async () => {
    const wc = registerView("ws-a", 101);

    const promise = bridge.requestManifestForWorkspace("ws-a");
    expect(leases.has(101)).toBe(true);
    wc.triggerDestroyed();

    await expect(promise).rejects.toBeInstanceOf(WorkspaceBindingError);
    expect(leases.has(101)).toBe(false);
  });

  it("coalesced manifest callers share one lease, released once the shared fetch settles", async () => {
    // Singleflight: the lease covers the fetch, not the caller, so a joiner
    // must neither add a second reference nor be left unprotected.
    registerView("ws-a", 101);

    const first = bridge.requestManifestForWorkspace("ws-a");
    const second = bridge.requestManifestForWorkspace("ws-a");
    await flushThaw();

    expect(pendingManifests.size).toBe(1);
    expect(leases.has(101)).toBe(true);

    const [requestId] = [...pendingManifests.keys()];
    mockIpcMain.emit(
      CHANNELS.MCP_SERVER_GET_MANIFEST_RESPONSE,
      { sender: { id: 101 } },
      { requestId, manifest: [{ id: "terminal.list" }] }
    );
    await Promise.all([first, second]);

    expect(leases.has(101)).toBe(false);
  });

  it("releases the manifest lease even when clearCache drops the singleflight mid-fetch", async () => {
    registerView("ws-a", 101);

    const promise = bridge.requestManifestForWorkspace("ws-a");
    await flushThaw();
    // Drops the inflight/cache bookkeeping but not the pending request itself.
    bridge.clearCache();

    const [requestId] = [...pendingManifests.keys()];
    mockIpcMain.emit(
      CHANNELS.MCP_SERVER_GET_MANIFEST_RESPONSE,
      { sender: { id: 101 } },
      { requestId, manifest: [] }
    );
    await promise;

    expect(leases.has(101)).toBe(false);
  });
});
