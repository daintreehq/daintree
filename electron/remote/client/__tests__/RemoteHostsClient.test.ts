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
      whenReady: ReturnType<typeof vi.fn>;
    }
  >();
  const listeners = new Set<(hostId: string, state: HostConnectionState) => void>();
  const manager = {
    status: "connected" as string,
    readiness: "ready" as string,
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
          whenReady: vi.fn(async () => manager.readiness),
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
    registry.add({ name: "studio-01", sshTarget: "studio.example" });
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
    await client.switchWindowHost(ctxFor(5, 1), { hostId: "studio-01", newWindow: false });
    await client.forget({ hostId: "studio-01" });
    expect(manager.disconnect).toHaveBeenCalledWith("studio-01");
    expect(bindings.get(1)).toBe("local");
    expect(client.list()).toEqual([]);
    expect(events.some((e) => e.type === "hosts-changed")).toBe(true);
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
});
