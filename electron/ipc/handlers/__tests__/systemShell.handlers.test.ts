import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

const shellMock = vi.hoisted(() => ({
  openPath: vi.fn(() => Promise.resolve("")),
  openExternal: vi.fn(() => Promise.resolve()),
  showItemInFolder: vi.fn<(p: string) => void>(() => undefined),
}));

const appMock = vi.hoisted(() => ({
  getPath: vi.fn((name: string) => `/userdata/${name}`),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  shell: shellMock,
  app: appMock,
}));

const fsMock = vi.hoisted(() => ({
  promises: {
    realpath: vi.fn<(p: string) => Promise<string>>((p: string) => Promise.resolve(p)),
    stat: vi.fn<(p: string) => Promise<{ isFile: () => boolean; isDirectory: () => boolean }>>(() =>
      Promise.resolve({ isFile: () => true, isDirectory: () => false })
    ),
    access: vi.fn<(p: string) => Promise<void>>(() => Promise.resolve()),
  },
}));

vi.mock("fs", () => ({ default: fsMock, ...fsMock }));

const projectStoreMock = vi.hoisted(() => ({
  getAllProjects: vi.fn<() => Array<{ path: string }>>(() => []),
  getProjectSettings: vi.fn(() => Promise.resolve({ preferredEditor: null })),
}));

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: projectStoreMock,
}));

type WorktreeRecord = {
  path: string;
  branch: string;
  bare: boolean;
  isMainWorktree: boolean;
};

const gitServiceMock = vi.hoisted(() => ({
  listWorktrees:
    vi.fn<
      () => Promise<Array<{ path: string; branch: string; bare: boolean; isMainWorktree: boolean }>>
    >(),
}));

const gitServiceCacheMock = vi.hoisted(() => ({
  getGitService: vi.fn<(root: string) => { listWorktrees: () => Promise<unknown[]> }>(),
}));

vi.mock("../../../services/GitServiceCache.js", () => ({
  gitServiceCache: gitServiceCacheMock,
}));

const openFileMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("../../../services/EditorService.js", () => ({
  openFile: openFileMock,
}));

const openExternalUrlMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("../../../utils/openExternal.js", () => ({
  openExternalUrl: openExternalUrlMock,
}));

// Bypass the IPC security guard + perf wrapper — register the raw handler.
vi.mock("../../utils.js", () => ({
  typedHandle: (channel: string, handler: unknown) => {
    ipcMainMock.handle(channel, (_e: unknown, ...args: unknown[]) =>
      (handler as (...a: unknown[]) => unknown)(...args)
    );
    return () => ipcMainMock.removeHandler(channel);
  },
  typedHandleValidated: (channel: string, _schema: unknown, handler: unknown) => {
    ipcMainMock.handle(channel, (_e: unknown, ...args: unknown[]) =>
      (handler as (payload: unknown) => unknown)(args[0])
    );
    return () => ipcMainMock.removeHandler(channel);
  },
}));

import { CHANNELS } from "../../channels.js";
import { registerSystemShellHandlers } from "../systemShell.js";
import { SystemShowItemInFolderUnconfinedPayloadSchema } from "../../../schemas/ipc.js";
import type { HandlerDependencies } from "../../types.js";

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

function getHandler(channel: string): Handler {
  const match = ipcMainMock.handle.mock.calls.find(([ch]) => ch === channel);
  if (!match) throw new Error(`No handler registered for ${channel}`);
  return match[1] as Handler;
}

const fakeEvent = {};
const TEST_ROOT = path.parse(process.cwd()).root;
const PROJECT_ROOT = path.join(TEST_ROOT, "Users", "me", "project");
// The parent dir the retired path-pattern heuristic used to predict from
// PROJECT_ROOT (`{parent-dir}/{base-folder}-worktrees/{branch-slug}`). Kept
// only as a negative fixture: living under it earns a path nothing anymore —
// containment now follows what `git worktree list` actually reports.
const LEGACY_PATTERN_PARENT = path.join(
  path.dirname(PROJECT_ROOT),
  `${path.basename(PROJECT_ROOT)}-worktrees`
);
const USERDATA_PARENT = path.join(TEST_ROOT, "userdata");

function worktreeRecord(worktreePath: string, overrides: Partial<WorktreeRecord> = {}) {
  return {
    path: worktreePath,
    branch: "feature",
    bare: false,
    isMainWorktree: false,
    ...overrides,
  };
}

