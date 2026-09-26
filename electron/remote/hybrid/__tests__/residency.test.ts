import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activate: vi.fn(async (_ws: unknown, _project: unknown, _handle: number) => undefined),
  release: vi.fn(),
  resident: new Map<number, string>(),
  projects: new Map<string, { id: string; path: string }>(),
}));

vi.mock("../../../services/ProjectSwitchService.js", () => ({
  activateProjectOnHost: (ws: unknown, project: { id: string }, handle: number) => {
    mocks.resident.set(handle, project.id);
    return mocks.activate(ws, project, handle);
  },
  releaseProjectOnHost: (ws: unknown, handle: number) => {
    if (mocks.resident.delete(handle)) mocks.release(ws, handle);
  },
  getHostResidentProject: (handle: number) => mocks.resident.get(handle) ?? null,
}));
vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: { getProjectById: (id: string) => mocks.projects.get(id) ?? null },
}));
vi.mock("../../../window/serviceRefs.js", () => ({ getWorkspaceClientRef: () => null }));

import { CHANNELS } from "../../../ipc/channels.js";
import { installRemoteProjectResidency } from "../residency.js";

interface FakeEndpoint {
  endpointId: string;
  handle: number;
  projectId: string | null;
  kind: "remote-view";
  closed: boolean;
  closeListeners: Array<() => void>;
  send: ReturnType<typeof vi.fn>;
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

const workspace = { loadProject: vi.fn(), resumeProject: vi.fn(), unregisterWindow: vi.fn() };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resident.clear();
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
