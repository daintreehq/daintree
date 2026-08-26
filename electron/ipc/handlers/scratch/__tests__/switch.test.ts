import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "os";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
  app: {
    getPath: vi.fn().mockReturnValue(os.tmpdir()),
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

const scratchStoreMock = vi.hoisted(() => ({
  getAllScratches: vi.fn(() => []),
  getCurrentScratch: vi.fn(() => null),
  getScratchById: vi.fn<(id: string) => { id: string; path: string } | null>(),
  createScratch: vi.fn(),
  updateScratch: vi.fn(),
  removeScratch: vi.fn(),
  setCurrentScratch: vi.fn<(id: string) => unknown>(),
}));

vi.mock("../../../../services/ScratchStore.js", () => ({
  scratchStore: scratchStoreMock,
}));

const projectStoreMock = vi.hoisted(() => ({
  clearCurrentProject: vi.fn(),
  // The global "last window to switch" pointer. History deliberately does not
  // read it (#11936) — this stays only because other code in the handler does.
  getCurrentProjectId: vi.fn<() => string | null>(() => null),
}));

vi.mock("../../../../services/ProjectStore.js", () => ({
  projectStore: projectStoreMock,
}));

const scheduleOpenWindowsSaveMock = vi.hoisted(() => vi.fn());
vi.mock("../../../../window/openWindowsTracker.js", () => ({
  scheduleOpenWindowsSave: scheduleOpenWindowsSaveMock,
}));

const refreshProjectMenuStateMock = vi.hoisted(() => vi.fn());
vi.mock("../../../../projectMenuState.js", () => ({
  refreshProjectMenuState: refreshProjectMenuStateMock,
}));

// `buildIpcContext` resolves the sender's own workspace binding through this
// registry, and that binding — not the global project pointer — is what the
// handler records as the workspace being left.
const webContentsRegistryMock = vi.hoisted(() => ({
  getWindowForWebContents: vi.fn<() => { id: number } | null>(() => null),
  getProjectForWebContents: vi.fn<(id: number) => string | null>(() => null),
}));
vi.mock("../../../../window/webContentsRegistry.js", () => webContentsRegistryMock);

const broadcastMock = vi.hoisted(() => ({ broadcastToRenderer: vi.fn() }));
vi.mock("../../../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../utils.js")>();
  return { ...actual, broadcastToRenderer: broadcastMock.broadcastToRenderer };
});

import { ipcMain } from "electron";
import { CHANNELS } from "../../../channels.js";
import { registerScratchHandlers } from "../index.js";
import {
  getProjectHistory,
  disposeProjectHistory,
  resetProjectHistory,
} from "../../../../services/ProjectHistoryService.js";
import type { HandlerDependencies } from "../../../types.js";

function getHandler(channel: string) {
  const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }).mock
    .calls;
  return calls.find((c) => c[0] === channel)?.[1] as (
    event: unknown,
    ...args: unknown[]
  ) => Promise<unknown>;
}

const fakeEvent = { sender: { id: 1 }, senderFrame: { url: "http://localhost:5173" } };

// Real id shapes, because the reader that consumes this history routes its
// existence checks on them: a scratch is a UUIDv4, a project 64 hex characters.
const PROJECT_A = "a".repeat(64);
const SCRATCH_ONE = "11111111-1111-4111-8111-111111111111";
const SCRATCH_TWO = "22222222-2222-4222-9222-222222222222";

/** Point the scratch store at one scratch, the way a real switch would find it. */
function enterScratch(scratchId: string): void {
  scratchStoreMock.getScratchById.mockReturnValue({ id: scratchId, path: `/tmp/${scratchId}` });
  scratchStoreMock.setCurrentScratch.mockReturnValue({ id: scratchId, path: `/tmp/${scratchId}` });
}

