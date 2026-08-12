import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "os";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
  dialog: {
    showOpenDialog: vi.fn(),
    showErrorBox: vi.fn(),
  },
  shell: {
    openPath: vi.fn(),
    openExternal: vi.fn(),
  },
  app: {
    getPath: vi.fn().mockReturnValue(os.tmpdir()),
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

const addProjectMock = vi.fn(async (projectPath: string, _options?: unknown) => ({
  id: "p1",
  path: projectPath,
  name: "p1",
  emoji: "🌲",
  lastOpened: 0,
}));

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: {
    addProject: (...args: unknown[]) =>
      addProjectMock(...(args as Parameters<typeof addProjectMock>)),
    getCurrentProjectId: vi.fn(),
    getProjectById: vi.fn(),
    setCurrentProject: vi.fn(),
    getProjectState: vi.fn(),
    saveProjectState: vi.fn(),
    getAllProjects: vi.fn(() => []),
    getCurrentProject: vi.fn(() => null),
    updateProjectStatus: vi.fn(),
  },
}));

vi.mock("../../../services/ProjectSwitchService.js", () => ({
  ProjectSwitchService: class MockProjectSwitchService {
    onSwitch = vi.fn();
    switchProject = vi.fn();
    reopenProject = vi.fn();
  },
}));

vi.mock("../../../services/RunCommandDetector.js", () => ({
  runCommandDetector: { detect: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: vi.fn(() => null),
  getProjectForWebContents: vi.fn(() => null),
  getAllAppWebContents: vi.fn(() => []),
}));

vi.mock("../../../window/portDistribution.js", () => ({
  distributePortsToView: vi.fn(),
}));

import { ipcMain } from "electron";
import { CHANNELS } from "../../channels.js";
import { createProjectCrudRegistrar } from "./helpers/projectCrudLifecycle.js";
import type { HandlerDependencies } from "../../types.js";
// Disposes the stats/fleet pollers this registration starts; see the helper for
// why dropping the disposer leaks live timers into the rest of the file.
const registerProjectCrudHandlers = createProjectCrudRegistrar();

const EVENT = { sender: { id: 1 } };

function getHandler(channel: string): (...args: unknown[]) => unknown {
  for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
    if (call[0] === channel) return call[1] as (...args: unknown[]) => unknown;
  }
  throw new Error(`No handler registered for ${channel}`);
}

/** The options object `project:add` actually handed the store. */
function forwardedOptions(): Record<string, unknown> | undefined {
  const call = addProjectMock.mock.calls.at(-1);
  return call?.[1] as Record<string, unknown> | undefined;
}

/**
 * `project:add`'s second argument carries two independently-validated things:
 * the lightweight-workspace opt-out (#11405) and the creation identity
 * (#11404). The identity validator drops a malformed payload WHOLE, so any
 * refactor that folds `gitBacked` in beside `name`/`emoji` would make an
 * "Open without git" add fail that gate and be discarded in silence — the
 * dialog would then reopen forever with nothing to show for it. Nothing else
 * in the suite covers that, so these assertions are the guard.
 */
describe("project:add options", () => {
  let handler: (...args: unknown[]) => unknown;

  beforeEach(() => {
    vi.clearAllMocks();
    const deps = {
      mainWindow: { id: 1 } as unknown,
      windowRegistry: {
        getPrimary: () => undefined,
        getByWindowId: () => undefined,
        getByWebContentsId: () => undefined,
        all: () => [],
        size: 0,
      },
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);
    handler = getHandler(CHANNELS.PROJECT_ADD);
  });

  it("carries gitBacked:false through to the store on its own", async () => {
    await handler(EVENT, "/tmp/plain-folder", { gitBacked: false });

    expect(addProjectMock).toHaveBeenCalledTimes(1);
    expect(addProjectMock.mock.calls[0]![0]).toBe("/tmp/plain-folder");
    expect(forwardedOptions()).toMatchObject({ gitBacked: false });
  });

  it("keeps gitBacked:false when no identity accompanies it", async () => {
    // The identity half being absent must not take the mode half down with it.
    await handler(EVENT, "/tmp/plain-folder", { gitBacked: false });

    const options = forwardedOptions();
    expect(options?.gitBacked).toBe(false);
    expect(options?.identity).toBeUndefined();
  });

  it("keeps gitBacked:false when the identity alongside it is malformed", async () => {
    await handler(EVENT, "/tmp/plain-folder", {
      gitBacked: false,
      identity: { name: "Only half" },
    });

    const options = forwardedOptions();
    expect(options?.gitBacked).toBe(false);
    expect(options?.identity).toBeUndefined();
  });

  it("carries a well-formed identity through, trimmed", async () => {
    await handler(EVENT, "/tmp/repo", { identity: { name: "  Chosen  ", emoji: " 🚀 " } });

    const options = forwardedOptions();
    expect(options?.identity).toEqual({ name: "Chosen", emoji: "🚀" });
    expect(options?.gitBacked).toBeUndefined();
  });

  it("carries both halves when both are supplied", async () => {
    await handler(EVENT, "/tmp/plain-folder", {
      gitBacked: false,
      identity: { name: "Downloads", emoji: "📦" },
    });

    expect(forwardedOptions()).toMatchObject({
      gitBacked: false,
      identity: { name: "Downloads", emoji: "📦" },
    });
  });

  it("never lets a caller assert that a folder IS git-backed", async () => {
    // Only `addProject` — which actually looked for a repository — may decide
    // that. `true` is narrowed away rather than forwarded.
    await handler(EVENT, "/tmp/repo", { gitBacked: true });

    expect(forwardedOptions()?.gitBacked).toBeUndefined();
  });

  it("forwards nothing meaningful for a plain add", async () => {
    await handler(EVENT, "/tmp/repo");

    const options = forwardedOptions();
    expect(options?.gitBacked).toBeUndefined();
    expect(options?.identity).toBeUndefined();
  });
});
