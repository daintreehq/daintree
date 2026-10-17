import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";
import type { ActionContext, ActionSource } from "@shared/types/actions";

const systemClientMock = vi.hoisted(() => ({
  openInEditor: vi.fn(),
  openPath: vi.fn(),
  showItemInFolder: vi.fn(),
  showItemInFolderUnconfined: vi.fn(),
}));

const projectStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const panelStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const openPanelDialogMock = vi.hoisted(() => vi.fn<(options: unknown) => Promise<string | null>>());
const primePreviewCapabilityMock = vi.hoisted(() => vi.fn<() => Promise<string | null>>());
const readMock = vi.hoisted(() => vi.fn());

vi.mock("@/clients", () => ({
  systemClient: systemClientMock,
  worktreeClient: { refresh: () => Promise.resolve() },
}));
vi.mock("@/clients/filesClient", () => ({ filesClient: { read: readMock } }));
vi.mock("@/store", () => ({ useProjectStore: projectStoreMock }));
vi.mock("@/store/panelStore", () => ({ usePanelStore: panelStoreMock }));
vi.mock("@/store/panelDialogStore", () => ({
  usePanelDialogStore: { getState: () => ({ openPanelDialog: openPanelDialogMock }) },
}));

vi.mock("@/components/FileViewer/filePreviewKinds", () => ({
  primeHostPreviewCapability: primePreviewCapabilityMock,
}));

import { registerFileActions } from "../fileActions";

/**
 * `wt-1` is what `getActiveWorktreeId` reports, so it is the fallback under
 * test; `wt-other` is a real worktree that is not the active one. Paths are
 * disjoint so containment has an unambiguous answer.
 */
let worktreesFixture: Array<{ id: string; path: string }> = [];

