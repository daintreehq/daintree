import path from "node:path";
import os from "node:os";
import { describe, it, expect, vi, beforeEach } from "vitest";

// #17186: a window switching from a project to a scratch has to let go of the
// project as a switch to another project does, and a scratch has one live view
// across the app, as a project does.

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  app: { getPath: vi.fn().mockReturnValue(os.tmpdir()) },
  BrowserWindow: { getAllWindows: () => [] },
}));

const hosts = vi.hoisted(
  () => [] as Array<{ projectPath: string; send: ReturnType<typeof vi.fn> }>
);
vi.mock("../../../../services/WorkspaceHostProcess.js", () => ({
  WorkspaceHostProcess: class {
    projectPath: string;
    dispose = vi.fn();
    onDispose = vi.fn();
    setStatusDownloadGate = vi.fn();
    send = vi.fn();
    on = vi.fn();
    setLogLevelOverrides = vi.fn();
    relayFetchThrottle = vi.fn();
    flushWorkspacePowerPolicy = vi.fn();
    waitForReady = vi.fn(async () => undefined);
    generateRequestId = () => "req";
    sendWithResponse = vi.fn(async () => undefined);
    isReady = () => true;
    constructor(projectPath: string) {
      this.projectPath = projectPath;
      hosts.push(this);
    }
  },
}));
vi.mock("../../../../services/workspace-client/statusDownloadGate.js", () => ({
  gateGitStatusOnDownload: () => null,
}));

type Row = { id: string; name: string; path: string; status: string };
const projectRows = vi.hoisted(() => new Map<string, Row>());
const projectStoreMock = vi.hoisted(() => ({
  clearCurrentProject: vi.fn(),
  getCurrentProjectId: vi.fn<() => string | null>(() => null),
  getProjectById: vi.fn((id: string) => projectRows.get(id) ?? null),
  updateProjectStatus: vi.fn((id: string, status: string) => {
    const row = { ...projectRows.get(id)!, status };
    projectRows.set(id, row);
    return row;
  }),
  getProjectSettings: vi.fn(async () => null),
  resolveProjectIdForPath: vi.fn((p: string) => `id-for-${p}`),
}));
vi.mock("../../../../services/ProjectStore.js", () => ({ projectStore: projectStoreMock }));

const scratchStoreMock = vi.hoisted(() => ({
  getAllScratches: vi.fn(() => []),
  getCurrentScratch: vi.fn<() => unknown>(() => null),
  getScratchById: vi.fn<(id: string) => unknown>(),
  setCurrentScratch: vi.fn<(id: string) => unknown>(),
}));
vi.mock("../../../../services/ScratchStore.js", () => ({ scratchStore: scratchStoreMock }));

vi.mock("../../../../window/openWindowsTracker.js", () => ({ scheduleOpenWindowsSave: vi.fn() }));
vi.mock("../../../../projectMenuState.js", () => ({ refreshProjectMenuState: vi.fn() }));
vi.mock("../../../../window/portDistribution.js", () => ({ distributePortsToView: vi.fn() }));

const registryMock = vi.hoisted(() => ({
  senderWindow: null as unknown,
  boundWorkspace: null as string | null,
}));
vi.mock("../../../../window/webContentsRegistry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../window/webContentsRegistry.js")>()),
  getWindowForWebContents: () => registryMock.senderWindow,
  getProjectForWebContents: () => registryMock.boundWorkspace,
}));

const broadcastMock = vi.hoisted(() => vi.fn());
vi.mock("../../../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils.js")>()),
  broadcastToRenderer: broadcastMock,
}));

import { ipcMain } from "electron";
import { CHANNELS } from "../../../channels.js";
import { registerScratchHandlers } from "../index.js";
import { WorkspaceHostPool } from "../../../../services/workspace-client/WorkspaceHostPool.js";
import { resetProjectHistory } from "../../../../services/ProjectHistoryService.js";
import { isAppError } from "../../../../utils/errorTypes.js";
import { beginWindowSwitch, isCurrentWindowSwitch } from "../../../../window/windowSwitchEpochs.js";
import { setRemoteVisibleProjectIdsProvider } from "../../../../window/activeProjectIds.js";
import type { HandlerDependencies } from "../../../types.js";
import type { WorkspaceClient } from "../../../../services/WorkspaceClient.js";

