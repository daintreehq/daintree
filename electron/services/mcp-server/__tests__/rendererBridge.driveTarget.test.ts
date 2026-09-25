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
  getProjectForWebContents: () => null,
}));

vi.mock("../../../utils/webContentsLifecycle.js", () => ({
  unfreezeWebContents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../viewless/index.js", () => viewless);

import {
  createRendererBridge,
  DriveHolderUnavailableError,
  NoFrontendAttachedError,
  WorkspaceBindingError,
} from "../rendererBridge.js";
import {
  MCP_DISPATCH_ACTION_METHOD,
  MCP_GET_MANIFEST_METHOD,
  _resetMcpDriveTargetResolverForTesting,
  setMcpDriveTargetResolver,
} from "../driveTarget.js";
import type { DispatchEnvelope, PendingRequest } from "../shared.js";
import type { ActionManifestEntry } from "../../../../shared/types/actions.js";

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
        { offerSessionApproval: true }
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
      expect(localView.send).not.toHaveBeenCalled();
      expect(envelope).toMatchObject({
        result: { ok: true, result: { terminalId: "t-remote" } },
        confirmationDecision: "approved",
        approvalScope: "session",
        dispatchedWorkspace: { workspaceId: WORKSPACE },
      });
      expect(viewless.runViewlessAction).not.toHaveBeenCalled();
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
