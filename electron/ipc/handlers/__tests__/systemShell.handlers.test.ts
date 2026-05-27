import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

const shellMock = vi.hoisted(() => ({
  openPath: vi.fn(() => Promise.resolve("")),
  openExternal: vi.fn(() => Promise.resolve()),
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
import type { HandlerDependencies } from "../../types.js";

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

function getHandler(channel: string): Handler {
  const match = ipcMainMock.handle.mock.calls.find(([ch]) => ch === channel);
  if (!match) throw new Error(`No handler registered for ${channel}`);
  return match[1] as Handler;
}

const fakeEvent = {};
const PROJECT_ROOT = "/Users/me/project";
// Derived from the default pattern `{parent-dir}/{base-folder}-worktrees/{branch-slug}`
// applied to PROJECT_ROOT.
const WORKTREE_PARENT = "/Users/me/project-worktrees";

describe("system:open-path containment", () => {
  let cleanup: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    fsMock.promises.realpath.mockImplementation((p: string) => Promise.resolve(p));
    projectStoreMock.getAllProjects.mockReturnValue([{ path: PROJECT_ROOT }]);
    appMock.getPath.mockImplementation((name: string) => `/userdata/${name}`);
    storeMock.get.mockReturnValue(undefined);
    cleanup = registerSystemShellHandlers({} as HandlerDependencies);
  });

  afterEach(() => {
    cleanup();
  });

  it("opens a path contained in a project root", async () => {
    const handler = getHandler(CHANNELS.SYSTEM_OPEN_PATH);
    await handler(fakeEvent, { path: `${PROJECT_ROOT}/src/index.ts` });
    expect(shellMock.openPath).toHaveBeenCalledWith(`${PROJECT_ROOT}/src/index.ts`);
  });

  it("opens a path contained in the userData dir (crash logs)", async () => {
    const handler = getHandler(CHANNELS.SYSTEM_OPEN_PATH);
    await handler(fakeEvent, { path: "/userdata/userData/crashes/log.txt" });
    expect(shellMock.openPath).toHaveBeenCalledWith("/userdata/userData/crashes/log.txt");
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
      handler(fakeEvent, { path: `${PROJECT_ROOT}-evil/secret.txt` })
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
      handler(fakeEvent, { path: `${PROJECT_ROOT}/launcher.desktop` })
    ).rejects.toMatchObject({ code: "INVALID_PATH" });
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });

  it("rejects a safe-named symlink that resolves to a denied extension", async () => {
    const link = `${PROJECT_ROOT}/notes.txt`;
    const payload = `${PROJECT_ROOT}/Evil.desktop`;
    fsMock.promises.realpath.mockImplementation((p: string) =>
      Promise.resolve(p === link ? payload : p)
    );

    const handler = getHandler(CHANNELS.SYSTEM_OPEN_PATH);
    await expect(handler(fakeEvent, { path: link })).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });

  it("opens the realpath-resolved target, not the original path", async () => {
    const link = `${PROJECT_ROOT}/link.png`;
    const resolved = `${PROJECT_ROOT}/real.png`;
    fsMock.promises.realpath.mockImplementation((p: string) =>
      Promise.resolve(p === link ? resolved : p)
    );

    const handler = getHandler(CHANNELS.SYSTEM_OPEN_PATH);
    await handler(fakeEvent, { path: link });
    expect(shellMock.openPath).toHaveBeenCalledWith(resolved);
  });

  it("propagates a non-empty error string from shell.openPath", async () => {
    shellMock.openPath.mockResolvedValueOnce("no app associated");
    const handler = getHandler(CHANNELS.SYSTEM_OPEN_PATH);
    await expect(handler(fakeEvent, { path: `${PROJECT_ROOT}/index.ts` })).rejects.toThrow(
      /no app associated/
    );
  });
});

describe("system:open-in-editor containment", () => {
  let cleanup: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    fsMock.promises.realpath.mockImplementation((p: string) => Promise.resolve(p));
    projectStoreMock.getAllProjects.mockReturnValue([{ path: PROJECT_ROOT }]);
    appMock.getPath.mockImplementation((name: string) => `/userdata/${name}`);
    storeMock.get.mockReturnValue(undefined);
    cleanup = registerSystemShellHandlers({} as HandlerDependencies);
  });

  afterEach(() => {
    cleanup();
  });

  it("opens a contained file in the editor", async () => {
    const handler = getHandler(CHANNELS.SYSTEM_OPEN_IN_EDITOR);
    await handler(fakeEvent, { path: `${PROJECT_ROOT}/src/app.ts`, line: 5, col: 2 });
    expect(openFileMock).toHaveBeenCalledWith(`${PROJECT_ROOT}/src/app.ts`, 5, 2, null);
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
        ? `${PROJECT_ROOT}/scripts/deploy.ps1`
        : `${PROJECT_ROOT}/scripts/setup.desktop`;
    await handler(fakeEvent, { path: scriptPath });
    expect(openFileMock).toHaveBeenCalledWith(scriptPath, undefined, undefined, null);
  });
});

describe("system path-allowlist: worktree parent dirs", () => {
  let cleanup: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    fsMock.promises.realpath.mockImplementation((p: string) => Promise.resolve(p));
    projectStoreMock.getAllProjects.mockReturnValue([{ path: PROJECT_ROOT }]);
    appMock.getPath.mockImplementation((name: string) => `/userdata/${name}`);
    storeMock.get.mockReturnValue(undefined);
    cleanup = registerSystemShellHandlers({} as HandlerDependencies);
  });

  afterEach(() => {
    cleanup();
  });

  it("opens a path inside the default worktree parent dir (Reveal in Finder on worktree card)", async () => {
    const handler = getHandler(CHANNELS.SYSTEM_OPEN_PATH);
    const worktreePath = `${WORKTREE_PARENT}/feature-issue-9149`;
    await handler(fakeEvent, { path: worktreePath });
    expect(shellMock.openPath).toHaveBeenCalledWith(worktreePath);
  });

  it("opens a file inside a worktree (ReviewHub file-open click)", async () => {
    const handler = getHandler(CHANNELS.SYSTEM_OPEN_IN_EDITOR);
    const filePath = `${WORKTREE_PARENT}/feature-issue-9149/src/index.ts`;
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
    const customParent = "/Users/me/project.wt";
    const customWorktree = `${customParent}/feature-x`;
    await handler(fakeEvent, { path: customWorktree });
    expect(shellMock.openPath).toHaveBeenCalledWith(customWorktree);

    // The default parent stays admitted too.
    shellMock.openPath.mockClear();
    const legacyWorktree = `${WORKTREE_PARENT}/legacy-branch`;
    await handler(fakeEvent, { path: legacyWorktree });
    expect(shellMock.openPath).toHaveBeenCalledWith(legacyWorktree);
  });

  it("still rejects sibling-prefix paths that share a worktree-parent prefix", async () => {
    const handler = getHandler(CHANNELS.SYSTEM_OPEN_PATH);
    // `/Users/me/project-worktrees-evil/...` shares a string prefix with the
    // worktree parent dir but isn't actually contained — the realpath +
    // separator check in pathGuard must still reject it.
    await expect(
      handler(fakeEvent, { path: `${WORKTREE_PARENT}-evil/secret.txt` })
    ).rejects.toMatchObject({ code: "OUTSIDE_ROOT" });
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });
});
