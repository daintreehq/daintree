// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.hoisted(() =>
  vi.fn<(id: string, args: unknown, opts?: unknown) => Promise<{ ok: boolean }>>(() =>
    Promise.resolve({ ok: true })
  )
);
const notify = vi.hoisted(() => vi.fn());
const setActiveTab = vi.hoisted(() => vi.fn<(groupId: string, panelId: string) => void>());
const getPanelGroup = vi.hoisted(() =>
  vi.fn<(panelId: string) => { id: string; panelIds: string[] } | undefined>()
);
const panelState = vi.hoisted(() => ({ panelsById: {} as Record<string, unknown> }));
const selection = vi.hoisted(() => ({
  activeWorktreeId: "w1" as string | null,
  deletedWorktrees: new Set<string>(),
  trackTerminalFocus: vi.fn<(worktreeId: string, panelId: string) => void>(),
  selectWorktree: vi.fn(),
}));
const view = vi.hoisted(() => ({
  workspaceId: "project-1" as string | null,
  currentProjectId: undefined as string | undefined,
  worktreeIds: new Set<string>(["w1", "w2"]) as Set<string> | null,
}));
const remote = vi.hoisted(() => ({
  hostId: null as string | null,
  resolve: vi.fn<(url: string, hostId: string | null) => Promise<string>>((url) =>
    Promise.resolve(url)
  ),
}));

vi.mock("@/clients", () => ({ systemClient: { openExternal: vi.fn() } }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));
vi.mock("@/lib/notify", () => ({ notify }));
vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: { getState: () => selection },
}));
vi.mock("@/store/viewWorkspaceId", () => ({ getViewWorkspaceId: () => view.workspaceId }));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: {
    getState: () => ({
      currentProject: view.currentProjectId ? { id: view.currentProjectId } : null,
    }),
  },
}));
vi.mock("@/store/storeAccessors", () => ({ getWorktreeIdSet: () => view.worktreeIds }));
vi.mock("@/services/terminal/remoteLoopbackLinks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/terminal/remoteLoopbackLinks")>()),
  remoteHostOfView: () => remote.hostId,
  resolveTerminalLinkForHost: (url: string, hostId: string | null) => remote.resolve(url, hostId),
  hostForwardFailure: () => "Port 5824 on the host couldn't be forwarded to this machine.",
}));
vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => ({ ...panelState, getPanelGroup, setActiveTab }),
  },
}));

import { devServerPanelInView, openDevServer, openDevServerExternally } from "../openDevServer";

function preview(id: string, extra: Record<string, unknown> = {}) {
  return { id, kind: "dev-preview", location: "grid", worktreeId: "w1", ...extra };
}

function withPanels(...panels: Array<{ id: string }>): void {
  panelState.panelsById = Object.fromEntries(panels.map((p) => [p.id, p]));
}

function server(extra: Record<string, unknown> = {}) {
  return {
    panelId: "p1",
    projectId: "project-1",
    status: "running" as const,
    url: "http://localhost:5824",
    ...extra,
  };
}

function calls(): Array<[string, unknown]> {
  return dispatch.mock.calls.map(([id, args]) => [id, args]);
}

function openedExternally(): unknown[] {
  return dispatch.mock.calls
    .filter(([id]) => id === "system.openExternal")
    .map(([, args]) =>
      typeof args === "object" && args !== null && "url" in args ? args.url : args
    );
}

beforeEach(() => {
  dispatch.mockReset().mockResolvedValue({ ok: true });
  notify.mockClear();
  setActiveTab.mockClear();
  getPanelGroup.mockReset().mockReturnValue(undefined);
  selection.activeWorktreeId = "w1";
  selection.deletedWorktrees = new Set();
  selection.trackTerminalFocus.mockClear();
  selection.selectWorktree.mockClear();
  view.workspaceId = "project-1";
  view.currentProjectId = undefined;
  view.worktreeIds = new Set(["w1", "w2"]);
  remote.hostId = null;
  remote.resolve.mockReset().mockImplementation((url) => Promise.resolve(url));
  withPanels();
});

describe("devServerPanelInView", () => {
  it("finds the server's own preview among this view's panels", () => {
    withPanels(preview("p1", { worktreeId: "w2" }));
    expect(devServerPanelInView(server())).toEqual(expect.objectContaining({ id: "p1" }));
  });

  it("finds a worktree-less preview of this view's folder or scratch", () => {
    withPanels(preview("p1", { worktreeId: undefined }));
    expect(devServerPanelInView(server())?.id).toBe("p1");
  });

  it("falls back to the current project when the view has no seeded workspace", () => {
    view.workspaceId = null;
    view.currentProjectId = "project-1";
    withPanels(preview("p1"));
    expect(devServerPanelInView(server())?.id).toBe("p1");
  });

  it("never takes another project's panel that shares the id", () => {
    withPanels(preview("p1"));
    expect(devServerPanelInView(server({ projectId: "project-2" }))).toBeUndefined();
  });

  it("has nothing when the view's workspace is unknown", () => {
    view.workspaceId = null;
    withPanels(preview("p1"));
    expect(devServerPanelInView(server())).toBeUndefined();
  });

  it.each(["trash", "background", "dialog", "overlay"])("skips a preview in %s", (location) => {
    withPanels(preview("p1", { location }));
    expect(devServerPanelInView(server())).toBeUndefined();
  });

  it("takes a preview in the dock", () => {
    withPanels(preview("p1", { location: "dock" }));
    expect(devServerPanelInView(server())?.id).toBe("p1");
  });

  it("skips a panel of another kind under the same id", () => {
    withPanels(preview("p1", { kind: "browser" }));
    expect(devServerPanelInView(server())).toBeUndefined();
  });

  it("skips a preview whose worktree this view doesn't show, but keeps a deleted one's", () => {
    withPanels(preview("p1", { worktreeId: "w9" }));
    expect(devServerPanelInView(server())).toBeUndefined();
    selection.deletedWorktrees = new Set(["w8"]);
    expect(devServerPanelInView(server())).toBeUndefined();
    selection.deletedWorktrees = new Set(["w8", "w9"]);
    expect(devServerPanelInView(server())?.id).toBe("p1");
  });
});

