import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { AppError } from "../../../utils/errorTypes.js";
import {
  toHostScopedKey,
  type HostDescriptor,
  type HostConnectionState,
} from "../../../../shared/types/remoteHosts.js";
import {
  disposeProjectHistory,
  getProjectHistory,
  resetProjectHistory,
} from "../../../services/ProjectHistoryService.js";
import type {
  PendingHostSwitch,
  RemoteHostsEvent,
} from "../../../../shared/types/ipc/remoteHosts.js";
import type { IpcContext } from "../../../ipc/types.js";
import type { RemoteRouter } from "../../../ipc/endpoint.js";
import { HostRegistry, type RemoteHostsStore } from "../HostRegistry.js";
import type { RemoteHostManager } from "../RemoteHostManager.js";
import { RemoteHostsClient, type WindowControl } from "../RemoteHostsClient.js";
import { RemoteRouterImpl } from "../RemoteRouter.js";
import { WindowHostBinding } from "../WindowHostBinding.js";
import { _resetRemoteServicesForTest, registerRemoteService } from "../../runtime.js";
import type { HostMetricsClient } from "../../metrics/client.js";
import type { HostSwitchService } from "../../projects/HostSwitchService.js";

function memoryStore(): RemoteHostsStore {
  let value: { hosts: HostDescriptor[] } | undefined;
  return { get: () => value, set: (_key, next) => void (value = next) };
}

