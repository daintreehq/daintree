import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activate: vi.fn(async (_ws: unknown, _project: unknown, _handle: number) => undefined),
  release: vi.fn(),
  resident: new Map<number, string>(),
  stale: new Set<number>(),
  projects: new Map<string, { id: string; path: string }>(),
}));

vi.mock("../../../services/ProjectSwitchService.js", () => ({
  activateProjectOnHost: (ws: unknown, project: { id: string }, handle: number) => {
    mocks.resident.set(handle, project.id);
    mocks.stale.delete(handle);
    return mocks.activate(ws, project, handle);
  },
  releaseProjectOnHost: (ws: unknown, handle: number) => {
    if (mocks.resident.delete(handle)) mocks.release(ws, handle);
  },
  getHostResidentProject: (handle: number) => mocks.resident.get(handle) ?? null,
  isProjectHeldOnHost: (_ws: unknown, handle: number, projectId: string) =>
    mocks.resident.get(handle) === projectId && !mocks.stale.has(handle),
}));
vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: { getProjectById: (id: string) => mocks.projects.get(id) ?? null },
}));
vi.mock("../../../window/serviceRefs.js", () => ({
  getWorkspaceClientRef: () => null,
  getWorktreePortBrokerRef: () => null,
}));

import { CHANNELS } from "../../../ipc/channels.js";
import { WORKTREE_PORT_REDELIVER_METHOD } from "../../../ipc/endpoint.js";
import { installRemoteProjectResidency } from "../residency.js";

interface FakeEndpoint {
  endpointId: string;
  handle: number;
  projectId: string | null;
  kind: "remote-view";
  closed: boolean;
  closeListeners: Array<() => void>;
  send: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  isClosed(): boolean;
  onClose(cb: () => void): { dispose(): void };
}

function endpoint(handle: number, projectId: string | null): FakeEndpoint {
  const ep: FakeEndpoint = {
    endpointId: `remote:s:view-${handle}`,
    handle,
    projectId,
    kind: "remote-view",
    closed: false,
    closeListeners: [],
    send: vi.fn(),
    request: vi.fn(async () => true),
    isClosed: () => ep.closed,
    onClose(cb) {
      ep.closeListeners.push(cb);
      return { dispose: () => (ep.closeListeners = ep.closeListeners.filter((l) => l !== cb)) };
    },
  };
  return ep;
}