// A tracked worktree in a location no path pattern would ever predict, so
// admitting it can only be the result of asking git.
const UNPREDICTED_WORKTREE = path.join(TEST_ROOT, "Volumes", "scratch", "hotfix");

// `vi.clearAllMocks()` wipes call history but leaves implementations set by a
// previous test in place, so every suite re-establishes the defaults: this
// project tracks no linked worktrees, and any candidate that is consulted
// looks like a live working tree.
function resetGitMocks() {
  gitServiceMock.listWorktrees.mockResolvedValue([]);
  gitServiceCacheMock.getGitService.mockReturnValue(gitServiceMock);
  fsMock.promises.access.mockResolvedValue(undefined);
}

// Rejects the `.git` probe for the given roots, marking them as no longer
// live working trees (deleted-and-recreated directories, bare repos).
function denyGitProbeFor(...roots: string[]) {
  fsMock.promises.access.mockImplementation((p: string) =>
    roots.some((root) => path.normalize(p) === path.join(root, ".git"))
      ? Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
      : Promise.resolve()
  );
}
const deniedLauncherName =
  process.platform === "win32"
    ? "launcher.exe"
    : process.platform === "darwin"
      ? "Evil.app"
      : "launcher.desktop";
const realpathEcho = (p: string) => Promise.resolve(path.normalize(p));

describe("system:open-path containment", () => {
  let cleanup: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    fsMock.promises.realpath.mockImplementation(realpathEcho);
    projectStoreMock.getAllProjects.mockReturnValue([{ path: PROJECT_ROOT }]);
    appMock.getPath.mockImplementation((name: string) => path.join(USERDATA_PARENT, name));
    resetGitMocks();
    cleanup = registerSystemShellHandlers({} as HandlerDependencies);
  });

  afterEach(() => {
    cleanup();
  });

  it("opens a path contained in a project root", async () => {
    const handler = getHandler(CHANNELS.SYSTEM_OPEN_PATH);
    const sourcePath = path.join(PROJECT_ROOT, "src", "index.ts");
    await handler(fakeEvent, { path: sourcePath });
    expect(shellMock.openPath).toHaveBeenCalledWith(sourcePath);
  });

  it("opens a path contained in the userData dir (crash logs)", async () => {
    const handler = getHandler(CHANNELS.SYSTEM_OPEN_PATH);
    const crashLog = path.join(USERDATA_PARENT, "userData", "crashes", "log.txt");
    await handler(fakeEvent, { path: crashLog });
    expect(shellMock.openPath).toHaveBeenCalledWith(crashLog);
  });

  it("rejects a path outside all roots with OUTSIDE_ROOT", async () => {
    const handler = getHandler(CHANNELS.SYSTEM_OPEN_PATH);
    await expect(handler(fakeEvent, { path: "/etc/passwd" })).rejects.toMatchObject({
      code: "OUTSIDE_ROOT",
    });
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });

  it("rejects a sibling-prefix path that is not actually contained", async () => {
    const handler = getHandler(CHANNELS.SYSTEM_OPEN_PATH);
    await expect(
      handler(fakeEvent, { path: `${PROJECT_ROOT}-evil${path.sep}secret.txt` })
    ).rejects.toMatchObject({ code: "OUTSIDE_ROOT" });
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });

  it("rejects a non-absolute path with INVALID_PATH", async () => {
    const handler = getHandler(CHANNELS.SYSTEM_OPEN_PATH);
    await expect(handler(fakeEvent, { path: "relative/file.txt" })).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });

  it("rejects an executable extension (.desktop) even inside a root", async () => {
    const handler = getHandler(CHANNELS.SYSTEM_OPEN_PATH);
    await expect(
      handler(fakeEvent, { path: path.join(PROJECT_ROOT, deniedLauncherName) })
    ).rejects.toMatchObject({ code: "INVALID_PATH" });
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });

  it("rejects a safe-named symlink that resolves to a denied extension", async () => {
    const link = path.join(PROJECT_ROOT, "notes.txt");
    const payload = path.join(PROJECT_ROOT, deniedLauncherName);
    fsMock.promises.realpath.mockImplementation((p: string) =>
      Promise.resolve(path.normalize(p) === path.normalize(link) ? payload : path.normalize(p))
    );

    const handler = getHandler(CHANNELS.SYSTEM_OPEN_PATH);
    await expect(handler(fakeEvent, { path: link })).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });

  it("opens the realpath-resolved target, not the original path", async () => {
    const link = path.join(PROJECT_ROOT, "link.png");
    const resolved = path.join(PROJECT_ROOT, "real.png");
    fsMock.promises.realpath.mockImplementation((p: string) =>
      Promise.resolve(path.normalize(p) === path.normalize(link) ? resolved : path.normalize(p))
    );

    const handler = getHandler(CHANNELS.SYSTEM_OPEN_PATH);
    await handler(fakeEvent, { path: link });
    expect(shellMock.openPath).toHaveBeenCalledWith(resolved);
  });

  it("propagates a non-empty error string from shell.openPath", async () => {
    shellMock.openPath.mockResolvedValueOnce("no app associated");
    const handler = getHandler(CHANNELS.SYSTEM_OPEN_PATH);
    await expect(handler(fakeEvent, { path: path.join(PROJECT_ROOT, "index.ts") })).rejects.toThrow(
      /no app associated/
    );
  });
});

