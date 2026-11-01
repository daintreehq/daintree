import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../../ipc/channels.js";
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
  getProjectForWebContents: (id: number) => {
    for (const [projectId, views] of mockProjectViews) {
      if (views.some((view) => (view as { id: number }).id === id)) return projectId;
    }
    return null;
  },
}));

vi.mock("../../../utils/webContentsLifecycle.js", () => ({
  unfreezeWebContents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../viewless/index.js", () => viewless);

import {
  createRendererBridge,
  DriveHolderUnavailableError,
  NoFrontendAttachedError,
  RelayDrivenElsewhereError,
  SessionBindingError,
  WorkspaceBindingError,
} from "../rendererBridge.js";
import {
  MCP_DISPATCH_ACTION_METHOD,
  MCP_GET_MANIFEST_METHOD,
  _resetMcpDriveTargetResolverForTesting,
  setMcpDriveTargetResolver,
} from "../driveTarget.js";
import {
  _resetEndpointRegistryForTesting,
  getEndpointRegistry,
} from "../../../ipc/endpointRegistry.js";
import {
  MCP_DISPATCH_TIMEOUT_MS,
  type DispatchEnvelope,
  type PendingRequest,
  type WorkspaceDispatchOptions,
} from "../shared.js";
import {
  _resetHostStartedTerminalsForTesting,
  hostStartedTerminals,
  noteHostStartedTerminal,
} from "../../viewless/hostStartedTerminals.js";
import type { ActionManifestEntry } from "../../../../shared/types/actions.js";
import {
  MCP_CONFIRM_ASK_MAX_MS,
  MCP_REMOTE_CONFIRM_MARGIN_MS,
  MCP_REMOTE_DISPATCH_TIMEOUT_MS,
} from "../../../../shared/config/mcpConfirmWindow.js";

const WORKSPACE = "ws-1";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function makeWebContents(
  id: number,
  onSend?: (channel: string, payload: { requestId: string }) => void
) {
  return {
    id,
    isDestroyed: vi.fn(() => false),
    send: vi.fn((channel: string, payload: { requestId: string }) => onSend?.(channel, payload)),
    once: vi.fn(),
    removeListener: vi.fn(),
  };
}

function makeRemoteEndpoint(request: ClientEndpoint["request"]): ClientEndpoint {
  return {
    endpointId: "remote:session-1:view-1",
    clientId: "client-1",
    projectId: WORKSPACE,
    kind: "remote-view",
    handle: -5,
    send: vi.fn(),
    request: vi.fn(request),
    onClose: vi.fn(() => ({ dispose: () => {} })),
    isClosed: () => false,
  };
}

describe("rendererBridge — drive target and no-frontend dispatch", () => {
  let pendingDispatches: Map<string, PendingRequest<DispatchEnvelope>>;
  let bridge: ReturnType<typeof createRendererBridge>;

  beforeEach(() => {
    mockIpcMain.removeAllListeners();
    mockWebContentsRegistry.clear();
    mockProjectViews.clear();
    _resetMcpDriveTargetResolverForTesting();
    viewless.runViewlessAction.mockReset();
    viewless.describeViewlessWorkspace
      .mockReset()
      .mockResolvedValue({ kind: "project", workspaceId: WORKSPACE, workspacePath: "/repo" });
    viewless.hasViewlessImplementation
      .mockReset()
      .mockImplementation((id: string) =>
        ["terminal.new", "terminal.sendCommand", "worktree.create"].includes(id)
      );
    pendingDispatches = new Map();
    bridge = createRendererBridge(new Map(), pendingDispatches, () => null);
    bridge.setupListeners([]);
  });

  afterEach(() => {
    _resetMcpDriveTargetResolverForTesting();
  });

  describe("without Host-mode routing (no lease installed)", () => {
    it("fails a detached workspace exactly as before: a binding failure, nothing run in main", async () => {
      const err = await bridge
        .dispatchActionForWorkspace(WORKSPACE, "terminal.new", {})
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(WorkspaceBindingError);
      expect(err).not.toBeInstanceOf(NoFrontendAttachedError);
      expect((err as WorkspaceBindingError).reason).toBe("not-found");
      expect(viewless.runViewlessAction).not.toHaveBeenCalled();
    });

    it("rejects a detached workspace's manifest with the plain binding failure", async () => {
      const err = await bridge.requestManifestForWorkspace(WORKSPACE).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WorkspaceBindingError);
      expect(err).not.toBeInstanceOf(NoFrontendAttachedError);
    });
  });

  describe("describeWorkspaceRoute (#13350)", () => {
    it("names the one local view, and nowhere once it goes or another opens beside it", () => {
      mockProjectViews.set(WORKSPACE, [makeWebContents(41)]);
      expect(bridge.describeWorkspaceRoute(WORKSPACE)).toBe("local:41");
      mockProjectViews.set(WORKSPACE, [makeWebContents(41), makeWebContents(42)]);
      expect(bridge.describeWorkspaceRoute(WORKSPACE)).toBe("none");
      // A pane's launch view settles two views, as the manifest fetch does.
      expect(bridge.describeWorkspaceRoute(WORKSPACE, 42)).toBe("local:42");
      mockProjectViews.clear();
      expect(bridge.describeWorkspaceRoute(WORKSPACE)).toBe("none");
    });

    it("names a remote driver, and a held place it cannot reach as unavailable", () => {
      const endpoint = makeRemoteEndpoint(vi.fn());
      mockProjectViews.set(WORKSPACE, [makeWebContents(41)]);
      setMcpDriveTargetResolver(() => ({ state: "live", endpoint }));
      expect(bridge.describeWorkspaceRoute(WORKSPACE)).toBe(`remote:${endpoint.endpointId}`);
      setMcpDriveTargetResolver(() => ({ state: "unavailable", reason: "reserved" }));
      expect(bridge.describeWorkspaceRoute(WORKSPACE)).toBe("unavailable");
      setMcpDriveTargetResolver(() => ({ state: "vacant" }));
      expect(bridge.describeWorkspaceRoute(WORKSPACE)).toBe("local:41");
    });
  });

  describe("with every renderer detached", () => {
    beforeEach(() => {
      setMcpDriveTargetResolver(() => ({ state: "vacant" }));
    });

    it("runs a host-runnable action in main and stamps the workspace", async () => {
      viewless.runViewlessAction.mockResolvedValue({ ok: true, result: { terminalId: "t-new" } });
      const context = { projectId: WORKSPACE, activeWorktreeId: "/repo/wt" };

      const envelope = await bridge.dispatchActionForWorkspace(
        WORKSPACE,
        "terminal.new",
        {},
        false,
        "external",
        { contextOverride: context }
      );

      expect(viewless.runViewlessAction).toHaveBeenCalledWith({
        workspaceId: WORKSPACE,
        actionId: "terminal.new",
        args: {},
        confirmed: false,
        sessionOrigin: "external",
        context,
        // In Host mode the lease hears of each change it makes (#15918).
        checkWrite: expect.any(Function),
      });
      expect(envelope.result).toEqual({ ok: true, result: { terminalId: "t-new" } });
      expect(envelope.dispatchedWorkspace).toEqual({
        kind: "project",
        workspaceId: WORKSPACE,
        workspacePath: "/repo",
      });
    });

    it("refuses a UI-only action with NoFrontendAttachedError and runs nothing", async () => {
      const err = await bridge
        .dispatchActionForWorkspace(WORKSPACE, "terminal.moveToDock", { terminalId: "t" })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(NoFrontendAttachedError);
      // Still a not-found binding failure to every caller that handles one.
      expect(err).toBeInstanceOf(WorkspaceBindingError);
      expect((err as WorkspaceBindingError).reason).toBe("not-found");
      expect(viewless.runViewlessAction).not.toHaveBeenCalled();
    });

    it("reports no frontend when the host cannot act for the workspace on its own", async () => {
      viewless.runViewlessAction.mockResolvedValue(null);

      await expect(
        bridge.dispatchActionForWorkspace("scratch-1", "terminal.new", {})
      ).rejects.toBeInstanceOf(NoFrontendAttachedError);
    });

    it("never runs an approval request in main", async () => {
      const err = await bridge
        .dispatchActionForWorkspace(WORKSPACE, "terminal.new", {}, false, "external", {
          approvalOnly: true,
        })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(WorkspaceBindingError);
      expect(err).not.toBeInstanceOf(NoFrontendAttachedError);
      expect(viewless.runViewlessAction).not.toHaveBeenCalled();
    });

    it("rejects a manifest request with NoFrontendAttachedError", async () => {
      await expect(bridge.requestManifestForWorkspace(WORKSPACE)).rejects.toBeInstanceOf(
        NoFrontendAttachedError
      );
    });

    it("leaves an ambiguous workspace ambiguous rather than running it in main", async () => {
      mockProjectViews.set(WORKSPACE, [makeWebContents(1), makeWebContents(2)]);

      const err = await bridge
        .dispatchActionForWorkspace(WORKSPACE, "terminal.new", {})
        .catch((e: unknown) => e);

      expect((err as WorkspaceBindingError).reason).toBe("ambiguous");
      expect(viewless.runViewlessAction).not.toHaveBeenCalled();
    });
  });

  describe("with a local view attached and no lease installed", () => {
    it("dispatches to the view exactly as before, never in main", async () => {
      const wc = makeWebContents(7, (channel, payload) => {
        if (channel !== CHANNELS.MCP_SERVER_DISPATCH_ACTION_REQUEST) return;
        queueMicrotask(() =>
          mockIpcMain.emit(
            CHANNELS.MCP_SERVER_DISPATCH_ACTION_RESPONSE,
            { sender: { id: 7 } },
            { requestId: payload.requestId, result: { ok: true, result: "from-view" } }
          )
        );
      });
      mockWebContentsRegistry.set(7, wc);
      mockProjectViews.set(WORKSPACE, [wc]);

      const envelope = await bridge.dispatchActionForWorkspace(WORKSPACE, "terminal.new", {});

      expect(envelope.result).toEqual({ ok: true, result: "from-view" });
      expect(viewless.runViewlessAction).not.toHaveBeenCalled();
    });
  });

  describe("with a drive lease", () => {
    it("dispatches to a remote driver through endpoint.request, never a local view", async () => {
      const localView = makeWebContents(3);
      mockWebContentsRegistry.set(3, localView);
      mockProjectViews.set(WORKSPACE, [localView]);
      const endpoint = makeRemoteEndpoint(async () => ({
        result: { ok: true, result: { terminalId: "t-remote" } },
        confirmationDecision: "approved",
        approvalScope: "session",
      }));
      setMcpDriveTargetResolver((projectId) =>
        projectId === WORKSPACE ? { state: "live", endpoint } : { state: "vacant" }
      );

      const envelope = await bridge.dispatchActionForWorkspace(
        WORKSPACE,
        "terminal.new",
        { cwd: "/repo" },
        true,
        "external",
        // This machine's pane: the driver's view has no such terminal to name.
        { offerSessionApproval: true, requester: { kind: "pane", terminalId: "t-local" } }
      );

      expect(endpoint.request).toHaveBeenCalledWith(
        MCP_DISPATCH_ACTION_METHOD,
        expect.objectContaining({
          actionId: "terminal.new",
          args: { cwd: "/repo" },
          confirmed: true,
          sessionOrigin: "external",
          offerSessionApproval: true,
        }),
        expect.objectContaining({ timeoutMs: expect.any(Number) })
      );
      const [, payload] = vi.mocked(endpoint.request).mock.calls[0];
      expect(payload).not.toHaveProperty("requestId");
      expect(payload).not.toHaveProperty("requester");
      expect(localView.send).not.toHaveBeenCalled();
      expect(envelope).toMatchObject({
        result: { ok: true, result: { terminalId: "t-remote" } },
        confirmationDecision: "approved",
        approvalScope: "session",
        dispatchedWorkspace: { workspaceId: WORKSPACE },
      });
      expect(viewless.runViewlessAction).not.toHaveBeenCalled();
    });

    describe("how long it waits on the driving view (#15699)", () => {
      // A Shell's own call, as `host.call` makes it, into that Shell's own driving view.
      const relayed = (holdUntil?: number) => ({
        ...(holdUntil !== undefined ? { holdUntil } : {}),
        relay: {
          linkSessionId: "shell-a",
          readOnly: false,
          call: { callId: "call-1", helpSessionId: "help-a" },
        },
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      function answeringEndpoint(): ClientEndpoint {
        return {
          ...makeRemoteEndpoint(async () => ({ result: { ok: true, result: null } })),
          endpointId: "remote:shell-a:view-1",
          linkSessionId: "shell-a",
        };
      }

      function sent(endpoint: ClientEndpoint) {
        const [, payload, options] = vi.mocked(endpoint.request).mock.calls[0] as [
          string,
          { holdBudgetMs?: number },
          { timeoutMs: number },
        ];
        return { budget: payload.holdBudgetMs, timeoutMs: options.timeoutMs };
      }

      async function dispatch(options: WorkspaceDispatchOptions) {
        return bridge.dispatchActionForWorkspace(
          WORKSPACE,
          "worktree.delete",
          { worktreeId: "/repo-wt/x" },
          false,
          "external",
          options
        );
      }

      it.each([
        ["a relayed call", relayed()],
        ["any other caller", {}],
      ])(
        "waits out a whole confirmation there for %s, and tells the view how long",
        async (_label, options) => {
          const endpoint = answeringEndpoint();
          setMcpDriveTargetResolver(() => ({ state: "live", endpoint }));

          await dispatch(options);

          const { budget, timeoutMs } = sent(endpoint);
          expect(budget).toBe(timeoutMs);
          // The view holds inside the budget less the trip back, which still fits a whole ask.
          expect(timeoutMs - MCP_REMOTE_CONFIRM_MARGIN_MS).toBeGreaterThanOrEqual(
            MCP_CONFIRM_ASK_MAX_MS
          );
        }
      );

      it("fits inside the relayed call's own deadline", async () => {
        vi.useFakeTimers();
        const endpoint = answeringEndpoint();
        setMcpDriveTargetResolver(() => ({ state: "live", endpoint }));

        await dispatch(relayed(Date.now() + 100_000));

        expect(sent(endpoint)).toEqual({ budget: 100_000, timeoutMs: 100_000 });
      });

      it("sends a whole number of milliseconds, so the view can read it", async () => {
        vi.useFakeTimers();
        const endpoint = answeringEndpoint();
        setMcpDriveTargetResolver(() => ({ state: "live", endpoint }));

        await dispatch(relayed(Date.now() + 100_000.75));

        expect(sent(endpoint)).toEqual({ budget: 100_000, timeoutMs: 100_000 });
      });

      it("keeps the whole confirmation when the call's deadline is further off", async () => {
        vi.useFakeTimers();
        const endpoint = answeringEndpoint();
        setMcpDriveTargetResolver(() => ({ state: "live", endpoint }));

        await dispatch(relayed(Date.now() + 2 * MCP_REMOTE_DISPATCH_TIMEOUT_MS));

        expect(sent(endpoint).timeoutMs).toBe(MCP_REMOTE_DISPATCH_TIMEOUT_MS);
      });

      it("sends nothing an older Shell's plain hold could outlast", async () => {
        vi.useFakeTimers();
        const endpoint = answeringEndpoint();
        setMcpDriveTargetResolver(() => ({ state: "live", endpoint }));
        // An older Shell ignores the budget and holds the plain deadline, whatever it is told.
        const leastSent = MCP_DISPATCH_TIMEOUT_MS + MCP_REMOTE_CONFIRM_MARGIN_MS;

        await expect(dispatch(relayed(Date.now() + leastSent - 1))).rejects.toThrow(/timed out/);
        expect(endpoint.request).not.toHaveBeenCalled();

        await dispatch(relayed(Date.now() + leastSent));
        expect(sent(endpoint).timeoutMs).toBe(leastSent);
      });
    });

    it("reports a driver that left mid-request as a lost, retriable route", async () => {
      const endpoint = makeRemoteEndpoint(async () => {
        throw Object.assign(new Error("gone"), { code: "HOST_DISCONNECTED" });
      });
      setMcpDriveTargetResolver(() => ({ state: "live", endpoint }));

      const err = await bridge
        .dispatchActionForWorkspace(WORKSPACE, "terminal.new", {})
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(WorkspaceBindingError);
      expect(err).not.toBeInstanceOf(NoFrontendAttachedError);
      expect((err as WorkspaceBindingError).retriable).toBe(true);
    });

    it("rejects a malformed answer rather than inventing a result", async () => {
      setMcpDriveTargetResolver(() => ({
        state: "live",
        endpoint: makeRemoteEndpoint(async () => ({ ok: true })),
      }));

      await expect(
        bridge.dispatchActionForWorkspace(WORKSPACE, "terminal.new", {})
      ).rejects.toThrow(/Malformed answer/);
    });

    it("fetches and caches a remote driver's manifest", async () => {
      const manifest = [{ id: "terminal.new" }] as unknown as ActionManifestEntry[];
      const endpoint = makeRemoteEndpoint(async () => manifest);
      setMcpDriveTargetResolver(() => ({ state: "live", endpoint }));

      expect(bridge.getCachedManifestForWorkspace(WORKSPACE)).toBeNull();
      await expect(bridge.requestManifestForWorkspace(WORKSPACE)).resolves.toBe(manifest);

      expect(endpoint.request).toHaveBeenCalledWith(
        MCP_GET_MANIFEST_METHOD,
        {},
        expect.objectContaining({ timeoutMs: expect.any(Number) })
      );
      expect(bridge.getCachedManifestForWorkspace(WORKSPACE)).toBe(manifest);
      // The same endpoint driving another project never serves this one's manifest.
      expect(bridge.getCachedManifestForWorkspace("ws-other")).toBeNull();
      bridge.clearCache();
      expect(bridge.getCachedManifestForWorkspace(WORKSPACE)).toBeNull();
    });

    it("prefers the local view the lease names when the workspace is open twice", async () => {
      const other = makeWebContents(1);
      const driver = makeWebContents(2, (channel, payload) => {
        if (channel !== CHANNELS.MCP_SERVER_DISPATCH_ACTION_REQUEST) return;
        queueMicrotask(() =>
          mockIpcMain.emit(
            CHANNELS.MCP_SERVER_DISPATCH_ACTION_RESPONSE,
            { sender: { id: 2 } },
            { requestId: payload.requestId, result: { ok: true, result: "driver" } }
          )
        );
      });
      mockWebContentsRegistry.set(1, other);
      mockWebContentsRegistry.set(2, driver);
      mockProjectViews.set(WORKSPACE, [other, driver]);
      setMcpDriveTargetResolver(() => ({
        state: "live",
        endpoint: { ...makeRemoteEndpoint(async () => null), kind: "local-view", handle: 2 },
      }));

      const envelope = await bridge.dispatchActionForWorkspace(WORKSPACE, "terminal.list", {});
      await flush();

      expect(envelope.result).toEqual({ ok: true, result: "driver" });
      expect(other.send).not.toHaveBeenCalled();
    });

    it("falls back to local resolution when the lease names nobody", async () => {
      setMcpDriveTargetResolver(() => ({ state: "vacant" }));
      viewless.runViewlessAction.mockResolvedValue({ ok: true, result: { terminalId: "t" } });

      const envelope = await bridge.dispatchActionForWorkspace(WORKSPACE, "terminal.new", {});

      expect(envelope.result.ok).toBe(true);
      expect(viewless.runViewlessAction).toHaveBeenCalledTimes(1);
    });

    describe("whose holder cannot be reached", () => {
      const localView = makeWebContents(3);

      beforeEach(() => {
        localView.send.mockClear();
        mockWebContentsRegistry.set(3, localView);
        mockProjectViews.set(WORKSPACE, [localView]);
      });

      async function expectRetriableRefusal(): Promise<void> {
        const err = await bridge
          .dispatchActionForWorkspace(WORKSPACE, "terminal.new", {})
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(DriveHolderUnavailableError);
        expect((err as DriveHolderUnavailableError).retriable).toBe(true);
        await expect(bridge.requestManifestForWorkspace(WORKSPACE)).rejects.toBeInstanceOf(
          DriveHolderUnavailableError
        );
        expect(bridge.getCachedManifestForWorkspace(WORKSPACE)).toBeNull();
        // Neither another renderer nor main acts for a holder that is away.
        expect(localView.send).not.toHaveBeenCalled();
        expect(viewless.runViewlessAction).not.toHaveBeenCalled();
      }

      it("refuses retriably while the lease holds a place for it", async () => {
        setMcpDriveTargetResolver(() => ({ state: "unavailable", reason: "reserved" }));
        await expectRetriableRefusal();
      });

      it("refuses retriably when the named driver has already closed", async () => {
        setMcpDriveTargetResolver(() => ({
          state: "live",
          endpoint: { ...makeRemoteEndpoint(async () => null), isClosed: () => true },
        }));
        await expectRetriableRefusal();
      });

      it("refuses retriably when the lease cannot be read, never routing the old way", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        setMcpDriveTargetResolver(() => {
          throw new Error("lease broke");
        });
        await expectRetriableRefusal();
      });
    });
  });
});

const PROJECT = "proj-1";
const HANDLE = -7;

function makeClosableRemoteEndpoint(request: ClientEndpoint["request"]) {
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
    const endpoint = makeClosableRemoteEndpoint(async () => ({ result: { ok: true, result: 42 } }));
    getEndpointRegistry().add(endpoint);
    const context = { activeWorktreeId: "wt-1" } as never;

    const envelope = await bridge.dispatchActionForWebContents(
      HANDLE,
      "worktree.list",
      { a: 1 },
      false,
      context,
      "help",
      // This machine's Assistant tab: the remote view has no such lane to name.
      { requester: { kind: "assistant", helpSessionId: "help-local" } }
    );

    expect(envelope.result).toEqual({ ok: true, result: 42 });
    expect(endpoint.request).toHaveBeenCalledWith(
      MCP_DISPATCH_ACTION_METHOD,
      expect.objectContaining({ actionId: "worktree.list", args: { a: 1 }, context }),
      expect.any(Object)
    );
    const [, payload] = vi.mocked(endpoint.request).mock.calls[0];
    expect(payload).not.toHaveProperty("requester");
    expect(pendingDispatches.size).toBe(0);
  });

  it("reads and caches the pinned view's manifest, evicted when its endpoint closes", async () => {
    const manifest = [{ id: "worktree.list" }];
    const endpoint = makeClosableRemoteEndpoint(async (method) =>
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

    const endpoint = makeClosableRemoteEndpoint(async () => {
      throw Object.assign(new Error("gone"), { code: "HOST_DISCONNECTED" });
    });
    getEndpointRegistry().add(endpoint);
    await expect(
      bridge.dispatchActionForWebContents(HANDLE, "worktree.list", {})
    ).rejects.toBeInstanceOf(SessionBindingError);
  });
});

describe("rendererBridge — relayed calls (#13493)", () => {
  let bridge: ReturnType<typeof createRendererBridge>;

  function ownEndpoint(sessionId: string): ClientEndpoint {
    return {
      ...makeRemoteEndpoint(async () => ({ result: { ok: true, result: { ran: true } } })),
      endpointId: `remote:${sessionId}:view-1`,
      linkSessionId: sessionId,
    };
  }

  beforeEach(() => {
    mockIpcMain.removeAllListeners();
    mockWebContentsRegistry.clear();
    mockProjectViews.clear();
    _resetMcpDriveTargetResolverForTesting();
    viewless.runViewlessAction.mockReset();
    viewless.describeViewlessWorkspace.mockReset().mockResolvedValue(undefined);
    viewless.hasViewlessImplementation.mockReset().mockReturnValue(true);
    bridge = createRendererBridge(new Map(), new Map(), () => null);
    bridge.setupListeners([]);
  });

  afterEach(() => {
    _resetMcpDriveTargetResolverForTesting();
  });

  const write = { relay: { linkSessionId: "shell-a", readOnly: false } };
  const read = { relay: { linkSessionId: "shell-a", readOnly: true } };

  it("runs a change in the requesting Shell's own driving view, saying it was relayed", async () => {
    const endpoint = ownEndpoint("shell-a");
    setMcpDriveTargetResolver(() => ({ state: "live", endpoint, holderName: "greg-mbp" }));

    const envelope = await bridge.dispatchActionForWorkspace(
      WORKSPACE,
      "agent.launch",
      { agentId: "claude" },
      false,
      "external",
      write
    );

    expect(envelope.result).toEqual({ ok: true, result: { ran: true } });
    expect(endpoint.request).toHaveBeenCalledWith(
      MCP_DISPATCH_ACTION_METHOD,
      expect.objectContaining({ actionId: "agent.launch", confirmed: false, relayed: true }),
      expect.anything()
    );
  });

  it("refuses a change where another machine drives, naming it, and runs nothing", async () => {
    const other = ownEndpoint("shell-b");
    setMcpDriveTargetResolver(() => ({ state: "live", endpoint: other, holderName: "studio-02" }));

    const err = await bridge
      .dispatchActionForWorkspace(WORKSPACE, "agent.launch", {}, false, "external", write)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RelayDrivenElsewhereError);
    expect((err as RelayDrivenElsewhereError).code).toBe("DRIVEN_ELSEWHERE");
    expect((err as Error).message).toContain("studio-02");
    expect(other.request).not.toHaveBeenCalled();
  });

  it("runs a change on the host as the Shell while nobody drives the project (#13501)", async () => {
    setMcpDriveTargetResolver(() => ({ state: "vacant" }));
    viewless.runViewlessAction.mockResolvedValue({ ok: true, result: { terminalId: "t-1" } });

    const envelope = await bridge.dispatchActionForWorkspace(
      WORKSPACE,
      "terminal.new",
      {},
      false,
      "external",
      write
    );

    expect(envelope.result).toEqual({ ok: true, result: { terminalId: "t-1" } });
    const [request] = viewless.runViewlessAction.mock.calls[0] as [
      { checkWrite?: (changed: boolean) => Error | null },
    ];
    expect(request.checkWrite?.(false)).toBeNull();
  });

  it("tells the lease of each change it runs for a caller on this machine, refusing none (#15918)", async () => {
    const asked: unknown[] = [];
    setMcpDriveTargetResolver((projectId, change) => {
      if (change) asked.push([projectId, change]);
      return { state: "vacant" };
    });
    viewless.runViewlessAction.mockResolvedValue({ ok: true, result: { terminalId: "t-1" } });

    await bridge.dispatchActionForWorkspace(WORKSPACE, "terminal.new", {});

    const [request] = viewless.runViewlessAction.mock.calls[0] as [
      { checkWrite: (changed: boolean) => Error | null },
    ];
    expect(asked).toEqual([]);
    expect(request.checkWrite(true)).toBeNull();
    expect(asked).toEqual([[WORKSPACE, { linkSessionId: null }]]);
  });

  it("never sends a change into a window here that only shows the project", async () => {
    setMcpDriveTargetResolver(() => ({ state: "vacant" }));
    const view = makeWebContents(7);
    mockWebContentsRegistry.set(7, view);
    mockProjectViews.set(WORKSPACE, [view]);
    viewless.runViewlessAction.mockResolvedValue({ ok: true, result: {} });

    await bridge.dispatchActionForWorkspace(
      WORKSPACE,
      "terminal.new",
      {},
      false,
      "external",
      write
    );

    expect(view.send).not.toHaveBeenCalled();
    expect(viewless.runViewlessAction).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["change", { relay: { linkSessionId: "shell-a", readOnly: false } }],
    ["read", { relay: { linkSessionId: "shell-a", readOnly: true } }],
  ] as const)(
    "says no frontend is attached for a relayed %s nobody drives or shows that the host has no form of",
    async (_kind, options) => {
      setMcpDriveTargetResolver(() => ({ state: "vacant" }));
      viewless.hasViewlessImplementation.mockReturnValue(false);

      const err = await bridge
        .dispatchActionForWorkspace(
          WORKSPACE,
          "git.getProjectPulse",
          {},
          false,
          "external",
          options
        )
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(NoFrontendAttachedError);
      expect((err as NoFrontendAttachedError).actionId).toBe("git.getProjectPulse");
      expect(viewless.runViewlessAction).not.toHaveBeenCalled();
    }
  );

  it("refuses a change nobody drives that only a window here showing the project could run", async () => {
    setMcpDriveTargetResolver(() => ({ state: "vacant" }));
    viewless.hasViewlessImplementation.mockReturnValue(false);
    const view = makeWebContents(7);
    mockWebContentsRegistry.set(7, view);
    mockProjectViews.set(WORKSPACE, [view]);

    const err = await bridge
      .dispatchActionForWorkspace(WORKSPACE, "terminal.moveToDock", {}, false, "external", write)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RelayDrivenElsewhereError);
    expect((err as RelayDrivenElsewhereError).holderName).toBeNull();
    expect(view.send).not.toHaveBeenCalled();
    expect(viewless.runViewlessAction).not.toHaveBeenCalled();
  });

  it("hands the host's run a write check that stops it once someone else takes the project", async () => {
    let target: Parameters<typeof setMcpDriveTargetResolver>[0] = () => ({ state: "vacant" });
    setMcpDriveTargetResolver((projectId) => target!(projectId));
    viewless.runViewlessAction.mockResolvedValue({ ok: true, result: { terminals: [] } });

    await bridge.dispatchActionForWorkspace(
      WORKSPACE,
      "terminal.list",
      {},
      false,
      "external",
      read
    );

    const [request] = viewless.runViewlessAction.mock.calls[0] as [
      { checkWrite: (changed: boolean) => Error | null },
    ];
    expect(request.checkWrite(false)).toBeNull();

    // The requesting Shell's own view taking it over is no reason to stop.
    target = () => ({ state: "live", endpoint: ownEndpoint("shell-a"), holderName: "greg-mbp" });
    expect(request.checkWrite(true)).toBeNull();

    target = () => ({ state: "live", endpoint: ownEndpoint("shell-b"), holderName: "studio-02" });
    const before = request.checkWrite(false);
    expect(before).toBeInstanceOf(RelayDrivenElsewhereError);
    expect((before as Error).message).toContain("studio-02 has control");
    expect((before as Error).message).toContain("Nothing was run");
    const after = request.checkWrite(true);
    expect(after).toBeInstanceOf(RelayDrivenElsewhereError);
    expect((after as Error).message).toContain("studio-02 took control");
    expect((after as Error).message).toContain("Part of it may already have run");

    target = () => ({ state: "unavailable", reason: "reserved" });
    expect(request.checkWrite(false)).toBeInstanceOf(DriveHolderUnavailableError);
    expect(request.checkWrite(true)).toBeInstanceOf(RelayDrivenElsewhereError);
  });

  it("asks the requesting Shell about a confirm-gated change, and reports what it decided", async () => {
    setMcpDriveTargetResolver(() => ({ state: "vacant" }));
    const requestApproval = vi.fn(async () => ({ decision: "rejected" as const }));
    viewless.runViewlessAction.mockImplementation(
      async (request: { requestApproval?: (ask: unknown) => Promise<unknown> }) => {
        await request.requestApproval?.({ actionId: "worktree.delete", args: {}, lines: [] });
        return { ok: false, error: { code: "USER_REJECTED", message: "User rejected" } };
      }
    );

    const envelope = await bridge.dispatchActionForWorkspace(
      WORKSPACE,
      "worktree.delete",
      { worktreeId: "/repo-wt/x" },
      false,
      "external",
      { relay: { ...write.relay, requestApproval } }
    );

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(envelope.confirmationDecision).toBe("rejected");
  });

  it("reports the Shell's own Never ask as the skip it is, not anyone's decision (#15698)", async () => {
    setMcpDriveTargetResolver(() => ({ state: "vacant" }));
    const skipped = {
      decision: "approved" as const,
      deadline: Date.now() + 40_000,
      authorization: "skip-preference" as const,
    };
    const requestApproval = vi.fn(async () => skipped);
    let executorSaw: unknown;
    viewless.runViewlessAction.mockImplementation(
      async (request: { requestApproval?: (ask: unknown) => Promise<unknown> }) => {
        executorSaw = await request.requestApproval?.({
          actionId: "worktree.delete",
          args: {},
          lines: [],
        });
        return { ok: true, result: { deleted: true } };
      }
    );

    const envelope = await bridge.dispatchActionForWorkspace(
      WORKSPACE,
      "worktree.delete",
      { worktreeId: "/repo-wt/x" },
      false,
      "external",
      { relay: { ...write.relay, requestApproval } }
    );

    // The executor runs under the answer as it would an approval.
    expect(executorSaw).toEqual(skipped);
    expect(envelope.confirmationDecision).toBeUndefined();
    expect(envelope.authorization).toBe("skip-preference");
  });

  it("names the Shell's own call to its driving view, and reads back a skip it granted (#15698)", async () => {
    const endpoint: ClientEndpoint = {
      ...ownEndpoint("shell-a"),
      request: vi
        .fn()
        .mockResolvedValueOnce({
          result: { ok: true, result: { ran: true } },
          authorization: "skip-preference",
        })
        .mockResolvedValueOnce({ result: { ok: true, result: { ran: true } } }),
    };
    setMcpDriveTargetResolver(() => ({ state: "live", endpoint, holderName: "greg-mbp" }));
    const call = { callId: "call-1", helpSessionId: "help-a" };

    const envelope = await bridge.dispatchActionForWorkspace(
      WORKSPACE,
      "worktree.delete",
      { worktreeId: "/repo-wt/x" },
      false,
      "external",
      { relay: { ...write.relay, call } }
    );

    expect(endpoint.request).toHaveBeenCalledWith(
      MCP_DISPATCH_ACTION_METHOD,
      expect.objectContaining({ confirmed: false, relayed: true, relayCall: call }),
      expect.anything()
    );
    expect(envelope.authorization).toBe("skip-preference");

    // An answer that says no skip is read as none.
    const plain = await bridge.dispatchActionForWorkspace(
      WORKSPACE,
      "worktree.delete",
      { worktreeId: "/repo-wt/x" },
      false,
      "external",
      { relay: { ...write.relay, call } }
    );
    expect(plain).not.toHaveProperty("authorization");
  });

  it("keeps a decision over a skip the same answer claims", async () => {
    const endpoint: ClientEndpoint = {
      ...ownEndpoint("shell-a"),
      request: vi.fn(async () => ({
        result: { ok: true, result: { ran: true } },
        confirmationDecision: "approved",
        authorization: "skip-preference",
      })),
    };
    setMcpDriveTargetResolver(() => ({ state: "live", endpoint, holderName: "greg-mbp" }));

    const envelope = await bridge.dispatchActionForWorkspace(
      WORKSPACE,
      "worktree.delete",
      { worktreeId: "/repo-wt/x" },
      false,
      "external",
      write
    );

    expect(envelope.confirmationDecision).toBe("approved");
    expect(envelope.authorization).toBeUndefined();
    expect(endpoint.request).toHaveBeenCalledWith(
      MCP_DISPATCH_ACTION_METHOD,
      expect.not.objectContaining({ relayCall: expect.anything() }),
      expect.anything()
    );
  });

  it("lets a read through wherever the project is driven", async () => {
    const other = ownEndpoint("shell-b");
    setMcpDriveTargetResolver(() => ({ state: "live", endpoint: other, holderName: "studio-02" }));

    const envelope = await bridge.dispatchActionForWorkspace(
      WORKSPACE,
      "terminal.list",
      {},
      false,
      "external",
      read
    );

    expect(envelope.result).toEqual({ ok: true, result: { ran: true } });
  });
});