const PROJECT_A = "a".repeat(64);
const PROJECT_PATH = path.resolve("/srv/project-a");
const SCRATCH = "11111111-1111-4111-8111-111111111111";
const SCRATCH_PATH = "/tmp/scratch-one";

function makeWebContents(id: number) {
  return { id, isDestroyed: () => false, send: vi.fn(), focus: vi.fn() };
}

function makeBrowserWindow(id: number) {
  return {
    id,
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  };
}

/** A window's view manager: the views it holds, and the one it shows. */
function makePvm(active: string | null, viewIds: string[] = active ? [active] : []) {
  const views = new Map(viewIds.map((id, i) => [id, { webContents: makeWebContents(100 + i) }]));
  const state = { active };
  const pvm = {
    state,
    views,
    setPendingFocusIntent: vi.fn(),
    getActiveProjectId: () => state.active,
    getOutgoingBridgeProjectId: () => null,
    getActiveView: () => (state.active ? (views.get(state.active) ?? null) : null),
    getAllViews: () =>
      [...views].map(([projectId, view]) => ({ projectId, view, state: "ready" as const })),
    getProjectIdForWebContents: vi.fn(() => null),
    releaseCachedView: vi.fn((id: string) => views.delete(id)),
    getCachedViewReleaseBlock: vi.fn(() => "running-assistant"),
    abandonBackgroundRestore: vi.fn(() => false),
    switchTo: vi.fn(async (id: string) => {
      if (!views.has(id)) views.set(id, { webContents: makeWebContents(200) });
      state.active = id;
      return { view: views.get(id)!, isNew: true };
    }),
  };
  return pvm;
}

type Pvm = ReturnType<typeof makePvm>;

const SENDER_ID = 1;
const OTHER_ID = 2;
const senderEvent = {
  sender: makeWebContents(10),
  senderFrame: { url: "http://localhost:5173" },
};

function setup(options: {
  senderPvm?: Pvm;
  otherPvm?: Pvm;
  worktreeService?: Partial<WorkspaceClient>;
}) {
  const senderPvm = options.senderPvm ?? makePvm(PROJECT_A);
  const senderWindow = makeBrowserWindow(SENDER_ID);
  const otherWindow = makeBrowserWindow(OTHER_ID);
  registryMock.senderWindow = senderWindow;
  const contexts = [
    {
      windowId: SENDER_ID,
      browserWindow: senderWindow,
      services: { projectViewManager: senderPvm },
    },
    ...(options.otherPvm
      ? [
          {
            windowId: OTHER_ID,
            browserWindow: otherWindow,
            services: { projectViewManager: options.otherPvm },
          },
        ]
      : []),
  ];
  const windowRegistry = {
    all: () => contexts,
    getByWindowId: (id: number) => contexts.find((c) => c.windowId === id),
  };
  registerScratchHandlers({
    mainWindow: senderWindow,
    windowRegistry,
    worktreeService: options.worktreeService,
  } as unknown as HandlerDependencies);
  const handler = (
    ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }
  ).mock.calls
    .filter((c) => c[0] === CHANNELS.SCRATCH_SWITCH)
    .at(-1)![1] as (event: unknown, ...args: unknown[]) => Promise<unknown>;
  return {
    senderPvm,
    otherWindow,
    switchToScratch: (focusIntent?: unknown) =>
      handler(senderEvent, SCRATCH, focusIntent ? { focusIntent } : undefined),
  };
}

function scratchOnSwitchBroadcasts() {
  return broadcastMock.mock.calls.filter(([channel]) => channel === CHANNELS.SCRATCH_ON_SWITCH);
}

beforeEach(() => {
  vi.clearAllMocks();
  hosts.length = 0;
  projectRows.clear();
  projectRows.set(PROJECT_A, {
    id: PROJECT_A,
    name: "Project A",
    path: PROJECT_PATH,
    status: "active",
  });
  registryMock.boundWorkspace = PROJECT_A;
  // `clearAllMocks` keeps return values; the global pointer names nothing unless a test says so.
  projectStoreMock.getCurrentProjectId.mockReturnValue(null);
  const scratch = { id: SCRATCH, name: "Spike", path: SCRATCH_PATH };
  scratchStoreMock.getScratchById.mockReturnValue(scratch);
  scratchStoreMock.setCurrentScratch.mockReturnValue(scratch);
  resetProjectHistory(SENDER_ID);
});

