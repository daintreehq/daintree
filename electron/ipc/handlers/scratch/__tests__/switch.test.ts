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
  // Read just before the pointer is cleared, to record the departing project in
  // this window's history so `Cmd+Alt+=` can leave the scratch again.
  getCurrentProjectId: vi.fn<() => string | null>(() => null),
}));

vi.mock("../../../../services/ProjectStore.js", () => ({
  projectStore: projectStoreMock,
}));

const refreshProjectMenuStateMock = vi.hoisted(() => vi.fn());
vi.mock("../../../../projectMenuState.js", () => ({
  refreshProjectMenuState: refreshProjectMenuStateMock,
}));

// buildIpcContext resolves the sender's project through this registry, so the
// factory has to export it even though this suite never asserts on it.
vi.mock("../../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: vi.fn(() => null),
  getProjectForWebContents: vi.fn(() => null),
}));

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

// #11136: a scratch is not a project. Switching to one leaves the window's
// ProjectViewManager holding a scratch id that has no project row, so the
// File-menu project gates have to drop — but only a refresh makes the menu notice.
describe("scratch:switch refreshes the File-menu project gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("records the departing project so the shortcut can leave the scratch again", async () => {
    projectStoreMock.getCurrentProjectId.mockReturnValue("project-a");
    const deps = { mainWindow: { id: 77 } } as unknown as HandlerDependencies;
    // Reset rather than dispose: a disposed id stays tombstoned and refuses to
    // record, which is the guard against a closed window's late switch.
    resetProjectHistory(77);
    registerScratchHandlers(deps);

    await getHandler(CHANNELS.SCRATCH_SWITCH)(fakeEvent, "scratch-1");

    // A scratch can never be a history entry, so this is the only point that
    // can capture where the window came from. Without it, entering a scratch as
    // the first move of a session leaves `Cmd+Alt+=` with nowhere to go.
    expect(getProjectHistory(77).snapshot().entries).toEqual(["project-a"]);
    disposeProjectHistory(77);
  });

  it("does not refresh when the scratch does not exist", async () => {
    scratchStoreMock.getScratchById.mockReturnValue(null);
    registerScratchHandlers(makeDeps());

    await expect(getHandler(CHANNELS.SCRATCH_SWITCH)(fakeEvent, "ghost")).rejects.toThrow();

    expect(refreshProjectMenuStateMock).not.toHaveBeenCalled();
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
