import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
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
      boundViews: () => number[];
    }
  >();
  const listeners = new Set<(hostId: string, state: HostConnectionState) => void>();
  const manager = {
    status: "connected" as string,
    readiness: "ready" as string,
    bound: [] as number[],
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
          boundViews: () => [...manager.bound],
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
    expect(windows.openRemoteProject).toHaveBeenCalledWith(1, "studio-01", "proj-1", "/srv/proj-1");
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

      const seen = pendingEvents();
      expect(seen.map((pending) => pending?.phase ?? null)).toEqual([
        "connecting",
        "opening",
        "opening",
        null,
      ]);
      expect(seen[2]).toMatchObject({ hostName: "studio-01", projectName: "proj-1" });
      expect(client.getPendingSwitch(ctxFor(5, 1))).toBeNull();
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

    it("has nothing to cancel once the switch has committed", async () => {
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

      expect(client.getPendingSwitch(ctxFor(5, 1))).toBeNull();
      releaseOpen();
      await expect(switching).resolves.toMatchObject({ outcome: "switched" });
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
    expect(windows.openRemoteProject).toHaveBeenCalledWith(1, "studio-02", "proj-2", "/srv/proj-2");
    expect(bindings.get(1)).toBe("studio-02");
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
        "/srv/proj-2"
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
      ).rejects.toMatchObject({ code: "HOST_MODE_OFF" });
      expect(bindings.get(1)).toBe("local");
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
      windows.lastProjectOnHost = vi.fn(() => "proj-9");
      await expect(
        client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
      ).resolves.toEqual({ outcome: "switched", hostId: "studio-01", projectId: "proj-9" });
      expect(windows.lastProjectOnHost).toHaveBeenCalledWith(1, "studio-01");

      // Gone from the host since: the host's memory answers instead.
      manager.connect("studio-01").describeProject.mockResolvedValueOnce(null);
      await client.switchWindowHost(ctxFor(5, 1), { hostId: "local", newWindow: false });
      await expect(
        client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
      ).resolves.toEqual({ outcome: "switched", hostId: "studio-01", projectId: "proj-2" });
    });

    it("returns to this machine's last project, or asks for its list", async () => {
      manager.last = { projectId: "proj-2", path: "/srv/proj-2", name: "proj-2" };
      await client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false });

      vi.mocked(windows.lastLocalProjectId).mockReturnValueOnce("local-a");
      await expect(
        client.switchWindowHost(ctxFor(5, 1), { hostId: "local", newWindow: false })
      ).resolves.toEqual({ outcome: "switched", hostId: "local", projectId: "local-a" });
      expect(windows.lastLocalProjectId).toHaveBeenLastCalledWith(1);
      expect(windows.openLocalProject).toHaveBeenCalledWith(1, "local-a");
      expect(bindings.get(1)).toBe("local");

      await expect(
        client.switchWindowHost(ctxFor(5, 1), { hostId: "local", newWindow: false })
      ).resolves.toEqual({ outcome: "choose-project", hostId: "local" });
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
    expect(windows.openLocalProject).toHaveBeenCalledWith(1, "abc");
  });

  it("names the host a window is on, for main code that holds a window rather than a sender", async () => {
    expect(client.windowHost(1)).toBe("local");
    await client.switchWindowHost(ctxFor(5, 1), {
      hostId: "studio-01",
      newWindow: false,
      projectId: "proj-1",
    });
    expect(client.windowHost(1)).toBe("studio-01");
    expect(client.windowHost(2)).toBe("local");
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
    expect(windows.openRemoteProject).toHaveBeenCalledWith(7, "studio-01", "proj-1", "/srv/proj-1");
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

  it("shows a host's project again in the window holding it in its cache, and brings that window forward", async () => {
    windows.projectOwner = vi.fn((_host: string, _project: string, except: number | null) =>
      except === 2 ? null : { windowId: 2, showing: false }
    );
    windows.revealWindow = vi.fn();
    await expect(
      client.switchWindowHost(ctxFor(5, 1), {
        hostId: "studio-01",
        newWindow: false,
        projectId: "proj-1",
      })
    ).resolves.toMatchObject({ outcome: "focused-elsewhere", targetWindowId: 2 });
    expect(windows.openRemoteProject).toHaveBeenCalledWith(2, "studio-01", "proj-1", "/srv/proj-1");
    expect(windows.openRemoteProject).not.toHaveBeenCalledWith(
      1,
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
    expect(bindings.get(2)).toBe("studio-01");
    expect(bindings.get(1)).toBe("local");
    expect(windows.revealWindow).toHaveBeenCalledWith(2);
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

  it("shows a project two windows hold in their caches in the one it found, without passing the request back and forth", async () => {
    // Each window's lookup finds the other: only the first lookup may count.
    windows.projectOwner = vi.fn((_host: string, _project: string, except: number | null) => ({
      windowId: except === 2 ? 1 : 2,
      showing: false,
    }));
    windows.revealWindow = vi.fn();
    await expect(
      client.switchWindowHost(ctxFor(5, 1), {
        hostId: "studio-01",
        newWindow: false,
        projectId: "proj-1",
      })
    ).resolves.toMatchObject({ outcome: "focused-elsewhere", targetWindowId: 2 });
    expect(windows.projectOwner).toHaveBeenCalledTimes(1);
    expect(windows.openRemoteProject).toHaveBeenCalledTimes(1);
    expect(windows.openRemoteProject).toHaveBeenCalledWith(2, "studio-01", "proj-1", "/srv/proj-1");
  });

  it("brings nothing forward when the person asked this window for something else meanwhile", async () => {
    windows.projectOwner = vi.fn((_host: string, _project: string, except: number | null) =>
      except === 1 ? { windowId: 2, showing: false } : null
    );
    windows.revealWindow = vi.fn();
    let opened: () => void = () => {};
    windows.openRemoteProject = vi.fn(() => new Promise<void>((resolve) => (opened = resolve)));
    const first = client.switchWindowHost(ctxFor(5, 1), {
      hostId: "studio-01",
      newWindow: false,
      projectId: "proj-1",
    });
    await vi.waitFor(() => expect(windows.openRemoteProject).toHaveBeenCalled());
    // A newer request for window 1 while window 2 was being switched.
    void client.switchWindowHost(ctxFor(5, 1), { hostId: "local", newWindow: false });
    opened();
    await expect(first).resolves.toMatchObject({ outcome: "superseded" });
    expect(windows.revealWindow).not.toHaveBeenCalled();
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
      "/srv/proj-2"
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
});