describe("scratch:switch releases the project's workspace host", () => {
  function poolService(pool: WorkspaceHostPool): Partial<WorkspaceClient> {
    return { unregisterWindow: (windowId: number) => pool.unregisterWindow(windowId) };
  }

  it("drops the window as a holder and backgrounds a host no window holds", async () => {
    const pool = new WorkspaceHostPool({ config: {}, emit: vi.fn() });
    await pool.loadProject(PROJECT_PATH, SENDER_ID);
    const { switchToScratch } = setup({ worktreeService: poolService(pool) });

    await switchToScratch();

    const entry = pool.entries.get(PROJECT_PATH)!;
    expect(entry.refCount).toBe(0);
    expect(pool.isWindowAttached(SENDER_ID, PROJECT_PATH)).toBe(false);
    // Paused: no foreground git or PR polling for a project nobody is looking at.
    expect(hosts[0]!.send).toHaveBeenCalledWith({ type: "background" });
    pool.dispose();
  });

  it("keeps the host foreground while another window still holds it", async () => {
    const pool = new WorkspaceHostPool({ config: {}, emit: vi.fn() });
    await pool.loadProject(PROJECT_PATH, SENDER_ID);
    await pool.loadProject(PROJECT_PATH, OTHER_ID);
    const { switchToScratch } = setup({
      worktreeService: poolService(pool),
      otherPvm: makePvm(PROJECT_A),
    });

    await switchToScratch();

    expect(pool.entries.get(PROJECT_PATH)!.refCount).toBe(1);
    expect(pool.isWindowAttached(OTHER_ID, PROJECT_PATH)).toBe(true);
    expect(hosts[0]!.send).not.toHaveBeenCalledWith({ type: "background" });
    pool.dispose();
  });

  it("leaves the window attached when the view swap fails", async () => {
    const pool = new WorkspaceHostPool({ config: {}, emit: vi.fn() });
    await pool.loadProject(PROJECT_PATH, SENDER_ID);
    const senderPvm = makePvm(PROJECT_A);
    senderPvm.switchTo.mockRejectedValueOnce(new Error("swap failed"));
    const { switchToScratch } = setup({ senderPvm, worktreeService: poolService(pool) });

    await expect(switchToScratch()).rejects.toThrow("swap failed");

    // The window still shows the project, so it still holds its host.
    expect(pool.isWindowAttached(SENDER_ID, PROJECT_PATH)).toBe(true);
    expect(hosts[0]!.send).not.toHaveBeenCalledWith({ type: "background" });
    pool.dispose();
  });
});

describe("scratch:switch never detaches a project asked for while its swap waited", () => {
  it("leaves the window on the project a later switch attached it to", async () => {
    // The window's queue runs the scratch's swap first, but a project switch
    // asked for meanwhile attaches the window to its project at the time it
    // is asked for. The scratch landing afterwards must not undo that.
    const pool = new WorkspaceHostPool({ config: {}, emit: vi.fn() });
    await pool.loadProject(PROJECT_PATH, SENDER_ID);
    let land: () => void = () => {};
    const senderPvm = makePvm(PROJECT_A);
    const landSwitch = senderPvm.switchTo.getMockImplementation()!;
    senderPvm.switchTo.mockImplementationOnce(
      (id: string) => new Promise((resolve) => (land = () => resolve(landSwitch(id))))
    );
    const { switchToScratch } = setup({
      senderPvm,
      worktreeService: { unregisterWindow: (windowId: number) => pool.unregisterWindow(windowId) },
    });
    const switching = switchToScratch();
    await vi.waitFor(() => expect(senderPvm.switchTo).toHaveBeenCalled());

    const projectB = path.resolve("/srv/project-b");
    beginWindowSwitch(SENDER_ID);
    await pool.loadProject(projectB, SENDER_ID);
    land();
    await switching;

    expect(pool.isWindowAttached(SENDER_ID, projectB)).toBe(true);
    pool.dispose();
  });
});

