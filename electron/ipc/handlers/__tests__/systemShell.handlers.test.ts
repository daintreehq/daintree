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

import { ipcMain } from "electron";
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

describe("system:open-path containment", () => {
  let cleanup: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    fsMock.promises.realpath.mockImplementation((p: string) => Promise.resolve(p));
    projectStoreMock.getAllProjects.mockReturnValue([{ path: PROJECT_ROOT }]);
    appMock.getPath.mockImplementation((name: string) => `/userdata/${name}`);
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
});