function setupActions() {
  const actions: ActionRegistry = new Map();
  const callbacks: ActionCallbacks = {
    getActiveWorktreeId: () => "wt-1",
    getWorktrees: () => worktreesFixture,
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
  worktreesFixture = [
    { id: "wt-1", path: "/repo/wt-1" },
    { id: "wt-other", path: "/repo/wt-other" },
  ];
  openPanelDialogMock.mockReset().mockResolvedValue("file-panel-1");
  primePreviewCapabilityMock.mockReset().mockResolvedValue(null);
  // `mockReset`, not `clearAllMocks` alone: the latter drains call records but
  // NOT queued `...Once` implementations, so a test that aborts before consuming
  // its rejection would hand it to the next one.
  systemClientMock.openInEditor.mockReset().mockResolvedValue(undefined);
  systemClientMock.openPath.mockReset().mockResolvedValue(undefined);
  systemClientMock.showItemInFolder.mockReset().mockResolvedValue(undefined);
  systemClientMock.showItemInFolderUnconfined.mockReset().mockResolvedValue(undefined);
  projectStoreMock.getState.mockReturnValue({
    currentProject: { id: "proj-1", path: "/repo" },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("fileActions adversarial", () => {
  it("file.view waits for a remote view's preview capability before opening the dialog", async () => {
    let resolvePrime!: (capability: string | null) => void;
    primePreviewCapabilityMock.mockReturnValue(
      new Promise((resolve) => {
        resolvePrime = resolve;
      })
    );
    const run = setupActions();

    const pending = run("file.view", { path: "shots/after.png" });
    await Promise.resolve();
    await Promise.resolve();
    expect(primePreviewCapabilityMock).toHaveBeenCalledTimes(1);
    expect(openPanelDialogMock).not.toHaveBeenCalled();

    resolvePrime("cap-1");
    await expect(pending).resolves.toEqual({ panelId: "file-panel-1" });
    expect(openPanelDialogMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "file", filePath: "/repo/shots/after.png" })
    );
  });

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

  it("file.view pins rootPath as the viewer's containment root when confineToRoot is set", async () => {
    const run = setupActions();
    // A link out of a plugin's notes directory, through `escape -> /etc`. The
    // viewer's own fallback root is the file's directory, which realpaths to
    // /etc and would contain the target; the pinned root does not.
    await run("file.view", {
      path: "/tmp/plugin/escape/passwd",
      rootPath: "/tmp/plugin",
      confineToRoot: true,
    });

    expect(openPanelDialogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: "/tmp/plugin/escape/passwd",
        fileContainmentRoot: "/tmp/plugin",
      })
    );
  });

  it("file.view leaves the viewer's root inference alone without confineToRoot", async () => {
    const run = setupActions();
    await run("file.view", { path: "/a/b.ts", rootPath: "/a" });

    expect(openPanelDialogMock.mock.calls[0]![0]).not.toHaveProperty("fileContainmentRoot");
  });

  it("file.view refuses confineToRoot without a rootPath to confine to", async () => {
    const run = setupActions();
    await expect(run("file.view", { path: "/a/b.ts", confineToRoot: true })).rejects.toThrow(
      /rootPath/
    );
    expect(openPanelDialogMock).not.toHaveBeenCalled();
  });

  it("file.view resolves a repo-relative path against the current project", async () => {
    const run = setupActions();
    await run("file.view", { path: "src/index.ts" });

    expect(openPanelDialogMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "/repo/src/index.ts" })
    );
  });

  it("file.view throws when the dialog panel could not be created", async () => {
    openPanelDialogMock.mockResolvedValue(null);
    const run = setupActions();

    await expect(run("file.view", { path: "/a/b.ts" })).rejects.toThrow();
  });

  it("file.view falls back to the active worktree for a file outside every one", async () => {
    const run = setupActions();
    await run("file.view", { path: "/elsewhere/b.ts" });

    expect(openPanelDialogMock).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: "wt-1" })
    );
  });

  it("file.view binds an unnamed target to the worktree containing it", async () => {
    const run = setupActions();
    await run("file.view", { path: "/repo/wt-other/src/b.ts" });

    // `wt-1` is the active worktree, so stamping it here would be the bug: the
    // binding decides the pane's read root and, on promotion, which worktree
    // bucket the panel lands in (#11276).
    expect(openPanelDialogMock).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: "wt-other" })
    );
  });

  it("file.view honours an explicit worktreeId over the active worktree", async () => {
    const run = setupActions();
    await run("file.view", { path: "/elsewhere/b.ts", worktreeId: "wt-other" });

    expect(openPanelDialogMock).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: "wt-other" })
    );
  });

  it("file.view rejects a worktreeId the project does not have", async () => {
    const run = setupActions();

    // Silently binding somewhere else on a named target is the class of bug
    // #7880 banned — the caller's claim is wrong, and it must be told.
    await expect(run("file.view", { path: "/a/b.ts", worktreeId: "ghost" })).rejects.toThrow();
    expect(openPanelDialogMock).not.toHaveBeenCalled();
  });

  it("file.view rejects an empty worktreeId rather than treating it as absent", async () => {
    const run = setupActions();

    // `""` is falsy but not nullish, so a plain `??` would carry it through and
    // index the panel under an empty, unreachable worktree bucket.
    await expect(run("file.view", { path: "/a/b.ts", worktreeId: "" })).rejects.toThrow();
    expect(openPanelDialogMock).not.toHaveBeenCalled();
  });

  it("file.view distinguishes an unloaded worktree list from a foreign id", async () => {
    worktreesFixture = [];
    const run = setupActions();

    // Transient and worth retrying, unlike a foreign id — so it must not read
    // as the same refusal.
    await expect(run("file.view", { path: "/a/b.ts", worktreeId: "wt-1" })).rejects.toThrow(
      /haven't loaded yet/
    );
  });

  it("file.view omits fileViewMode when no view mode was requested", async () => {
    const run = setupActions();
    await run("file.view", { path: "/a/notes.md" });

    const options = openPanelDialogMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(options).not.toHaveProperty("fileViewMode");
  });

  it("file.view keeps an explicit source request on a renderable file", async () => {
    const run = setupActions();
    await run("file.view", { path: "/a/notes.md", viewMode: "source" });

    // The clamp only ever demotes; asking for source on a file that *could*
    // render must not be quietly upgraded.
    expect(openPanelDialogMock).toHaveBeenCalledWith(
      expect.objectContaining({ fileViewMode: "source" })
    );
  });

  it("file.view clamps a rendered request on a non-renderable file to source", async () => {
    const run = setupActions();
    await run("file.view", { path: "/a/styles.css", viewMode: "rendered" });

    expect(openPanelDialogMock).toHaveBeenCalledWith(
      expect.objectContaining({ fileViewMode: "source" })
    );
  });

  it("file.view opens a worktree plan file rendered, rooted on that worktree (#11942)", async () => {
    const run = setupActions();
    // The shape a worktree card dispatches: `planFilePath` is a bare candidate
    // filename, joined against the card's own worktree rather than the project.
    await run("file.view", {
      path: "TODO.md",
      rootPath: "/repo/wt-other",
      worktreeId: "wt-other",
      viewMode: "rendered",
    });

    expect(openPanelDialogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "file",
        filePath: "/repo/wt-other/TODO.md",
        worktreeId: "wt-other",
        fileViewMode: "rendered",
        title: "TODO.md",
      })
    );
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

    it.each([
      ["omitted, so Zod's default decides", {}],
      ["passed explicitly as false", { allowOutsideRoots: false }],
    ])("rethrows OUTSIDE_ROOT untouched when the flag is %s", async (_label, flag) => {
      const rejection = encoded("OUTSIDE_ROOT", "Path is outside all allowed roots");
      systemClientMock.showItemInFolder.mockRejectedValueOnce(rejection);
      const run = setupActions();

      await expect(run("file.showItemInFolder", { path: OUT_OF_ROOT, ...flag })).rejects.toBe(
        rejection
      );
      expect(systemClientMock.showItemInFolderUnconfined).not.toHaveBeenCalled();
      // Identity alone would also hold for a decode-then-rethrow. What the five
      // non-viewer dispatchers rely on is that a caller who never opted in hands
      // its error onward exactly as it arrived: `isClientAppError` decodes by
      // mutating, so reaching it at all would strip the prefix and stamp
      // `name`/`code` here instead of at the one place that owns that decode.
      expect(rejection.message).toBe("[AppError|OUTSIDE_ROOT] Path is outside all allowed roots");
      expect(rejection.name).toBe("Error");
      expect(Object.hasOwn(rejection, "code")).toBe(false);
    });

    it("rejects a non-boolean flag before reaching either client method", async () => {
      const run = setupActions();

      await expect(
        run("file.showItemInFolder", { path: OUT_OF_ROOT, allowOutsideRoots: "yes" })
      ).rejects.toThrow();
      expect(systemClientMock.showItemInFolder).not.toHaveBeenCalled();
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

    // Every one of these, not just the deny-list case: an implementation that
    // retried or swallowed the relaxed op's own OUTSIDE_ROOT would loop, and one
    // that only rethrew decodable errors would eat a raw shell failure.
    it.each([
      ["a denied executable target", () => encoded("INVALID_PATH", "Path is not a valid file")],
      ["OUTSIDE_ROOT again", () => encoded("OUTSIDE_ROOT", "Path is outside all allowed roots")],
      ["an undecodable failure", () => new Error("shell unavailable")],
    ])("propagates %s from the unconfined op rather than swallowing it", async (_label, make) => {
      systemClientMock.showItemInFolder.mockRejectedValueOnce(
        encoded("OUTSIDE_ROOT", "Path is outside all allowed roots")
      );
      const denied = make();
      systemClientMock.showItemInFolderUnconfined.mockRejectedValueOnce(denied);
      const run = setupActions();

      await expect(
        run("file.showItemInFolder", { path: "/tmp/Evil.app", allowOutsideRoots: true })
      ).rejects.toBe(denied);
      expect(systemClientMock.showItemInFolderUnconfined).toHaveBeenCalledTimes(1);
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

const addPanelSpy = vi.fn<(options: unknown) => Promise<string | null>>();
const activateTerminalSpy = vi.fn<(id: string) => void>();
const setFileViewModeSpy = vi.fn<(id: string, mode: string) => void>();

function setPanelState(
  panelsById: Record<string, Record<string, unknown>>,
  panelIds = Object.keys(panelsById)
) {
  panelStoreMock.getState.mockReturnValue({
    panelsById,
    panelIds,
    addPanel: addPanelSpy,
    activateTerminal: activateTerminalSpy,
    setFileViewMode: setFileViewModeSpy,
  });
}

function setProjectPath(path: string | undefined) {
  projectStoreMock.getState.mockReturnValue({
    currentProject: path ? { id: "proj", path } : undefined,
  });
}

function setupOpenPanel(activeWorktreeId?: string) {
  const actions: ActionRegistry = new Map();
  const callbacks = { getActiveWorktreeId: () => activeWorktreeId } as ActionCallbacks;
  registerFileActions(actions, callbacks);
  return async (id: string, args?: unknown, dispatchSource?: ActionSource): Promise<unknown> => {
    const factory = actions.get(id);
    if (!factory) throw new Error(`missing ${id}`);
    const def = factory() as AnyActionDefinition;
    return def.run(args, (dispatchSource ? { dispatchSource } : {}) as never);
  };
}

function setupRead(worktreePaths: string[] = []) {
  const actions: ActionRegistry = new Map();
  const callbacks = {
    getWorktrees: () => worktreePaths.map((p, i) => ({ id: `wt-${i}`, path: p })),
  } as unknown as ActionCallbacks;
  registerFileActions(actions, callbacks);
  return async (args?: unknown): Promise<unknown> => {
    const factory = actions.get("file.read");
    if (!factory) throw new Error("missing file.read");
    const def = factory() as AnyActionDefinition;
    return def.run(args, {} as never);
  };
}

describe("file.openPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    addPanelSpy.mockResolvedValue("new-panel-id");
    setPanelState({});
    setProjectPath("/repo");
  });

  it("creates a new file panel with an absolute path", async () => {
    const run = setupOpenPanel("wt-1");
    const result = await run("file.openPanel", { path: "/repo/docs/spec.md" });

    expect(addPanelSpy).toHaveBeenCalledWith({
      kind: "file",
      filePath: "/repo/docs/spec.md",
      fileViewMode: undefined,
      worktreeId: "wt-1",
      location: "grid",
    });
    expect(result).toEqual({ panelId: "new-panel-id" });
  });

  it("resolves a repo-relative path against the current project root", async () => {
    const run = setupOpenPanel();
    await run("file.openPanel", { path: "docs/spec.md" });

    expect(addPanelSpy).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "/repo/docs/spec.md" })
    );
  });

  it("prefers an explicit rootPath for relative resolution", async () => {
    const run = setupOpenPanel();
    await run("file.openPanel", { path: "notes.md", rootPath: "/elsewhere" });

    expect(addPanelSpy).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "/elsewhere/notes.md" })
    );
  });

  it("clamps a rendered request on a non-markdown file to source", async () => {
    const run = setupOpenPanel();
    await run("file.openPanel", { path: "src/index.css", viewMode: "rendered" });

    expect(addPanelSpy).toHaveBeenCalledWith(expect.objectContaining({ fileViewMode: "source" }));
  });

  it("passes rendered through for markdown files", async () => {
    const run = setupOpenPanel();
    await run("file.openPanel", { path: "docs/spec.md", viewMode: "rendered" });

    expect(addPanelSpy).toHaveBeenCalledWith(expect.objectContaining({ fileViewMode: "rendered" }));
  });

  it("passes rendered through for html files", async () => {
    const run = setupOpenPanel();
    await run("file.openPanel", { path: "dist/report.html", viewMode: "rendered" });

    expect(addPanelSpy).toHaveBeenCalledWith(expect.objectContaining({ fileViewMode: "rendered" }));
  });

  it("reuses a panel already showing the same file instead of duplicating", async () => {
    setPanelState({
      "file-1": {
        id: "file-1",
        kind: "file",
        location: "grid",
        filePath: "/repo/docs/spec.md",
      },
    });
    const run = setupOpenPanel();
    const result = await run("file.openPanel", {
      path: "/repo/docs/spec.md",
      viewMode: "rendered",
    });

    expect(addPanelSpy).not.toHaveBeenCalled();
    expect(activateTerminalSpy).toHaveBeenCalledWith("file-1");
    expect(setFileViewModeSpy).toHaveBeenCalledWith("file-1", "rendered");
    expect(result).toEqual({ panelId: "file-1" });
  });

  it("does not reuse a trashed panel", async () => {
    setPanelState({
      "file-1": {
        id: "file-1",
        kind: "file",
        location: "trash",
        filePath: "/repo/docs/spec.md",
      },
    });
    const run = setupOpenPanel();
    await run("file.openPanel", { path: "/repo/docs/spec.md" });

    expect(addPanelSpy).toHaveBeenCalled();
    expect(activateTerminalSpy).not.toHaveBeenCalled();
  });

  it("does not reuse a backgrounded panel (hibernated, activation shows nothing)", async () => {
    setPanelState({
      "file-1": {
        id: "file-1",
        kind: "file",
        location: "background",
        filePath: "/repo/docs/spec.md",
      },
    });
    const run = setupOpenPanel();
    await run("file.openPanel", { path: "/repo/docs/spec.md" });

    expect(addPanelSpy).toHaveBeenCalled();
    expect(activateTerminalSpy).not.toHaveBeenCalled();
  });

  // #11506 — the store forces `preserve` (skipping both focus AND the exit from
  // fullscreen) whenever an MCP suppression lease is live or the assistant owns
  // focus. Those guards are about background spawns; a person asking for a file
  // has to see it, so a foreground dispatch overrides them with `take`.
  it.each<ActionSource>(["user", "keybinding", "menu", "context-menu"])(
    "takes focus for a %s dispatch so the panel can't land behind fullscreen",
    async (source) => {
      const run = setupOpenPanel();
      await run("file.openPanel", { path: "/repo/docs/spec.md" }, source);

      expect(addPanelSpy).toHaveBeenCalledWith(expect.objectContaining({ focusPolicy: "take" }));
    }
  );

  // The allowlist has to stay an allowlist: a background source must fall
  // through to the store's own resolution rather than being read as foreground.
  it.each<ActionSource>(["agent", "plugin"])(
    "leaves focus policy to the store for a %s dispatch",
    async (source) => {
      const run = setupOpenPanel();
      await run("file.openPanel", { path: "/repo/docs/spec.md" }, source);

      const options = addPanelSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(options.focusPolicy).toBeUndefined();
    }
  );

  it("leaves focus policy to the store when the dispatch carries no source", async () => {
    const run = setupOpenPanel();
    await run("file.openPanel", { path: "/repo/docs/spec.md" });

    const options = addPanelSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options.focusPolicy).toBeUndefined();
  });

  it("throws for a relative path with no project open and no rootPath", async () => {
    setProjectPath(undefined);
    const run = setupOpenPanel();
    await expect(run("file.openPanel", { path: "docs/spec.md" })).rejects.toThrow(
      /No project open/
    );
  });

  it("throws when the panel limit blocks creation", async () => {
    addPanelSpy.mockResolvedValue(null);
    const run = setupOpenPanel();
    await expect(run("file.openPanel", { path: "/repo/docs/spec.md" })).rejects.toThrow(
      /panel limit/
    );
  });
});