describe("system:open-in-editor containment", () => {
  let cleanup: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    fsMock.promises.realpath.mockImplementation(realpathEcho);
    projectStoreMock.getAllProjects.mockReturnValue([{ path: PROJECT_ROOT }]);
    appMock.getPath.mockImplementation((name: string) => path.join(USERDATA_PARENT, name));
    resetGitMocks();
    cleanup = registerSystemShellHandlers({} as HandlerDependencies);
  });

  afterEach(() => {
    cleanup();
  });

  it("opens a contained file in the editor", async () => {
    const handler = getHandler(CHANNELS.SYSTEM_OPEN_IN_EDITOR);
    const filePath = path.join(PROJECT_ROOT, "src", "app.ts");
    await handler(fakeEvent, { path: filePath, line: 5, col: 2 });
    expect(openFileMock).toHaveBeenCalledWith(filePath, 5, 2, null);
  });

  it("rejects an out-of-root file without invoking the editor", async () => {
    const handler = getHandler(CHANNELS.SYSTEM_OPEN_IN_EDITOR);
    await expect(handler(fakeEvent, { path: "/etc/shadow" })).rejects.toMatchObject({
      code: "OUTSIDE_ROOT",
    });
    expect(openFileMock).not.toHaveBeenCalled();
  });

  // ReviewHub legitimately opens scripts for viewing in the editor. The
  // launcher deny-list (which blocks .sh / .ps1 / .bat / .desktop) must not
  // apply here — editors read the file, they don't execute it.
  it("allows opening script extensions for viewing (deny-list relaxed)", async () => {
    const handler = getHandler(CHANNELS.SYSTEM_OPEN_IN_EDITOR);
    // Use a platform-appropriate scripty extension. `.desktop` is denied on
    // both darwin and linux; `.ps1` is denied on win32.
    const scriptPath =
      process.platform === "win32"
        ? path.join(PROJECT_ROOT, "scripts", "deploy.ps1")
        : path.join(PROJECT_ROOT, "scripts", "setup.desktop");
    await handler(fakeEvent, { path: scriptPath });
    expect(openFileMock).toHaveBeenCalledWith(scriptPath, undefined, undefined, null);
  });
});