describe("openDevServer", () => {
  it("brings a preview in the active worktree forward without navigating it", async () => {
    withPanels(preview("p1"));
    await openDevServer(server());
    expect(calls()).toEqual([["panel.focus", { panelId: "p1" }]]);
    expect(selection.trackTerminalFocus).not.toHaveBeenCalled();
  });

  it("switches to another worktree of this project before focusing its preview", async () => {
    withPanels(preview("p1", { worktreeId: "w2" }));
    let selected!: (result: { ok: boolean }) => void;
    dispatch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          selected = resolve;
        })
    );
    const opening = openDevServer(server());
    await Promise.resolve();
    // Nothing is focused while the switch is still under way.
    expect(calls()).toEqual([["worktree.select", { worktreeId: "w2" }]]);
    selected({ ok: true });
    await opening;
    expect(selection.trackTerminalFocus).toHaveBeenCalledWith("w2", "p1");
    expect(calls()).toEqual([
      ["worktree.select", { worktreeId: "w2" }],
      ["panel.focus", { panelId: "p1" }],
    ]);
  });

  it("stops short of focusing when the worktree switch is refused", async () => {
    withPanels(preview("p1", { worktreeId: "w2" }));
    dispatch.mockResolvedValueOnce({ ok: false });
    await openDevServer(server());
    expect(calls().map(([id]) => id)).toEqual(["worktree.select"]);
  });

  it("brings a preview behind another tab of its group to the front", async () => {
    withPanels(preview("p1"));
    getPanelGroup.mockReturnValue({ id: "g1", panelIds: ["other", "p1"] });
    await openDevServer(server());
    expect(setActiveTab).toHaveBeenCalledWith("g1", "p1");
    expect(calls()).toEqual([["panel.focus", { panelId: "p1" }]]);
    // In front before it takes focus, so the focus lands on a pane on screen.
    expect(setActiveTab.mock.invocationCallOrder[0]).toBeLessThan(
      dispatch.mock.invocationCallOrder[0]!
    );
  });

  it("opens another project's server in the system browser", async () => {
    withPanels(preview("p1"));
    await openDevServer(server({ projectId: "project-2" }));
    expect(openedExternally()).toEqual(["http://localhost:5824"]);
    expect(calls().some(([id]) => id === "panel.focus")).toBe(false);
  });

  it("opens nothing for a server that isn't running", async () => {
    withPanels(preview("p1"));
    await openDevServer(server({ status: "starting" }));
    await openDevServer(server({ url: null }));
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("openDevServerExternally", () => {
  it("hands a local view's address straight to the system browser", async () => {
    await openDevServerExternally("http://localhost:5824");
    expect(remote.resolve).not.toHaveBeenCalled();
    expect(openedExternally()).toEqual(["http://localhost:5824"]);
  });

  it("forwards a Remote Host's port first and opens the forwarded address", async () => {
    remote.hostId = "host-1";
    remote.resolve.mockResolvedValue("http://localhost:61234/");
    await openDevServerExternally("http://localhost:5824");
    expect(remote.resolve).toHaveBeenCalledWith("http://localhost:5824/", "host-1");
    expect(openedExternally()).toEqual(["http://localhost:61234/"]);
  });

  it("forwards an address spelled the way the system browser reads it", async () => {
    remote.hostId = "host-1";
    remote.resolve.mockResolvedValue("http://localhost:61234/");
    await openDevServerExternally("http:localhost:5824");
    expect(remote.resolve).toHaveBeenCalledWith("http://localhost:5824/", "host-1");
    expect(openedExternally()).toEqual(["http://localhost:61234/"]);
  });

  it("opens nothing, and says why, when the host's port can't be forwarded", async () => {
    remote.hostId = "host-1";
    remote.resolve.mockRejectedValue(new Error("refused"));
    await openDevServerExternally("http://localhost:5824");
    expect(openedExternally()).toEqual([]);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Couldn't open dev server" })
    );
  });

  it("forwards a host's wildcard address as its loopback", async () => {
    remote.hostId = "host-1";
    await openDevServerExternally("http://0.0.0.0:5824");
    expect(remote.resolve).toHaveBeenCalledWith("http://0.0.0.0:5824/", "host-1");
  });

  it.each(["http://app.localhost:5824", "http://[::]:5824", "http://127.0.0.2:5824"])(
    "never opens the host's %s against this machine",
    async (url) => {
      remote.hostId = "host-1";
      await openDevServerExternally(url);
      expect(remote.resolve).not.toHaveBeenCalled();
      expect(openedExternally()).toEqual([]);
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          message: expect.stringContaining("can't be forwarded to this machine"),
        })
      );
    }
  );

  it("passes a host's private-network address through the host's resolver", async () => {
    remote.hostId = "host-1";
    remote.resolve.mockImplementation((url) => Promise.resolve(`${url}#resolved`));
    await openDevServerExternally("http://10.0.0.5:5824");
    expect(remote.resolve).toHaveBeenCalledWith("http://10.0.0.5:5824/", "host-1");
    expect(openedExternally()).toEqual(["http://10.0.0.5:5824/#resolved"]);
  });
});