// #11136: a scratch is not a project. Switching to one leaves the window's
// ProjectViewManager holding a scratch id that has no project row, so the
// File-menu project gates have to drop — but only a refresh makes the menu notice.
describe("scratch:switch refreshes the File-menu project gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` clears calls, not queued return values, so a binding set
    // by one test would otherwise leak into the next.
    webContentsRegistryMock.getProjectForWebContents.mockReturnValue(null);
    webContentsRegistryMock.getWindowForWebContents.mockReturnValue(null);
    scratchStoreMock.getScratchById.mockReturnValue({ id: "scratch-1", path: "/tmp/scratch-1" });
    scratchStoreMock.setCurrentScratch.mockReturnValue({
      id: "scratch-1",
      path: "/tmp/scratch-1",
    });
  });

  function makeDeps(): HandlerDependencies {
    return { mainWindow: {} as unknown } as unknown as HandlerDependencies;
  }

  it("refreshes after the canonical pointers move to the scratch", async () => {
    registerScratchHandlers(makeDeps());

    await getHandler(CHANNELS.SCRATCH_SWITCH)(fakeEvent, "scratch-1");

    expect(projectStoreMock.clearCurrentProject).toHaveBeenCalled();
    expect(refreshProjectMenuStateMock).toHaveBeenCalled();

    // Refreshing before the project pointer is cleared would re-read the old
    // project and leave the gates enabled.
    expect(refreshProjectMenuStateMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      projectStoreMock.clearCurrentProject.mock.invocationCallOrder[0]
    );
  });

  it("records the departing project and the scratch as a workspace pair", async () => {
    webContentsRegistryMock.getProjectForWebContents.mockReturnValue(PROJECT_A);
    enterScratch(SCRATCH_ONE);
    const deps = { mainWindow: { id: 77 } } as unknown as HandlerDependencies;
    // Reset rather than dispose: a disposed id stays tombstoned and refuses to
    // record, which is the guard against a closed window's late switch.
    resetProjectHistory(77);
    registerScratchHandlers(deps);

    await getHandler(CHANNELS.SCRATCH_SWITCH)(fakeEvent, SCRATCH_ONE);

    // Both sides, outgoing first: the project so the shortcut can leave the
    // scratch, and the scratch itself so the shortcut can come back to it. A
    // scratch that left no entry made `Cmd+Alt+=` land on an older project
    // instead (#11936).
    expect(getProjectHistory(77).snapshot().entries).toEqual([SCRATCH_ONE, PROJECT_A]);
    disposeProjectHistory(77);
  });

  it("records the departing scratch when moving between two scratches", async () => {
    // The global project pointer was cleared on the way into the first scratch,
    // so it has nothing to say here. Only the sender's own binding does.
    projectStoreMock.getCurrentProjectId.mockReturnValue(null);
    webContentsRegistryMock.getProjectForWebContents.mockReturnValue(SCRATCH_ONE);
    enterScratch(SCRATCH_TWO);
    const deps = { mainWindow: { id: 78 } } as unknown as HandlerDependencies;
    resetProjectHistory(78);
    registerScratchHandlers(deps);

    await getHandler(CHANNELS.SCRATCH_SWITCH)(fakeEvent, SCRATCH_TWO);

    expect(getProjectHistory(78).snapshot().entries).toEqual([SCRATCH_TWO, SCRATCH_ONE]);
    disposeProjectHistory(78);
  });

  it("records into the sending window's history, not the main window's", async () => {
    // Windows navigate independently. Folding a second window's scratch switch
    // into the primary window's list would send the primary somewhere it has
    // never been, and leave the sender with nothing to go back to.
    webContentsRegistryMock.getWindowForWebContents.mockReturnValue({ id: 81 });
    webContentsRegistryMock.getProjectForWebContents.mockReturnValue(PROJECT_A);
    enterScratch(SCRATCH_ONE);
    const deps = { mainWindow: { id: 80 } } as unknown as HandlerDependencies;
    resetProjectHistory(80);
    resetProjectHistory(81);
    registerScratchHandlers(deps);

    await getHandler(CHANNELS.SCRATCH_SWITCH)(fakeEvent, SCRATCH_ONE);

    expect(getProjectHistory(81).snapshot().entries).toEqual([SCRATCH_ONE, PROJECT_A]);
    expect(getProjectHistory(80).snapshot().entries).toEqual([]);
    disposeProjectHistory(80);
    disposeProjectHistory(81);
  });

  it("records nothing when the view swap fails", async () => {
    webContentsRegistryMock.getProjectForWebContents.mockReturnValue(PROJECT_A);
    enterScratch(SCRATCH_ONE);
    const deps = {
      mainWindow: { id: 79 },
      projectViewManager: {
        setPendingFocusIntent: vi.fn(),
        switchTo: vi.fn().mockRejectedValue(new Error("swap failed")),
      },
    } as unknown as HandlerDependencies;
    resetProjectHistory(79);
    registerScratchHandlers(deps);

    await expect(getHandler(CHANNELS.SCRATCH_SWITCH)(fakeEvent, SCRATCH_ONE)).rejects.toThrow(
      "swap failed"
    );

    // A switch that threw never happened, and moving the toggle for it would
    // point the shortcut at a workspace the window is not in.
    expect(getProjectHistory(79).snapshot().entries).toEqual([]);
    disposeProjectHistory(79);
  });

  it("does not refresh when the scratch does not exist", async () => {
    scratchStoreMock.getScratchById.mockReturnValue(null);
    registerScratchHandlers(makeDeps());

    await expect(getHandler(CHANNELS.SCRATCH_SWITCH)(fakeEvent, "ghost")).rejects.toThrow();

    expect(refreshProjectMenuStateMock).not.toHaveBeenCalled();
  });
});