describe("rendererBridge — terminals the host started while a window shows the project (#14473)", () => {
  let bridge: ReturnType<typeof createRendererBridge>;
  const read = { relay: { linkSessionId: "shell-a", readOnly: true } };

  function viewAnswering(result: unknown, ok = true) {
    const wc = makeWebContents(7, (channel, payload) => {
      if (channel !== CHANNELS.MCP_SERVER_DISPATCH_ACTION_REQUEST) return;
      queueMicrotask(() =>
        mockIpcMain.emit(
          CHANNELS.MCP_SERVER_DISPATCH_ACTION_RESPONSE,
          { sender: { id: 7 } },
          {
            requestId: payload.requestId,
            result: ok ? { ok: true, result } : { ok: false, error: result },
          }
        )
      );
    });
    mockWebContentsRegistry.set(7, wc);
    mockProjectViews.set(WORKSPACE, [wc]);
  }

  const startedIds = () => hostStartedTerminals(WORKSPACE).map((terminal) => terminal.id);
  const panelLimit = { count: 1, softWarningLimit: 10 };
  const viewRow = { id: "view-pane", kind: "terminal", location: "grid", isFocused: true };
  const hostRow = { id: "host-agent", kind: "terminal", location: "grid", isFocused: false };
  const status = (terminalId: string, agentState: string | null, error?: string) => ({
    terminalId,
    agentId: null,
    agentState,
    ...(error !== undefined ? { error } : {}),
  });
  const viewStatus = (entries: unknown[]) => ({
    terminals: entries,
    source: "renderer",
    unavailableFields: [],
  });
  const ptyStatus = (entries: unknown[]) => ({
    ok: true,
    result: { terminals: entries, source: "pty", unavailableFields: ["armed"] },
  });

  beforeEach(() => {
    mockIpcMain.removeAllListeners();
    mockWebContentsRegistry.clear();
    mockProjectViews.clear();
    _resetMcpDriveTargetResolverForTesting();
    _resetHostStartedTerminalsForTesting();
    viewless.runViewlessAction.mockReset();
    viewless.describeViewlessWorkspace.mockReset().mockResolvedValue(undefined);
    viewless.hasViewlessImplementation.mockReset().mockReturnValue(true);
    setMcpDriveTargetResolver(() => ({ state: "vacant" }));
    bridge = createRendererBridge(new Map(), new Map(), () => null);
    bridge.setupListeners([]);
  });

  afterEach(() => {
    _resetMcpDriveTargetResolverForTesting();
    _resetHostStartedTerminalsForTesting();
  });

  it.each([
    ["a vacant lease", true],
    ["no lease installed", false],
  ])("adds a host-started terminal the view's list leaves out, under %s", async (_name, leased) => {
    if (!leased) _resetMcpDriveTargetResolverForTesting();
    noteHostStartedTerminal(WORKSPACE, "host-agent", { worktreeId: "/repo" });
    viewAnswering({ terminals: [viewRow], panelLimit });
    viewless.runViewlessAction.mockResolvedValue({
      ok: true,
      result: {
        terminals: [
          { ...viewRow, isFocused: false },
          hostRow,
          { id: "never-started-here", kind: "terminal", location: "grid" },
        ],
      },
    });

    const args = { worktreeId: "/repo" };
    const envelope = await bridge.dispatchActionForWorkspace(
      WORKSPACE,
      "terminal.list",
      args,
      false,
      "external",
      read
    );

    expect(envelope.result).toEqual({
      ok: true,
      result: { terminals: [viewRow, hostRow], panelLimit },
    });
    expect(viewless.runViewlessAction).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE, actionId: "terminal.list", args })
    );
  });

  it("reads a pane the view's filters leave out not at all", async () => {
    noteHostStartedTerminal(WORKSPACE, "parked", { location: "background", worktreeId: "/repo" });
    noteHostStartedTerminal(WORKSPACE, "elsewhere", { worktreeId: "/other" });
    viewAnswering({ terminals: [viewRow], panelLimit });

    await bridge.dispatchActionForWorkspace(WORKSPACE, "terminal.list", { worktreeId: "/repo" });

    expect(viewless.runViewlessAction).not.toHaveBeenCalled();
    expect(startedIds()).toEqual(["parked", "elsewhere"]);
  });

  it("finds a parked pane when the caller asks for the background", async () => {
    noteHostStartedTerminal(WORKSPACE, "parked", { location: "background" });
    viewAnswering({ terminals: [], panelLimit });
    const parkedRow = { ...hostRow, id: "parked", location: "background" };
    viewless.runViewlessAction.mockResolvedValue({ ok: true, result: { terminals: [parkedRow] } });

    const envelope = await bridge.dispatchActionForWorkspace(WORKSPACE, "terminal.list", {
      location: "background",
    });

    expect(envelope.result).toEqual({ ok: true, result: { terminals: [parkedRow], panelLimit } });
  });

  it("finds parked and gridded panes alike when the caller asks for every location (#15732)", async () => {
    noteHostStartedTerminal(WORKSPACE, "parked", { location: "background", worktreeId: "/repo" });
    noteHostStartedTerminal(WORKSPACE, "host-agent", { worktreeId: "/repo" });
    noteHostStartedTerminal(WORKSPACE, "elsewhere", { worktreeId: "/other" });
    viewAnswering({ terminals: [], panelLimit });
    const parkedRow = { ...hostRow, id: "parked", location: "background" };
    viewless.runViewlessAction.mockResolvedValue({
      ok: true,
      result: { terminals: [parkedRow, hostRow] },
    });

    const args = { worktreeId: "/repo", location: "all" };
    const envelope = await bridge.dispatchActionForWorkspace(WORKSPACE, "terminal.list", args);

    expect(envelope.result).toEqual({
      ok: true,
      result: { terminals: [parkedRow, hostRow], panelLimit },
    });
    expect(viewless.runViewlessAction).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: "terminal.list", args })
    );
  });

  it("answers status from the pty-host, whole and labelled so, once a named terminal is only there", async () => {
    noteHostStartedTerminal(WORKSPACE, "host-agent", {});
    viewAnswering(
      viewStatus([
        { ...status("view-pane", "idle"), armed: true },
        status("host-agent", null, "Terminal not found"),
        status("hidden-pane", null, "Terminal not found"),
      ])
    );
    viewless.runViewlessAction.mockResolvedValue(
      ptyStatus([
        status("view-pane", "idle"),
        { ...status("host-agent", "working"), agentId: "claude" },
        status("hidden-pane", "working"),
      ])
    );

    const args = { terminalIds: ["view-pane", "host-agent", "hidden-pane"] };
    const envelope = await bridge.dispatchActionForWorkspace(
      WORKSPACE,
      "terminal.getStatus",
      args,
      false,
      "external",
      read
    );

    // A pane the view hides stays hidden: only what it showed and the host started is read here.
    expect(envelope.result).toEqual(
      ptyStatus([
        status("view-pane", "idle"),
        { ...status("host-agent", "working"), agentId: "claude" },
        status("hidden-pane", null, "Terminal not found"),
      ])
    );
    expect(viewless.runViewlessAction).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: "terminal.getStatus", args })
    );
  });

  it("answers the fleet from the pty-host, without panes the view hides", async () => {
    noteHostStartedTerminal(WORKSPACE, "host-agent", {});
    viewAnswering(viewStatus([status("view-pane", "idle")]));
    viewless.runViewlessAction.mockResolvedValue(
      ptyStatus([
        status("view-pane", "idle"),
        status("hidden-pane", "working"),
        status("host-agent", "working"),
      ])
    );

    const envelope = await bridge.dispatchActionForWorkspace(WORKSPACE, "terminal.getStatus", {});

    expect(envelope.result).toEqual(
      ptyStatus([status("view-pane", "idle"), status("host-agent", "working")])
    );
  });

  it("keeps the view's status when the pty-host doesn't have the named terminal either", async () => {
    noteHostStartedTerminal(WORKSPACE, "host-agent", {});
    const fromView = viewStatus([status("host-agent", null, "Terminal not found")]);
    viewAnswering(fromView);
    viewless.runViewlessAction.mockResolvedValue(
      ptyStatus([status("host-agent", null, "Terminal not found or status unavailable")])
    );

    const envelope = await bridge.dispatchActionForWorkspace(WORKSPACE, "terminal.getStatus", {
      terminalIds: ["host-agent"],
    });

    expect(envelope.result).toEqual({ ok: true, result: fromView });
  });

  it("replaces the answer for a host-started terminal whose read carries another error", async () => {
    noteHostStartedTerminal(WORKSPACE, "host-agent", {});
    viewAnswering(viewStatus([status("host-agent", null, "Terminal not found")]));
    const fromPty = ptyStatus([status("host-agent", "working", "Failed to fetch terminal output")]);
    viewless.runViewlessAction.mockResolvedValue(fromPty);

    const envelope = await bridge.dispatchActionForWorkspace(WORKSPACE, "terminal.getStatus", {
      terminalIds: ["host-agent"],
    });

    expect(envelope.result).toEqual(fromPty);
  });

  it("leaves the view to answer for a pane it was seen holding, even when filtered out later", async () => {
    noteHostStartedTerminal(WORKSPACE, "adopted", {});
    viewAnswering(viewStatus([status("adopted", "idle", "Failed to fetch terminal output")]));
    await bridge.dispatchActionForWorkspace(WORKSPACE, "terminal.getStatus", {
      terminalIds: ["adopted"],
    });

    viewAnswering(viewStatus([]));
    await bridge.dispatchActionForWorkspace(WORKSPACE, "terminal.getStatus", {});

    expect(viewless.runViewlessAction).not.toHaveBeenCalled();
    expect(startedIds()).toEqual(["adopted"]);
  });

  it("still reads it for another view that never adopted it", async () => {
    noteHostStartedTerminal(WORKSPACE, "host-agent", {});
    viewAnswering(viewStatus([status("host-agent", "idle")]));
    await bridge.dispatchActionForWorkspace(WORKSPACE, "terminal.getStatus", {});

    const other = makeWebContents(8, (channel, payload) => {
      if (channel !== CHANNELS.MCP_SERVER_DISPATCH_ACTION_REQUEST) return;
      queueMicrotask(() =>
        mockIpcMain.emit(
          CHANNELS.MCP_SERVER_DISPATCH_ACTION_RESPONSE,
          { sender: { id: 8 } },
          { requestId: payload.requestId, result: { ok: true, result: viewStatus([]) } }
        )
      );
    });
    mockWebContentsRegistry.set(8, other);
    mockProjectViews.set(WORKSPACE, [other]);
    const fromPty = ptyStatus([status("host-agent", "working")]);
    viewless.runViewlessAction.mockResolvedValue(fromPty);

    const envelope = await bridge.dispatchActionForWebContents(8, "terminal.getStatus", {});

    expect(envelope.result).toEqual(fromPty);
  });

  it("never takes a read as a terminal being gone: a failed read is worded the same", async () => {
    noteHostStartedTerminal(WORKSPACE, "host-agent", {});
    viewAnswering(viewStatus([status("host-agent", null, "Terminal not found")]));
    viewless.runViewlessAction.mockResolvedValue(
      ptyStatus([status("host-agent", null, "Terminal not found or status unavailable")])
    );

    await bridge.dispatchActionForWorkspace(WORKSPACE, "terminal.getStatus", {
      terminalIds: ["host-agent"],
    });
    await bridge.dispatchActionForWorkspace(WORKSPACE, "terminal.getStatus", {});

    expect(startedIds()).toEqual(["host-agent"]);
    expect(viewless.runViewlessAction).toHaveBeenCalledTimes(2);
  });

  it("finds a docked launch under a dock filter, and in the default fleet", async () => {
    noteHostStartedTerminal(WORKSPACE, "docked", { location: "dock" });
    viewAnswering(viewStatus([]));
    const fromPty = ptyStatus([status("docked", "working")]);
    viewless.runViewlessAction.mockResolvedValue(fromPty);

    const filtered = await bridge.dispatchActionForWorkspace(WORKSPACE, "terminal.getStatus", {
      location: "dock",
    });
    const fleet = await bridge.dispatchActionForWorkspace(WORKSPACE, "terminal.getStatus", {});
    await bridge.dispatchActionForWorkspace(WORKSPACE, "terminal.getStatus", { location: "grid" });

    expect(filtered.result).toEqual(fromPty);
    expect(fleet.result).toEqual(fromPty);
    expect(viewless.runViewlessAction).toHaveBeenCalledTimes(2);
  });

  it("reads a parked launch into a fleet read of every location (#15732)", async () => {
    noteHostStartedTerminal(WORKSPACE, "parked", { location: "background" });
    viewAnswering(viewStatus([]));
    const fromPty = ptyStatus([status("parked", "working")]);
    viewless.runViewlessAction.mockResolvedValue(fromPty);

    const fleet = await bridge.dispatchActionForWorkspace(WORKSPACE, "terminal.getStatus", {});
    const every = await bridge.dispatchActionForWorkspace(WORKSPACE, "terminal.getStatus", {
      location: "all",
    });

    expect(fleet.result).toEqual({ ok: true, result: viewStatus([]) });
    expect(every.result).toEqual(fromPty);
    expect(viewless.runViewlessAction).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the view's answer failed", () => viewAnswering("boom", false), undefined],
    [
      "the pty-host read failed",
      () => viewAnswering({ terminals: [], panelLimit }),
      () => viewless.runViewlessAction.mockRejectedValue(new Error("shard down")),
    ],
    [
      "the pty-host refused",
      () => viewAnswering({ terminals: [], panelLimit }),
      () => viewless.runViewlessAction.mockResolvedValue({ ok: false, error: {} }),
    ],
  ])("keeps the view's answer when %s", async (_name, arrangeView, arrangePty) => {
    noteHostStartedTerminal(WORKSPACE, "host-agent", {});
    arrangeView();
    arrangePty?.();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const envelope = await bridge.dispatchActionForWorkspace(WORKSPACE, "terminal.list", {});

    expect(envelope.result).toEqual(
      arrangePty ? { ok: true, result: { terminals: [], panelLimit } } : expect.anything()
    );
    if (!arrangePty) expect(viewless.runViewlessAction).not.toHaveBeenCalled();
    expect(startedIds()).toEqual(["host-agent"]);
    warn.mockRestore();
  });

  it("reads nothing for an approval request", async () => {
    noteHostStartedTerminal(WORKSPACE, "host-agent", {});
    viewAnswering({ terminals: [], panelLimit });

    await bridge.dispatchActionForWorkspace(WORKSPACE, "terminal.list", {}, false, "external", {
      approvalOnly: true,
    });

    expect(viewless.runViewlessAction).not.toHaveBeenCalled();
  });

  it("reads nothing more when the host started nothing, and the view's status stays its own", async () => {
    const fromView = viewStatus([status("view-pane", "idle")]);
    viewAnswering(fromView);

    const envelope = await bridge.dispatchActionForWorkspace(WORKSPACE, "terminal.getStatus", {});

    expect(envelope.result).toEqual({ ok: true, result: fromView });
    expect(viewless.runViewlessAction).not.toHaveBeenCalled();
  });
});