describe("file.read containment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readMock.mockResolvedValue({ content: "file body" });
    setProjectPath("/repo");
  });

  it("reads a repo-relative path against the project root", async () => {
    const run = setupRead();
    const result = await run({ path: "docs/spec.md" });

    expect(readMock).toHaveBeenCalledWith({ path: "/repo/docs/spec.md", rootPath: "/repo" });
    expect(result).toEqual({ content: "file body" });
  });

  it("reads an absolute path inside a worktree using the worktree as root", async () => {
    const run = setupRead(["/worktrees/feature-x"]);
    await run({ path: "/worktrees/feature-x/notes.md" });

    expect(readMock).toHaveBeenCalledWith({
      path: "/worktrees/feature-x/notes.md",
      rootPath: "/worktrees/feature-x",
    });
  });

  it("rejects an absolute path outside the project and its worktrees", async () => {
    const run = setupRead(["/worktrees/feature-x"]);
    await expect(run({ path: "/Users/someone/.ssh/id_rsa" })).rejects.toThrow(
      /outside the current project/
    );
    expect(readMock).not.toHaveBeenCalled();
  });

  it("rejects a prefix-sibling of the project root", async () => {
    const run = setupRead();
    await expect(run({ path: "/repo-evil/secret.md" })).rejects.toThrow(
      /outside the current project/
    );
    expect(readMock).not.toHaveBeenCalled();
  });

  it("rejects traversal that resolves outside the project", async () => {
    const run = setupRead();
    await expect(run({ path: "../../etc/passwd" })).rejects.toThrow(/outside the current project/);
    expect(readMock).not.toHaveBeenCalled();
  });

  it("rejects a caller-supplied rootPath that is not a known root", async () => {
    const run = setupRead();
    await expect(run({ path: "id_rsa", rootPath: "/Users/someone/.ssh" })).rejects.toThrow(
      /outside the current project/
    );
    expect(readMock).not.toHaveBeenCalled();
  });

  it("throws for a relative path with no project open and no rootPath", async () => {
    setProjectPath(undefined);
    const run = setupRead();
    await expect(run({ path: "docs/spec.md" })).rejects.toThrow(/No project open/);
  });
});
