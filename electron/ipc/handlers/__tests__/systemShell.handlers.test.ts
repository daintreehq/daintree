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

const storeMock = vi.hoisted(() => ({
  get: vi.fn<(key: string) => unknown>(() => undefined),
}));

vi.mock("../../../store.js", () => ({
  store: storeMock,
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
// Derived from the default pattern `{parent-dir}/{base-folder}-worktrees/{branch-slug}`
// applied to PROJECT_ROOT.
const WORKTREE_PARENT = path.join(
  path.dirname(PROJECT_ROOT),
  `${path.basename(PROJECT_ROOT)}-worktrees`
);
const USERDATA_PARENT = path.join(TEST_ROOT, "userdata");
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
    storeMock.get.mockReturnValue(undefined);
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
    storeMock.get.mockReturnValue(undefined);
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
    storeMock.get.mockReturnValue(undefined);
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

describe("system path-allowlist: worktree parent dirs", () => {
  let cleanup: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    fsMock.promises.realpath.mockImplementation(realpathEcho);
    projectStoreMock.getAllProjects.mockReturnValue([{ path: PROJECT_ROOT }]);
    appMock.getPath.mockImplementation((name: string) => path.join(USERDATA_PARENT, name));
    storeMock.get.mockReturnValue(undefined);
    cleanup = registerSystemShellHandlers({} as HandlerDependencies);
  });

  afterEach(() => {
    cleanup();
  });

  it("opens a path inside the default worktree parent dir (Reveal in Finder on worktree card)", async () => {
    const handler = getHandler(CHANNELS.SYSTEM_OPEN_PATH);
    const worktreePath = path.join(WORKTREE_PARENT, "feature-issue-9149");
    await handler(fakeEvent, { path: worktreePath });
    expect(shellMock.openPath).toHaveBeenCalledWith(worktreePath);
  });

  it("opens a file inside a worktree (ReviewHub file-open click)", async () => {
    const handler = getHandler(CHANNELS.SYSTEM_OPEN_IN_EDITOR);
    const filePath = path.join(WORKTREE_PARENT, "feature-issue-9149", "src", "index.ts");
    await handler(fakeEvent, { path: filePath, line: 1, col: 1 });
    expect(openFileMock).toHaveBeenCalledWith(filePath, 1, 1, null);
  });

  it("honors a globally-configured worktree pattern in addition to the default", async () => {
    // Configure an alternative pattern. Both the configured and the default
    // parent should be admitted (so changing the pattern doesn't lock the
    // user out of previously-created worktrees).
    storeMock.get.mockImplementation((key: string) =>
      key === "worktreeConfig.pathPattern"
        ? "{parent-dir}/{base-folder}.wt/{branch-slug}"
        : undefined
    );
    // Re-register so the handler picks up the mock (the handler itself reads
    // the store on each call, so this is technically unnecessary — but kept
    // explicit to mirror the production startup order).
    cleanup();
    cleanup = registerSystemShellHandlers({} as HandlerDependencies);

    const handler = getHandler(CHANNELS.SYSTEM_OPEN_PATH);
    const customParent = path.join(path.dirname(PROJECT_ROOT), `${path.basename(PROJECT_ROOT)}.wt`);
    const customWorktree = path.join(customParent, "feature-x");
    await handler(fakeEvent, { path: customWorktree });
    expect(shellMock.openPath).toHaveBeenCalledWith(customWorktree);

    // The default parent stays admitted too.
    shellMock.openPath.mockClear();
    const legacyWorktree = path.join(WORKTREE_PARENT, "legacy-branch");
    await handler(fakeEvent, { path: legacyWorktree });
    expect(shellMock.openPath).toHaveBeenCalledWith(legacyWorktree);
  });

  it("still rejects sibling-prefix paths that share a worktree-parent prefix", async () => {
    const handler = getHandler(CHANNELS.SYSTEM_OPEN_PATH);
    // `/Users/me/project-worktrees-evil/...` shares a string prefix with the
    // worktree parent dir but isn't actually contained — the realpath +
    // separator check in pathGuard must still reject it.
    await expect(
      handler(fakeEvent, { path: `${WORKTREE_PARENT}-evil${path.sep}secret.txt` })
    ).rejects.toMatchObject({ code: "OUTSIDE_ROOT" });
    expect(shellMock.openPath).not.toHaveBeenCalled();
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
    storeMock.get.mockReturnValue(undefined);
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