describe("system:show-item-in-folder containment", () => {
  let cleanup: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    fsMock.promises.realpath.mockImplementation(realpathEcho);
    projectStoreMock.getAllProjects.mockReturnValue([{ path: PROJECT_ROOT }]);
    appMock.getPath.mockImplementation((name: string) => path.join(USERDATA_PARENT, name));
    resetGitMocks();
    cleanup = registerSystemShellHandlers({} as HandlerDependencies);
  });

  afterEach(() => {
    cleanup();
  });

  it("reveals a path contained in a project root", async () => {
    const handler = getHandler(CHANNELS.SYSTEM_SHOW_ITEM_IN_FOLDER);
    const sourcePath = path.join(PROJECT_ROOT, "src", "index.ts");
    await handler(fakeEvent, { path: sourcePath });
    expect(shellMock.showItemInFolder).toHaveBeenCalledWith(sourcePath);
  });

  it("rejects a path outside all roots with OUTSIDE_ROOT", async () => {
    const handler = getHandler(CHANNELS.SYSTEM_SHOW_ITEM_IN_FOLDER);
    await expect(handler(fakeEvent, { path: "/etc/passwd" })).rejects.toMatchObject({
      code: "OUTSIDE_ROOT",
    });
    expect(shellMock.showItemInFolder).not.toHaveBeenCalled();
  });

  it("rejects a non-absolute path with INVALID_PATH", async () => {
    const handler = getHandler(CHANNELS.SYSTEM_SHOW_ITEM_IN_FOLDER);
    await expect(handler(fakeEvent, { path: "relative/file.txt" })).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
    expect(shellMock.showItemInFolder).not.toHaveBeenCalled();
  });

  // The key behavior difference from system:open-path: revealing an item only
  // selects it in the file manager, it never launches it — so the executable
  // deny-list (which blocks .app / .exe / .desktop for the launcher) must NOT
  // apply. Revealing an executable the user can already see is safe.
  it("allows revealing an executable extension inside a root (deny-list relaxed)", async () => {
    const handler = getHandler(CHANNELS.SYSTEM_SHOW_ITEM_IN_FOLDER);
    const executablePath = path.join(PROJECT_ROOT, deniedLauncherName);
    await handler(fakeEvent, { path: executablePath });
    expect(shellMock.showItemInFolder).toHaveBeenCalledWith(executablePath);
  });

  // A file detected in terminal output can be deleted before the user reveals
  // it. resolveContainedPath realpaths the target, so a missing path is
  // rejected (INVALID_PATH) before shell.showItemInFolder — which has no
  // failure signal — is ever called. Mock realpath to reject like real Node.
  it("rejects a since-deleted path (realpath ENOENT) without revealing", async () => {
    const missing = path.join(PROJECT_ROOT, "gone.txt");
    fsMock.promises.realpath.mockImplementation((p: string) =>
      path.normalize(p) === path.normalize(missing)
        ? Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
        : realpathEcho(p)
    );
    const handler = getHandler(CHANNELS.SYSTEM_SHOW_ITEM_IN_FOLDER);
    await expect(handler(fakeEvent, { path: missing })).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
    expect(shellMock.showItemInFolder).not.toHaveBeenCalled();
  });

  it("reveals the realpath-resolved target, not the original path", async () => {
    const link = path.join(PROJECT_ROOT, "link.txt");
    const resolved = path.join(PROJECT_ROOT, "real.txt");
    fsMock.promises.realpath.mockImplementation((p: string) =>
      Promise.resolve(path.normalize(p) === path.normalize(link) ? resolved : path.normalize(p))
    );
    const handler = getHandler(CHANNELS.SYSTEM_SHOW_ITEM_IN_FOLDER);
    await handler(fakeEvent, { path: link });
    expect(shellMock.showItemInFolder).toHaveBeenCalledWith(resolved);
  });
});