function fakeRegistry() {
  const endpoints: FakeEndpoint[] = [];
  const listeners = new Set<() => void>();
  return {
    endpoints,
    change: () => listeners.forEach((l) => l()),
    getRemote: () => endpoints.filter((e) => !e.closed) as never,
    onChange: (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

function fakeWorkspace() {
  const spawnListeners = new Set<() => void>();
  return {
    loadProject: vi.fn(),
    resumeProject: vi.fn(),
    unregisterWindow: vi.fn(),
    isWindowAttached: vi.fn(() => true),
    getHostForProject: vi.fn((rootPath: string) => ({
      projectPath: rootPath,
      attachWorktreePort: vi.fn(),
    })),
    on: vi.fn((_event: "host-spawned", listener: () => void) => spawnListeners.add(listener)),
    off: vi.fn((_event: "host-spawned", listener: () => void) => spawnListeners.delete(listener)),
    spawn: () => spawnListeners.forEach((l) => l()),
    spawnListeners,
  };
}

const workspace = fakeWorkspace();
const broker = { connectEndpointPort: vi.fn(() => true) };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resident.clear();
  mocks.stale.clear();
  workspace.spawnListeners.clear();
  mocks.projects.clear();
  mocks.projects.set("p1", { id: "p1", path: "/srv/p1" });
  mocks.projects.set("p2", { id: "p2", path: "/srv/p2" });
});

describe("installRemoteProjectResidency", () => {
  it("activates the project a view names when its endpoint opens", async () => {
    const registry = fakeRegistry();
    const dispose = installRemoteProjectResidency({ registry, workspace: () => workspace });
    const ep = endpoint(-3, "p1");
    registry.endpoints.push(ep);
    registry.change();
    registry.change();
    await flush();

    expect(mocks.activate).toHaveBeenCalledTimes(1);
    expect(mocks.activate).toHaveBeenCalledWith(workspace, mocks.projects.get("p1"), -3);
    expect(ep.send).toHaveBeenCalledWith({
      type: "event",
      channel: CHANNELS.PROJECT_WORKTREE_LOAD_STATUS,
      args: [{ projectId: "p1", worktreeLoadError: null }],
    });
    dispose();
  });

  it("follows a rebind and releases the view's hold when it closes", async () => {
    const registry = fakeRegistry();
    installRemoteProjectResidency({ registry, workspace: () => workspace });
    const ep = endpoint(-3, "p1");
    registry.endpoints.push(ep);
    registry.change();
    ep.projectId = "p2";
    registry.change();
    expect(mocks.activate).toHaveBeenLastCalledWith(workspace, mocks.projects.get("p2"), -3);

    ep.closed = true;
    ep.closeListeners.forEach((l) => l());
    expect(mocks.release).toHaveBeenCalledWith(workspace, -3);
  });

  it("stops holding the project a view leaves for a scratch", () => {
    const registry = fakeRegistry();
    installRemoteProjectResidency({ registry, workspace: () => workspace });
    const ep = endpoint(-3, "p1");
    registry.endpoints.push(ep);
    registry.change();
    ep.projectId = "scratch-1";
    registry.change();
    expect(mocks.activate).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledWith(workspace, -3);
  });

  it("reports a failed load to the view it was for", async () => {
    mocks.activate.mockRejectedValueOnce(new Error("no git"));
    const registry = fakeRegistry();
    installRemoteProjectResidency({ registry, workspace: () => workspace });
    const ep = endpoint(-5, "p1");
    registry.endpoints.push(ep);
    registry.change();
    await flush();
    expect(ep.send).toHaveBeenCalledWith({
      type: "event",
      channel: CHANNELS.PROJECT_WORKTREE_LOAD_STATUS,
      args: [{ projectId: "p1", worktreeLoadError: expect.stringContaining("no git") }],
    });
  });

  it("connects the view's worktree port to the host its project loaded on", async () => {
    const registry = fakeRegistry();
    installRemoteProjectResidency({ registry, workspace: () => workspace, broker: () => broker });
    const ep = endpoint(-9, "p1");
    registry.endpoints.push(ep);
    registry.change();
    await flush();

    expect(workspace.getHostForProject).toHaveBeenCalledWith("/srv/p1");
    expect(broker.connectEndpointPort).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: "/srv/p1" }),
      -9
    );
    // A first attachment's port reaches the renderer the usual way.
    expect(ep.request).not.toHaveBeenCalled();
  });

  it("does not connect a view that moved on while its load ran", async () => {
    let finish!: () => void;
    mocks.activate.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (finish = () => resolve(undefined)))
    );
    const registry = fakeRegistry();
    installRemoteProjectResidency({ registry, workspace: () => workspace, broker: () => broker });
    const ep = endpoint(-9, "p1");
    registry.endpoints.push(ep);
    registry.change();
    ep.projectId = "scratch-1";
    finish();
    await flush();

    expect(broker.connectEndpointPort).not.toHaveBeenCalled();
  });

  it("re-holds and reconnects a view whose project's host was re-spawned under it", async () => {
    const registry = fakeRegistry();
    installRemoteProjectResidency({ registry, workspace: () => workspace, broker: () => broker });
    const stranded = endpoint(-9, "p1");
    const other = endpoint(-8, "p2");
    registry.endpoints.push(stranded, other);
    registry.change();
    await flush();
    expect(mocks.activate).toHaveBeenCalledTimes(2);
    broker.connectEndpointPort.mockClear();

    // The host serving p1 was replaced; -9 is no longer among its holders.
    mocks.stale.add(-9);
    workspace.spawn();
    await flush();

    expect(mocks.activate).toHaveBeenCalledTimes(3);
    expect(mocks.activate).toHaveBeenLastCalledWith(workspace, mocks.projects.get("p1"), -9);
    expect(broker.connectEndpointPort).toHaveBeenCalledTimes(1);
    expect(broker.connectEndpointPort).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: "/srv/p1" }),
      -9
    );
    // Its renderer is handed a fresh port so it fetches a snapshot again.
    expect(stranded.request).toHaveBeenCalledWith(WORKTREE_PORT_REDELIVER_METHOD, null, {
      timeoutMs: expect.any(Number),
    });
    expect(other.request).not.toHaveBeenCalled();
  });

  it("does not redeliver when the re-held view has no port waiting", async () => {
    const registry = fakeRegistry();
    installRemoteProjectResidency({ registry, workspace: () => workspace, broker: () => broker });
    const ep = endpoint(-9, "p1");
    registry.endpoints.push(ep);
    registry.change();
    await flush();

    broker.connectEndpointPort.mockReturnValueOnce(false);
    mocks.stale.add(-9);
    workspace.spawn();
    await flush();

    expect(mocks.activate).toHaveBeenCalledTimes(2);
    expect(ep.request).not.toHaveBeenCalled();
  });

  it("stops watching for re-spawned hosts once disposed", () => {
    const registry = fakeRegistry();
    const dispose = installRemoteProjectResidency({ registry, workspace: () => workspace });
    registry.change();
    expect(workspace.on).toHaveBeenCalledTimes(1);
    expect(workspace.spawnListeners.size).toBe(1);
    dispose();
    expect(workspace.spawnListeners.size).toBe(0);
  });

  it("does nothing without a workspace client, and releases everything on dispose", () => {
    const registry = fakeRegistry();
    let ws: typeof workspace | null = null;
    const dispose = installRemoteProjectResidency({ registry, workspace: () => ws });
    registry.endpoints.push(endpoint(-3, "p1"));
    registry.change();
    expect(mocks.activate).not.toHaveBeenCalled();

    ws = workspace;
    registry.change();
    expect(mocks.activate).toHaveBeenCalledTimes(1);
    dispose();
    expect(mocks.release).toHaveBeenCalledWith(workspace, -3);
  });
});