// The open-window manifest is what a relaunch reads to decide which workspace
// each window comes back on. `project:switch` re-persists it after committing;
// `scratch:switch` did not, so a hard crash straight after entering a scratch
// relaunched into the workspace the user had left (#11958).
describe("scratch:switch re-persists the open-window manifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    webContentsRegistryMock.getProjectForWebContents.mockReturnValue(null);
    webContentsRegistryMock.getWindowForWebContents.mockReturnValue(null);
    enterScratch(SCRATCH_ONE);
  });

  it("schedules a save once the pointers name the scratch", async () => {
    registerScratchHandlers({ mainWindow: {} } as unknown as HandlerDependencies);

    await getHandler(CHANNELS.SCRATCH_SWITCH)(fakeEvent, SCRATCH_ONE);

    expect(scheduleOpenWindowsSaveMock).toHaveBeenCalled();
    // The manifest is built from every window's committed active id, so saving
    // before the pointers move would persist the workspace being left.
    expect(scheduleOpenWindowsSaveMock.mock.invocationCallOrder[0]!).toBeGreaterThan(
      scratchStoreMock.setCurrentScratch.mock.invocationCallOrder[0]!
    );
  });

  it("waits for the view swap to resolve before scheduling", async () => {
    // The manifest reads each window's ProjectViewManager, so a save that
    // landed while `switchTo` was still in flight would snapshot the outgoing
    // workspace. Held open deliberately to pin that ordering — asserting it
    // against the pointer writes alone cannot see it.
    let releaseSwitch: (() => void) | undefined;
    const switchTo = vi.fn(
      () =>
        new Promise<{ view: null; isNew: boolean }>((resolve) => {
          releaseSwitch = () => resolve({ view: null, isNew: false });
        })
    );
    registerScratchHandlers({
      mainWindow: {},
      projectViewManager: { setPendingFocusIntent: vi.fn(), switchTo },
    } as unknown as HandlerDependencies);

    const pending = getHandler(CHANNELS.SCRATCH_SWITCH)(fakeEvent, SCRATCH_ONE);
    await Promise.resolve();
    expect(switchTo).toHaveBeenCalled();
    expect(scheduleOpenWindowsSaveMock).not.toHaveBeenCalled();

    releaseSwitch?.();
    await pending;

    expect(scheduleOpenWindowsSaveMock).toHaveBeenCalled();
  });

  it("schedules no save when the view swap fails", async () => {
    const deps = {
      mainWindow: { id: 91 },
      projectViewManager: {
        setPendingFocusIntent: vi.fn(),
        switchTo: vi.fn().mockRejectedValue(new Error("swap failed")),
      },
    } as unknown as HandlerDependencies;
    registerScratchHandlers(deps);

    await expect(getHandler(CHANNELS.SCRATCH_SWITCH)(fakeEvent, SCRATCH_ONE)).rejects.toThrow(
      "swap failed"
    );

    // Persisting a switch that threw would relaunch into a workspace this
    // window never reached.
    expect(scheduleOpenWindowsSaveMock).not.toHaveBeenCalled();
  });

  it("schedules no save when the scratch does not exist", async () => {
    scratchStoreMock.getScratchById.mockReturnValue(null);
    registerScratchHandlers({ mainWindow: {} } as unknown as HandlerDependencies);

    await expect(getHandler(CHANNELS.SCRATCH_SWITCH)(fakeEvent, "ghost")).rejects.toThrow();

    expect(scheduleOpenWindowsSaveMock).not.toHaveBeenCalled();
  });
});