describe("rendererBridge — this machine's assistant in another of its projects (#14024)", () => {
  let bridge: ReturnType<typeof createRendererBridge>;

  /** A view of the project here that answers every dispatch with `answer`. */
  function localView(id: number, answer: unknown) {
    const wc = makeWebContents(id, (channel, payload) => {
      if (channel !== CHANNELS.MCP_SERVER_DISPATCH_ACTION_REQUEST) return;
      queueMicrotask(() =>
        mockIpcMain.emit(
          CHANNELS.MCP_SERVER_DISPATCH_ACTION_RESPONSE,
          { sender: { id } },
          { requestId: payload.requestId, result: answer }
        )
      );
    });
    mockWebContentsRegistry.set(id, wc);
    mockProjectViews.set(WORKSPACE, [wc]);
    return wc;
  }

  beforeEach(() => {
    mockIpcMain.removeAllListeners();
    mockWebContentsRegistry.clear();
    mockProjectViews.clear();
    _resetMcpDriveTargetResolverForTesting();
    viewless.runViewlessAction.mockReset();
    viewless.describeViewlessWorkspace.mockReset().mockResolvedValue(undefined);
    viewless.hasViewlessImplementation
      .mockReset()
      .mockImplementation((id: string) => ["terminal.new", "terminal.list"].includes(id));
    bridge = createRendererBridge(new Map(), new Map(), () => null);
    bridge.setupListeners([]);
  });

  afterEach(() => {
    _resetMcpDriveTargetResolverForTesting();
  });

  const write = { relay: { linkSessionId: "local", readOnly: false, local: true as const } };
  const read = { relay: { linkSessionId: "local", readOnly: true, local: true as const } };

  it("runs a change in this machine's own view of the project with no lease installed", async () => {
    const view = localView(7, { ok: true, result: "from-view" });

    const envelope = await bridge.dispatchActionForWorkspace(
      WORKSPACE,
      "terminal.new",
      {},
      false,
      "external",
      write
    );

    expect(envelope.result).toEqual({ ok: true, result: "from-view" });
    expect(view.send).toHaveBeenCalledTimes(1);
    expect(viewless.runViewlessAction).not.toHaveBeenCalled();
  });

  it("runs here, reads included, in a project no view shows, and stops a change only another machine's lease could", async () => {
    viewless.runViewlessAction.mockResolvedValue({ ok: true, result: { terminals: [] } });

    for (const options of [read, write]) {
      await bridge.dispatchActionForWorkspace(
        WORKSPACE,
        "terminal.list",
        {},
        false,
        "external",
        options
      );
    }

    expect(viewless.runViewlessAction).toHaveBeenCalledTimes(2);
    const [request] = viewless.runViewlessAction.mock.calls[1] as [
      { checkWrite: (changed: boolean) => Error | null },
    ];
    expect(request.checkWrite(true)).toBeNull();
    const remote = { ...makeRemoteEndpoint(async () => null), linkSessionId: "local" };
    setMcpDriveTargetResolver(() => ({ state: "live", endpoint: remote, holderName: "studio-02" }));
    const stopped = request.checkWrite(true);
    expect(stopped).toBeInstanceOf(RelayDrivenElsewhereError);
    expect((stopped as Error).message).toContain("studio-02 took control");
    expect((stopped as Error).message).not.toContain("Shell");
  });

  it("says no frontend is attached for what only a view can run in a project none shows", async () => {
    const err = await bridge
      .dispatchActionForWorkspace(WORKSPACE, "git.getProjectPulse", {}, false, "external", read)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NoFrontendAttachedError);
    // Read by an assistant, not a person: it says what still runs, never what to open (#14122).
    expect((err as Error).message).toContain("'git.getProjectPulse'");
    expect((err as Error).message).toContain("can still run here");
    expect((err as Error).message).not.toMatch(/open the workspace/i);
    expect(viewless.runViewlessAction).not.toHaveBeenCalled();
  });

  it("runs a change through the local view the lease names, and refuses to guess between two", async () => {
    const other = localView(1, { ok: true, result: "other" });
    const driver = localView(2, { ok: true, result: "driver" });
    mockProjectViews.set(WORKSPACE, [other, driver]);

    const err = await bridge
      .dispatchActionForWorkspace(WORKSPACE, "terminal.new", {}, false, "external", write)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceBindingError);
    expect((err as WorkspaceBindingError).reason).toBe("ambiguous");
    expect(other.send).not.toHaveBeenCalled();
    expect(driver.send).not.toHaveBeenCalled();
    expect(viewless.runViewlessAction).not.toHaveBeenCalled();

    setMcpDriveTargetResolver(() => ({
      state: "live",
      endpoint: { ...makeRemoteEndpoint(async () => null), kind: "local-view", handle: 2 },
    }));
    const envelope = await bridge.dispatchActionForWorkspace(
      WORKSPACE,
      "terminal.new",
      {},
      false,
      "external",
      write
    );

    expect(envelope.result).toEqual({ ok: true, result: "driver" });
    expect(driver.send).toHaveBeenCalledTimes(1);
    expect(other.send).not.toHaveBeenCalled();
  });

  it("refuses a change another machine drives, naming it, whatever its link session is called", async () => {
    const view = localView(7, { ok: true, result: "from-view" });
    const remote = {
      ...makeRemoteEndpoint(async () => ({ result: { ok: true, result: "remote" } })),
      linkSessionId: "local",
    };
    setMcpDriveTargetResolver(() => ({ state: "live", endpoint: remote, holderName: "studio-02" }));

    const err = await bridge
      .dispatchActionForWorkspace(WORKSPACE, "terminal.new", {}, false, "external", write)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RelayDrivenElsewhereError);
    expect((err as Error).message).toContain("studio-02 has control");
    expect(remote.request).not.toHaveBeenCalled();
    expect(view.send).not.toHaveBeenCalled();

    const envelope = await bridge.dispatchActionForWorkspace(
      WORKSPACE,
      "terminal.list",
      {},
      false,
      "external",
      read
    );
    expect(envelope.result).toEqual({ ok: true, result: "remote" });
  });
});