function fakeManager() {
  const connections = new Map<
    string,
    {
      linkState: { status: string; handshake?: unknown };
      hostInfo: { platform: "linux"; homeDir: string; tmpDir: string } | null;
      state: () => HostConnectionState;
      describeProject: ReturnType<typeof vi.fn>;
      listProjects: ReturnType<typeof vi.fn>;
      lastActiveProject: ReturnType<typeof vi.fn>;
      noteActiveProject: ReturnType<typeof vi.fn>;
      whenReady: ReturnType<typeof vi.fn>;
      retryNow: ReturnType<typeof vi.fn>;
      restarting: boolean;
      boundViews: () => number[];
      hasLiveAssistant: (webContentsId: number) => boolean;
      hasActiveAgent: (webContentsId: number) => boolean;
      hasKeepResident: (webContentsId: number) => boolean;
      hasLiveMcpBinding: (webContentsId: number) => boolean;
    }
  >();
  const listeners = new Set<(hostId: string, state: HostConnectionState) => void>();
  const manager = {
    status: "connected" as string,
    readiness: "ready" as string,
    bound: [] as number[],
    /** Views a host says have its live assistant pinned to them, by host. */
    liveAssistants: new Map<string, Set<number>>(),
    /** Views a host says have an active agent in their project, by host. */
    activeAgents: new Map<string, Set<number>>(),
    residentViews: new Map<string, Set<number>>(),
    /** Views a host says an MCP session there is bound to, live, by host. */
    mcpBoundViews: new Map<string, Set<number>>(),
    /** What the host remembers this Shell last showed there. */
    last: null as { projectId: string; path: string; name: string } | null,
    touch: vi.fn(),
    useChecks: [] as Array<(hostId: string) => boolean>,
    addUseCheck: vi.fn((check: (hostId: string) => boolean) => {
      manager.useChecks.push(check);
      return () => {};
    }),
    connect: vi.fn((hostId: string) => {
      let connection = connections.get(hostId);
      if (!connection) {
        connection = {
          linkState: { status: manager.status },
          hostInfo: { platform: "linux", homeDir: "/home/greg", tmpDir: "/tmp" },
          state: () => ({ status: "disconnected" }),
          describeProject: vi.fn(async (projectId: string) => ({
            projectId,
            path: `/srv/${projectId}`,
            name: projectId,
          })),
          listProjects: vi.fn(async () => [{ id: "proj-1", name: "App", path: "/srv/app" }]),
          lastActiveProject: vi.fn(async () => manager.last),
          noteActiveProject: vi.fn(),
          whenReady: vi.fn(async () => manager.readiness),
          retryNow: vi.fn(),
          restarting: false,
          boundViews: () => [...manager.bound],
          hasLiveAssistant: (webContentsId: number) =>
            manager.liveAssistants.get(hostId)?.has(webContentsId) === true,
          hasActiveAgent: (webContentsId: number) =>
            manager.activeAgents.get(hostId)?.has(webContentsId) === true,
          hasKeepResident: (webContentsId: number) =>
            manager.residentViews.get(hostId)?.has(webContentsId) === true,
          hasLiveMcpBinding: (webContentsId: number) =>
            manager.mcpBoundViews.get(hostId)?.has(webContentsId) === true,
        };
        connections.set(hostId, connection);
      }
      return connection;
    }),
    get: (hostId: string) => connections.get(hostId),
    disconnect: vi.fn(async (hostId: string) => void connections.delete(hostId)),
    connectionState: (hostId: string): HostConnectionState =>
      connections.has(hostId)
        ? { status: "connected", rttMs: 1, handshake: {} as never }
        : { status: "disconnected" },
    onStateChange: (l: (hostId: string, state: HostConnectionState) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    disposeAll: vi.fn(async () => {}),
    emit: (hostId: string, state: HostConnectionState) => {
      for (const l of listeners) l(hostId, state);
    },
  };
  return manager;
}

function ctxFor(webContentsId: number, windowId: number | null): IpcContext {
  return {
    event: null,
    webContentsId,
    senderWindow: windowId === null ? null : ({ id: windowId, isDestroyed: () => false } as never),
    projectId: null,
    endpoint: {} as never,
    client: {} as never,
  };
}

describe("RemoteHostsClient", () => {
  let registry: HostRegistry;
  let manager: ReturnType<typeof fakeManager>;
  let bindings: WindowHostBinding;
  let windows: WindowControl & Record<string, ReturnType<typeof vi.fn>>;
  let installRouter: Mock<(router: RemoteRouter | null) => void>;
  let events: RemoteHostsEvent[];
  let keys: Map<number, string>;
  let client: RemoteHostsClient;
  let router: RemoteRouter;
  let onFirstUse: Mock<() => void>;

  beforeEach(() => {
    registry = new HostRegistry(memoryStore());
    manager = fakeManager();
    bindings = new WindowHostBinding();
    keys = new Map();
    const senders = {
      projectKeyFor: (id: number) => keys.get(id) ?? null,
      windowIdFor: (id: number) => (id === 5 ? 1 : null),
    };
    router = new RemoteRouterImpl(manager as unknown as RemoteHostManager, bindings, senders);
    windows = {
      openWindow: vi.fn(async () => 7),
      openRemoteProject: vi.fn(async () => {}),
      openLocalProject: vi.fn(async () => {}),
      watchWindow: vi.fn(),
      lastLocalProjectId: vi.fn(() => null),
    };
    installRouter = vi.fn<(router: RemoteRouter | null) => void>();
    events = [];
    onFirstUse = vi.fn<() => void>();
    client = new RemoteHostsClient({
      onFirstUse,
      registry,
      manager: manager as unknown as RemoteHostManager,
      bindings,
      router,
      senders,
      windows,
      installRouter,
      emit: (event) => events.push(event),
    });
    registry.add({ name: "studio-01", connection: { kind: "ssh", target: "studio.example" } });
    events.length = 0;
  });

  it("reports this machine for a window that never attached anywhere", () => {
    const info = client.getWindowHost(ctxFor(5, 1));
    expect(info).toMatchObject({
      hostId: "local",
      descriptor: null,
      connection: { status: "local" },
      hostPlatform: process.platform,
    });
    expect(info.hostHomeDir).toBeTruthy();
    expect(info.hostTmpDir).toBeTruthy();
    expect(installRouter).not.toHaveBeenCalled();
  });

  it("lists a connected host's projects and never dials one to do it", async () => {
    await expect(client.listHostProjects({ hostId: "studio-01" })).rejects.toMatchObject({
      code: "HOST_DISCONNECTED",
    });
    expect(manager.connect).not.toHaveBeenCalled();

    manager.connect("studio-01");
    await expect(client.listHostProjects({ hostId: "studio-01" })).resolves.toEqual([
      { id: "proj-1", name: "App", path: "/srv/app" },
    ]);
    await expect(client.listHostProjects({ hostId: "nowhere" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(client.listHostProjects({ hostId: "local" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(installRouter).not.toHaveBeenCalled();
  });

  describe("restoreHostProjectInBackground (#13932)", () => {
    let restore: Mock<NonNullable<WindowControl["restoreRemoteProjectInBackground"]>>;

    beforeEach(() => {
      restore = vi.fn<NonNullable<WindowControl["restoreRemoteProjectInBackground"]>>(
        async () => "restored"
      );
      windows.restoreRemoteProjectInBackground = restore;
    });

    it("loads the project at the host's path, and nothing the window shows changes", async () => {
      await expect(
        client.restoreHostProjectInBackground(1, "studio-01", "proj-1", { lastUsed: 42 })
      ).resolves.toBe("restored");
      expect(manager.connect).toHaveBeenCalledWith("studio-01");
      expect(installRouter).toHaveBeenCalledWith(router);
      expect(restore).toHaveBeenCalledWith(1, "studio-01", "proj-1", "/srv/proj-1", {
        lastUsed: 42,
        stillWanted: expect.any(Function),
      });
      expect(bindings.get(1)).toBe("local");
      expect(windows.openRemoteProject).not.toHaveBeenCalled();
      expect(manager.connect("studio-01").noteActiveProject).not.toHaveBeenCalled();
      expect(client.listRecent()).toEqual([]);
    });

    it("leaves a project another window has to it, without dialling the host", async () => {
      windows.projectOwner = vi.fn(() => ({ windowId: 2, showing: false }));
      await expect(
        client.restoreHostProjectInBackground(1, "studio-01", "proj-1", { lastUsed: 1 })
      ).resolves.toBe("owned-elsewhere");
      expect(manager.connect).not.toHaveBeenCalled();
      expect(restore).not.toHaveBeenCalled();
    });

    it("says so when the host no longer has the project", async () => {
      manager.connect("studio-01").describeProject.mockResolvedValueOnce(null);
      await expect(
        client.restoreHostProjectInBackground(1, "studio-01", "proj-1", { lastUsed: 1 })
      ).resolves.toBe("project-gone");
      expect(restore).not.toHaveBeenCalled();
    });

    it("says so for a host removed from this device, without dialling anything", async () => {
      await expect(
        client.restoreHostProjectInBackground(1, "nowhere", "proj-1", { lastUsed: 1 })
      ).resolves.toBe("host-removed");
      expect(manager.connect).not.toHaveBeenCalled();
    });

    it.each([
      ["timeout", "HOST_DISCONNECTED"],
      ["version-mismatch", "HOST_VERSION_MISMATCH"],
    ])("throws as a switch does when the host comes back %s", async (readiness, code) => {
      manager.readiness = readiness;
      await expect(
        client.restoreHostProjectInBackground(1, "studio-01", "proj-1", { lastUsed: 1 })
      ).rejects.toMatchObject({ code });
      expect(restore).not.toHaveBeenCalled();
    });

    it("treats a lookup the host couldn't answer as the host being unreachable", async () => {
      manager.connect("studio-01").describeProject.mockRejectedValueOnce(new Error("link dropped"));
      await expect(
        client.restoreHostProjectInBackground(1, "studio-01", "proj-1", { lastUsed: 1 })
      ).rejects.toMatchObject({ code: "HOST_DISCONNECTED" });
    });

    it("hands the window a check that still holds the caller's wish", async () => {
      let wanted = true;
      await client.restoreHostProjectInBackground(1, "studio-01", "proj-1", {
        lastUsed: 1,
        stillWanted: () => wanted,
      });
      const [, , , , { stillWanted }] = restore.mock.calls[0]!;
      expect(stillWanted()).toBe(true);
      wanted = false;
      expect(stillWanted()).toBe(false);
    });

    it("gives up once it is no longer wanted", async () => {
      let wanted = true;
      manager.connect("studio-01").whenReady.mockImplementationOnce(async () => {
        wanted = false;
        return "ready";
      });
      await expect(
        client.restoreHostProjectInBackground(1, "studio-01", "proj-1", {
          lastUsed: 1,
          stillWanted: () => wanted,
        })
      ).resolves.toBe("cancelled");
      expect(restore).not.toHaveBeenCalled();
    });
  });

  it("leaves the router installed when it is disposed, so host views fail closed at quit", async () => {
    await client.switchWindowHost(ctxFor(5, 1), {
      hostId: "studio-01",
      newWindow: false,
      projectId: "proj-1",
    });
    expect(installRouter).toHaveBeenCalledWith(router);

    await client.dispose();

    expect(manager.disposeAll).toHaveBeenCalled();
    expect(installRouter).not.toHaveBeenCalledWith(null);
  });

  it("attaches the window to the host and opens the project at the host's path", async () => {
    await client.switchWindowHost(ctxFor(5, 1), {
      hostId: "studio-01",
      newWindow: false,
      projectId: "proj-1",
    });

    expect(installRouter).toHaveBeenCalledWith(router);
    expect(bindings.get(1)).toBe("studio-01");
    expect(windows.openRemoteProject).toHaveBeenCalledWith(
      1,
      "studio-01",
      "proj-1",
      "/srv/proj-1",
      undefined,
      { requesterWebContentsId: 5 }
    );
    // The picker in that window now routes to the host; a remote view reports its host.
    expect(router.hostForSender(5)).toBe("studio-01");
    keys.set(6, "studio-01:proj-1");
    expect(router.hostForSender(6)).toBe("studio-01");
    const info = client.getWindowHost(ctxFor(6, 1));
    expect(info).toMatchObject({
      hostId: "studio-01",
      hostPlatform: "linux",
      hostHomeDir: "/home/greg",
      hostTmpDir: "/tmp",
    });
    expect(info.descriptor?.id).toBe("studio-01");
    // A local project view keeps running here even inside that window.
    keys.set(8, "proj-1");
    expect(router.hostForSender(8)).toBeNull();
  });

  it("hands the project the switch opens what to focus once it is showing", async () => {
    const focusIntent = { intent: "focus-panel", panelId: "term-1" } as const;
    await client.switchWindowHost(ctxFor(5, 1), {
      hostId: "studio-01",
      newWindow: false,
      projectId: "proj-1",
      focusIntent,
    });
    expect(windows.openRemoteProject).toHaveBeenCalledWith(
      1,
      "studio-01",
      "proj-1",
      "/srv/proj-1",
      focusIntent,
      { requesterWebContentsId: 5 }
    );

    await client.switchWindowHost(ctxFor(5, 1), {
      hostId: "local",
      newWindow: false,
      projectId: "proj-local",
      focusIntent,
    });
    expect(windows.openLocalProject).toHaveBeenCalledWith(1, "proj-local", focusIntent, {
      requesterWebContentsId: 5,
    });

    // A new window opened on the project takes it too.
    await client.switchWindowHost(ctxFor(5, 1), {
      hostId: "studio-01",
      newWindow: true,
      projectId: "proj-2",
      focusIntent,
    });
    expect(windows.openRemoteProject).toHaveBeenLastCalledWith(
      7,
      "studio-01",
      "proj-2",
      "/srv/proj-2",
      focusIntent
    );
  });

  it("carries Open in Assistant only to the host and project its lane is in (#14163)", async () => {
    const subject = {
      hostId: "studio-01",
      scope: { kind: "project" as const, projectId: "proj-1" },
      terminalId: "t1",
      incarnation: 2,
      lane: 1,
    };
    const focusIntent = { intent: "open-assistant", subject } as const;
    await client.switchWindowHost(ctxFor(5, 1), {
      hostId: "studio-01",
      newWindow: false,
      projectId: "proj-1",
      focusIntent,
    });
    expect(windows.openRemoteProject).toHaveBeenCalledWith(
      1,
      "studio-01",
      "proj-1",
      "/srv/proj-1",
      focusIntent,
      { requesterWebContentsId: 5 }
    );
    vi.mocked(windows.openRemoteProject).mockClear();
    for (const wrong of [
      { ...subject, hostId: "local" },
      { ...subject, scope: { kind: "project" as const, projectId: "proj-2" } },
      { ...subject, lane: undefined },
      { ...subject, incarnation: -1 },
      { hostId: "studio-01", scope: { kind: "global" as const }, terminalId: "g", incarnation: 1 },
    ]) {
      await expect(
        client.switchWindowHost(ctxFor(5, 1), {
          hostId: "studio-01",
          newWindow: false,
          projectId: "proj-1",
          focusIntent: { intent: "open-assistant", subject: wrong } as never,
        })
      ).rejects.toMatchObject({ code: "VALIDATION" });
    }
    expect(windows.openRemoteProject).not.toHaveBeenCalled();
  });

  it("names the asking renderer as the switch's requester, in its own window only", async () => {
    await client.switchWindowHost(ctxFor(5, 1), {
      hostId: "studio-01",
      newWindow: false,
      projectId: "proj-1",
    });
    expect(windows.openRemoteProject).toHaveBeenLastCalledWith(
      1,
      "studio-01",
      "proj-1",
      "/srv/proj-1",
      undefined,
      { requesterWebContentsId: 5 }
    );

    // Away from a host view: the view the rollback restores is the one that asked.
    await client.switchWindowHost(ctxFor(9, 1), {
      hostId: "local",
      newWindow: false,
      projectId: "proj-local",
    });
    expect(windows.openLocalProject).toHaveBeenLastCalledWith(1, "proj-local", undefined, {
      requesterWebContentsId: 9,
    });

    // A caller that words the failure itself leaves the report to main.
    await client.switchWindowHost(
      ctxFor(5, 1),
      { hostId: "studio-01", newWindow: false, projectId: "proj-1" },
      { requesterReports: false }
    );
    expect(windows.openRemoteProject).toHaveBeenLastCalledWith(
      1,
      "studio-01",
      "proj-1",
      "/srv/proj-1"
    );

    // A new window has no view of the asker's to roll back to.
    await client.switchWindowHost(ctxFor(5, 1), {
      hostId: "studio-01",
      newWindow: true,
      projectId: "proj-2",
    });
    expect(windows.openRemoteProject).toHaveBeenLastCalledWith(
      7,
      "studio-01",
      "proj-2",
      "/srv/proj-2"
    );
  });

  it("hands the window already showing the project what to focus, as it comes forward", async () => {
    const focusIntent = { intent: "focus-panel", panelId: "term-1" } as const;
    windows.projectOwner = vi.fn(() => ({ windowId: 2, showing: true }));
    windows.revealWindow = vi.fn();
    windows.focusInWindow = vi.fn();
    await expect(
      client.switchWindowHost(ctxFor(5, 1), {
        hostId: "studio-01",
        newWindow: false,
        projectId: "proj-1",
        focusIntent,
      })
    ).resolves.toMatchObject({ outcome: "focused-elsewhere", targetWindowId: 2 });
    expect(windows.revealWindow).toHaveBeenCalledWith(2);
    expect(windows.focusInWindow).toHaveBeenCalledWith(2, "studio-01", "proj-1", focusIntent);
    expect(windows.openRemoteProject).not.toHaveBeenCalled();

    // This machine's project, shown in another window, the same way.
    windows.redirectToLocalOwner = vi.fn(() => 3);
    vi.mocked(windows.focusInWindow).mockClear();
    await client.switchWindowHost(ctxFor(5, 1), {
      hostId: "local",
      newWindow: false,
      projectId: "proj-local",
      focusIntent,
    });
    expect(windows.focusInWindow).toHaveBeenCalledWith(3, "local", "proj-local", focusIntent);
  });

  it("carries a worktree to land on, and refuses one that names no worktree (#14569)", async () => {
    // A worktree's id is its path, which can run well past a project id's length.
    const focusIntent = {
      intent: "focus-worktree",
      worktreeId: `/srv/${"deep/".repeat(100)}proj-1-feature`,
    } as const;
    await client.switchWindowHost(ctxFor(5, 1), {
      hostId: "studio-01",
      newWindow: false,
      projectId: "proj-1",
      // Only the intent itself is carried on.
      focusIntent: { ...focusIntent, panelId: "term-1" } as never,
    });
    expect(windows.openRemoteProject).toHaveBeenCalledWith(
      1,
      "studio-01",
      "proj-1",
      "/srv/proj-1",
      focusIntent,
      { requesterWebContentsId: 5 }
    );
    await client.switchWindowHost(ctxFor(5, 1), {
      hostId: "local",
      newWindow: false,
      projectId: "proj-local",
      focusIntent,
    });
    expect(windows.openLocalProject).toHaveBeenCalledWith(1, "proj-local", focusIntent, {
      requesterWebContentsId: 5,
    });

    vi.mocked(windows.openRemoteProject).mockClear();
    for (const worktreeId of ["", "w".repeat(10_000), 42, undefined, ["/srv/a"], { length: 1 }]) {
      await expect(
        client.switchWindowHost(ctxFor(5, 1), {
          hostId: "studio-01",
          newWindow: false,
          projectId: "proj-1",
          focusIntent: { intent: "focus-worktree", worktreeId } as never,
        })
      ).rejects.toMatchObject({ code: "VALIDATION" });
    }
    expect(windows.openRemoteProject).not.toHaveBeenCalled();
  });

  it("carries a restore from Canopy's Trash, and refuses one that names no trash", async () => {
    const focusIntent = {
      intent: "restore-trashed",
      runId: "term-1",
      spawnedAt: 100,
      expiresAt: 120,
    } as const;
    await client.switchWindowHost(ctxFor(5, 1), {
      hostId: "studio-01",
      newWindow: false,
      projectId: "proj-1",
      focusIntent: { ...focusIntent, panelId: "term-9" } as never,
    });
    expect(windows.openRemoteProject).toHaveBeenCalledWith(
      1,
      "studio-01",
      "proj-1",
      "/srv/proj-1",
      focusIntent,
      { requesterWebContentsId: 5 }
    );

    vi.mocked(windows.openRemoteProject).mockClear();
    for (const bad of [
      { runId: "" },
      { runId: 42 },
      { spawnedAt: "100" },
      { expiresAt: 1.5 },
      { expiresAt: undefined },
    ]) {
      await expect(
        client.switchWindowHost(ctxFor(5, 1), {
          hostId: "studio-01",
          newWindow: false,
          projectId: "proj-1",
          focusIntent: { ...focusIntent, ...bad } as never,
        })
      ).rejects.toMatchObject({ code: "VALIDATION" });
    }
    expect(windows.openRemoteProject).not.toHaveBeenCalled();
  });

  it("carries what a placed worktree's host said it skipped, and refuses one with no note (#14991)", async () => {
    const focusIntent = {
      intent: "placement-note",
      note: "The setup recipe isn't in this host's copy of the repository, so it won't run.",
    } as const;
    await client.switchWindowHost(ctxFor(5, 1), {
      hostId: "studio-01",
      newWindow: false,
      projectId: "proj-1",
      focusIntent: { ...focusIntent, panelId: "term-9" } as never,
    });
    expect(windows.openRemoteProject).toHaveBeenCalledWith(
      1,
      "studio-01",
      "proj-1",
      "/srv/proj-1",
      focusIntent,
      { requesterWebContentsId: 5 }
    );

    vi.mocked(windows.openRemoteProject).mockClear();
    for (const note of ["", "n".repeat(20_000), 42, undefined, ["a note"]]) {
      await expect(
        client.switchWindowHost(ctxFor(5, 1), {
          hostId: "studio-01",
          newWindow: false,
          projectId: "proj-1",
          focusIntent: { intent: "placement-note", note } as never,
        })
      ).rejects.toMatchObject({ code: "VALIDATION" });
    }
    expect(windows.openRemoteProject).not.toHaveBeenCalled();
  });

  it("focuses nothing in a window that came forward without being asked to", async () => {
    windows.projectOwner = vi.fn(() => ({ windowId: 2, showing: true }));
    windows.revealWindow = vi.fn();
    windows.focusInWindow = vi.fn();
    await client.switchWindowHost(ctxFor(5, 1), {
      hostId: "studio-01",
      newWindow: false,
      projectId: "proj-1",
    });
    expect(windows.focusInWindow).not.toHaveBeenCalled();
  });

  it("refuses a focus intent that isn't one", async () => {
    await expect(
      client.switchWindowHost(ctxFor(5, 1), {
        hostId: "studio-01",
        newWindow: false,
        projectId: "proj-1",
        focusIntent: { intent: "focus-panel", panelId: "" },
      })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      client.switchWindowHost(ctxFor(5, 1), {
        hostId: "studio-01",
        newWindow: false,
        projectId: "proj-1",
        focusIntent: { intent: "explode" } as never,
      })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(windows.openRemoteProject).not.toHaveBeenCalled();
  });

  it("asks a view's own host whether its assistant is live, and no host for a local view (#13349)", () => {
    manager.connect("studio-01");
    manager.liveAssistants.set("studio-01", new Set([6, 8]));
    keys.set(6, "studio-01:proj-1");
    keys.set(7, "studio-01:proj-2");
    keys.set(8, "proj-1");
    keys.set(9, "studio-02:proj-1");

    expect(client.viewHasLiveAssistant(6)).toBe(true);
    expect(client.viewHasLiveAssistant(7)).toBe(false);
    // Whatever a host says about a view it doesn't own.
    expect(client.viewHasLiveAssistant(8)).toBe(false);
    // A host with no connection says nothing.
    expect(client.viewHasLiveAssistant(9)).toBe(false);
  });

  it("asks a view's own host whether its project has an active agent, and no host for a local view (#13359)", () => {
    manager.connect("studio-01");
    manager.activeAgents.set("studio-01", new Set([6, 8]));
    keys.set(6, "studio-01:proj-1");
    keys.set(7, "studio-01:proj-2");
    keys.set(8, "proj-1");
    keys.set(9, "studio-02:proj-1");

    expect(client.viewHasActiveAgent(6)).toBe(true);
    expect(client.viewHasActiveAgent(7)).toBe(false);
    expect(client.viewHasActiveAgent(8)).toBe(false);
    expect(client.viewHasActiveAgent(9)).toBe(false);
  });

  it("asks a view's own host whether its project is granted residency, and no host for a local view (#13933)", () => {
    manager.connect("studio-01");
    manager.residentViews.set("studio-01", new Set([6, 8]));
    keys.set(6, "studio-01:proj-1");
    keys.set(7, "studio-01:proj-2");
    keys.set(8, "proj-1");
    keys.set(9, "studio-02:proj-1");

    expect(client.viewKeepsResident(6)).toBe(true);
    expect(client.viewKeepsResident(7)).toBe(false);
    expect(client.viewKeepsResident(8)).toBe(false);
    expect(client.viewKeepsResident(9)).toBe(false);
  });

  it("asks a view's own host whether an MCP session is bound to its project, and no host for a local view (#14228)", () => {
    manager.connect("studio-01");
    manager.mcpBoundViews.set("studio-01", new Set([6, 8]));
    keys.set(6, "studio-01:proj-1");
    keys.set(7, "studio-01:proj-2");
    keys.set(8, "proj-1");
    keys.set(9, "studio-02:proj-1");

    expect(client.viewHasLiveMcpBinding(6)).toBe(true);
    expect(client.viewHasLiveMcpBinding(7)).toBe(false);
    expect(client.viewHasLiveMcpBinding(8)).toBe(false);
    expect(client.viewHasLiveMcpBinding(9)).toBe(false);
  });

  it("puts the binding back when the view can't be moved, so the two never name different hosts", async () => {
    vi.mocked(windows.openRemoteProject).mockRejectedValueOnce(new Error("view failed"));
    await expect(
      client.switchWindowHost(ctxFor(5, 1), {
        hostId: "studio-01",
        newWindow: false,
        projectId: "proj-1",
      })
    ).rejects.toThrow("view failed");
    expect(bindings.get(1)).toBe("local");
    expect(manager.get("studio-01")?.noteActiveProject).not.toHaveBeenCalled();
  });

  it("doesn't put back a binding to a host forgotten while the view failed to move", async () => {
    await client.switchWindowHost(ctxFor(5, 1), {
      hostId: "studio-01",
      newWindow: false,
      projectId: "proj-1",
    });
    vi.mocked(windows.openLocalProject).mockImplementationOnce(async () => {
      await client.forget({ hostId: "studio-01" });
      throw new Error("view failed");
    });
    await expect(
      client.switchWindowHost(ctxFor(5, 1), {
        hostId: "local",
        newWindow: false,
        projectId: "proj-local",
      })
    ).rejects.toThrow("view failed");
    expect(bindings.get(1)).toBe("local");
  });

  it("ignores a stale host lookup's failure once a newer switch was asked for", async () => {
    registry.add({ name: "studio-02", connection: { kind: "ssh", target: "studio2.example" } });
    let failLookup!: () => void;
    manager
      .connect("studio-01")
      .describeProject.mockImplementationOnce(
        () => new Promise((_resolve, reject) => (failLookup = () => reject(new Error("gone"))))
      );
    const slow = client.switchWindowHost(ctxFor(5, 1), {
      hostId: "studio-01",
      newWindow: false,
      projectId: "proj-1",
    });
    await vi.waitFor(() => expect(failLookup).toBeTypeOf("function"));
    await client.switchWindowHost(ctxFor(5, 1), {
      hostId: "studio-02",
      newWindow: false,
      projectId: "proj-2",
    });
    failLookup();
    await expect(slow).resolves.toEqual({ outcome: "superseded", hostId: "studio-01" });
  });

  describe("a switch still on its way", () => {
    function pendingEvents(): Array<PendingHostSwitch | null> {
      return vi
        .mocked(windows.notifyWindow!)
        .mock.calls.filter(([windowId]) => windowId === 1)
        .map(([, event]) => (event as { pending: PendingHostSwitch | null }).pending);
    }

    beforeEach(() => {
      windows.notifyWindow = vi.fn();
    });

    it("tells the window's views what it is waiting on, then that it is over", async () => {
      await client.switchWindowHost(ctxFor(5, 1), {
        hostId: "studio-01",
        newWindow: false,
        projectId: "proj-1",
      });

      // The host was up already: nothing was waited on, so nothing said "connecting".
      const seen = pendingEvents();
      expect(seen.map((pending) => pending?.phase ?? null)).toEqual([
        "opening",
        "opening",
        "opening",
        null,
      ]);
      expect(seen[1]).toMatchObject({ hostName: "studio-01", projectName: "proj-1" });
      // Committed, and still pending until the new view shows.
      expect(seen[2]).toMatchObject({ switchId: seen[1]!.switchId, committed: true });
      expect(seen[1]!.committed).toBeUndefined();
      expect(client.getPendingSwitch(ctxFor(5, 1))).toBeNull();
    });

    it("answers only the views the window is showing, not one loading in its cache", async () => {
      let release!: (value: string) => void;
      manager
        .connect("studio-01")
        .whenReady.mockImplementationOnce(() => new Promise<string>((r) => (release = r)));
      windows.showsView = vi.fn((_windowId: number, webContentsId: number) => webContentsId === 5);
      const switching = client.switchWindowHost(ctxFor(5, 1), {
        hostId: "studio-01",
        newWindow: false,
        projectId: "proj-1",
      });
      await vi.waitFor(() => expect(pendingEvents()).toHaveLength(1));

      expect(client.getPendingSwitch(ctxFor(5, 1))).toMatchObject({ phase: "connecting" });
      // Never shown, so never told the switch is over: it asks again once revealed.
      expect(client.getPendingSwitch(ctxFor(9, 1))).toBeNull();
      expect(windows.showsView).toHaveBeenCalledWith(1, 9);

      release("ready");
      await expect(switching).resolves.toMatchObject({ outcome: "switched" });
    });

    it("says it is connecting from the start when the host isn't up yet", async () => {
      let release!: (value: string) => void;
      manager
        .connect("studio-01")
        .whenReady.mockImplementationOnce(() => new Promise<string>((r) => (release = r)));
      const switching = client.switchWindowHost(ctxFor(5, 1), {
        hostId: "studio-01",
        newWindow: false,
        projectId: "proj-1",
      });
      await vi.waitFor(() => expect(pendingEvents()).toHaveLength(1));
      expect(pendingEvents()[0]).toMatchObject({
        phase: "connecting",
        request: { projectId: "proj-1" },
      });
      release("ready");
      await expect(switching).resolves.toMatchObject({ outcome: "switched" });
      expect(pendingEvents().at(-1)).toBeNull();
    });

    describe("a switch that fails", () => {
      async function failedSwitch(
        options?: Parameters<RemoteHostsClient["switchWindowHost"]>[2]
      ): Promise<unknown> {
        manager.connect("studio-01").whenReady.mockResolvedValueOnce("timeout");
        return client
          .switchWindowHost(
            ctxFor(5, 1),
            { hostId: "studio-01", newWindow: false, projectId: "proj-1" },
            options
          )
          .then(
            () => null,
            (error: unknown) => error
          );
      }

      it("stays on the window's screen, saying why, and tells the caller it is shown there", async () => {
        const error = await failedSwitch();

        const pending = client.getPendingSwitch(ctxFor(5, 1));
        expect(pending).toMatchObject({
          hostId: "studio-01",
          phase: "failed",
          request: { projectId: "proj-1" },
          failure: { code: "HOST_DISCONNECTED" },
        });
        expect(pending!.failure!.message).toMatch(/Couldn't reach this host/);
        expect(pendingEvents().at(-1)).toEqual(pending);
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).details).toEqual({
          code: "HOST_SWITCH_ON_SCREEN",
          switchId: pending!.switchId,
        });
        // Nothing moves the window later: the host coming back changes nothing.
        client.refreshPendingSwitches("studio-01");
        expect(client.getPendingSwitch(ctxFor(5, 1))).toEqual(pending);
        expect(windows.openRemoteProject).not.toHaveBeenCalled();
      });

      it("goes when the person cancels it", async () => {
        await failedSwitch();
        const { switchId } = client.getPendingSwitch(ctxFor(5, 1))!;

        expect(client.cancelPendingSwitch(ctxFor(5, 1), { switchId })).toBe(true);
        expect(client.getPendingSwitch(ctxFor(5, 1))).toBeNull();
        expect(pendingEvents().at(-1)).toBeNull();
        expect(bindings.get(1)).toBe("local");
      });

      it("goes when the window navigates anywhere else", async () => {
        await failedSwitch();
        client.supersedePendingSwitch(1);
        expect(client.getPendingSwitch(ctxFor(5, 1))).toBeNull();

        await failedSwitch();
        await client.switchWindowHost(ctxFor(5, 1), {
          hostId: "local",
          newWindow: false,
          projectId: "proj-local",
        });
        expect(client.getPendingSwitch(ctxFor(5, 1))).toBeNull();
      });

      it("is replaced by a Retry that lands", async () => {
        await failedSwitch();
        await expect(
          client.switchWindowHost(ctxFor(5, 1), {
            hostId: "studio-01",
            newWindow: false,
            projectId: "proj-1",
          })
        ).resolves.toMatchObject({ outcome: "switched" });
        expect(client.getPendingSwitch(ctxFor(5, 1))).toBeNull();
      });

      it("goes when its host is removed, so a Retry never asks a host that is gone", async () => {
        await failedSwitch();
        await client.forget({ hostId: "studio-01" });
        expect(client.getPendingSwitch(ctxFor(5, 1))).toBeNull();
      });

      it("keeps typing held for an earlier switch still opening when its screen is left", async () => {
        registry.add({ name: "studio-02", connection: { kind: "ssh", target: "studio2.example" } });
        let releaseOpen!: () => void;
        vi.mocked(windows.openRemoteProject).mockImplementationOnce(
          () => new Promise<void>((resolve) => (releaseOpen = resolve))
        );
        const first = client.switchWindowHost(ctxFor(5, 1), {
          hostId: "studio-02",
          newWindow: false,
          projectId: "proj-2",
        });
        await vi.waitFor(() => expect(windows.openRemoteProject).toHaveBeenCalled());
        const committed = client.getPendingSwitch(ctxFor(5, 1))!;
        expect(committed.committed).toBe(true);

        await failedSwitch();
        const { switchId } = client.getPendingSwitch(ctxFor(5, 1))!;
        expect(client.cancelPendingSwitch(ctxFor(5, 1), { switchId })).toBe(true);
        expect(client.getPendingSwitch(ctxFor(5, 1))).toEqual(committed);

        releaseOpen();
        await first;
        expect(client.getPendingSwitch(ctxFor(5, 1))).toBeNull();
      });

      it("is left to the caller for a view's own switch to another of its host's projects", async () => {
        const error = await failedSwitch({ failureOnScreen: false });
        expect(client.getPendingSwitch(ctxFor(5, 1))).toBeNull();
        expect((error as AppError).details).toBeUndefined();
      });
    });

    it("says Daintree is being started on the host while it is", async () => {
      let starting = false;
      client = new RemoteHostsClient({
        registry,
        manager: manager as unknown as RemoteHostManager,
        bindings,
        router,
        senders: { projectKeyFor: () => null, windowIdFor: (id) => (id === 5 ? 1 : null) },
        windows,
        installRouter,
        emit: () => {},
        isStarting: () => starting,
      });
      let release!: (value: string) => void;
      manager
        .connect("studio-01")
        .whenReady.mockImplementationOnce(() => new Promise<string>((r) => (release = r)));
      const switching = client.switchWindowHost(ctxFor(5, 1), {
        hostId: "studio-01",
        newWindow: false,
        projectId: "proj-1",
      });
      await vi.waitFor(() => expect(client.getPendingSwitch(ctxFor(5, 1))).not.toBeNull());

      starting = true;
      client.refreshPendingSwitches("studio-01");
      expect(client.getPendingSwitch(ctxFor(5, 1))?.phase).toBe("starting");

      // Each start attempt that ends and begins again leaves the phase as it
      // is: the screen never reads connecting, starting, connecting…
      const heard = pendingEvents().length;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        starting = false;
        client.refreshPendingSwitches("studio-01");
        starting = true;
        client.refreshPendingSwitches("studio-01");
      }
      starting = false;
      client.refreshPendingSwitches("studio-01");
      expect(client.getPendingSwitch(ctxFor(5, 1))?.phase).toBe("starting");
      expect(pendingEvents()).toHaveLength(heard);

      release("ready");
      await switching;
      expect(client.getPendingSwitch(ctxFor(5, 1))).toBeNull();
    });

    it("cancels straight away, wherever the switch was waiting, and the window stays", async () => {
      manager
        .connect("studio-01")
        .whenReady.mockImplementationOnce(() => new Promise<string>(() => {}));
      const switching = client.switchWindowHost(ctxFor(5, 1), {
        hostId: "studio-01",
        newWindow: false,
        projectId: "proj-1",
      });
      await vi.waitFor(() => expect(client.getPendingSwitch(ctxFor(5, 1))).not.toBeNull());
      const { switchId } = client.getPendingSwitch(ctxFor(5, 1))!;

      expect(client.cancelPendingSwitch(ctxFor(5, 1), { switchId: "someone-else" })).toBe(false);
      expect(client.cancelPendingSwitch(ctxFor(5, 1), { switchId })).toBe(true);

      // The host never answered, and the switch settled anyway.
      await expect(switching).resolves.toEqual({ outcome: "superseded", hostId: "studio-01" });
      expect(windows.openRemoteProject).not.toHaveBeenCalled();
      expect(bindings.get(1)).toBe("local");
      expect(pendingEvents().at(-1)).toBeNull();
      expect(client.cancelPendingSwitch(ctxFor(5, 1), { switchId })).toBe(false);
    });

    it("has nothing to cancel once committed, but stays pending until the new view shows", async () => {
      let releaseOpen!: () => void;
      vi.mocked(windows.openRemoteProject).mockImplementationOnce(
        () => new Promise<void>((resolve) => (releaseOpen = resolve))
      );
      const switching = client.switchWindowHost(ctxFor(5, 1), {
        hostId: "studio-01",
        newWindow: false,
        projectId: "proj-1",
      });
      await vi.waitFor(() => expect(windows.openRemoteProject).toHaveBeenCalled());

      // The old view is still on screen: typing stays held, but Cancel is gone.
      const pending = client.getPendingSwitch(ctxFor(5, 1));
      expect(pending).toMatchObject({ hostId: "studio-01", committed: true });
      expect(client.cancelPendingSwitch(ctxFor(5, 1), { switchId: pending!.switchId })).toBe(false);
      client.refreshPendingSwitches("studio-01");
      expect(client.getPendingSwitch(ctxFor(5, 1))).toEqual(pending);

      releaseOpen();
      await expect(switching).resolves.toMatchObject({ outcome: "switched" });
      expect(client.getPendingSwitch(ctxFor(5, 1))).toBeNull();
      expect(pendingEvents().at(-1)).toBeNull();
    });

    it("keeps typing held for a committed switch when a newer one is cancelled first", async () => {
      let releaseOpen!: () => void;
      vi.mocked(windows.openRemoteProject).mockImplementationOnce(
        () => new Promise<void>((resolve) => (releaseOpen = resolve))
      );
      const first = client.switchWindowHost(ctxFor(5, 1), {
        hostId: "studio-01",
        newWindow: false,
        projectId: "proj-1",
      });
      await vi.waitFor(() => expect(windows.openRemoteProject).toHaveBeenCalled());
      const committed = client.getPendingSwitch(ctxFor(5, 1))!;
      expect(committed.committed).toBe(true);

      manager
        .connect("studio-01")
        .whenReady.mockImplementationOnce(() => new Promise<string>(() => {}));
      const second = client.switchWindowHost(ctxFor(5, 1), {
        hostId: "studio-01",
        newWindow: false,
        projectId: "proj-2",
      });
      await vi.waitFor(() =>
        expect(client.getPendingSwitch(ctxFor(5, 1))?.switchId).not.toBe(committed.switchId)
      );
      const newer = client.getPendingSwitch(ctxFor(5, 1))!;
      expect(client.cancelPendingSwitch(ctxFor(5, 1), { switchId: newer.switchId })).toBe(true);
      await expect(second).resolves.toMatchObject({ outcome: "superseded" });

      // The first is still moving the window: its views hear about it again.
      expect(client.getPendingSwitch(ctxFor(5, 1))).toEqual(committed);
      expect(pendingEvents().at(-1)).toEqual(committed);

      releaseOpen();
      await expect(first).resolves.toMatchObject({ outcome: "switched" });
      expect(client.getPendingSwitch(ctxFor(5, 1))).toBeNull();
      expect(pendingEvents().at(-1)).toBeNull();
    });

    it("settles a first switch whose window closes before it ever bound", async () => {
      manager
        .connect("studio-01")
        .whenReady.mockImplementationOnce(() => new Promise<string>(() => {}));
      const switching = client.switchWindowHost(ctxFor(5, 1), {
        hostId: "studio-01",
        newWindow: false,
        projectId: "proj-1",
      });
      await vi.waitFor(() => expect(client.getPendingSwitch(ctxFor(5, 1))).not.toBeNull());

      const closed = vi.mocked(windows.watchWindow).mock.calls.find(([id]) => id === 1)![1];
      closed();

      await expect(switching).resolves.toEqual({ outcome: "superseded", hostId: "studio-01" });
      expect(windows.openRemoteProject).not.toHaveBeenCalled();
    });

    it("says nothing for a switch that opens a new window", async () => {
      await client.switchWindowHost(ctxFor(5, 1), {
        hostId: "studio-01",
        newWindow: true,
        projectId: "proj-1",
      });
      expect(windows.notifyWindow).not.toHaveBeenCalled();
    });
  });

  it("gives way to a navigation made in the window while the host is still answering", async () => {
    let releaseSlow!: (value: string) => void;
    manager
      .connect("studio-01")
      .whenReady.mockImplementationOnce(
        () => new Promise<string>((resolve) => (releaseSlow = resolve))
      );
    const slow = client.switchWindowHost(ctxFor(5, 1), {
      hostId: "studio-01",
      newWindow: false,
      projectId: "proj-1",
    });
    // A local project picked in that window meanwhile.
    client.supersedePendingSwitch(1);
    releaseSlow("ready");

    await expect(slow).resolves.toEqual({ outcome: "superseded", hostId: "studio-01" });
    expect(windows.openRemoteProject).not.toHaveBeenCalled();
    expect(bindings.get(1)).toBe("local");
  });

  it("moves the window for the latest request only, whatever order the hosts answer in", async () => {
    registry.add({ name: "studio-02", connection: { kind: "ssh", target: "studio2.example" } });
    let releaseSlow!: (value: string) => void;
    manager
      .connect("studio-01")
      .whenReady.mockImplementationOnce(
        () => new Promise<string>((resolve) => (releaseSlow = resolve))
      );
    const slow = client.switchWindowHost(ctxFor(5, 1), {
      hostId: "studio-01",
      newWindow: false,
      projectId: "proj-1",
    });
    await expect(
      client.switchWindowHost(ctxFor(5, 1), {
        hostId: "studio-02",
        newWindow: false,
        projectId: "proj-2",
      })
    ).resolves.toEqual({ outcome: "switched", hostId: "studio-02", projectId: "proj-2" });
    releaseSlow("ready");
    await expect(slow).resolves.toEqual({ outcome: "superseded", hostId: "studio-01" });
    expect(windows.openRemoteProject).toHaveBeenCalledTimes(1);
    expect(windows.openRemoteProject).toHaveBeenCalledWith(
      1,
      "studio-02",
      "proj-2",
      "/srv/proj-2",
      undefined,
      { requesterWebContentsId: 5 }
    );
    expect(bindings.get(1)).toBe("studio-02");
  });

  describe("a click on a banner about a host's agent", () => {
    const notice = { hostId: "studio-01", projectId: "proj-1", terminalId: "term-1" };

    beforeEach(() => {
      // Each window's view on screen: a project's, or a new window's welcome view.
      windows.appViewId = vi.fn((windowId: number) => ({ 1: 5, 7: 70 })[windowId] ?? null);
    });

    it("brings the window forward and opens the notice's project there with the agent's pane focused", async () => {
      const revealWindow = vi.fn();
      windows.revealWindow = revealWindow;
      await expect(client.openHostForNotice(1, notice)).resolves.toEqual({
        outcome: "switched",
        hostId: "studio-01",
        projectId: "proj-1",
      });
      // The view on screen reports a rollback on its switch screen, so main doesn't too.
      expect(windows.openRemoteProject).toHaveBeenCalledWith(
        1,
        "studio-01",
        "proj-1",
        "/srv/proj-1",
        { intent: "focus-panel", panelId: "term-1" },
        { requesterWebContentsId: 5 }
      );
      expect(revealWindow).toHaveBeenCalledWith(1);
      expect(revealWindow.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(windows.openRemoteProject).mock.invocationCallOrder[0]
      );
      expect(bindings.get(1)).toBe("studio-01");
    });

    it("opens it in a new window when none is open, its welcome view standing in to report", async () => {
      windows.revealWindow = vi.fn();
      await client.openHostForNotice(null, notice);
      expect(windows.openWindow).toHaveBeenCalledTimes(1);
      expect(windows.revealWindow).toHaveBeenCalledWith(7);
      expect(windows.openRemoteProject).toHaveBeenCalledWith(
        7,
        "studio-01",
        "proj-1",
        "/srv/proj-1",
        expect.objectContaining({ panelId: "term-1" }),
        { requesterWebContentsId: 70 }
      );
      expect(bindings.get(7)).toBe("studio-01");
    });

    it("yields a window it opened to a click that took it over while it was opening", async () => {
      let opened!: (windowId: number) => void;
      windows.openWindow = vi.fn(() => new Promise<number>((resolve) => (opened = resolve)));
      const first = client.openHostForNotice(null, notice);
      const second = client.openHostForNotice(7, { ...notice, projectId: "proj-2" });
      opened(7);
      await expect(first).resolves.toEqual({ outcome: "superseded", hostId: "studio-01" });
      await expect(second).resolves.toMatchObject({ outcome: "switched", projectId: "proj-2" });
      expect(windows.openRemoteProject).toHaveBeenCalledTimes(1);
    });

    it("keeps a failure on the window's switch screen, as a switch the person asked for does", async () => {
      manager.connect("studio-01").whenReady.mockResolvedValueOnce("timeout");
      const error = await client.openHostForNotice(1, notice).then(
        () => null,
        (failure: unknown) => failure
      );
      expect((error as AppError).details).toMatchObject({ code: "HOST_SWITCH_ON_SCREEN" });
      expect(client.getPendingSwitch(ctxFor(5, 1))).toMatchObject({
        hostId: "studio-01",
        phase: "failed",
        request: { projectId: "proj-1" },
      });
      expect(bindings.get(1)).toBe("local");
    });

    it("returns to the project this machine last had open there for a notice that named none", async () => {
      manager.last = { projectId: "proj-2", path: "/srv/proj-2", name: "proj-2" };
      await expect(client.openHostForNotice(1, { ...notice, projectId: null })).resolves.toEqual({
        outcome: "switched",
        hostId: "studio-01",
        projectId: "proj-2",
      });
      expect(windows.openRemoteProject).toHaveBeenCalledWith(
        1,
        "studio-01",
        "proj-2",
        "/srv/proj-2",
        undefined,
        { requesterWebContentsId: 5 }
      );
    });

    it("offers the host's project list in the window when there is nothing to return to", async () => {
      windows.notifyWindow = vi.fn();
      const projectless = { ...notice, projectId: null };
      await expect(client.openHostForNotice(1, projectless)).resolves.toEqual({
        outcome: "choose-project",
        hostId: "studio-01",
      });
      expect(windows.openRemoteProject).not.toHaveBeenCalled();
      expect(bindings.get(1)).toBe("local");
      expect(windows.notifyWindow).toHaveBeenCalledWith(1, { type: "project-offer" });
      expect(client.takeProjectOffer(ctxFor(5, 1))).toBe("studio-01");
      expect(client.takeProjectOffer(ctxFor(5, 1))).toBeNull();

      // A second click watches the window for its close once, not again.
      await client.openHostForNotice(1, projectless);
      const watches = vi.mocked(windows.watchWindow).mock.calls.filter(([id]) => id === 1);
      expect(watches).toHaveLength(1);
      watches[0][1]();
      expect(client.takeProjectOffer(ctxFor(5, 1))).toBeNull();
    });
  });

  describe("a switch that names no project", () => {
    it("returns the window to the project the host remembers for this machine", async () => {
      manager.last = { projectId: "proj-2", path: "/srv/proj-2", name: "proj-2" };
      await expect(
        client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
      ).resolves.toEqual({ outcome: "switched", hostId: "studio-01", projectId: "proj-2" });
      expect(windows.openRemoteProject).toHaveBeenCalledWith(
        1,
        "studio-01",
        "proj-2",
        "/srv/proj-2",
        undefined,
        { requesterWebContentsId: 5 }
      );
      expect(bindings.get(1)).toBe("studio-01");
      expect(manager.get("studio-01")!.noteActiveProject).toHaveBeenCalledWith("proj-2");
    });

    it("moves nothing and asks for the host's project list when there is nothing to return to", async () => {
      keys.set(5, "proj-local");
      await expect(
        client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
      ).resolves.toEqual({ outcome: "choose-project", hostId: "studio-01" });
      expect(windows.openRemoteProject).not.toHaveBeenCalled();
      // Binding and view still agree: the local view keeps running here.
      expect(bindings.get(1)).toBe("local");
      expect(router.hostForSender(5)).toBeNull();
    });

    it("treats a host that can't say as having nothing to return to", async () => {
      manager.connect("studio-01").lastActiveProject.mockRejectedValueOnce(new Error("gone"));
      await expect(
        client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
      ).resolves.toEqual({ outcome: "choose-project", hostId: "studio-01" });
    });

    it("keeps waiting for a host whose Daintree is being started, past the usual wait", async () => {
      let starting = true;
      const startingClient = new RemoteHostsClient({
        registry,
        manager: manager as unknown as RemoteHostManager,
        bindings,
        router,
        senders: { projectKeyFor: () => null, windowIdFor: (id) => (id === 5 ? 1 : null) },
        windows,
        installRouter,
        emit: () => {},
        isStarting: () => starting,
      });
      const whenReady = manager.connect("studio-01").whenReady;
      whenReady.mockResolvedValueOnce("timeout").mockImplementationOnce(async () => {
        starting = false;
        return "ready";
      });
      await expect(
        startingClient.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
      ).resolves.toEqual({ outcome: "choose-project", hostId: "studio-01" });
      expect(whenReady).toHaveBeenCalledTimes(2);

      // Not being started: the usual wait is the whole wait.
      whenReady.mockClear();
      whenReady.mockResolvedValueOnce("timeout");
      await expect(
        startingClient.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
      ).rejects.toMatchObject({ code: "HOST_DISCONNECTED" });
      expect(whenReady).toHaveBeenCalledTimes(1);
      startingClient.dispose();
    });

    it("says at once when the host answered but Daintree there isn't in Host mode", async () => {
      manager.readiness = "host-mode-off";
      await expect(
        client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
      ).rejects.toMatchObject({
        code: "HOST_MODE_OFF",
        userMessage: "Daintree isn't running in Host mode on studio-01. Set it up to work there.",
      });
      expect(bindings.get(1)).toBe("local");
    });

    it("doesn't ask to set up a host this machine has worked with: its Daintree isn't listening", async () => {
      manager.readiness = "host-mode-off";
      registry.recordObservation("studio-01", { lastSeenAt: 1_000 });
      const failure = await client
        .switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: "HOST_MODE_OFF",
        userMessage: "Daintree isn't listening on studio-01. Try again once it's running there.",
      });
    });

    it("says the host may be restarting when its Daintree stopped listening moments ago", async () => {
      manager.readiness = "timeout";
      manager.connect("studio-01").restarting = true;
      await expect(
        client.switchWindowHost(ctxFor(5, 1), {
          hostId: "studio-01",
          newWindow: false,
          projectId: "proj-1",
        })
      ).rejects.toMatchObject({
        code: "HOST_DISCONNECTED",
        userMessage:
          "Daintree on studio-01 stopped listening moments ago and hasn't come back yet. If it's restarting, try again in a moment.",
      });
      expect(bindings.get(1)).toBe("local");
    });

    it("says at once, in ssh's words, when ssh couldn't log in", async () => {
      manager.readiness = "stopped-retrying";
      const link = manager.connect("studio-01");
      link.linkState = {
        status: "unreachable",
        detail: "greg@studio-01: Permission denied (publickey).",
      } as typeof link.linkState;
      await expect(
        client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
      ).rejects.toMatchObject({
        code: "HOST_SSH_ACCESS_DENIED",
        userMessage: expect.stringContaining("greg@studio-01: Permission denied (publickey)"),
      });
      expect(bindings.get(1)).toBe("local");

      // Not a new window either: it could never show the host.
      await expect(
        client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: true })
      ).rejects.toMatchObject({ code: "HOST_SSH_ACCESS_DENIED" });
    });

    it("refuses when the host never answers, rather than moving the window blind", async () => {
      manager.readiness = "unreachable";
      await expect(
        client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
      ).rejects.toMatchObject({ code: "HOST_DISCONNECTED" });
      expect(bindings.get(1)).toBe("local");
    });

    it("opens a new window here that offers the host's projects when there is nothing to return to", async () => {
      manager.readiness = "unreachable";
      windows.offerHostProjects = vi.fn();
      await expect(
        client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: true })
      ).resolves.toEqual({ outcome: "window-opened", hostId: "studio-01" });
      // Not bound until a project is picked: a bound window with no host view
      // routed to the host while everything on screen said This Mac.
      expect(bindings.get(7)).toBe("local");
      expect(windows.offerHostProjects).toHaveBeenCalledWith(7);
      expect(windows.openRemoteProject).not.toHaveBeenCalled();
      // The new window's view asks once it can show the list, and gets it once.
      expect(client.takeProjectOffer(ctxFor(9, 7))).toBe("studio-01");
      expect(client.takeProjectOffer(ctxFor(9, 7))).toBeNull();
      // Another window was never offered anything.
      expect(client.takeProjectOffer(ctxFor(5, 1))).toBeNull();
    });

    it("drops a window's project offer when it closes, or when its host is removed", async () => {
      manager.readiness = "unreachable";
      await client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: true });
      const closed = vi.mocked(windows.watchWindow).mock.calls.find(([id]) => id === 7)![1];
      closed();
      expect(client.takeProjectOffer(ctxFor(9, 7))).toBeNull();

      await client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: true });
      registry.forget("studio-01");
      expect(client.takeProjectOffer(ctxFor(9, 7))).toBeNull();
    });

    it("returns to this window's own last project on the host before the host's memory of this machine", async () => {
      manager.last = { projectId: "proj-2", path: "/srv/proj-2", name: "proj-2" };
      windows.recentProjectsOnHost = vi.fn(() => ["proj-9"]);
      await expect(
        client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
      ).resolves.toEqual({ outcome: "switched", hostId: "studio-01", projectId: "proj-9" });
      expect(windows.recentProjectsOnHost).toHaveBeenCalledWith(1, "studio-01");

      // Gone from the host since: the host's memory answers instead.
      manager.connect("studio-01").describeProject.mockResolvedValueOnce(null);
      await client.switchWindowHost(ctxFor(5, 1), { hostId: "local", newWindow: false });
      await expect(
        client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
      ).resolves.toEqual({ outcome: "switched", hostId: "studio-01", projectId: "proj-2" });
    });

    it("asks about all of this window's projects there at once, and returns to the newest", async () => {
      manager.last = null;
      windows.recentProjectsOnHost = vi.fn(() => ["proj-9", "proj-8"]);
      const answers = new Map<
        string,
        (description: { projectId: string; path: string; name: string }) => void
      >();
      manager
        .connect("studio-01")
        .describeProject.mockImplementation(
          (projectId: string) => new Promise((resolve) => answers.set(projectId, resolve))
        );
      const switching = client.switchWindowHost(ctxFor(5, 1), {
        hostId: "studio-01",
        newWindow: false,
      });
      await vi.waitFor(() => expect([...answers.keys()]).toEqual(["proj-9", "proj-8"]));
      answers.get("proj-8")!({ projectId: "proj-8", path: "/srv/proj-8", name: "proj-8" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(windows.openRemoteProject).not.toHaveBeenCalled();
      answers.get("proj-9")!({ projectId: "proj-9", path: "/srv/proj-9", name: "proj-9" });
      await expect(switching).resolves.toEqual({
        outcome: "switched",
        hostId: "studio-01",
        projectId: "proj-9",
      });
    });

    it("walks past this window's projects the host no longer has, and forgets them", async () => {
      manager.last = { projectId: "proj-2", path: "/srv/proj-2", name: "proj-2" };
      getProjectHistory(1).record(toHostScopedKey("studio-01", "proj-gone"));
      windows.recentProjectsOnHost = vi.fn(() => ["proj-gone", "proj-8"]);
      manager
        .connect("studio-01")
        .describeProject.mockImplementation(async (projectId: string) =>
          projectId === "proj-gone"
            ? null
            : { projectId, path: `/srv/${projectId}`, name: projectId }
        );
      await expect(
        client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
      ).resolves.toEqual({ outcome: "switched", hostId: "studio-01", projectId: "proj-8" });
      expect(getProjectHistory(1).snapshot().entries).not.toContain(
        toHostScopedKey("studio-01", "proj-gone")
      );
    });

    it("walks on past a project another window started showing while the host was answering", async () => {
      manager.last = null;
      windows.recentProjectsOnHost = vi.fn(() => ["proj-9", "proj-8"]);
      let shownIn2 = false;
      windows.projectOwner = vi.fn((_host: string, projectId: string) =>
        projectId === "proj-9" && shownIn2 ? { windowId: 2, showing: true } : null
      );
      manager.connect("studio-01").describeProject.mockImplementation(async (projectId: string) => {
        if (projectId === "proj-9") shownIn2 = true;
        return { projectId, path: `/srv/${projectId}`, name: projectId };
      });
      await expect(
        client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
      ).resolves.toEqual({ outcome: "switched", hostId: "studio-01", projectId: "proj-8" });
    });

    it("brings no window forward when the project it resumed was taken while it waited its turn", async () => {
      windows.recentProjectsOnHost = vi.fn(() => ["proj-9"]);
      let shownIn2 = false;
      windows.projectOwner = vi.fn(() => (shownIn2 ? { windowId: 2, showing: true } : null));
      windows.revealWindow = vi.fn();
      // The window is still busy with an earlier switch when this one resolves its project.
      let finishFirst: () => void = () => {};
      vi.mocked(windows.openRemoteProject).mockImplementationOnce(
        () => new Promise<void>((resolve) => (finishFirst = resolve))
      );
      const first = client.switchWindowToHostProject(1, "studio-01", "proj-1");
      await vi.waitFor(() => expect(windows.openRemoteProject).toHaveBeenCalledTimes(1));
      const second = client.switchWindowHost(ctxFor(5, 1), {
        hostId: "studio-01",
        newWindow: false,
      });
      await vi.waitFor(() =>
        expect(manager.connect("studio-01").describeProject).toHaveBeenCalledWith("proj-9")
      );
      // Every wait before its turn settles; the switch now queues behind the first.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(windows.revealWindow).not.toHaveBeenCalled();
      shownIn2 = true;
      finishFirst();
      await first;
      await expect(second).resolves.toEqual({ outcome: "choose-project", hostId: "studio-01" });
      expect(windows.revealWindow).not.toHaveBeenCalled();
      expect(windows.openRemoteProject).toHaveBeenCalledTimes(1);
    });

    it("walks the whole of this window's history on the host before the host's memory", async () => {
      manager.last = { projectId: "proj-2", path: "/srv/proj-2", name: "proj-2" };
      const gone = ["g1", "g2", "g3", "g4", "g5", "g6"];
      windows.recentProjectsOnHost = vi.fn(() => [...gone, "proj-7"]);
      manager
        .connect("studio-01")
        .describeProject.mockImplementation(async (projectId: string) =>
          gone.includes(projectId)
            ? null
            : { projectId, path: `/srv/${projectId}`, name: projectId }
        );
      await expect(
        client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
      ).resolves.toEqual({ outcome: "switched", hostId: "studio-01", projectId: "proj-7" });
    });

    it("never resumes a project another window is showing, the host's memory included", async () => {
      manager.last = { projectId: "proj-2", path: "/srv/proj-2", name: "proj-2" };
      windows.recentProjectsOnHost = vi.fn(() => ["proj-9"]);
      windows.projectOwner = vi.fn((_host: string, projectId: string) =>
        projectId === "proj-9" || projectId === "proj-2" ? { windowId: 2, showing: true } : null
      );
      windows.revealWindow = vi.fn();
      await expect(
        client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
      ).resolves.toEqual({ outcome: "choose-project", hostId: "studio-01" });
      expect(windows.revealWindow).not.toHaveBeenCalled();
      expect(windows.openRemoteProject).not.toHaveBeenCalled();
      expect(bindings.get(2)).toBe("local");
    });

    it("opens a new window on the host even when the host remembers the asking window's project", async () => {
      manager.last = { projectId: "proj-2", path: "/srv/proj-2", name: "proj-2" };
      // Window 1, the one asking, is showing proj-2: the new window is no owner lookup's "elsewhere".
      windows.projectOwner = vi.fn(() => ({ windowId: 1, showing: true }));
      windows.revealWindow = vi.fn();
      await expect(
        client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: true })
      ).resolves.toEqual({ outcome: "window-opened", hostId: "studio-01" });
      expect(windows.openWindow).toHaveBeenCalled();
      expect(windows.revealWindow).not.toHaveBeenCalled();
      expect(client.takeProjectOffer(ctxFor(9, 7))).toBe("studio-01");
    });

    it("returns to this machine's last project, or asks for its list", async () => {
      manager.last = { projectId: "proj-2", path: "/srv/proj-2", name: "proj-2" };
      await client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false });

      vi.mocked(windows.lastLocalProjectId).mockReturnValueOnce("local-a");
      await expect(
        client.switchWindowHost(ctxFor(5, 1), { hostId: "local", newWindow: false })
      ).resolves.toEqual({ outcome: "switched", hostId: "local", projectId: "local-a" });
      expect(windows.lastLocalProjectId).toHaveBeenLastCalledWith(1);
      expect(windows.openLocalProject).toHaveBeenCalledWith(1, "local-a", undefined, {
        requesterWebContentsId: 5,
      });
      expect(bindings.get(1)).toBe("local");

      await expect(
        client.switchWindowHost(ctxFor(5, 1), { hostId: "local", newWindow: false })
      ).resolves.toEqual({ outcome: "choose-project", hostId: "local" });
    });

    describe("from a window showing a project (#14564)", () => {
      const copy = (projectId: string, path = `/srv/${projectId}`) => ({
        projectId,
        name: "App",
        path,
      });
      /** Whether `work` settles well inside the lookup's 3 s deadline. */
      const promptly = <T>(work: Promise<T>) =>
        Promise.race([
          work,
          new Promise<"still waiting">((resolve) =>
            setTimeout(() => resolve("still waiting"), 500)
          ),
        ]);
      let copiesOnHost: Mock<HostSwitchService["copiesOn"]>;

      beforeEach(() => {
        copiesOnHost = vi.fn<HostSwitchService["copiesOn"]>(async () => []);
        registerRemoteService("hostSwitchService", {
          copiesOn: copiesOnHost,
        } as unknown as HostSwitchService);
        keys.set(5, "proj-local");
        manager.last = { projectId: "proj-2", path: "/srv/proj-2", name: "proj-2" };
        windows.recentProjectsOnHost = vi.fn((windowId: number | null) =>
          windowId === 1 ? ["proj-9"] : []
        );
      });

      afterEach(() => _resetRemoteServicesForTest());

      it("lands on that project's copy on the host, ahead of anything to return to", async () => {
        copiesOnHost.mockResolvedValueOnce([copy("proj-copy")]);
        await expect(
          client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
        ).resolves.toEqual({ outcome: "switched", hostId: "studio-01", projectId: "proj-copy" });
        expect(copiesOnHost).toHaveBeenCalledWith(
          { hostId: "local", projectId: "proj-local" },
          "studio-01"
        );
        expect(windows.openRemoteProject).toHaveBeenCalledWith(
          1,
          "studio-01",
          "proj-copy",
          "/srv/proj-copy",
          undefined,
          { requesterWebContentsId: 5 }
        );
        // The window's past there and the host's memory were asked alongside; the copy comes first.
        expect(windows.openRemoteProject).toHaveBeenCalledTimes(1);
      });

      it("asks where to return while the copy lookup is still out, and lands once it comes back empty", async () => {
        windows.recentProjectsOnHost = vi.fn(() => []);
        const order: string[] = [];
        const link = manager.connect("studio-01");
        link.lastActiveProject.mockImplementationOnce(async () => {
          order.push("last asked");
          return manager.last;
        });
        let answer: (copies: ReturnType<typeof copy>[]) => void = () => {};
        copiesOnHost.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
        const switching = client.switchWindowHost(ctxFor(5, 1), {
          hostId: "studio-01",
          newWindow: false,
        });
        await vi.waitFor(() => expect(order).toEqual(["last asked"]));
        expect(windows.openRemoteProject).not.toHaveBeenCalled();
        order.push("copies answered");
        answer([]);
        await expect(promptly(switching)).resolves.toEqual({
          outcome: "switched",
          hostId: "studio-01",
          projectId: "proj-2",
        });
        expect(order).toEqual(["last asked", "copies answered"]);
        expect(link.lastActiveProject).toHaveBeenCalledTimes(1);
      });

      it("still lands on a copy the host names after it named the project it remembers", async () => {
        let answer: (copies: ReturnType<typeof copy>[]) => void = () => {};
        copiesOnHost.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
        const switching = client.switchWindowHost(ctxFor(5, 1), {
          hostId: "studio-01",
          newWindow: false,
        });
        const link = manager.connect("studio-01");
        await vi.waitFor(() => expect(link.lastActiveProject).toHaveBeenCalled());
        await link.lastActiveProject.mock.results[0]!.value;
        answer([copy("proj-copy")]);
        await expect(switching).resolves.toEqual({
          outcome: "switched",
          hostId: "studio-01",
          projectId: "proj-copy",
        });
        expect(windows.openRemoteProject).toHaveBeenCalledTimes(1);
      });

      it("lands on a host's copy the first time, with nothing there to return to", async () => {
        manager.last = null;
        windows.recentProjectsOnHost = vi.fn(() => []);
        copiesOnHost.mockResolvedValueOnce([copy("proj-copy")]);
        await expect(
          client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
        ).resolves.toEqual({ outcome: "switched", hostId: "studio-01", projectId: "proj-copy" });
      });

      it("takes the copy this window was in most recently when the host has several", async () => {
        copiesOnHost.mockResolvedValueOnce([
          copy("proj-b", "/srv/b"),
          copy("proj-c", "/srv/c"),
          copy("proj-a", "/srv/a"),
        ]);
        windows.recentProjectsOnHost = vi.fn(() => ["proj-9", "proj-c", "proj-b"]);
        await expect(
          client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
        ).resolves.toEqual({ outcome: "switched", hostId: "studio-01", projectId: "proj-c" });

        // None of them in this window's history: the first by path, as the sidebar's row opens.
        copiesOnHost.mockResolvedValueOnce([copy("proj-a", "/srv/z"), copy("proj-z", "/srv/a")]);
        windows.recentProjectsOnHost = vi.fn(() => ["proj-9"]);
        await expect(
          client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
        ).resolves.toEqual({ outcome: "switched", hostId: "studio-01", projectId: "proj-z" });
      });

      it("never lands on a copy with no path", async () => {
        copiesOnHost.mockResolvedValueOnce([copy("proj-blank", ""), copy("proj-copy", "/srv/z")]);
        await expect(
          client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
        ).resolves.toEqual({ outcome: "switched", hostId: "studio-01", projectId: "proj-copy" });

        keys.set(5, toHostScopedKey("studio-01", "proj-copy"));
        vi.mocked(windows.lastLocalProjectId).mockReturnValue("local-a");
        copiesOnHost.mockResolvedValueOnce([copy("local-blank", "")]);
        await expect(
          client.switchWindowHost(ctxFor(5, 1), { hostId: "local", newWindow: false })
        ).resolves.toEqual({ outcome: "switched", hostId: "local", projectId: "local-a" });
      });

      it("returns where it would have when the host has no copy, or can't say", async () => {
        copiesOnHost.mockResolvedValueOnce([]);
        await expect(
          client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
        ).resolves.toEqual({ outcome: "switched", hostId: "studio-01", projectId: "proj-9" });

        copiesOnHost.mockResolvedValueOnce(null);
        windows.recentProjectsOnHost = vi.fn(() => []);
        await expect(
          client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
        ).resolves.toEqual({ outcome: "switched", hostId: "studio-01", projectId: "proj-2" });

        copiesOnHost.mockRejectedValueOnce(new Error("link dropped"));
        manager.last = null;
        await expect(
          client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
        ).resolves.toEqual({ outcome: "choose-project", hostId: "studio-01" });
      });

      it("passes over a copy another window is showing, and never brings that window forward", async () => {
        copiesOnHost.mockResolvedValue([copy("proj-copy")]);
        windows.projectOwner = vi.fn((_host: string, projectId: string) =>
          projectId === "proj-copy" ? { windowId: 2, showing: true } : null
        );
        windows.revealWindow = vi.fn();
        await expect(
          client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
        ).resolves.toEqual({ outcome: "switched", hostId: "studio-01", projectId: "proj-9" });

        // Nothing else to land on: the host's project list, still not the other window.
        windows.recentProjectsOnHost = vi.fn(() => []);
        manager.last = null;
        await expect(
          client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
        ).resolves.toEqual({ outcome: "choose-project", hostId: "studio-01" });
        expect(windows.revealWindow).not.toHaveBeenCalled();
        expect(windows.openRemoteProject).not.toHaveBeenCalledWith(
          expect.anything(),
          "studio-01",
          "proj-copy",
          expect.anything(),
          undefined,
          expect.anything()
        );
      });

      it("takes a free copy past one another window is showing", async () => {
        copiesOnHost.mockResolvedValueOnce([
          copy("proj-taken", "/srv/a"),
          copy("proj-free", "/srv/b"),
        ]);
        windows.recentProjectsOnHost = vi.fn(() => ["proj-taken", "proj-9"]);
        windows.projectOwner = vi.fn((_host: string, projectId: string) =>
          projectId === "proj-taken" ? { windowId: 2, showing: true } : null
        );
        windows.revealWindow = vi.fn();
        await expect(
          client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
        ).resolves.toEqual({ outcome: "switched", hostId: "studio-01", projectId: "proj-free" });
        expect(windows.revealWindow).not.toHaveBeenCalled();
      });

      it("passes over a copy another window started showing while the host was answering", async () => {
        let shownIn2 = false;
        windows.projectOwner = vi.fn((_host: string, projectId: string) =>
          projectId === "proj-copy" && shownIn2 ? { windowId: 2, showing: true } : null
        );
        copiesOnHost.mockImplementationOnce(async () => {
          shownIn2 = true;
          return [copy("proj-copy")];
        });
        await expect(
          client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
        ).resolves.toEqual({ outcome: "switched", hostId: "studio-01", projectId: "proj-9" });
      });

      it("looks for no copy for a new window, a named project, a scratch, or the host it is on", async () => {
        copiesOnHost.mockResolvedValue([copy("proj-copy")]);
        // A new window has no history of its own there: the host's memory, in window 7.
        await expect(
          client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: true })
        ).resolves.toEqual({ outcome: "switched", hostId: "studio-01", projectId: "proj-2" });
        expect(windows.openRemoteProject).toHaveBeenLastCalledWith(
          7,
          "studio-01",
          "proj-2",
          "/srv/proj-2"
        );
        expect(bindings.get(1)).toBe("local");

        await expect(
          client.switchWindowHost(ctxFor(5, 1), {
            hostId: "studio-01",
            newWindow: false,
            projectId: "proj-1",
          })
        ).resolves.toEqual({ outcome: "switched", hostId: "studio-01", projectId: "proj-1" });

        keys.set(5, "6f1c2b9e-3a4d-4c5e-8f60-1a2b3c4d5e6f");
        await expect(
          client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
        ).resolves.toEqual({ outcome: "switched", hostId: "studio-01", projectId: "proj-9" });

        keys.set(5, toHostScopedKey("studio-01", "proj-1"));
        await expect(
          client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
        ).resolves.toEqual({ outcome: "switched", hostId: "studio-01", projectId: "proj-9" });
        expect(copiesOnHost).not.toHaveBeenCalled();
      });

      it("looks for no copy when the asking view is parked in the window's cache", async () => {
        windows.showsView = vi.fn(() => false);
        copiesOnHost.mockResolvedValue([copy("proj-copy")]);
        await expect(
          client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
        ).resolves.toEqual({ outcome: "switched", hostId: "studio-01", projectId: "proj-9" });
        expect(windows.showsView).toHaveBeenCalledWith(1, 5);
        expect(copiesOnHost).not.toHaveBeenCalled();
      });

      it("returns where it would have when the host doesn't say in time", async () => {
        const slowClient = new RemoteHostsClient({
          registry,
          manager: manager as unknown as RemoteHostManager,
          bindings,
          router,
          senders: {
            projectKeyFor: () => "proj-local",
            windowIdFor: (id) => (id === 5 ? 1 : null),
          },
          windows,
          installRouter,
          emit: () => {},
          copyLookupTimeoutMs: 10,
        });
        try {
          let answer: (copies: ReturnType<typeof copy>[]) => void = () => {};
          copiesOnHost.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
          await expect(
            slowClient.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
          ).resolves.toEqual({ outcome: "switched", hostId: "studio-01", projectId: "proj-9" });
          // Its answer, late, moves nothing.
          answer([copy("proj-copy")]);
          await new Promise((resolve) => setTimeout(resolve, 0));
          expect(windows.openRemoteProject).toHaveBeenCalledTimes(1);
        } finally {
          await slowClient.dispose();
        }
      });

      it("lands a host's project on this machine's copy of it", async () => {
        keys.set(5, toHostScopedKey("studio-01", "proj-1"));
        vi.mocked(windows.lastLocalProjectId).mockReturnValue("local-a");
        copiesOnHost.mockResolvedValueOnce([copy("local-copy")]);
        await expect(
          client.switchWindowHost(ctxFor(5, 1), { hostId: "local", newWindow: false })
        ).resolves.toEqual({ outcome: "switched", hostId: "local", projectId: "local-copy" });
        expect(copiesOnHost).toHaveBeenCalledWith(
          { hostId: "studio-01", projectId: "proj-1" },
          "local"
        );
        expect(windows.openLocalProject).toHaveBeenCalledWith(1, "local-copy", undefined, {
          requesterWebContentsId: 5,
        });

        // No copy here: this machine's last project, as before.
        copiesOnHost.mockResolvedValueOnce([]);
        await expect(
          client.switchWindowHost(ctxFor(5, 1), { hostId: "local", newWindow: false })
        ).resolves.toEqual({ outcome: "switched", hostId: "local", projectId: "local-a" });
      });

      it("passes over this machine's copy while another window is showing it", async () => {
        keys.set(5, toHostScopedKey("studio-01", "proj-1"));
        vi.mocked(windows.lastLocalProjectId).mockReturnValue("local-a");
        windows.projectOwner = vi.fn((_host: string, projectId: string) =>
          projectId === "local-copy" ? { windowId: 2, showing: true } : null
        );
        windows.redirectToLocalOwner = vi.fn((projectId: string) =>
          projectId === "local-copy" ? 2 : null
        );
        windows.revealWindow = vi.fn();
        copiesOnHost.mockResolvedValueOnce([copy("local-copy")]);
        await expect(
          client.switchWindowHost(ctxFor(5, 1), { hostId: "local", newWindow: false })
        ).resolves.toEqual({ outcome: "switched", hostId: "local", projectId: "local-a" });
        expect(windows.redirectToLocalOwner).not.toHaveBeenCalledWith(
          "local-copy",
          expect.anything()
        );
        expect(windows.revealWindow).not.toHaveBeenCalled();
      });

      it("gives way to a newer switch made while the host was looking for its copy", async () => {
        let answer: (copies: ReturnType<typeof copy>[]) => void = () => {};
        copiesOnHost.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
        const first = client.switchWindowHost(ctxFor(5, 1), {
          hostId: "studio-01",
          newWindow: false,
        });
        await vi.waitFor(() => expect(copiesOnHost).toHaveBeenCalledTimes(1));
        vi.mocked(windows.lastLocalProjectId).mockReturnValueOnce("local-a");
        const second = client.switchWindowHost(ctxFor(5, 1), { hostId: "local", newWindow: false });
        await expect(promptly(first)).resolves.toEqual({
          outcome: "superseded",
          hostId: "studio-01",
        });
        answer([copy("proj-copy")]);
        await expect(second).resolves.toEqual({
          outcome: "switched",
          hostId: "local",
          projectId: "local-a",
        });
        expect(windows.openRemoteProject).not.toHaveBeenCalled();
      });

      it("gives way at once to a Cancel while the host is looking for its copy", async () => {
        let answer: (copies: ReturnType<typeof copy>[]) => void = () => {};
        copiesOnHost.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
        const switching = client.switchWindowHost(ctxFor(5, 1), {
          hostId: "studio-01",
          newWindow: false,
        });
        await vi.waitFor(() => expect(copiesOnHost).toHaveBeenCalledTimes(1));
        const { switchId } = client.getPendingSwitch(ctxFor(5, 1))!;
        expect(client.cancelPendingSwitch(ctxFor(5, 1), { switchId })).toBe(true);
        await expect(promptly(switching)).resolves.toEqual({
          outcome: "superseded",
          hostId: "studio-01",
        });
        answer([copy("proj-copy")]);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(windows.openRemoteProject).not.toHaveBeenCalled();
        expect(bindings.get(1)).toBe("local");
        expect(client.getPendingSwitch(ctxFor(5, 1))).toBeNull();
      });

      it("lands nowhere when the host is removed while it looks for its copy", async () => {
        let answer: (copies: ReturnType<typeof copy>[]) => void = () => {};
        copiesOnHost.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
        const switching = client.switchWindowHost(ctxFor(5, 1), {
          hostId: "studio-01",
          newWindow: false,
        });
        await vi.waitFor(() => expect(copiesOnHost).toHaveBeenCalledTimes(1));
        const link = manager.get("studio-01")!;
        await client.forget({ hostId: "studio-01" });
        answer([]);
        await expect(switching).resolves.toEqual({ outcome: "superseded", hostId: "studio-01" });
        // Its other lookups were out already; what they answered opens nothing.
        await Promise.all(
          [...link.lastActiveProject.mock.results, ...link.describeProject.mock.results].map(
            (result) => result.value
          )
        );
        expect(windows.openRemoteProject).not.toHaveBeenCalled();
        expect(bindings.get(1)).toBe("local");
      });
    });
  });

  it("tells the host which project a switch showed, and only once it showed", async () => {
    await client.switchWindowHost(ctxFor(5, 1), {
      hostId: "studio-01",
      newWindow: false,
      projectId: "proj-1",
    });
    const connection = manager.get("studio-01")!;
    expect(connection.noteActiveProject).toHaveBeenCalledWith("proj-1");

    vi.mocked(windows.openRemoteProject).mockRejectedValueOnce(new Error("view failed"));
    await expect(
      client.switchWindowHost(ctxFor(5, 1), {
        hostId: "studio-01",
        newWindow: false,
        projectId: "proj-2",
      })
    ).rejects.toThrow("view failed");
    expect(connection.noteActiveProject).not.toHaveBeenCalledWith("proj-2");
  });

  it("opens a new window for a Cmd/Ctrl-click and leaves the current one alone", async () => {
    manager.last = { projectId: "proj-9", path: "/srv/proj-9", name: "proj-9" };
    await client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: true });
    expect(windows.openWindow).toHaveBeenCalled();
    expect(bindings.get(7)).toBe("studio-01");
    expect(bindings.get(1)).toBe("local");
    expect(windows.watchWindow).toHaveBeenCalledWith(7, expect.any(Function));
  });

  it("refuses to attach to a host that runs a different build", async () => {
    manager.status = "version-mismatch";
    await expect(
      client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
    ).rejects.toMatchObject({ code: "HOST_VERSION_MISMATCH" });
    expect(bindings.get(1)).toBe("local");
  });

  it("rejects unknown hosts and malformed payloads", async () => {
    await expect(
      client.switchWindowHost(ctxFor(5, 1), { hostId: "nope", newWindow: false })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      client.switchWindowHost(ctxFor(5, 1), {
        hostId: "studio-01",
        newWindow: false,
        projectId: 42 as never,
      })
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("switches a window back to this machine", async () => {
    manager.last = { projectId: "proj-9", path: "/srv/proj-9", name: "proj-9" };
    await client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false });
    await client.switchWindowHost(ctxFor(5, 1), {
      hostId: "local",
      newWindow: false,
      projectId: "abc",
    });
    expect(bindings.get(1)).toBe("local");
    expect(windows.openLocalProject).toHaveBeenCalledWith(1, "abc", undefined, {
      requesterWebContentsId: 5,
    });
  });

  it("brings a window on a host back to this machine to show a local project", async () => {
    await client.switchWindowHost(ctxFor(5, 1), {
      hostId: "studio-01",
      newWindow: false,
      projectId: "proj-1",
    });
    await expect(client.switchWindowToLocal(1, "abc")).resolves.toEqual({
      outcome: "switched",
      hostId: "local",
      projectId: "abc",
    });
    expect(bindings.get(1)).toBe("local");
    expect(windows.openLocalProject).toHaveBeenCalledWith(1, "abc");
  });

  it("lets main's switch back to this machine supersede a host switch still waiting on its link", async () => {
    let releaseSlow!: (value: string) => void;
    manager
      .connect("studio-01")
      .whenReady.mockImplementationOnce(
        () => new Promise<string>((resolve) => (releaseSlow = resolve))
      );
    const slow = client.switchWindowHost(ctxFor(5, 1), {
      hostId: "studio-01",
      newWindow: false,
      projectId: "proj-1",
    });
    await vi.waitFor(() => expect(releaseSlow).toBeTypeOf("function"));

    await expect(client.switchWindowToLocal(1, "abc")).resolves.toEqual({
      outcome: "switched",
      hostId: "local",
      projectId: "abc",
    });
    releaseSlow("ready");

    await expect(slow).resolves.toEqual({ outcome: "superseded", hostId: "studio-01" });
    expect(windows.openRemoteProject).not.toHaveBeenCalled();
    expect(bindings.get(1)).toBe("local");
  });

  it("keeps the window on its host when the local view can't be shown", async () => {
    await client.switchWindowHost(ctxFor(5, 1), {
      hostId: "studio-01",
      newWindow: false,
      projectId: "proj-1",
    });
    vi.mocked(windows.openLocalProject).mockRejectedValueOnce(new Error("view failed"));
    await expect(client.switchWindowToLocal(1, "abc")).rejects.toThrow("view failed");
    expect(bindings.get(1)).toBe("studio-01");
  });

  describe("a switch to a project whose path this Shell already has (#15894)", () => {
    const held = toHostScopedKey("studio-01", "proj-1");
    /** What each window shows, as its view manager would say. */
    let shown: Map<number, string | null>;
    let order: string[];

    beforeEach(() => {
      shown = new Map([[1, "proj-local"]]);
      order = [];
      windows.shownProjectKey = vi.fn((windowId: number) => shown.get(windowId) ?? null);
      windows.reusableRemoteViewPath = vi.fn((windowId: number, hostId: string, projectId: string) =>
        windowId === 1 && hostId === "studio-01" && projectId === "proj-1" ? "/srv/held" : null
      );
      windows.discardCachedView = vi.fn();
      windows.notifyWindow = vi.fn();
      windows.replaceWithLocalWindow = vi.fn(async () => 8);
      windows.openRemoteProject = vi.fn(
        async (windowId: number, hostId: string, projectId: string) => {
          order.push("open");
          shown.set(windowId, toHostScopedKey(hostId, projectId));
        }
      );
      windows.openLocalProject = vi.fn(async (windowId: number, projectId: string) => {
        shown.set(windowId, projectId);
      });
      manager
        .connect("studio-01")
        .describeProject.mockImplementation(async (projectId: string) => {
          order.push("describe");
          return { projectId, path: `/srv/${projectId}`, name: projectId };
        });
    });

    afterEach(() => {
      disposeProjectHistory(1);
      resetProjectHistory(1);
    });

    const switchTo = (projectId: string) =>
      client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false, projectId });
    const hostSaysGone = () =>
      manager.get("studio-01")!.describeProject.mockImplementation(async () => {
        order.push("describe");
        return null;
      });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    it("swaps to the view this window holds of it before asking the host anything", async () => {
      await expect(switchTo("proj-1")).resolves.toEqual({
        outcome: "switched",
        hostId: "studio-01",
        projectId: "proj-1",
      });
      expect(windows.openRemoteProject).toHaveBeenCalledWith(
        1,
        "studio-01",
        "proj-1",
        "/srv/held",
        undefined,
        { requesterWebContentsId: 5 }
      );
      await settle();
      expect(order).toEqual(["open", "describe"]);
      expect(bindings.get(1)).toBe("studio-01");
      expect(windows.openLocalProject).not.toHaveBeenCalled();
    });

    it("takes the window back, and offers the host's projects, when the host says it is gone", async () => {
      getProjectHistory(1).record(held);
      hostSaysGone();
      await expect(switchTo("proj-1")).resolves.toMatchObject({ outcome: "switched" });
      await vi.waitFor(() =>
        expect(windows.notifyWindow).toHaveBeenCalledWith(1, { type: "project-offer" })
      );
      expect(order).toEqual(["open", "describe"]);
      expect(windows.openLocalProject).toHaveBeenCalledWith(1, "proj-local");
      expect(shown.get(1)).toBe("proj-local");
      expect(bindings.get(1)).toBe("local");
      expect(windows.discardCachedView).toHaveBeenCalledWith(1, "studio-01", "proj-1");
      expect(client.takeProjectOffer(ctxFor(5, 1))).toBe("studio-01");
      expect(getProjectHistory(1).snapshot().entries).not.toContain(held);
    });

    it("leaves a window the person has moved on from where they put it", async () => {
      let answer: (description: null) => void = () => {};
      manager
        .get("studio-01")!
        .describeProject.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
      await switchTo("proj-1");
      await client.switchWindowHost(ctxFor(5, 1), {
        hostId: "local",
        newWindow: false,
        projectId: "proj-other",
      });
      answer(null);
      await settle();
      expect(shown.get(1)).toBe("proj-other");
      expect(windows.openLocalProject).toHaveBeenCalledTimes(1);
      expect(windows.notifyWindow).not.toHaveBeenCalledWith(1, { type: "project-offer" });
    });

    it("keeps the view up when the host can't say", async () => {
      manager
        .get("studio-01")!
        .describeProject.mockRejectedValue(new AppError({ code: "OUTCOME_UNKNOWN", message: "No answer in time" }));
      await switchTo("proj-1");
      await settle();
      expect(shown.get(1)).toBe(held);
      expect(bindings.get(1)).toBe("studio-01");
      expect(windows.openLocalProject).not.toHaveBeenCalled();
      expect(windows.discardCachedView).not.toHaveBeenCalled();
    });

    it("opens a project at the path the host's listing just named", async () => {
      windows.reusableRemoteViewPath = vi.fn(() => null);
      await client.listHostProjects({ hostId: "studio-01" });
      await switchTo("proj-1");
      expect(windows.openRemoteProject).toHaveBeenCalledWith(
        1,
        "studio-01",
        "proj-1",
        "/srv/app",
        undefined,
        { requesterWebContentsId: 5 }
      );
      await settle();
      expect(order).toEqual(["open", "describe"]);
    });

    it("asks the host first once its listing is no longer recent", async () => {
      windows.reusableRemoteViewPath = vi.fn(() => null);
      await client.listHostProjects({ hostId: "studio-01" });
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now + 5 * 60_000);
      try {
        await switchTo("proj-1");
      } finally {
        clock.mockRestore();
      }
      expect(order).toEqual(["describe", "open"]);
      expect(windows.openRemoteProject).toHaveBeenCalledWith(
        1,
        "studio-01",
        "proj-1",
        "/srv/proj-1",
        undefined,
        { requesterWebContentsId: 5 }
      );
    });

    it("puts a new window opened on a listed project that is gone back on this machine, offering the list", async () => {
      windows.reusableRemoteViewPath = vi.fn(() => null);
      await client.listHostProjects({ hostId: "studio-01" });
      hostSaysGone();
      await expect(
        client.switchWindowHost(ctxFor(5, 1), {
          hostId: "studio-01",
          newWindow: true,
          projectId: "proj-1",
        })
      ).resolves.toMatchObject({ outcome: "switched" });
      await vi.waitFor(() =>
        expect(windows.notifyWindow).toHaveBeenCalledWith(8, { type: "project-offer" })
      );
      expect(windows.replaceWithLocalWindow).toHaveBeenCalledWith(7);
      expect(shown.get(1)).toBe("proj-local");
    });

    it("opens what the host's own answer named without asking it again", async () => {
      await client.switchWindowHost(
        ctxFor(5, 1),
        { hostId: "studio-01", newWindow: false, projectId: "proj-2" },
        { known: { path: "/srv/answered", name: "Answered" } }
      );
      expect(windows.openRemoteProject).toHaveBeenCalledWith(
        1,
        "studio-01",
        "proj-2",
        "/srv/answered",
        undefined,
        { requesterWebContentsId: 5 }
      );
      await settle();
      expect(order).toEqual(["open"]);
    });
  });

  describe("cold opens at critical memory pressure (#13638)", () => {
    it("asks before opening a new window, and opens none on Cancel", async () => {
      windows.admitProjectOpen = vi.fn(async () => false);

      await expect(
        client.switchWindowHost(ctxFor(5, 1), {
          hostId: "studio-01",
          newWindow: true,
          projectId: "proj-2",
        })
      ).resolves.toEqual({ outcome: "superseded", hostId: "studio-01" });

      expect(windows.admitProjectOpen).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          windowId: null,
          askingWindowId: 1,
          hostId: "studio-01",
          projectId: "proj-2",
        })
      );
      expect(windows.openWindow).not.toHaveBeenCalled();
      expect(windows.openRemoteProject).not.toHaveBeenCalled();
    });

    it("never asks about a new window that only offers a host's project list", async () => {
      windows.admitProjectOpen = vi.fn(async () => false);

      await expect(
        client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: true })
      ).resolves.toEqual({ outcome: "window-opened", hostId: "studio-01" });

      expect(windows.admitProjectOpen).not.toHaveBeenCalled();
      expect(windows.openWindow).toHaveBeenCalledOnce();
    });

    it("closes a question a newer switch in the window made moot, which then goes ahead", async () => {
      let signal: AbortSignal | undefined;
      windows.admitProjectOpen = vi.fn(
        (request: { signal?: AbortSignal }) =>
          new Promise<boolean>((resolve) => {
            signal = request.signal;
            request.signal?.addEventListener("abort", () => resolve(false));
          })
      );
      const first = client.switchWindowHost(ctxFor(5, 1), {
        hostId: "local",
        newWindow: false,
        projectId: "abc",
      });
      await vi.waitFor(() => expect(signal).toBeDefined());

      windows.admitProjectOpen = vi.fn(async () => true);
      await expect(
        client.switchWindowHost(ctxFor(5, 1), {
          hostId: "local",
          newWindow: false,
          projectId: "def",
        })
      ).resolves.toEqual({ outcome: "switched", hostId: "local", projectId: "def" });

      await expect(first).resolves.toEqual({ outcome: "superseded", hostId: "local" });
      expect(signal!.aborted).toBe(true);
      expect(windows.openLocalProject).toHaveBeenCalledExactlyOnceWith(1, "def", undefined, {
        requesterWebContentsId: 5,
      });
    });

    it("leaves an existing window on its host and view when a switch is declined", async () => {
      await client.switchWindowHost(ctxFor(5, 1), {
        hostId: "studio-01",
        newWindow: false,
        projectId: "proj-1",
      });
      windows.admitProjectOpen = vi.fn(async () => false);
      windows.claimProject = vi.fn(() => () => {});

      await expect(client.switchWindowToLocal(1, "abc")).resolves.toEqual({
        outcome: "superseded",
        hostId: "local",
      });

      expect(windows.admitProjectOpen).toHaveBeenCalledExactlyOnceWith({
        windowId: 1,
        askingWindowId: 1,
        hostId: "local",
        projectId: "abc",
        projectName: null,
        signal: expect.any(AbortSignal),
      });
      expect(windows.openLocalProject).not.toHaveBeenCalled();
      expect(windows.claimProject).not.toHaveBeenCalled();
      expect(bindings.get(1)).toBe("studio-01");
    });

    it("goes ahead once the open is admitted", async () => {
      windows.admitProjectOpen = vi.fn(async () => true);

      await expect(
        client.switchWindowHost(ctxFor(5, 1), {
          hostId: "studio-01",
          newWindow: false,
          projectId: "proj-1",
        })
      ).resolves.toEqual({ outcome: "switched", hostId: "studio-01", projectId: "proj-1" });
      expect(windows.admitProjectOpen).toHaveBeenCalledOnce();
      expect(windows.openRemoteProject).toHaveBeenCalledWith(
        1,
        "studio-01",
        "proj-1",
        "/srv/proj-1",
        undefined,
        { requesterWebContentsId: 5 }
      );
    });

    it("never asks about bringing a forgotten host's windows home", async () => {
      manager.last = { projectId: "proj-9", path: "/srv/proj-9", name: "proj-9" };
      await client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false });
      vi.mocked(windows.lastLocalProjectId).mockReturnValue("local-proj");
      windows.admitProjectOpen = vi.fn(async () => false);

      await client.forget({ hostId: "studio-01" });

      expect(windows.admitProjectOpen).not.toHaveBeenCalled();
      expect(windows.openLocalProject).toHaveBeenCalledWith(1, "local-proj");
      expect(bindings.get(1)).toBe("local");
    });

    it("never asks about restoring a window to the host project it was showing", async () => {
      windows.admitProjectOpen = vi.fn(async () => false);

      await expect(client.switchWindowToHostProject(1, "studio-01", "proj-1")).resolves.toEqual({
        outcome: "switched",
        hostId: "studio-01",
        projectId: "proj-1",
      });
      expect(windows.admitProjectOpen).not.toHaveBeenCalled();
    });
  });

  it("opens a host project named by its host path in a new window on that host", async () => {
    manager.connect("studio-01");
    await expect(client.openHostProjectInNewWindow("studio-01", "/srv/app")).resolves.toEqual({
      outcome: "switched",
      hostId: "studio-01",
      projectId: "proj-1",
    });
    expect(windows.openWindow).toHaveBeenCalledTimes(1);
    expect(bindings.get(7)).toBe("studio-01");
    expect(bindings.get(1)).toBe("local");
    // At the path the listing just named, without asking the host again.
    expect(windows.openRemoteProject).toHaveBeenCalledWith(7, "studio-01", "proj-1", "/srv/app");
    await Promise.resolve();
    expect(manager.get("studio-01")!.describeProject).not.toHaveBeenCalled();
  });

  it("opens no window for a path the host has no project at", async () => {
    manager.connect("studio-01");
    await expect(
      client.openHostProjectInNewWindow("studio-01", "/Users/greg/app")
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(windows.openWindow).not.toHaveBeenCalled();
    expect(windows.openRemoteProject).not.toHaveBeenCalled();
  });

  it("brings forward the window already showing a host's project instead of opening a second view", async () => {
    windows.projectOwner = vi.fn(() => ({ windowId: 2, showing: true }));
    windows.revealWindow = vi.fn();
    await expect(
      client.switchWindowHost(ctxFor(5, 1), {
        hostId: "studio-01",
        newWindow: false,
        projectId: "proj-1",
      })
    ).resolves.toEqual({
      outcome: "focused-elsewhere",
      hostId: "studio-01",
      projectId: "proj-1",
      targetWindowId: 2,
    });
    expect(windows.projectOwner).toHaveBeenCalledWith("studio-01", "proj-1", 1);
    expect(windows.revealWindow).toHaveBeenCalledWith(2);
    expect(windows.openRemoteProject).not.toHaveBeenCalled();
    expect(bindings.get(1)).toBe("local");

    // Nor does a new window open for it.
    await client.switchWindowHost(ctxFor(5, 1), {
      hostId: "studio-01",
      newWindow: true,
      projectId: "proj-1",
    });
    expect(windows.projectOwner).toHaveBeenLastCalledWith("studio-01", "proj-1", null);
    expect(windows.openWindow).not.toHaveBeenCalled();
  });

  it("takes a host's project from a window holding it only in its cache, and leaves that window alone", async () => {
    let cachedIn2 = true;
    windows.projectOwner = vi.fn(() => (cachedIn2 ? { windowId: 2, showing: false } : null));
    windows.releaseCachedProject = vi.fn(() => {
      cachedIn2 = false;
      return null;
    });
    windows.revealWindow = vi.fn();
    await expect(
      client.switchWindowHost(ctxFor(5, 1), {
        hostId: "studio-01",
        newWindow: false,
        projectId: "proj-1",
      })
    ).resolves.toEqual({ outcome: "switched", hostId: "studio-01", projectId: "proj-1" });
    expect(windows.releaseCachedProject).toHaveBeenCalledWith("studio-01", "proj-1", 1, "proj-1");
    expect(windows.openRemoteProject).toHaveBeenCalledTimes(1);
    expect(windows.openRemoteProject).toHaveBeenCalledWith(
      1,
      "studio-01",
      "proj-1",
      "/srv/proj-1",
      undefined,
      { requesterWebContentsId: 5 }
    );
    expect(bindings.get(1)).toBe("studio-01");
    expect(bindings.get(2)).toBe("local");
    expect(windows.revealWindow).not.toHaveBeenCalled();
  });

  it("lets go of the cached view in the same tick the project is claimed here", async () => {
    let claimed = false;
    let claimedByNextMicrotask: boolean | null = null;
    windows.projectOwner = vi.fn(() => null);
    windows.releaseCachedProject = vi.fn(() => {
      expect(claimed).toBe(false);
      // Nothing may run between the release and the claim.
      queueMicrotask(() => void (claimedByNextMicrotask = claimed));
      return null;
    });
    windows.claimProject = vi.fn(() => {
      claimed = true;
      return () => {};
    });
    await client.switchWindowHost(ctxFor(5, 1), {
      hostId: "studio-01",
      newWindow: false,
      projectId: "proj-1",
    });
    expect(windows.releaseCachedProject).toHaveBeenCalledOnce();
    expect(claimedByNextMicrotask).toBe(true);
  });

  it("brings forward, without opening a second view, a window already switching to its cached copy", async () => {
    windows.projectOwner = vi.fn(() => ({ windowId: 2, showing: false }));
    windows.releaseCachedProject = vi.fn(() => 2);
    windows.redirectToLocalOwner = vi.fn(() => null);
    windows.revealWindow = vi.fn();
    windows.claimProject = vi.fn(() => () => {});
    await expect(
      client.switchWindowHost(ctxFor(5, 1), {
        hostId: "local",
        newWindow: false,
        projectId: "local-proj",
      })
    ).resolves.toEqual({
      outcome: "focused-elsewhere",
      hostId: "local",
      projectId: "local-proj",
      targetWindowId: 2,
    });
    expect(windows.revealWindow).toHaveBeenCalledWith(2);
    expect(windows.claimProject).not.toHaveBeenCalled();
    expect(windows.openLocalProject).not.toHaveBeenCalled();
  });

  it("fails without moving any window when the other window's cache can't let the project go", async () => {
    windows.projectOwner = vi.fn(() => ({ windowId: 2, showing: false }));
    windows.releaseCachedProject = vi.fn(() => {
      throw new Error("busy");
    });
    windows.revealWindow = vi.fn();
    await expect(
      client.switchWindowHost(ctxFor(5, 1), {
        hostId: "studio-01",
        newWindow: false,
        projectId: "proj-1",
      })
    ).rejects.toThrow("busy");
    expect(windows.openRemoteProject).not.toHaveBeenCalled();
    expect(windows.revealWindow).not.toHaveBeenCalled();
    expect(bindings.get(1)).toBe("local");
    expect(bindings.get(2)).toBe("local");
  });

  it("hands a local project another window has to that window, as a local open does", async () => {
    windows.redirectToLocalOwner = vi.fn(() => 3);
    await expect(
      client.switchWindowHost(ctxFor(5, 1), {
        hostId: "local",
        newWindow: false,
        projectId: "local-proj",
      })
    ).resolves.toEqual({
      outcome: "focused-elsewhere",
      hostId: "local",
      projectId: "local-proj",
      targetWindowId: 3,
    });
    expect(windows.redirectToLocalOwner).toHaveBeenCalledWith("local-proj", 1);
    expect(windows.openLocalProject).not.toHaveBeenCalled();
  });

  it("claims the project for the window in the same tick it finds no owner, until the view is up", async () => {
    const release = vi.fn();
    windows.projectOwner = vi.fn(() => null);
    windows.claimProject = vi.fn(() => release);
    let opened: () => void = () => {};
    windows.openRemoteProject = vi.fn(() => new Promise<void>((resolve) => (opened = resolve)));
    const switching = client.switchWindowHost(ctxFor(5, 1), {
      hostId: "studio-01",
      newWindow: false,
      projectId: "proj-1",
    });
    await vi.waitFor(() => expect(windows.openRemoteProject).toHaveBeenCalled());
    expect(windows.claimProject).toHaveBeenCalledWith("studio-01", "proj-1", 1);
    expect(release).not.toHaveBeenCalled();
    opened();
    await expect(switching).resolves.toMatchObject({ outcome: "switched" });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("restores a window although its own claim reads as an open in flight there", async () => {
    // The restore's stillWanted is false once anything is being opened in the
    // window, the switch's own claim included: the claim comes after its last ask.
    let claimed = false;
    windows.projectOwner = vi.fn(() => null);
    windows.claimProject = vi.fn(() => {
      claimed = true;
      return () => {
        claimed = false;
      };
    });
    await expect(
      client.switchWindowToHostProject(1, "studio-01", "proj-1", () => !claimed)
    ).resolves.toMatchObject({ outcome: "switched" });
    expect(windows.openRemoteProject).toHaveBeenCalledWith(1, "studio-01", "proj-1", "/srv/proj-1");
    expect(claimed).toBe(false);
  });

  it("replaces a forgotten host's window whose local project another window took meanwhile", async () => {
    manager.last = { projectId: "proj-9", path: "/srv/proj-9", name: "proj-9" };
    await client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false });
    vi.mocked(windows.lastLocalProjectId).mockReturnValue("local-proj");
    windows.redirectToLocalOwner = vi.fn(() => 4);
    windows.replaceWithLocalWindow = vi.fn(async () => {});
    await client.forget({ hostId: "studio-01" });
    expect(windows.replaceWithLocalWindow).toHaveBeenCalledWith(1);
    expect(windows.openLocalProject).not.toHaveBeenCalled();
  });

  it("forgets a host: disconnects it and returns its windows to this machine", async () => {
    manager.last = { projectId: "proj-9", path: "/srv/proj-9", name: "proj-9" };
    await client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false });
    await client.forget({ hostId: "studio-01" });
    expect(manager.disconnect).toHaveBeenCalledWith("studio-01");
    expect(bindings.get(1)).toBe("local");
    expect(client.list()).toEqual([]);
    expect(events.some((e) => e.type === "hosts-changed")).toBe(true);
  });

  it("restores a window onto a host project, unless the window stopped waiting for it", async () => {
    await expect(
      client.switchWindowToHostProject(1, "studio-01", "proj-1", () => true)
    ).resolves.toEqual({ outcome: "switched", hostId: "studio-01", projectId: "proj-1" });
    expect(windows.openRemoteProject).toHaveBeenCalledWith(1, "studio-01", "proj-1", "/srv/proj-1");

    vi.mocked(windows.openRemoteProject).mockClear();
    await expect(
      client.switchWindowToHostProject(2, "studio-01", "proj-1", () => false)
    ).resolves.toEqual({ outcome: "superseded", hostId: "studio-01" });
    expect(windows.openRemoteProject).not.toHaveBeenCalled();
    expect(bindings.get(2)).toBe("local");
  });

  it("forgetting a host moves its windows' views back to a local project, not just their binding", async () => {
    manager.last = { projectId: "proj-9", path: "/srv/proj-9", name: "proj-9" };
    await client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false });
    vi.mocked(windows.lastLocalProjectId).mockReturnValue("local-proj");
    await client.forget({ hostId: "studio-01" });
    expect(windows.openLocalProject).toHaveBeenCalledWith(1, "local-proj");
    // The window leaves before the link goes, so its view never sits on a dead host.
    expect(vi.mocked(windows.openLocalProject).mock.invocationCallOrder[0]).toBeLessThan(
      manager.disconnect.mock.invocationCallOrder[0]!
    );
    expect(bindings.get(1)).toBe("local");
  });

  it("forgetting a host puts a fresh local window in place of one with no project here to return to", async () => {
    manager.last = { projectId: "proj-9", path: "/srv/proj-9", name: "proj-9" };
    await client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false });
    vi.mocked(windows.lastLocalProjectId).mockReturnValue(null);
    windows.replaceWithLocalWindow = vi.fn(async () => {});
    await client.forget({ hostId: "studio-01" });
    expect(windows.replaceWithLocalWindow).toHaveBeenCalledWith(1);
    expect(windows.openLocalProject).not.toHaveBeenCalled();
    expect(vi.mocked(windows.replaceWithLocalWindow).mock.invocationCallOrder[0]).toBeLessThan(
      manager.disconnect.mock.invocationCallOrder[0]!
    );
  });

  it("still removes the host when no replacement window could be opened", async () => {
    manager.last = { projectId: "proj-9", path: "/srv/proj-9", name: "proj-9" };
    await client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false });
    vi.mocked(windows.lastLocalProjectId).mockReturnValue(null);
    windows.replaceWithLocalWindow = vi.fn(async () => {
      throw new Error("The replacement window didn't open");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(client.forget({ hostId: "studio-01" })).resolves.toBeUndefined();
    expect(manager.disconnect).toHaveBeenCalledWith("studio-01");
    expect(registry.list()).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("doesn't let a local project that never finishes activating hold the host's removal", async () => {
    const slow = new RemoteHostsClient({
      registry,
      manager: manager as unknown as RemoteHostManager,
      bindings,
      router,
      senders: { projectKeyFor: () => null, windowIdFor: (id) => (id === 5 ? 1 : null) },
      windows: {
        ...windows,
        openLocalProject: vi.fn(() => new Promise<void>(() => {})),
        lastLocalProjectId: vi.fn(() => "local-proj"),
      },
      installRouter,
      emit: () => {},
      forgetSwitchWaitMs: 5,
    });
    manager.last = { projectId: "proj-9", path: "/srv/proj-9", name: "proj-9" };
    await slow.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false });
    await slow.forget({ hostId: "studio-01" });
    expect(manager.disconnect).toHaveBeenCalledWith("studio-01");
    expect(registry.list()).toEqual([]);
  });

  it("leaves a window the person moved to another host while the removal ran", async () => {
    registry.add({ name: "studio-02", connection: { kind: "ssh", target: "s2.example" } });
    manager.last = { projectId: "proj-9", path: "/srv/proj-9", name: "proj-9" };
    await client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false });
    vi.mocked(windows.lastLocalProjectId).mockReturnValue("local-proj");
    // The removal starts, then the person sends the window to studio-02.
    const removal = client.forget({ hostId: "studio-01" });
    const elsewhere = client.switchWindowHost(ctxFor(5, 1), {
      hostId: "studio-02",
      newWindow: false,
      projectId: "proj-2",
    });
    await removal;
    await elsewhere;
    expect(bindings.get(1)).toBe("studio-02");
    expect(windows.openRemoteProject).toHaveBeenLastCalledWith(
      1,
      "studio-02",
      "proj-2",
      "/srv/proj-2",
      undefined,
      { requesterWebContentsId: 5 }
    );
  });

  it("cleans up what this machine kept for a forgotten host, after it leaves the list", async () => {
    const onForget = vi.fn(async () => {
      expect(registry.get("studio-01")).toBeNull();
    });
    const withCleanup = new RemoteHostsClient({
      registry,
      manager: manager as unknown as RemoteHostManager,
      bindings,
      router,
      senders: { projectKeyFor: () => null, windowIdFor: () => null },
      windows,
      installRouter,
      emit: () => {},
      onForget,
    });
    await withCleanup.forget({ hostId: "studio-01" });
    expect(onForget).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "studio-01",
        connection: { kind: "ssh", target: "studio.example" },
      })
    );
  });

  describe("while an install is running on the host", () => {
    function installingClient(installing: () => boolean) {
      return new RemoteHostsClient({
        registry,
        manager: manager as unknown as RemoteHostManager,
        bindings,
        router,
        senders: { projectKeyFor: () => null, windowIdFor: () => null },
        windows,
        installRouter,
        emit: () => {},
        isInstalling: (connection) =>
          installing() && connection.kind === "ssh" && connection.target === "studio.example",
      });
    }

    it("refuses to remove the host, and changes nothing", async () => {
      const busy = installingClient(() => true);
      bindings.set(1, "studio-01");
      vi.mocked(windows.lastLocalProjectId).mockReturnValue("local-proj");
      await expect(busy.forget({ hostId: "studio-01" })).rejects.toMatchObject({
        code: "VALIDATION",
      });
      expect(registry.get("studio-01")).not.toBeNull();
      expect(registry.retiredIds().size).toBe(0);
      expect(bindings.get(1)).toBe("studio-01");
      expect(windows.openLocalProject).not.toHaveBeenCalled();
      expect(manager.disconnect).not.toHaveBeenCalled();
    });

    it("refuses a new SSH target, but takes a rename or the same target", async () => {
      const busy = installingClient(() => true);
      await expect(
        busy.update({ hostId: "studio-01", connection: { kind: "ssh", target: "other.example" } })
      ).rejects.toMatchObject({ code: "VALIDATION" });
      expect(registry.get("studio-01")?.connection).toEqual({
        kind: "ssh",
        target: "studio.example",
      });
      await expect(busy.update({ hostId: "studio-01", name: "Studio" })).resolves.toMatchObject({
        name: "Studio",
      });
      await expect(
        busy.update({ hostId: "studio-01", connection: { kind: "ssh", target: "studio.example" } })
      ).resolves.toMatchObject({ id: "studio-01" });
    });

    it("allows both once the install settles", async () => {
      let installing = true;
      const settling = installingClient(() => installing);
      installing = false;
      await settling.update({
        hostId: "studio-01",
        connection: { kind: "ssh", target: "other.example" },
      });
      await expect(settling.forget({ hostId: "studio-01" })).resolves.toBeUndefined();
      expect(registry.list()).toEqual([]);
    });
  });

  it("still forgets a host when its cleanup fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = new RemoteHostsClient({
      registry,
      manager: manager as unknown as RemoteHostManager,
      bindings,
      router,
      senders: { projectKeyFor: () => null, windowIdFor: () => null },
      windows,
      installRouter,
      emit: () => {},
      onForget: async () => {
        throw new Error("ssh gone");
      },
    });
    await expect(failing.forget({ hostId: "studio-01" })).resolves.toBeUndefined();
    expect(registry.list()).toEqual([]);
    warn.mockRestore();
  });

  describe("removal races", () => {
    function deferred<T = void>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((r) => (resolve = r));
      return { promise, resolve };
    }

    function quickClient(overrides: Partial<WindowControl> = {}) {
      return new RemoteHostsClient({
        registry,
        manager: manager as unknown as RemoteHostManager,
        bindings,
        router,
        senders: { projectKeyFor: () => null, windowIdFor: (id) => (id === 5 ? 1 : null) },
        windows: { ...windows, ...overrides },
        installRouter,
        emit: () => {},
        forgetSwitchWaitMs: 5,
      });
    }

    it("still brings a window home when its switch home timed out behind the host's own activation", async () => {
      const activation = deferred();
      const openRemoteProject = vi.fn(() => activation.promise);
      const openLocalProject = vi.fn(async () => {});
      const quick = quickClient({
        openRemoteProject,
        openLocalProject,
        lastLocalProjectId: vi.fn(() => "local-proj"),
      });
      const opening = quick.switchWindowToHostProject(1, "studio-01", "proj-1");
      await vi.waitFor(() => expect(openRemoteProject).toHaveBeenCalled());
      // The switch home queues behind the activation, which outlasts the wait.
      await quick.forget({ hostId: "studio-01" });
      expect(registry.get("studio-01")).toBeNull();
      expect(openLocalProject).not.toHaveBeenCalled();
      activation.resolve();
      await opening;
      await vi.waitFor(() => expect(openLocalProject).toHaveBeenCalledWith(1, "local-proj"));
      expect(bindings.get(1)).toBe("local");
    });

    it("binds no window opened for a host removed while the window was opening", async () => {
      const opened = deferred<number>();
      const openWindow = vi.fn(() => opened.promise);
      const quick = quickClient({ openWindow });
      const opening = quick.switchWindowHost(ctxFor(5, 1), {
        hostId: "studio-01",
        newWindow: true,
        projectId: "proj-1",
      });
      await vi.waitFor(() => expect(openWindow).toHaveBeenCalled());
      await quick.forget({ hostId: "studio-01" });
      opened.resolve(7);
      await expect(opening).resolves.toEqual({ outcome: "superseded", hostId: "studio-01" });
      expect(windows.openRemoteProject).not.toHaveBeenCalled();
      expect(bindings.get(7)).toBe("local");
    });

    it("doesn't replace a window sent to another host after its switch home failed", async () => {
      registry.add({ name: "studio-02", connection: { kind: "ssh", target: "s2.example" } });
      const replaceWithLocalWindow = vi.fn(async () => {});
      const quick = quickClient({
        openLocalProject: vi.fn(async () => {
          // The person sends the window elsewhere while its switch home is failing.
          bindings.set(1, "studio-02");
          throw new Error("The local project didn't load");
        }),
        lastLocalProjectId: vi.fn(() => "local-proj"),
        replaceWithLocalWindow,
      });
      bindings.set(1, "studio-01");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await quick.forget({ hostId: "studio-01" });
      warn.mockRestore();
      expect(replaceWithLocalWindow).not.toHaveBeenCalled();
    });

    it("holds the host from the first moment of its removal, so nothing starts on it meanwhile", async () => {
      const home = deferred();
      const quick = quickClient({
        openLocalProject: vi.fn(() => home.promise),
        lastLocalProjectId: vi.fn(() => "local-proj"),
      });
      bindings.set(1, "studio-01");
      const connection = { kind: "ssh", target: "studio.example" } as const;
      expect(quick.isRetiring(connection)).toBe(false);
      const removal = quick.forget({ hostId: "studio-01" });
      expect(quick.isRetiring(connection)).toBe(true);
      manager.connect.mockClear();
      // A switch onto it asked for meanwhile never dials it.
      await expect(quick.switchWindowToHostProject(2, "studio-01", "proj-1")).resolves.toEqual({
        outcome: "superseded",
        hostId: "studio-01",
      });
      expect(manager.connect).not.toHaveBeenCalled();
      await expect(quick.forget({ hostId: "studio-01" })).rejects.toMatchObject({
        code: "VALIDATION",
      });
      home.resolve();
      await removal;
      expect(quick.isRetiring(connection)).toBe(false);
    });
  });

  describe("changing a host's SSH target", () => {
    function retargetClient(onRetarget = vi.fn(async () => {})) {
      const retarget = new RemoteHostsClient({
        registry,
        manager: manager as unknown as RemoteHostManager,
        bindings,
        router,
        senders: { projectKeyFor: () => null, windowIdFor: (id) => (id === 5 ? 1 : null) },
        windows,
        installRouter,
        emit: () => {},
        onRetarget,
      });
      return { retarget, onRetarget };
    }

    it("brings its windows home and clears the old machine's state before rebinding, without dialling", async () => {
      const { retarget, onRetarget } = retargetClient(
        vi.fn(async () => {
          // Cleared while the record still names the old machine.
          expect(registry.get("studio-01")?.connection).toEqual({
            kind: "ssh",
            target: "studio.example",
          });
        })
      );
      await retarget.switchWindowToHostProject(1, "studio-01", "proj-1");
      vi.mocked(windows.lastLocalProjectId).mockReturnValue("local-proj");
      manager.connect.mockClear();
      const after = await retarget.update({
        hostId: "studio-01",
        connection: { kind: "ssh", target: "newbox.example" },
      });
      expect(after.connection).toEqual({ kind: "ssh", target: "newbox.example" });
      expect(windows.openLocalProject).toHaveBeenCalledWith(1, "local-proj");
      expect(bindings.get(1)).toBe("local");
      expect(manager.disconnect).toHaveBeenCalledWith("studio-01");
      expect(onRetarget).toHaveBeenCalledWith(expect.objectContaining({ id: "studio-01" }));
      expect(vi.mocked(windows.openLocalProject).mock.invocationCallOrder[0]).toBeLessThan(
        manager.disconnect.mock.invocationCallOrder[0]!
      );
      expect(manager.connect).not.toHaveBeenCalled();
    });

    it("binds no window to an open that began before the target changed, even once the change is done", async () => {
      let resolveOpen!: (id: number) => void;
      const openWindow = vi.fn(() => new Promise<number>((r) => (resolveOpen = r)));
      const retarget = new RemoteHostsClient({
        registry,
        manager: manager as unknown as RemoteHostManager,
        bindings,
        router,
        senders: { projectKeyFor: () => null, windowIdFor: (id) => (id === 5 ? 1 : null) },
        windows: { ...windows, openWindow },
        installRouter,
        emit: () => {},
      });
      const opening = retarget.switchWindowHost(ctxFor(5, 1), {
        hostId: "studio-01",
        newWindow: true,
        projectId: "proj-1",
      });
      await vi.waitFor(() => expect(openWindow).toHaveBeenCalled());
      await retarget.update({
        hostId: "studio-01",
        connection: { kind: "ssh", target: "newbox.example" },
      });
      resolveOpen(7);
      await expect(opening).resolves.toEqual({ outcome: "superseded", hostId: "studio-01" });
      expect(windows.openRemoteProject).not.toHaveBeenCalled();
    });

    it("replaces a window still showing the old machine rather than leave its view behind", async () => {
      const replaceWithLocalWindow = vi.fn(async () => {});
      const retarget = new RemoteHostsClient({
        registry,
        manager: manager as unknown as RemoteHostManager,
        bindings,
        router,
        senders: { projectKeyFor: () => null, windowIdFor: () => null },
        windows: {
          ...windows,
          openLocalProject: vi.fn(() => new Promise<void>(() => {})),
          lastLocalProjectId: vi.fn(() => "local-proj"),
          replaceWithLocalWindow,
        },
        installRouter,
        emit: () => {},
        forgetSwitchWaitMs: 5,
      });
      bindings.set(1, "studio-01");
      await retarget.update({
        hostId: "studio-01",
        connection: { kind: "ssh", target: "newbox.example" },
      });
      expect(replaceWithLocalWindow).toHaveBeenCalledWith(1);
    });

    it("leaves a window whose local project is already on screen, however long it takes to finish", async () => {
      const replaceWithLocalWindow = vi.fn(async () => {});
      const retarget = new RemoteHostsClient({
        registry,
        manager: manager as unknown as RemoteHostManager,
        bindings,
        router,
        senders: { projectKeyFor: () => null, windowIdFor: () => null },
        windows: {
          ...windows,
          openLocalProject: vi.fn(() => new Promise<void>(() => {})),
          lastLocalProjectId: vi.fn(() => "local-proj"),
          replaceWithLocalWindow,
          showsHost: () => false,
        },
        installRouter,
        emit: () => {},
        forgetSwitchWaitMs: 5,
      });
      bindings.set(1, "studio-01");
      await retarget.update({
        hostId: "studio-01",
        connection: { kind: "ssh", target: "newbox.example" },
      });
      expect(replaceWithLocalWindow).not.toHaveBeenCalled();
    });

    it("dials nothing for the host while it is being re-pointed", async () => {
      let home!: () => void;
      const retarget = new RemoteHostsClient({
        registry,
        manager: manager as unknown as RemoteHostManager,
        bindings,
        router,
        senders: { projectKeyFor: () => null, windowIdFor: () => null },
        windows: {
          ...windows,
          openLocalProject: vi.fn(() => new Promise<void>((r) => (home = r))),
          lastLocalProjectId: vi.fn(() => "local-proj"),
        },
        installRouter,
        emit: () => {},
      });
      bindings.set(1, "studio-01");
      const changing = retarget.update({
        hostId: "studio-01",
        connection: { kind: "ssh", target: "newbox.example" },
      });
      manager.connect.mockClear();
      retarget.connect({ hostId: "studio-01" });
      expect(manager.connect).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(home).toBeTypeOf("function"));
      home();
      await changing;
    });

    it("refuses an unusable target before moving any window", async () => {
      registry.add({ name: "studio-02", connection: { kind: "ssh", target: "s2.example" } });
      const { retarget, onRetarget } = retargetClient();
      bindings.set(1, "studio-01");
      vi.mocked(windows.lastLocalProjectId).mockReturnValue("local-proj");
      await expect(
        retarget.update({ hostId: "studio-01", connection: { kind: "ssh", target: "S2.example" } })
      ).rejects.toMatchObject({ code: "VALIDATION" });
      expect(windows.openLocalProject).not.toHaveBeenCalled();
      expect(onRetarget).not.toHaveBeenCalled();
      expect(bindings.get(1)).toBe("studio-01");
    });

    it("renames without touching the link or its windows", async () => {
      const { retarget, onRetarget } = retargetClient();
      bindings.set(1, "studio-01");
      await retarget.update({ hostId: "studio-01", name: "Studio" });
      expect(manager.disconnect).not.toHaveBeenCalled();
      expect(onRetarget).not.toHaveBeenCalled();
      expect(bindings.get(1)).toBe("studio-01");
    });
  });

  it("lists hosts with their connection and pushes connection changes", () => {
    client.connect({ hostId: "studio-01" });
    expect(client.list()).toEqual([
      expect.objectContaining({
        descriptor: expect.objectContaining({ id: "studio-01" }),
        connection: expect.objectContaining({ status: "connected" }),
        summary: null,
      }),
    ]);
    manager.emit("studio-01", { status: "unreachable", lastSeenAt: 5, detail: "refused" });
    expect(events).toContainEqual({
      type: "connection-changed",
      hostId: "studio-01",
      connection: { status: "unreachable", lastSeenAt: 5, detail: "refused" },
    });
  });

  // A restart abandons an attempt under way: from a caller that only needs the
  // link, it would keep cutting a slow host off before it could answer.
  it("starts a link over only when a person asks to, never for a caller waiting on it", async () => {
    client.connect({ hostId: "studio-01", restart: true });
    expect(manager.connect).toHaveBeenLastCalledWith("studio-01", { restart: true });
    client.connect({ hostId: "studio-01" });
    expect(manager.connect).toHaveBeenLastCalledWith("studio-01", { restart: false });
    await client.connectAndWait("studio-01", 1_000);
    expect(manager.connect).toHaveBeenLastCalledWith("studio-01");
  });

  it("fills each host's summary from the last frame host metrics holds", () => {
    const summary = { agentsObserved: { working: 2 } };
    registerRemoteService("hostMetrics", {
      latest: (hostId: string) => (hostId === "studio-01" ? summary : null),
    } as unknown as HostMetricsClient);
    try {
      expect(client.list()).toEqual([expect.objectContaining({ summary })]);
    } finally {
      _resetRemoteServicesForTest();
    }
  });

  it("runs the first-use wiring once, and never for a user who only reads", async () => {
    client.list();
    client.getWindowHost(ctxFor(5, 1));
    expect(onFirstUse).not.toHaveBeenCalled();
    client.connect({ hostId: "studio-01" });
    await client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false });
    expect(onFirstUse).toHaveBeenCalledTimes(1);
  });

  it("waits for the link before opening a project, and fails clearly when it never comes", async () => {
    manager.readiness = "timeout";
    await expect(
      client.switchWindowHost(ctxFor(5, 1), {
        hostId: "studio-01",
        newWindow: false,
        projectId: "proj-1",
      })
    ).rejects.toMatchObject({ code: "HOST_DISCONNECTED" });
    expect(windows.openRemoteProject).not.toHaveBeenCalled();
    expect(bindings.get(1)).toBe("local");

    manager.readiness = "version-mismatch";
    await expect(
      client.switchWindowHost(ctxFor(5, 1), {
        hostId: "studio-01",
        newWindow: true,
        projectId: "proj-1",
      })
    ).rejects.toMatchObject({ code: "HOST_VERSION_MISMATCH" });
    // No window is opened for a host that cannot serve it.
    expect(windows.openWindow).not.toHaveBeenCalled();
  });

  it("never opens a remote view without the host's path for the project", async () => {
    const connection = manager.connect("studio-01");
    connection.describeProject.mockResolvedValueOnce(null);
    await expect(
      client.switchWindowHost(ctxFor(5, 1), {
        hostId: "studio-01",
        newWindow: false,
        projectId: "gone",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A lookup the link dropped is the host being unreachable, not the project
    // being gone: Retry is what helps, and nothing is forgotten.
    connection.describeProject.mockRejectedValueOnce(new Error("link dropped"));
    await expect(
      client.switchWindowHost(ctxFor(5, 1), {
        hostId: "studio-01",
        newWindow: false,
        projectId: "proj-1",
      })
    ).rejects.toMatchObject({ code: "HOST_DISCONNECTED" });
    expect(windows.openRemoteProject).not.toHaveBeenCalled();
  });

  it("forgets a project in the toggle's history only once the host says it's gone", async () => {
    const history = getProjectHistory(1);
    const gone = toHostScopedKey("studio-01", "gone");
    const dropped = toHostScopedKey("studio-01", "proj-1");
    history.record(gone);
    history.record(dropped);
    history.record("local-a");
    const connection = manager.connect("studio-01");

    connection.describeProject.mockRejectedValueOnce(new Error("link dropped"));
    await expect(
      client.switchWindowHost(ctxFor(5, 1), {
        hostId: "studio-01",
        newWindow: false,
        projectId: "proj-1",
      })
    ).rejects.toMatchObject({ code: "HOST_DISCONNECTED" });
    expect(history.snapshot().entries).toEqual(["local-a", dropped, gone]);

    connection.describeProject.mockResolvedValueOnce(null);
    await expect(
      client.switchWindowHost(ctxFor(5, 1), {
        hostId: "studio-01",
        newWindow: false,
        projectId: "gone",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(history.snapshot().entries).toEqual(["local-a", dropped]);
    disposeProjectHistory(1);
    resetProjectHistory(1);
  });

  describe("after an explicit disconnect", () => {
    const connected: HostConnectionState = {
      status: "connected",
      rttMs: 1,
      handshake: {} as never,
    };

    async function disconnectWithBoundView() {
      keys.set(9, "studio-01:proj-1");
      manager.connect("studio-01");
      manager.bound = [9];
      await client.disconnect({ hostId: "studio-01" });
      events.length = 0;
    }

    function resyncs() {
      return events.filter((event) => event.type === "resync-required");
    }

    it("remembers the person disconnected it, until something dials it again", async () => {
      manager.connect("studio-01");
      expect(client.isDisconnectedByPerson("studio-01")).toBe(false);

      await client.disconnect({ hostId: "studio-01" });
      expect(client.isDisconnectedByPerson("studio-01")).toBe(true);

      await client.connectAndWait("studio-01", 1_000);
      expect(client.isDisconnectedByPerson("studio-01")).toBe(false);

      await client.disconnect({ hostId: "studio-01" });
      client.connect({ hostId: "studio-01" });
      expect(client.isDisconnectedByPerson("studio-01")).toBe(false);
    });

    it("never counts a link the Shell let go on its own", async () => {
      manager.connect("studio-01");
      await manager.disconnect("studio-01");
      expect(client.isDisconnectedByPerson("studio-01")).toBe(false);
    });

    it("resyncs the views it cut off once a new connection can take calls", async () => {
      await disconnectWithBoundView();
      manager.connect("studio-01");
      manager.emit("studio-01", { status: "connecting", attempt: 1 });
      manager.emit("studio-01", connected);
      await vi.waitFor(() =>
        expect(resyncs()).toEqual([
          { type: "resync-required", hostId: "studio-01", reason: "reconnected" },
        ])
      );

      // Once only: a later reconnect of the same connection is the coordinator's.
      manager.emit("studio-01", connected);
      await Promise.resolve();
      expect(resyncs()).toHaveLength(1);
    });

    it("tells no one when the views have since moved to another host", async () => {
      await disconnectWithBoundView();
      keys.set(9, "proj-1");
      manager.connect("studio-01");
      manager.emit("studio-01", connected);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(resyncs()).toHaveLength(0);
    });

    it("keeps waiting when the connection never became usable", async () => {
      await disconnectWithBoundView();
      manager.readiness = "timeout";
      manager.connect("studio-01");
      manager.emit("studio-01", connected);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(resyncs()).toHaveLength(0);

      manager.readiness = "ready";
      manager.emit("studio-01", connected);
      await vi.waitFor(() => expect(resyncs()).toHaveLength(1));
    });

    it("drops the views of a forgotten host", async () => {
      await disconnectWithBoundView();
      await client.forget({ hostId: "studio-01" });
      registry.add({ name: "studio-01", connection: { kind: "ssh", target: "studio.example" } });
      manager.connect("studio-01");
      manager.emit("studio-01", connected);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(resyncs()).toHaveLength(0);
    });
  });
  describe("a window on a host whose Daintree isn't listening", () => {
    const parked: HostConnectionState = {
      status: "unreachable",
      lastSeenAt: 1_000,
      detail: "Daintree isn't running in Host mode there (no host.json).",
      hostModeOff: true,
      stoppedRetrying: true,
    };
    const connected: HostConnectionState = {
      status: "connected",
      rttMs: 1,
      handshake: {} as never,
    };
    /** The check the window's link made, failing the same way. */
    function checkedAgain() {
      manager.emit("studio-01", { status: "connecting", attempt: 2 });
      manager.emit("studio-01", parked);
    }

    it("checks back on the host now and then, backing off while it stays away", async () => {
      vi.useFakeTimers();
      try {
        const link = manager.connect("studio-01");
        bindings.set(1, "studio-01");
        manager.emit("studio-01", parked);
        vi.advanceTimersByTime(29_999);
        expect(link.retryNow).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(link.retryNow).toHaveBeenCalledTimes(1);

        checkedAgain();
        vi.advanceTimersByTime(59_999);
        expect(link.retryNow).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1);
        expect(link.retryNow).toHaveBeenCalledTimes(2);

        // However long it stays away, it is checked at least every five minutes.
        for (let i = 0; i < 6; i++) {
          checkedAgain();
          vi.advanceTimersByTime(5 * 60_000);
        }
        expect(link.retryNow).toHaveBeenCalledTimes(8);

        // Back, and away again later: the wait starts over.
        manager.emit("studio-01", connected);
        manager.emit("studio-01", parked);
        vi.advanceTimersByTime(30_000);
        expect(link.retryNow).toHaveBeenCalledTimes(9);
      } finally {
        await client.dispose();
        vi.useRealTimers();
      }
    });

    it("never dials a host no window shows, and stops once the last one leaves", async () => {
      vi.useFakeTimers();
      try {
        const link = manager.connect("studio-01");
        manager.emit("studio-01", parked);
        vi.advanceTimersByTime(60 * 60_000);
        expect(link.retryNow).not.toHaveBeenCalled();

        bindings.set(1, "studio-01");
        bindings.set(2, "studio-01");
        vi.advanceTimersByTime(30_000);
        expect(link.retryNow).toHaveBeenCalledTimes(1);

        // One of two windows closing leaves the other still waiting on it.
        checkedAgain();
        bindings.release(1);
        vi.advanceTimersByTime(60_000);
        expect(link.retryNow).toHaveBeenCalledTimes(2);

        checkedAgain();
        bindings.set(2, "local");
        vi.advanceTimersByTime(60 * 60_000);
        expect(link.retryNow).toHaveBeenCalledTimes(2);
      } finally {
        await client.dispose();
        vi.useRealTimers();
      }
    });

    it("keeps the wait already under way when another window comes to the host", async () => {
      vi.useFakeTimers();
      try {
        const link = manager.connect("studio-01");
        bindings.set(1, "studio-01");
        manager.emit("studio-01", parked);
        vi.advanceTimersByTime(20_000);
        bindings.set(2, "studio-01");
        vi.advanceTimersByTime(10_000);
        expect(link.retryNow).toHaveBeenCalledTimes(1);
      } finally {
        await client.dispose();
        vi.useRealTimers();
      }
    });

    it("dials nothing once the client is disposed with a check pending", async () => {
      vi.useFakeTimers();
      try {
        const link = manager.connect("studio-01");
        bindings.set(1, "studio-01");
        manager.emit("studio-01", parked);
        vi.advanceTimersByTime(10_000);
        await client.dispose();
        vi.advanceTimersByTime(60 * 60_000);
        expect(link.retryNow).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("leaves a link alone that stopped for any other reason", async () => {
      vi.useFakeTimers();
      try {
        const link = manager.connect("studio-01");
        bindings.set(1, "studio-01");
        // ssh refused the login: a check would knock on sshd for nothing.
        manager.emit("studio-01", {
          status: "unreachable",
          lastSeenAt: 1_000,
          detail: "Permission denied (publickey).",
          stoppedRetrying: true,
        });
        vi.advanceTimersByTime(60 * 60_000);
        // Parked, then let go (removed, disconnected): nothing left to check.
        manager.emit("studio-01", parked);
        manager.emit("studio-01", { status: "disconnected" });
        vi.advanceTimersByTime(60 * 60_000);
        expect(link.retryNow).not.toHaveBeenCalled();
      } finally {
        await client.dispose();
        vi.useRealTimers();
      }
    });
  });
});