describe("system path-allowlist: tracked worktree roots", () => {
  let cleanup: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    fsMock.promises.realpath.mockImplementation(realpathEcho);
    projectStoreMock.getAllProjects.mockReturnValue([{ path: PROJECT_ROOT }]);
    appMock.getPath.mockImplementation((name: string) => path.join(USERDATA_PARENT, name));
    resetGitMocks();
    cleanup = registerSystemShellHandlers({} as HandlerDependencies);
  });

  afterEach(() => {
    cleanup();
  });

  it("opens a worktree root that git reports (the worktree card menu's Open ▸ Show in Finder/Explorer/file manager)", async () => {
    gitServiceMock.listWorktrees.mockResolvedValue([
      worktreeRecord(PROJECT_ROOT, { isMainWorktree: true, branch: "develop" }),
      worktreeRecord(UNPREDICTED_WORKTREE),
    ]);

    const handler = getHandler(CHANNELS.SYSTEM_OPEN_PATH);
    await handler(fakeEvent, { path: UNPREDICTED_WORKTREE });
    expect(shellMock.openPath).toHaveBeenCalledWith(UNPREDICTED_WORKTREE);
  });

  // The per-project `worktreePathPattern` override was invisible to the old
  // global-pattern heuristic, so worktrees created under it were rejected.
  // Git reports the real path regardless of which pattern produced it.
  it("opens a file inside a worktree created under a custom per-project pattern", async () => {
    const customWorktree = path.join(
      path.dirname(PROJECT_ROOT),
      `${path.basename(PROJECT_ROOT)}.wt`,
      "feature-x"
    );
    gitServiceMock.listWorktrees.mockResolvedValue([
      worktreeRecord(PROJECT_ROOT, { isMainWorktree: true }),
      worktreeRecord(customWorktree),
    ]);

    const handler = getHandler(CHANNELS.SYSTEM_OPEN_IN_EDITOR);
    const filePath = path.join(customWorktree, "src", "index.ts");
    await handler(fakeEvent, { path: filePath, line: 1, col: 1 });
    expect(openFileMock).toHaveBeenCalledWith(filePath, 1, 1, null);
  });

  // `git worktree add ~/scratch/hotfix` puts the worktree somewhere no pattern
  // predicts. Enumerating instead of predicting is what makes this case work.
  it("reveals a file inside a manually-created worktree outside any pattern", async () => {
    const manualWorktree = path.join(TEST_ROOT, "tmp", "scratch", "hotfix");
    gitServiceMock.listWorktrees.mockResolvedValue([
      worktreeRecord(PROJECT_ROOT, { isMainWorktree: true }),
      worktreeRecord(manualWorktree),
    ]);

    const handler = getHandler(CHANNELS.SYSTEM_SHOW_ITEM_IN_FOLDER);
    const filePath = path.join(manualWorktree, "src", "app.ts");
    await handler(fakeEvent, { path: filePath });
    expect(shellMock.showItemInFolder).toHaveBeenCalledWith(filePath);
  });

  // The deliberate tightening: the pattern-derived parent used to admit every
  // child wholesale, including directories that were never worktrees.
  it("rejects a predicted-pattern sibling that git does not track", async () => {
    gitServiceMock.listWorktrees.mockResolvedValue([
      worktreeRecord(PROJECT_ROOT, { isMainWorktree: true }),
      worktreeRecord(path.join(LEGACY_PATTERN_PARENT, "real-worktree")),
    ]);

    const handler = getHandler(CHANNELS.SYSTEM_OPEN_PATH);
    await expect(
      handler(fakeEvent, {
        path: path.join(LEGACY_PATTERN_PARENT, "never-a-worktree", "src", "index.ts"),
      })
    ).rejects.toMatchObject({ code: "OUTSIDE_ROOT" });
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });

  it("rejects a sibling-prefix path that shares a tracked worktree's prefix", async () => {
    const worktreePath = path.join(LEGACY_PATTERN_PARENT, "feature-x");
    gitServiceMock.listWorktrees.mockResolvedValue([worktreeRecord(worktreePath)]);

    const handler = getHandler(CHANNELS.SYSTEM_OPEN_PATH);
    // Shares a string prefix with the tracked root but isn't contained — the
    // realpath + separator check in pathGuard must still reject it.
    await expect(
      handler(fakeEvent, { path: `${worktreePath}-evil${path.sep}secret.txt` })
    ).rejects.toMatchObject({ code: "OUTSIDE_ROOT" });
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });

  // Git keeps externally-deleted worktrees listed as "prunable" until someone
  // runs `git worktree prune`. Containment must tolerate them rather than
  // mutate repository state to tidy up, so the stale root is simply skipped.
  it("skips a worktree root that has since been deleted and admits a healthy one", async () => {
    const orphaned = path.join(TEST_ROOT, "Volumes", "scratch", "deleted-branch");
    gitServiceMock.listWorktrees.mockResolvedValue([
      worktreeRecord(PROJECT_ROOT, { isMainWorktree: true }),
      worktreeRecord(orphaned),
      worktreeRecord(UNPREDICTED_WORKTREE),
    ]);
    fsMock.promises.realpath.mockImplementation((p: string) =>
      path.normalize(p) === path.normalize(orphaned)
        ? Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
        : realpathEcho(p)
    );
    denyGitProbeFor(orphaned);

    const handler = getHandler(CHANNELS.SYSTEM_OPEN_PATH);
    const filePath = path.join(UNPREDICTED_WORKTREE, "src", "index.ts");
    await handler(fakeEvent, { path: filePath });
    expect(shellMock.openPath).toHaveBeenCalledWith(filePath);
  });

  // Git keeps reporting a worktree the user deleted behind its back. If that
  // path is later reused by something unrelated, it realpaths fine — only the
  // missing `.git` keeps it from becoming a launch root.
  it("rejects a stale worktree path that was recreated as an unrelated directory", async () => {
    const recreated = path.join(TEST_ROOT, "Volumes", "scratch", "reused");
    gitServiceMock.listWorktrees.mockResolvedValue([
      worktreeRecord(PROJECT_ROOT, { isMainWorktree: true }),
      worktreeRecord(recreated),
    ]);
    denyGitProbeFor(recreated);

    const handler = getHandler(CHANNELS.SYSTEM_OPEN_PATH);
    await expect(handler(fakeEvent, { path: path.join(recreated, "runme") })).rejects.toMatchObject(
      { code: "OUTSIDE_ROOT" }
    );
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });

  // pathGuard treats the filesystem root as containing every absolute path, so
  // a record pointing there would hand out the whole disk.
  it("rejects a worktree record pointing at the filesystem root", async () => {
    gitServiceMock.listWorktrees.mockResolvedValue([worktreeRecord(TEST_ROOT)]);

    const handler = getHandler(CHANNELS.SYSTEM_OPEN_PATH);
    await expect(handler(fakeEvent, { path: "/etc/passwd" })).rejects.toMatchObject({
      code: "OUTSIDE_ROOT",
    });
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });

  // Git reported this worktree; a permission or I/O failure while probing says
  // nothing about whether it is one, so it must not lock the user out.
  it("still admits a worktree whose .git probe fails for a non-existence reason", async () => {
    gitServiceMock.listWorktrees.mockResolvedValue([worktreeRecord(UNPREDICTED_WORKTREE)]);
    fsMock.promises.access.mockImplementation(() =>
      Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" }))
    );

    const handler = getHandler(CHANNELS.SYSTEM_OPEN_PATH);
    const filePath = path.join(UNPREDICTED_WORKTREE, "src", "index.ts");
    await handler(fakeEvent, { path: filePath });
    expect(shellMock.openPath).toHaveBeenCalledWith(filePath);
  });

  // A linked checkout backed by a bare repository reports that repository.
  // Granting it would hand out the object store, refs, config and hooks.
  it("rejects the bare repository backing a linked worktree", async () => {
    const bareRepo = path.join(TEST_ROOT, "srv", "repo.git");
    gitServiceMock.listWorktrees.mockResolvedValue([
      worktreeRecord(bareRepo, { bare: true, isMainWorktree: true, branch: "" }),
      worktreeRecord(UNPREDICTED_WORKTREE),
    ]);

    const handler = getHandler(CHANNELS.SYSTEM_OPEN_IN_EDITOR);
    await expect(handler(fakeEvent, { path: path.join(bareRepo, "config") })).rejects.toMatchObject(
      {
        code: "OUTSIDE_ROOT",
      }
    );
    expect(openFileMock).not.toHaveBeenCalled();

    // The healthy linked worktree alongside it is still admitted.
    const filePath = path.join(UNPREDICTED_WORKTREE, "src", "index.ts");
    await handler(fakeEvent, { path: filePath });
    expect(openFileMock).toHaveBeenCalledWith(filePath, undefined, undefined, null);
  });

  // The escalated branch must hand the sink the canonical target, not the
  // renderer-supplied path — same TOCTOU-narrowing property as the base path.
  it("forwards the realpath-resolved target when admitted via a worktree root", async () => {
    const link = path.join(UNPREDICTED_WORKTREE, "link.txt");
    const resolved = path.join(UNPREDICTED_WORKTREE, "real.txt");
    gitServiceMock.listWorktrees.mockResolvedValue([worktreeRecord(UNPREDICTED_WORKTREE)]);
    fsMock.promises.realpath.mockImplementation((p: string) =>
      Promise.resolve(path.normalize(p) === path.normalize(link) ? resolved : path.normalize(p))
    );

    const handler = getHandler(CHANNELS.SYSTEM_OPEN_PATH);
    await handler(fakeEvent, { path: link });
    expect(shellMock.openPath).toHaveBeenCalledWith(resolved);
  });

  // The deny-list runs again on the resolved target, so a safe-named symlink
  // inside a worktree can't smuggle an executable past the launcher.
  it("rejects a safe-named symlink inside a worktree that resolves to an executable", async () => {
    const link = path.join(UNPREDICTED_WORKTREE, "notes.txt");
    const payload = path.join(UNPREDICTED_WORKTREE, deniedLauncherName);
    gitServiceMock.listWorktrees.mockResolvedValue([worktreeRecord(UNPREDICTED_WORKTREE)]);
    fsMock.promises.realpath.mockImplementation((p: string) =>
      Promise.resolve(path.normalize(p) === path.normalize(link) ? payload : path.normalize(p))
    );

    const handler = getHandler(CHANNELS.SYSTEM_OPEN_PATH);
    await expect(handler(fakeEvent, { path: link })).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });

  // One unreadable repository must not suppress the others — each enumeration
  // fails independently to an empty list.
  it("isolates a failing project's enumeration from a healthy project", async () => {
    const otherRoot = path.join(TEST_ROOT, "Users", "me", "other-project");
    const failing = vi.fn(() => Promise.reject(new Error("not a git repository")));
    const healthy = vi.fn(() => Promise.resolve([worktreeRecord(UNPREDICTED_WORKTREE)]));
    projectStoreMock.getAllProjects.mockReturnValue([{ path: PROJECT_ROOT }, { path: otherRoot }]);
    gitServiceCacheMock.getGitService.mockImplementation((root: string) => {
      if (root === PROJECT_ROOT) return { listWorktrees: failing };
      if (root === otherRoot) return { listWorktrees: healthy };
      throw new Error(`unexpected project root: ${root}`);
    });

    const handler = getHandler(CHANNELS.SYSTEM_OPEN_PATH);
    const filePath = path.join(UNPREDICTED_WORKTREE, "src", "index.ts");
    await handler(fakeEvent, { path: filePath });

    // Both repositories were consulted, and the rejection didn't abort the batch.
    expect(failing).toHaveBeenCalled();
    expect(healthy).toHaveBeenCalled();
    expect(shellMock.openPath).toHaveBeenCalledWith(filePath);
  });

  // Enumeration shells out to git, so it must stay off the common path where
  // the target already sits inside a registered project root.
  it("does not enumerate worktrees when the target is inside a project root", async () => {
    const handler = getHandler(CHANNELS.SYSTEM_OPEN_PATH);
    await handler(fakeEvent, { path: path.join(PROJECT_ROOT, "src", "index.ts") });
    expect(shellMock.openPath).toHaveBeenCalled();
    expect(gitServiceCacheMock.getGitService).not.toHaveBeenCalled();
    expect(gitServiceMock.listWorktrees).not.toHaveBeenCalled();
  });

  // A path that can't be resolved at all fails identically against every root
  // set, so it must short-circuit before paying for enumeration.
  it("does not enumerate worktrees for a non-absolute path", async () => {
    const handler = getHandler(CHANNELS.SYSTEM_OPEN_PATH);
    await expect(handler(fakeEvent, { path: "relative/file.txt" })).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
    expect(gitServiceMock.listWorktrees).not.toHaveBeenCalled();
  });
});