describe("scratch:switch outdates an earlier project switch's deferred tail", () => {
  // A failed project switch restores the window's worktree mapping once its
  // load settles, and a cloned project loads once its clone lands. Either one
  // landing after the window moved to a scratch would attach it to that
  // project again.
  it("starts a new switch epoch for the window once the scratch lands", async () => {
    const earlier = beginWindowSwitch(SENDER_ID);
    const { switchToScratch } = setup({});

    await switchToScratch();

    expect(isCurrentWindowSwitch(SENDER_ID, earlier)).toBe(false);
  });

  it("leaves the earlier switch current when the scratch's swap fails", async () => {
    const earlier = beginWindowSwitch(SENDER_ID);
    const senderPvm = makePvm(PROJECT_A);
    senderPvm.switchTo.mockRejectedValueOnce(new Error("swap failed"));
    const { switchToScratch } = setup({ senderPvm });

    await expect(switchToScratch()).rejects.toThrow("swap failed");

    expect(isCurrentWindowSwitch(SENDER_ID, earlier)).toBe(true);
  });
});

describe("scratch:switch moves the departing project to the background", () => {
  it("backgrounds a project no window shows any more and tells every view", async () => {
    const { switchToScratch } = setup({});

    await switchToScratch();

    expect(projectRows.get(PROJECT_A)?.status).toBe("background");
    expect(broadcastMock).toHaveBeenCalledWith(
      CHANNELS.PROJECT_UPDATED,
      expect.objectContaining({ id: PROJECT_A, status: "background" })
    );
  });

  it("leaves a project another window still shows active", async () => {
    const { switchToScratch } = setup({ otherPvm: makePvm(PROJECT_A) });

    await switchToScratch();

    expect(projectRows.get(PROJECT_A)?.status).toBe("active");
    expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
  });

  it("reads the departing workspace from the sender, not the global pointer", async () => {
    // The global pointer names whichever window switched last; this sender
    // shows a scratch, so no project departed from it.
    projectStoreMock.getCurrentProjectId.mockReturnValue(PROJECT_A);
    registryMock.boundWorkspace = "22222222-2222-4222-9222-222222222222";
    const { switchToScratch } = setup({
      senderPvm: makePvm("22222222-2222-4222-9222-222222222222"),
    });

    await switchToScratch();

    expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
  });

  it("leaves a project a remote Shell still shows active", async () => {
    const stop = setRemoteVisibleProjectIdsProvider(() => [PROJECT_A]);
    try {
      const { switchToScratch } = setup({});

      await switchToScratch();

      expect(projectRows.get(PROJECT_A)?.status).toBe("active");
    } finally {
      stop();
    }
  });

  it("still brings the window to the scratch when the status write fails", async () => {
    projectStoreMock.updateProjectStatus.mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    const { senderPvm, switchToScratch } = setup({});

    // The window has already moved: its view must still hear it switched.
    await expect(switchToScratch()).resolves.toEqual(expect.objectContaining({ id: SCRATCH }));

    expect(senderPvm.views.get(SCRATCH)!.webContents.send).toHaveBeenCalledWith(
      CHANNELS.SCRATCH_ON_SWITCH,
      expect.objectContaining({ scratch: expect.objectContaining({ id: SCRATCH }) })
    );
  });

  it("leaves a closed row alone", async () => {
    projectRows.set(PROJECT_A, { ...projectRows.get(PROJECT_A)!, status: "closed" });
    const { switchToScratch } = setup({});

    await switchToScratch();

    expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
  });

  it("changes nothing when the view swap fails", async () => {
    const senderPvm = makePvm(PROJECT_A);
    senderPvm.switchTo.mockRejectedValueOnce(new Error("swap failed"));
    const { switchToScratch } = setup({ senderPvm });

    await expect(switchToScratch()).rejects.toThrow("swap failed");

    expect(projectRows.get(PROJECT_A)?.status).toBe("active");
  });
});