describe("rendererBridge — a help session with no view (#13511)", () => {
  let bridge: ReturnType<typeof createRendererBridge>;

  function holder(sessionId: string): ClientEndpoint {
    return {
      ...makeRemoteEndpoint(async () => ({ result: { ok: true, result: { ran: true } } })),
      endpointId: `remote:${sessionId}:view-1`,
      linkSessionId: sessionId,
    };
  }

  beforeEach(() => {
    mockIpcMain.removeAllListeners();
    mockWebContentsRegistry.clear();
    mockProjectViews.clear();
    _resetMcpDriveTargetResolverForTesting();
    viewless.runViewlessAction.mockReset();
    viewless.describeViewlessWorkspace.mockReset().mockResolvedValue(undefined);
    viewless.hasViewlessImplementation.mockReset().mockReturnValue(true);
    bridge = createRendererBridge(new Map(), new Map(), () => null);
    bridge.setupListeners([]);
  });

  afterEach(() => {
    _resetMcpDriveTargetResolverForTesting();
  });

  it("runs its calls on the host, with its launch context and skip preference, never in a window here", async () => {
    setMcpDriveTargetResolver(() => ({ state: "vacant" }));
    const view = makeWebContents(7);
    mockWebContentsRegistry.set(7, view);
    mockProjectViews.set(WORKSPACE, [view]);
    viewless.runViewlessAction.mockResolvedValue({ ok: true, result: { terminalId: "t-1" } });
    const authorization = "skip-preference" as const;

    const envelope = await bridge.dispatchActionWithoutView(
      WORKSPACE,
      "agent.launch",
      { agentId: "codex" },
      true,
      "help",
      { contextOverride: { projectId: WORKSPACE }, authorization }
    );

    expect(envelope.result).toEqual({ ok: true, result: { terminalId: "t-1" } });
    expect(view.send).not.toHaveBeenCalled();
    const [request] = viewless.runViewlessAction.mock.calls[0] as [
      {
        sessionOrigin: string;
        confirmed: boolean;
        context?: unknown;
        authorization?: unknown;
        checkWrite: (changed: boolean) => Error | null;
      },
    ];
    expect(request).toMatchObject({
      sessionOrigin: "help",
      confirmed: true,
      context: { projectId: WORKSPACE },
      authorization,
    });
    expect(request.checkWrite(false)).toBeNull();
  });

  it("stops a change once anyone takes the project, naming them, with no view of its own to except", async () => {
    let target: Parameters<typeof setMcpDriveTargetResolver>[0] = () => ({ state: "vacant" });
    setMcpDriveTargetResolver((projectId) => target!(projectId));
    viewless.runViewlessAction.mockResolvedValue({ ok: true, result: {} });

    await bridge.dispatchActionWithoutView(WORKSPACE, "terminal.new", {}, false, "help");
    const [request] = viewless.runViewlessAction.mock.calls[0] as [
      { checkWrite: (changed: boolean) => Error | null },
    ];

    target = () => ({ state: "live", endpoint: holder("shell-a"), holderName: "greg-mbp" });
    const before = request.checkWrite(false);
    expect(before).toBeInstanceOf(RelayDrivenElsewhereError);
    expect((before as RelayDrivenElsewhereError).code).toBe("DRIVEN_ELSEWHERE");
    expect((before as Error).message).toContain("greg-mbp has control");
    expect((before as Error).message).not.toContain("Shell");
    expect((request.checkWrite(true) as Error).message).toContain("greg-mbp took control");

    target = () => ({ state: "unavailable", reason: "reserved" });
    expect(request.checkWrite(false)).toBeInstanceOf(DriveHolderUnavailableError);
  });

  it("answers an action only a view can run as no frontend attached", async () => {
    setMcpDriveTargetResolver(() => ({ state: "vacant" }));
    viewless.hasViewlessImplementation.mockReturnValue(false);

    const err = await bridge
      .dispatchActionWithoutView(WORKSPACE, "terminal.moveToDock", {}, false, "help")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NoFrontendAttachedError);
    expect(viewless.runViewlessAction).not.toHaveBeenCalled();
  });
});
