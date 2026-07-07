// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const systemClientMock = vi.hoisted(() => ({
  openInEditor: vi.fn(),
  openPath: vi.fn(),
  showItemInFolder: vi.fn(),
}));

const projectStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));

vi.mock("@/clients", () => ({ systemClient: systemClientMock }));
vi.mock("@/store", () => ({ useProjectStore: projectStoreMock }));
// file.openPanel pulls the panel store; stub it so its persistence graph stays out.
vi.mock("@/store/panelStore", () => ({ usePanelStore: { getState: vi.fn() } }));

import { registerFileActions } from "../fileActions";

function setupActions() {
  const actions: ActionRegistry = new Map();
  const callbacks: ActionCallbacks = {} as unknown as ActionCallbacks;
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
  it("file.view dispatches event with full detail (path/rootPath/line/col)", async () => {
    const run = setupActions();
    await run("file.view", {
      path: "/a/b.ts",
      rootPath: "/a",
      line: 12,
      col: 4,
    });

    const event = dispatchSpy.mock.calls[0]![0] as unknown as {
      type: string;
      detail: { path: string; rootPath?: string; line?: number; col?: number };
    };
    expect(event.type).toBe("daintree:view-file");
    expect(event.detail).toEqual({
      path: "/a/b.ts",
      rootPath: "/a",
      line: 12,
      col: 4,
    });
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

  it("file.view dispatches correct shape even with only path supplied", async () => {
    const run = setupActions();
    await run("file.view", { path: "/just/a/path.txt" });

    const event = dispatchSpy.mock.calls[0]![0] as unknown as {
      detail: { path: string; rootPath?: string; line?: number; col?: number };
    };
    expect(event.detail.path).toBe("/just/a/path.txt");
    expect(event.detail.rootPath).toBeUndefined();
    expect(event.detail.line).toBeUndefined();
    expect(event.detail.col).toBeUndefined();
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
