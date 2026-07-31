import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../../ipc/channels.js";

const { mockIpcMain, mockWebContentsRegistry } = vi.hoisted(() => {
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

import { createRendererBridge, SessionBindingError } from "../rendererBridge.js";
import type { PendingRequest, DispatchEnvelope } from "../shared.js";
import type { ActionManifestEntry } from "../../../../shared/types/actions.js";

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

    await expect(promise).rejects.toThrow(/MCP renderer bridge destroyed/);
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

    // Kick off a fetch that stays in flight.
    const inflight = bridge.requestManifestForWebContents(161);
    await Promise.resolve();
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

    await expect(inflight).rejects.toThrow(/MCP renderer bridge destroyed/);
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
          projectViewManager: { getActiveView: () => ({ webContents: wc }) },
        },
      },
    ];
    const registry = {
      all: () => contexts,
      focusOrder: () => contexts,
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
    projectRef?: { projectId: string; projectPath: string } | null;
    /** Simulates a host whose manager predates getProjectRefForWebContents. */
    omitProjectRefAccessor?: boolean;
  }

  function makeContext(options: FakeContextOptions) {
    const { windowDestroyed = false, activeWebContents = null, projectRef = null } = options;
    const projectViewManager: Record<string, unknown> = {
      getActiveView: () => (activeWebContents ? { webContents: activeWebContents } : null),
    };
    if (!options.omitProjectRefAccessor) {
      projectViewManager.getProjectRefForWebContents = (id: number) =>
        projectRef && activeWebContents && activeWebContents.id === id ? projectRef : null;
    }
    return {
      browserWindow: { isDestroyed: () => windowDestroyed },
      services: { projectViewManager },
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
        registrationOrder.find(
          (ctx) =>
            (
              ctx.services.projectViewManager as {
                getActiveView: () => { webContents: FakeWebContents } | null;
              }
            ).getActiveView()?.webContents.id === id
        ),
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

  it("stamps the dispatched project on the envelope, resolved from the responding sender", async () => {
    const wcA = makeWebContents(941);
    const wcB = makeWebContents(942);
    const ctxA = makeContext({
      activeWebContents: wcA,
      projectRef: { projectId: "proj-a", projectPath: "/repos/a" },
    });
    const ctxB = makeContext({
      activeWebContents: wcB,
      projectRef: { projectId: "proj-b", projectPath: "/repos/b" },
    });
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
    expect(focusedEnvelope.dispatchedProject).toEqual({
      projectId: "proj-b",
      projectPath: "/repos/b",
    });

    // Focus moves — the stamp must follow the window the call actually hit.
    focusRef.current = [ctxA, ctxB];
    const retargetedEnvelope = await bridge.dispatchAction("actions.list", {}, false);
    expect(retargetedEnvelope.dispatchedProject).toEqual({
      projectId: "proj-a",
      projectPath: "/repos/a",
    });
  });

  it("omits dispatchedProject when the sender has no registered project", async () => {
    const wc = makeWebContents(951);
    const ctx = makeContext({ activeWebContents: wc, projectRef: null });
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
    expect(envelope.dispatchedProject).toBeUndefined();
    expect("dispatchedProject" in envelope).toBe(false);
  });

  it("still resolves the action when the project lookup throws", async () => {
    const wc = makeWebContents(961);
    // A manager that predates the accessor: calling it throws a TypeError.
    const ctx = makeContext({ activeWebContents: wc, omitProjectRefAccessor: true });
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
    expect(envelope.dispatchedProject).toBeUndefined();
  });
});
