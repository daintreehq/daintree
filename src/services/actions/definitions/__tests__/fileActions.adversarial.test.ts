// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";
import type { ActionContext } from "@shared/types/actions";

const systemClientMock = vi.hoisted(() => ({
  openInEditor: vi.fn(),
  openPath: vi.fn(),
  showItemInFolder: vi.fn(),
  showItemInFolderUnconfined: vi.fn(),
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
  return async (id: string, args?: unknown, ctx?: Partial<ActionContext>): Promise<unknown> => {
    const factory = actions.get(id);
    if (!factory) throw new Error(`missing ${id}`);
    const def = factory() as AnyActionDefinition;
    return def.run(args, (ctx ?? {}) as never);
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  openPanelDialogMock.mockReset().mockResolvedValue("file-panel-1");
  systemClientMock.openInEditor.mockResolvedValue(undefined);
  systemClientMock.openPath.mockResolvedValue(undefined);
  systemClientMock.showItemInFolder.mockResolvedValue(undefined);
  systemClientMock.showItemInFolderUnconfined.mockResolvedValue(undefined);
  projectStoreMock.getState.mockReturnValue({
    currentProject: { id: "proj-1", path: "/repo" },
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
    expect(systemClientMock.showItemInFolderUnconfined).not.toHaveBeenCalled();
  });

  it("file.showItemInFolder propagates systemClient errors to caller", async () => {
    systemClientMock.showItemInFolder.mockRejectedValueOnce(new Error("outside root"));
    const run = setupActions();

    await expect(run("file.showItemInFolder", { path: "/repo/x.ts" })).rejects.toThrow(
      "outside root"
    );
  });

  // The out-of-root reveal fallback (#11934). These exercise the action directly
  // because it is the only layer where both client methods are observable: the
  // pane's own tests mock `actionService.dispatch` wholesale. Rejections carry
  // the `[AppError|CODE] ` prefix and NO own `code`/`name`, which is the shape a
  // main-process AppError actually has once contextBridge has stripped it twice.
  describe("file.showItemInFolder out-of-root fallback", () => {
    const OUT_OF_ROOT = "/var/folders/t/daintree-clipboard/clipboard-1.png";
    const encoded = (code: string, message: string): Error =>
      new Error(`[AppError|${code}] ${message}`);

    it("never reaches the unconfined op when the contained reveal succeeds", async () => {
      const run = setupActions();
      await run("file.showItemInFolder", { path: OUT_OF_ROOT, allowOutsideRoots: true });

      expect(systemClientMock.showItemInFolder).toHaveBeenCalledWith(OUT_OF_ROOT);
      expect(systemClientMock.showItemInFolderUnconfined).not.toHaveBeenCalled();
    });

    it("retries through the unconfined op on OUTSIDE_ROOT, with the same path", async () => {
      systemClientMock.showItemInFolder.mockRejectedValueOnce(
        encoded("OUTSIDE_ROOT", "Path is outside all allowed roots")
      );
      const run = setupActions();
      await run("file.showItemInFolder", { path: OUT_OF_ROOT, allowOutsideRoots: true });

      expect(systemClientMock.showItemInFolder).toHaveBeenCalledWith(OUT_OF_ROOT);
      expect(systemClientMock.showItemInFolderUnconfined).toHaveBeenCalledWith(OUT_OF_ROOT);
      // Contained first, always: the relaxed op is a fallback, never the opener.
      expect(systemClientMock.showItemInFolder.mock.invocationCallOrder[0]!).toBeLessThan(
        systemClientMock.showItemInFolderUnconfined.mock.invocationCallOrder[0]!
      );
    });

    it("rethrows OUTSIDE_ROOT untouched when the flag is left at its default", async () => {
      const rejection = encoded("OUTSIDE_ROOT", "Path is outside all allowed roots");
      systemClientMock.showItemInFolder.mockRejectedValueOnce(rejection);
      const run = setupActions();

      // No `allowOutsideRoots` key at all, so Zod's `.default(false)` decides.
      await expect(run("file.showItemInFolder", { path: OUT_OF_ROOT })).rejects.toBe(rejection);
      expect(systemClientMock.showItemInFolderUnconfined).not.toHaveBeenCalled();
    });

    it("does not fall back on INVALID_PATH even with the flag set", async () => {
      const rejection = encoded("INVALID_PATH", "Could not resolve path");
      systemClientMock.showItemInFolder.mockRejectedValueOnce(rejection);
      const run = setupActions();

      await expect(
        run("file.showItemInFolder", { path: OUT_OF_ROOT, allowOutsideRoots: true })
      ).rejects.toBe(rejection);
      expect(systemClientMock.showItemInFolderUnconfined).not.toHaveBeenCalled();
    });

    it("does not fall back on an undecodable error even with the flag set", async () => {
      const rejection = new Error("shell unavailable");
      systemClientMock.showItemInFolder.mockRejectedValueOnce(rejection);
      const run = setupActions();

      await expect(
        run("file.showItemInFolder", { path: OUT_OF_ROOT, allowOutsideRoots: true })
      ).rejects.toBe(rejection);
      expect(systemClientMock.showItemInFolderUnconfined).not.toHaveBeenCalled();
    });

    it("propagates a failure from the unconfined op rather than swallowing it", async () => {
      systemClientMock.showItemInFolder.mockRejectedValueOnce(
        encoded("OUTSIDE_ROOT", "Path is outside all allowed roots")
      );
      const denied = encoded("INVALID_PATH", "Executable targets cannot be revealed");
      systemClientMock.showItemInFolderUnconfined.mockRejectedValueOnce(denied);
      const run = setupActions();

      await expect(
        run("file.showItemInFolder", { path: "/tmp/Evil.app", allowOutsideRoots: true })
      ).rejects.toBe(denied);
    });

    it("refuses the flag from a plugin dispatch before either client call", async () => {
      const run = setupActions();

      await expect(
        run(
          "file.showItemInFolder",
          { path: OUT_OF_ROOT, allowOutsideRoots: true },
          { dispatchSource: "plugin" }
        )
      ).rejects.toThrow(/Plugins cannot reveal paths outside/);
      expect(systemClientMock.showItemInFolder).not.toHaveBeenCalled();
      expect(systemClientMock.showItemInFolderUnconfined).not.toHaveBeenCalled();
    });

    it("leaves a plugin's ordinary contained reveal alone", async () => {
      const run = setupActions();
      await run("file.showItemInFolder", { path: "/repo/src/x.ts" }, { dispatchSource: "plugin" });

      expect(systemClientMock.showItemInFolder).toHaveBeenCalledWith("/repo/src/x.ts");
      expect(systemClientMock.showItemInFolderUnconfined).not.toHaveBeenCalled();
    });
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

  it("file.openDiff opens a diff panel with the path relativized against the supplied worktree", async () => {
    openPanelDialogMock.mockResolvedValue("diff-panel-1");
    const run = setupActions();
    const result = await run("file.openDiff", {
      path: "/repo/src/x.ts",
      worktreePath: "/repo",
      status: "added",
    });

    const options = openPanelDialogMock.mock.calls[0]![0] as Record<string, unknown>;
    // The panel resolves its root from worktreeId, so the path must arrive relative.
    expect(options).toMatchObject({
      kind: "diff",
      filePath: "src/x.ts",
      fileStatus: "added",
      diffSource: "working-tree",
      worktreeId: "wt-1",
    });
    expect(result).toEqual({ panelId: "diff-panel-1" });
  });

  it("file.openDiff falls back to the current project path and modified status", async () => {
    const run = setupActions();
    await run("file.openDiff", { path: "/repo/src/y.ts" });

    const options = openPanelDialogMock.mock.calls[0]![0] as Record<string, unknown>;
    // No worktreePath given — currentProject.path (/repo) is what strips the prefix.
    expect(options.filePath).toBe("src/y.ts");
    expect(options.fileStatus).toBe("modified");
  });

  it("file.openDiff leaves a path outside the worktree untouched", async () => {
    const run = setupActions();
    await run("file.openDiff", { path: "/elsewhere/z.ts", worktreePath: "/repo" });

    const options = openPanelDialogMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(options.filePath).toBe("/elsewhere/z.ts");
  });

  it("file.openDiff does not mangle a sibling worktree whose name extends the root", async () => {
    const run = setupActions();
    const siblingPath = "/repo-other/src/x.ts";
    await run("file.openDiff", { path: siblingPath, worktreePath: "/repo" });

    const options = openPanelDialogMock.mock.calls[0]![0] as Record<string, unknown>;
    // A prefix test without a separator boundary accepts "/repo-other/..." and
    // slices the root's length off it, producing "-other/src/x.ts".
    expect(options.filePath).toBe(siblingPath);
  });

  it("file.openDiff relativizes across separator styles and redundant segments", async () => {
    const run = setupActions();
    await run("file.openDiff", { path: "/repo/./src\\deep\\x.ts", worktreePath: "/repo/" });

    const options = openPanelDialogMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(options.filePath).toBe("src/deep/x.ts");
  });

  it("file.openDiff throws when the panel could not be created", async () => {
    openPanelDialogMock.mockResolvedValue(null);
    const run = setupActions();

    await expect(run("file.openDiff", { path: "/repo/src/x.ts" })).rejects.toThrow(/diff viewer/i);
  });
});