describe("system:show-item-in-folder-unconfined (out-of-root reveal recovery)", () => {
  let cleanup: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    fsMock.promises.realpath.mockImplementation(realpathEcho);
    fsMock.promises.stat.mockResolvedValue({ isFile: () => true, isDirectory: () => false });
    projectStoreMock.getAllProjects.mockReturnValue([{ path: PROJECT_ROOT }]);
    appMock.getPath.mockImplementation((name: string) => path.join(USERDATA_PARENT, name));
    resetGitMocks();
    cleanup = registerSystemShellHandlers({} as HandlerDependencies);
  });

  afterEach(() => {
    cleanup();
  });

  // The whole point of this op: an out-of-root path is revealed (no
  // OUTSIDE_ROOT), because it's the user-initiated recovery for a file link
  // that resolved outside roots. Roots containment is intentionally skipped.
  it("reveals an absolute path outside all roots (bypasses containment)", async () => {
    const handler = getHandler(CHANNELS.SYSTEM_SHOW_ITEM_IN_FOLDER_UNCONFINED);
    const outside = path.join(TEST_ROOT, "etc", "passwd");
    await handler(fakeEvent, { path: outside });
    expect(shellMock.showItemInFolder).toHaveBeenCalledWith(outside);
  });

  it("rejects a non-absolute path with INVALID_PATH", async () => {
    const handler = getHandler(CHANNELS.SYSTEM_SHOW_ITEM_IN_FOLDER_UNCONFINED);
    await expect(handler(fakeEvent, { path: "relative/file.txt" })).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
    expect(shellMock.showItemInFolder).not.toHaveBeenCalled();
  });

  // Key security distinction from the confined system:show-item-in-folder op
  // (which relaxes the deny-list for reveal): an out-of-root path is untrusted
  // terminal output, and historical Windows ShellExecute("open") / Linux
  // xdg-open fallbacks make reveal a launch surface on some platforms — so the
  // deny-list stays in force.
  it("rejects an executable extension even out-of-root (deny-list enforced)", async () => {
    const handler = getHandler(CHANNELS.SYSTEM_SHOW_ITEM_IN_FOLDER_UNCONFINED);
    await expect(
      handler(fakeEvent, { path: path.join(TEST_ROOT, "dropped", deniedLauncherName) })
    ).rejects.toMatchObject({ code: "INVALID_PATH" });
    expect(shellMock.showItemInFolder).not.toHaveBeenCalled();
  });

  it("rejects a safe-named symlink whose realpath has a denied extension", async () => {
    const link = path.join(TEST_ROOT, "etc", "notes.txt");
    const target = path.join(TEST_ROOT, "dropped", deniedLauncherName);
    fsMock.promises.realpath.mockImplementation((p: string) =>
      Promise.resolve(path.normalize(p) === path.normalize(link) ? target : path.normalize(p))
    );
    const handler = getHandler(CHANNELS.SYSTEM_SHOW_ITEM_IN_FOLDER_UNCONFINED);
    await expect(handler(fakeEvent, { path: link })).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
    expect(shellMock.showItemInFolder).not.toHaveBeenCalled();
  });

  it("rejects a since-deleted path (realpath ENOENT) without revealing", async () => {
    const missing = path.join(TEST_ROOT, "etc", "gone.txt");
    fsMock.promises.realpath.mockImplementation((p: string) =>
      path.normalize(p) === path.normalize(missing)
        ? Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
        : realpathEcho(p)
    );
    const handler = getHandler(CHANNELS.SYSTEM_SHOW_ITEM_IN_FOLDER_UNCONFINED);
    await expect(handler(fakeEvent, { path: missing })).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
    expect(shellMock.showItemInFolder).not.toHaveBeenCalled();
  });

  it("rejects when stat fails after realpath (INVALID_PATH, no reveal)", async () => {
    const target = path.join(TEST_ROOT, "etc", "vanished.txt");
    fsMock.promises.stat.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const handler = getHandler(CHANNELS.SYSTEM_SHOW_ITEM_IN_FOLDER_UNCONFINED);
    await expect(handler(fakeEvent, { path: target })).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
    expect(shellMock.showItemInFolder).not.toHaveBeenCalled();
  });

  it("rejects a non-file/non-directory node (e.g. socket/device) without revealing", async () => {
    const target = path.join(TEST_ROOT, "etc", "socket");
    fsMock.promises.stat.mockResolvedValue({ isFile: () => false, isDirectory: () => false });
    const handler = getHandler(CHANNELS.SYSTEM_SHOW_ITEM_IN_FOLDER_UNCONFINED);
    await expect(handler(fakeEvent, { path: target })).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
    expect(shellMock.showItemInFolder).not.toHaveBeenCalled();
  });

  it("reveals the realpath-resolved target, not the original path", async () => {
    const link = path.join(TEST_ROOT, "etc", "link.txt");
    const resolved = path.join(TEST_ROOT, "elsewhere", "real.txt");
    fsMock.promises.realpath.mockImplementation((p: string) =>
      Promise.resolve(path.normalize(p) === path.normalize(link) ? resolved : path.normalize(p))
    );
    const handler = getHandler(CHANNELS.SYSTEM_SHOW_ITEM_IN_FOLDER_UNCONFINED);
    await handler(fakeEvent, { path: link });
    expect(shellMock.showItemInFolder).toHaveBeenCalledWith(resolved);
  });
});

describe("SystemShowItemInFolderUnconfinedPayloadSchema (null-byte guard, lesson #6263)", () => {
  it("rejects a null byte in the path at the schema boundary", () => {
    const result = SystemShowItemInFolderUnconfinedPayloadSchema.safeParse({
      path: "/etc/passwd\x00",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a well-formed absolute path", () => {
    const result = SystemShowItemInFolderUnconfinedPayloadSchema.safeParse({
      path: "/etc/passwd",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty path (.min(1))", () => {
    const result = SystemShowItemInFolderUnconfinedPayloadSchema.safeParse({ path: "" });
    expect(result.success).toBe(false);
  });
});