describe("scratch:switch keeps one live view of a scratch", () => {
  it("brings forward the window showing it instead of opening a second view", async () => {
    const unregisterWindow = vi.fn();
    const otherPvm = makePvm(SCRATCH);
    const { senderPvm, otherWindow, switchToScratch } = setup({
      otherPvm,
      worktreeService: { unregisterWindow },
    });
    const focusIntent = { intent: "focus-panel", panelId: "t7" };

    await expect(switchToScratch(focusIntent)).resolves.toBeNull();

    expect(otherWindow.focus).toHaveBeenCalled();
    const ownerView = otherPvm.views.get(SCRATCH)!.webContents;
    expect(ownerView.focus).toHaveBeenCalled();
    expect(ownerView.send).toHaveBeenCalledWith(CHANNELS.PROJECT_FOCUS_ON_ACTIVATE, focusIntent);
    // The requesting window stays exactly where it was.
    expect(senderPvm.switchTo).not.toHaveBeenCalled();
    expect(senderPvm.setPendingFocusIntent).not.toHaveBeenCalled();
    expect(unregisterWindow).not.toHaveBeenCalled();
    expect(scratchStoreMock.setCurrentScratch).not.toHaveBeenCalled();
    expect(projectStoreMock.clearCurrentProject).not.toHaveBeenCalled();
  });

  it("releases another window's cached view and opens the scratch here", async () => {
    const otherPvm = makePvm(PROJECT_A, [PROJECT_A, SCRATCH]);
    const { senderPvm, otherWindow, switchToScratch } = setup({ otherPvm });

    await expect(switchToScratch()).resolves.toEqual(expect.objectContaining({ id: SCRATCH }));

    expect(otherPvm.releaseCachedView).toHaveBeenCalledWith(SCRATCH);
    expect(otherPvm.views.has(SCRATCH)).toBe(false);
    expect(senderPvm.switchTo).toHaveBeenCalledWith(SCRATCH, SCRATCH_PATH);
    expect(otherWindow.focus).not.toHaveBeenCalled();
  });

  it("refuses when another window's cached view can't be released", async () => {
    const otherPvm = makePvm(PROJECT_A, [PROJECT_A, SCRATCH]);
    otherPvm.releaseCachedView.mockReturnValue(false);
    const { senderPvm, switchToScratch } = setup({ otherPvm });

    const error = await switchToScratch().catch((e: unknown) => e);

    expect(isAppError(error) && error.code).toBe("PROJECT_HELD_ELSEWHERE");
    // Its recovery would switch that window with a project switch, which
    // can't take a scratch.
    expect((error as { details?: { showable?: boolean } }).details?.showable).toBe(false);
    expect(senderPvm.switchTo).not.toHaveBeenCalled();
  });

  it("reuses the sender's own view even when another window also holds one", async () => {
    // A fleet from before the rule could hold two; activating the view this
    // window already has creates nothing new, so it is never redirected.
    const senderPvm = makePvm(PROJECT_A, [PROJECT_A, SCRATCH]);
    const { switchToScratch } = setup({ senderPvm, otherPvm: makePvm(SCRATCH) });

    await switchToScratch();

    expect(senderPvm.switchTo).toHaveBeenCalledWith(SCRATCH, SCRATCH_PATH);
  });
});

describe("scratch:on-switch reaches only the view that switched", () => {
  it("is sent to the scratch's view and broadcast to no one", async () => {
    const { senderPvm, switchToScratch } = setup({ otherPvm: makePvm(PROJECT_A) });

    await switchToScratch();

    const scratchView = senderPvm.views.get(SCRATCH)!.webContents;
    expect(scratchView.send).toHaveBeenCalledWith(
      CHANNELS.SCRATCH_ON_SWITCH,
      expect.objectContaining({ scratch: expect.objectContaining({ id: SCRATCH }) })
    );
    expect(senderEvent.sender.send).not.toHaveBeenCalled();
    expect(scratchOnSwitchBroadcasts()).toEqual([]);
  });
});

describe("scratch:getCurrent answers for the sender's own view", () => {
  function getCurrent(boundTo: string | null) {
    const senderPvm = makePvm(boundTo);
    senderPvm.getProjectIdForWebContents.mockReturnValue(boundTo as never);
    setup({ senderPvm });
    const handler = (
      ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }
    ).mock.calls
      .filter((c) => c[0] === CHANNELS.SCRATCH_GET_CURRENT)
      .at(-1)![1] as (event: unknown) => Promise<unknown>;
    return handler(senderEvent);
  }

  beforeEach(() => {
    // Another window switched to a scratch last.
    scratchStoreMock.getCurrentScratch.mockReturnValue({ id: "other", name: "Other", path: "/x" });
  });

  it("is null in a project's view, whatever scratch another window switched to", async () => {
    await expect(getCurrent(PROJECT_A)).resolves.toBeNull();
  });

  it("is the scratch a scratch's view is bound to", async () => {
    await expect(getCurrent(SCRATCH)).resolves.toEqual(expect.objectContaining({ id: SCRATCH }));
    expect(scratchStoreMock.getScratchById).toHaveBeenCalledWith(SCRATCH);
  });
});
