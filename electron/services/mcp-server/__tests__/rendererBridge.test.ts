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
