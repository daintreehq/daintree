// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const systemClientMock = vi.hoisted(() => ({
  openInEditor: vi.fn(),
  openPath: vi.fn(),
  showItemInFolder: vi.fn(),
}));

const projectStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const openPanelDialogMock = vi.hoisted(() => vi.fn<(options: unknown) => Promise<string | null>>());

vi.mock("@/clients", () => ({ systemClient: systemClientMock }));
vi.mock("@/store", () => ({ useProjectStore: projectStoreMock }));
// file.openPanel pulls the panel store; stub it so its persistence graph stays out.
vi.mock("@/store/panelStore", () => ({ usePanelStore: { getState: vi.fn() } }));
vi.mock("@/store/panelDialogStore", () => ({
  usePanelDialogStore: { getState: () => ({ openPanelDialog: openPanelDialogMock }) },
}));

import { registerFileActions } from "../fileActions";

function setupActions() {
  const actions: ActionRegistry = new Map();
  const callbacks: ActionCallbacks = {
    getActiveWorktreeId: () => "wt-1",
    getWorktrees: () => [],
  } as unknown as ActionCallbacks;
  registerFileActions(actions, callbacks);
  return async (id: string, args?: unknown): Promise<unknown> => {
    const factory = actions.get(id);
    if (!factory) throw new Error(`missing ${id}`);
    const def = factory() as AnyActionDefinition;
    return def.run(args, {} as never);
  };
}

const dispatchSpy = vi.fn<(event: Event) => boolean>(() => true);

beforeEach(() => {
  vi.clearAllMocks();
  dispatchSpy.mockReset().mockReturnValue(true);
  openPanelDialogMock.mockReset().mockResolvedValue("file-panel-1");
  systemClientMock.openInEditor.mockResolvedValue(undefined);
  systemClientMock.openPath.mockResolvedValue(undefined);
  systemClientMock.showItemInFolder.mockResolvedValue(undefined);
  projectStoreMock.getState.mockReturnValue({
    currentProject: { id: "proj-1", path: "/repo" },
  });
  Object.defineProperty(globalThis.window, "dispatchEvent", {
    value: dispatchSpy,
    configurable: true,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("fileActions adversarial", () => {
  it("file.view opens an ephemeral file panel dialog with the resolved path", async () => {
    const run = setupActions();
    const result = await run("file.view", {
      path: "/a/b.ts",
      rootPath: "/a",
      line: 12,
      col: 4,
    });

    expect(openPanelDialogMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "file", filePath: "/a/b.ts", initialLine: 12 })
    );
    expect(result).toEqual({ panelId: "file-panel-1" });
  });

  it("file.view resolves a repo-relative path against the current project", async () => {
    const run = setupActions();
    await run("file.view", { path: "src/index.ts" });

    expect(openPanelDialogMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "/repo/src/index.ts" })
    );
  });

  it("file.view omits initialLine when no line was requested", async () => {
    const run = setupActions();
    await run("file.view", { path: "/a/b.ts" });

    const options = openPanelDialogMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(options).not.toHaveProperty("initialLine");
  });

  it("file.view throws when the dialog panel could not be created", async () => {
    openPanelDialogMock.mockResolvedValue(null);
    const run = setupActions();

    await expect(run("file.view", { path: "/a/b.ts" })).rejects.toThrow();
  });

  it("file.openInEditor forwards projectId from current project", async () => {
    const run = setupActions();
    await run("file.openInEditor", { path: "/a/b.ts", line: 5 });

    expect(systemClientMock.openInEditor).toHaveBeenCalledWith({
      path: "/a/b.ts",
      line: 5,
      col: undefined,
      projectId: "proj-1",
    });
  });

  it("file.openInEditor forwards undefined projectId when no current project", async () => {
    projectStoreMock.getState.mockReturnValue({ currentProject: null });
    const run = setupActions();
    await run("file.openInEditor", { path: "/a/b.ts" });

    expect(systemClientMock.openInEditor).toHaveBeenCalledWith({
      path: "/a/b.ts",
      line: undefined,
      col: undefined,
      projectId: undefined,
    });
  });

  it("file.openImageViewer forwards path to systemClient.openPath", async () => {
    const run = setupActions();
    await run("file.openImageViewer", { path: "/img/x.png" });

    expect(systemClientMock.openPath).toHaveBeenCalledWith("/img/x.png");
  });

  it("file.showItemInFolder forwards path to systemClient.showItemInFolder", async () => {
    const run = setupActions();
    await run("file.showItemInFolder", { path: "/repo/src/x.ts" });

    expect(systemClientMock.showItemInFolder).toHaveBeenCalledWith("/repo/src/x.ts");
  });

  it("file.showItemInFolder propagates systemClient errors to caller", async () => {
    systemClientMock.showItemInFolder.mockRejectedValueOnce(new Error("outside root"));
    const run = setupActions();

    await expect(run("file.showItemInFolder", { path: "/repo/x.ts" })).rejects.toThrow(
      "outside root"
    );
  });

  it("file.view opens with only a path supplied, omitting the optional hints", async () => {
    const run = setupActions();
    await run("file.view", { path: "/just/a/path.txt" });

    const options = openPanelDialogMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(options.filePath).toBe("/just/a/path.txt");
    expect(options).not.toHaveProperty("initialLine");
    // `col` is accepted by the schema for compatibility but never plumbed —
    // CodeViewer only positions by line.
    expect(options).not.toHaveProperty("initialCol");
  });

  it("file.openInEditor propagates systemClient errors to caller", async () => {
    systemClientMock.openInEditor.mockRejectedValueOnce(new Error("editor not found"));
    const run = setupActions();

    await expect(run("file.openInEditor", { path: "/a/b.ts" })).rejects.toThrow("editor not found");
  });

  it("file.openDiff dispatches view-diff with the supplied worktreePath and status", async () => {
    const run = setupActions();
    await run("file.openDiff", {
      path: "/repo/src/x.ts",
      worktreePath: "/repo",
      status: "added",
    });

    const event = dispatchSpy.mock.calls[0]![0] as unknown as {
      type: string;
      detail: { path: string; worktreePath?: string; status?: string };
    };
    expect(event.type).toBe("daintree:view-diff");
    expect(event.detail).toEqual({
      path: "/repo/src/x.ts",
      worktreePath: "/repo",
      status: "added",
    });
  });

  it("file.openDiff falls back to the current project path and modified status", async () => {
    const run = setupActions();
    await run("file.openDiff", { path: "/repo/src/y.ts" });

    const event = dispatchSpy.mock.calls[0]![0] as unknown as {
      detail: { path: string; worktreePath?: string; status?: string };
    };
    // worktreePath resolves from currentProject.path (/repo); status defaults.
    expect(event.detail.worktreePath).toBe("/repo");
    expect(event.detail.status).toBe("modified");
  });
});