// A run opened from the fleet overview has to land on its own panel, not on
// whatever the incoming scratch view happened to focus last. The intent can
// only ride the switch: the caller's V8 context dies with it.
describe("scratch:switch carries a focus intent to the incoming view", () => {
  const setPendingFocusIntent = vi.fn();
  const switchTo = vi.fn(async () => ({ view: null, isNew: false }));

  function makeDepsWithPvm(): HandlerDependencies {
    return {
      mainWindow: {},
      projectViewManager: { setPendingFocusIntent, switchTo },
    } as unknown as HandlerDependencies;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    scratchStoreMock.getScratchById.mockReturnValue({ id: "scratch-1", path: "/tmp/scratch-1" });
    scratchStoreMock.setCurrentScratch.mockReturnValue({
      id: "scratch-1",
      path: "/tmp/scratch-1",
    });
  });

  it("records the intent against the scratch id before the view swaps", async () => {
    registerScratchHandlers(makeDepsWithPvm());
    const focusIntent = { intent: "focus-panel", panelId: "t7" } as const;

    await getHandler(CHANNELS.SCRATCH_SWITCH)(fakeEvent, "scratch-1", { focusIntent });

    expect(setPendingFocusIntent).toHaveBeenCalledWith("scratch-1", focusIntent);
    // Ordering is the whole contract: the cached-view fast path reads the
    // pending intent synchronously inside switchTo, so recording it afterwards
    // would deliver nothing.
    expect(setPendingFocusIntent.mock.invocationCallOrder[0]!).toBeLessThan(
      switchTo.mock.invocationCallOrder[0]!
    );
  });

  it("leaves no intent pending when the caller supplies none", async () => {
    registerScratchHandlers(makeDepsWithPvm());

    await getHandler(CHANNELS.SCRATCH_SWITCH)(fakeEvent, "scratch-1");

    // A stale one-shot intent would fire on somebody else's later switch.
    expect(setPendingFocusIntent).not.toHaveBeenCalled();
  });

  it("records nothing when the scratch does not exist", async () => {
    scratchStoreMock.getScratchById.mockReturnValue(null);
    registerScratchHandlers(makeDepsWithPvm());

    await expect(
      getHandler(CHANNELS.SCRATCH_SWITCH)(fakeEvent, "ghost", {
        focusIntent: { intent: "focus-panel", panelId: "t7" },
      })
    ).rejects.toThrow();

    expect(setPendingFocusIntent).not.toHaveBeenCalled();
  });
});
