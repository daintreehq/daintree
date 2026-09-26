import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientEndpoint } from "../../../ipc/endpoint.js";

const { mockIpcMain, mockWebContentsRegistry, mockProjectViews, viewless } = vi.hoisted(() => {
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
    mockProjectViews: new Map<string, unknown[]>(),
    viewless: {
      runViewlessAction: vi.fn(),
      describeViewlessWorkspace: vi.fn(),
      hasViewlessImplementation: vi.fn(),
    },
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
  getWindowForWebContents: () => null,
  getProjectForWebContents: () => null,
}));

vi.mock("../../../utils/webContentsLifecycle.js", () => ({
  unfreezeWebContents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../viewless/index.js", () => viewless);

import { createRendererBridge, SessionBindingError } from "../rendererBridge.js";
import { MCP_DISPATCH_ACTION_METHOD, MCP_GET_MANIFEST_METHOD } from "../driveTarget.js";
import {
  _resetEndpointRegistryForTesting,
  getEndpointRegistry,
} from "../../../ipc/endpointRegistry.js";
import type { DispatchEnvelope, PendingRequest } from "../shared.js";

const PROJECT = "proj-1";
const HANDLE = -7;

function makeRemoteEndpoint(request: ClientEndpoint["request"]) {
  let closed = false;
  const closers: Array<() => void> = [];
  const endpoint: ClientEndpoint & { close(): void } = {
    endpointId: "remote:session-1:view-1",
    clientId: "client-1",
    projectId: PROJECT,
    kind: "remote-view",
    handle: HANDLE,
    send: vi.fn(),
    request: vi.fn(request),
    onClose: (cb) => {
      closers.push(cb);
      return { dispose: () => {} };
    },
    isClosed: () => closed,
    close() {
      closed = true;
      for (const cb of closers.splice(0)) cb();
    },
  };
  return endpoint;
}

/**
 * A help session a remote Shell launched on this host is pinned to that view's
 * endpoint handle (negative). Its MCP calls must reach that endpoint, and fail
 * closed once it goes, never fall through to a local WebContents lookup.
 */
describe("rendererBridge — sessions pinned to a remote view", () => {
  let pendingDispatches: Map<string, PendingRequest<DispatchEnvelope>>;
  let bridge: ReturnType<typeof createRendererBridge>;

  beforeEach(() => {
    mockIpcMain.removeAllListeners();
    mockWebContentsRegistry.clear();
    mockProjectViews.clear();
    _resetEndpointRegistryForTesting();
    viewless.describeViewlessWorkspace.mockReset().mockResolvedValue(undefined);
    pendingDispatches = new Map();
    bridge = createRendererBridge(new Map(), pendingDispatches, () => null);
    bridge.setupListeners([]);
  });

  afterEach(() => {
    _resetEndpointRegistryForTesting();
  });

  it("dispatches through the pinned endpoint with the launch context", async () => {
    const endpoint = makeRemoteEndpoint(async () => ({ result: { ok: true, result: 42 } }));
    getEndpointRegistry().add(endpoint);
    const context = { activeWorktreeId: "wt-1" } as never;

    const envelope = await bridge.dispatchActionForWebContents(
      HANDLE,
      "worktree.list",
      { a: 1 },
      false,
      context,
      "help"
    );

    expect(envelope.result).toEqual({ ok: true, result: 42 });
    expect(endpoint.request).toHaveBeenCalledWith(
      MCP_DISPATCH_ACTION_METHOD,
      expect.objectContaining({ actionId: "worktree.list", args: { a: 1 }, context }),
      expect.any(Object)
    );
    expect(pendingDispatches.size).toBe(0);
  });

  it("reads and caches the pinned view's manifest, evicted when its endpoint closes", async () => {
    const manifest = [{ id: "worktree.list" }];
    const endpoint = makeRemoteEndpoint(async (method) =>
      method === MCP_GET_MANIFEST_METHOD ? manifest : null
    );
    getEndpointRegistry().add(endpoint);

    await expect(bridge.requestManifestForWebContents(HANDLE)).resolves.toEqual(manifest);
    expect(bridge.getCachedManifestForWebContents(HANDLE)).toEqual(manifest);

    endpoint.close();
    expect(bridge.getCachedManifestForWebContents(HANDLE)).toBeNull();
  });

  it("fails closed as a dead pin when the endpoint is gone or answers disconnected", async () => {
    await expect(
      bridge.dispatchActionForWebContents(HANDLE, "worktree.list", {})
    ).rejects.toBeInstanceOf(SessionBindingError);
    await expect(bridge.requestManifestForWebContents(HANDLE)).rejects.toBeInstanceOf(
      SessionBindingError
    );

    const endpoint = makeRemoteEndpoint(async () => {
      throw Object.assign(new Error("gone"), { code: "HOST_DISCONNECTED" });
    });
    getEndpointRegistry().add(endpoint);
    await expect(
      bridge.dispatchActionForWebContents(HANDLE, "worktree.list", {})
    ).rejects.toBeInstanceOf(SessionBindingError);
  });
});
