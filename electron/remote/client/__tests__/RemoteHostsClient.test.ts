import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { HostDescriptor, HostConnectionState } from "../../../../shared/types/remoteHosts.js";
import type { RemoteHostsEvent } from "../../../../shared/types/ipc/remoteHosts.js";
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

    it("refuses when the host never answers, rather than moving the window blind", async () => {
      manager.readiness = "unreachable";
      await expect(
        client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false })
      ).rejects.toMatchObject({ code: "HOST_DISCONNECTED" });
      expect(bindings.get(1)).toBe("local");
    });

    it("opens a new window on the host's project list when there is nothing to return to", async () => {
      manager.readiness = "unreachable";
      await expect(
        client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: true })
      ).resolves.toEqual({ outcome: "window-opened", hostId: "studio-01" });
      expect(bindings.get(7)).toBe("studio-01");
      expect(windows.openRemoteProject).not.toHaveBeenCalled();
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

  it("forgets a host: disconnects it and returns its windows to this machine", async () => {
    manager.last = { projectId: "proj-9", path: "/srv/proj-9", name: "proj-9" };
    await client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false });
    await client.forget({ hostId: "studio-01" });
    expect(manager.disconnect).toHaveBeenCalledWith("studio-01");
    expect(bindings.get(1)).toBe("local");
    expect(client.list()).toEqual([]);
    expect(events.some((e) => e.type === "hosts-changed")).toBe(true);
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
    connection.describeProject.mockRejectedValueOnce(new Error("link dropped"));
    await expect(
      client.switchWindowHost(ctxFor(5, 1), {
        hostId: "studio-01",
        newWindow: false,
        projectId: "proj-1",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(windows.openRemoteProject).not.toHaveBeenCalled();
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
