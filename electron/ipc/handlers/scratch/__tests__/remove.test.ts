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
  getScratchById: vi.fn(),
  createScratch: vi.fn(),
  updateScratch: vi.fn(),
  removeScratch: vi.fn<(scratchId: string) => Promise<void>>(),
  setCurrentScratch: vi.fn(),
}));

vi.mock("../../../../services/ScratchStore.js", () => ({
  scratchStore: scratchStoreMock,
}));

vi.mock("../../../../services/ProjectStore.js", () => ({
  projectStore: {
    clearCurrentProject: vi.fn(),
  },
}));

const broadcastMock = vi.hoisted(() => ({ broadcastToRenderer: vi.fn() }));
vi.mock("../../../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../utils.js")>();
  return { ...actual, broadcastToRenderer: broadcastMock.broadcastToRenderer };
});

const teardownMock = vi.hoisted(() => ({
  gracefulTeardownAndJournalProject:
    vi.fn<(...args: unknown[]) => Promise<{ confirmed: boolean; terminalsKilled: number }>>(),
}));
vi.mock("../../../../services/pty/projectSessionJournal.js", () => teardownMock);

import { ipcMain } from "electron";
import { CHANNELS } from "../../../channels.js";
import { registerScratchHandlers } from "../index.js";
import type { HandlerDependencies } from "../../../types.js";

function getHandler(channel: string) {
  const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }).mock
    .calls;
  return calls.find((c) => c[0] === channel)?.[1] as (
    event: unknown,
    ...args: unknown[]
  ) => Promise<unknown>;
}

function makeDeps(ptyClient: unknown): HandlerDependencies {
  return { mainWindow: {} as unknown, ptyClient } as unknown as HandlerDependencies;
}

const fakeEvent = { senderFrame: { url: "http://localhost:5173" } };

describe("scratch:remove handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scratchStoreMock.removeScratch.mockResolvedValue(undefined);
    teardownMock.gracefulTeardownAndJournalProject.mockResolvedValue({
      confirmed: true,
      terminalsKilled: 0,
    });
  });

  it("gracefully tears down and journals the scratch's terminals before deleting it", async () => {
    const ptyClient = {};
    teardownMock.gracefulTeardownAndJournalProject.mockResolvedValue({
      confirmed: true,
      terminalsKilled: 2,
    });
    registerScratchHandlers(makeDeps(ptyClient));

    await getHandler(CHANNELS.SCRATCH_REMOVE)(fakeEvent, "scratch-1");

    // Journaling (not a bare kill) runs, and before the folder is deleted (#11340).
    expect(teardownMock.gracefulTeardownAndJournalProject).toHaveBeenCalledWith(
      "scratch-1",
      ptyClient,
      undefined
    );
    expect(scratchStoreMock.removeScratch).toHaveBeenCalledWith("scratch-1");

    const killOrder = teardownMock.gracefulTeardownAndJournalProject.mock.invocationCallOrder[0]!;
    const removeOrder = scratchStoreMock.removeScratch.mock.invocationCallOrder[0]!;
    expect(killOrder).toBeLessThan(removeOrder);
  });

  it("fails closed: keeps the scratch when the teardown is unconfirmed", async () => {
    teardownMock.gracefulTeardownAndJournalProject.mockResolvedValue({
      confirmed: false,
      terminalsKilled: 0,
    });
    registerScratchHandlers(makeDeps({}));

    await expect(getHandler(CHANNELS.SCRATCH_REMOVE)(fakeEvent, "scratch-2")).rejects.toThrow();

    // Deleting the folder now would orphan the still-running agents (#11340).
    expect(scratchStoreMock.removeScratch).not.toHaveBeenCalled();
    expect(broadcastMock.broadcastToRenderer).not.toHaveBeenCalledWith(
      CHANNELS.SCRATCH_REMOVED,
      "scratch-2"
    );
  });

  it("fails closed when the teardown throws: the old swallow-and-delete is gone", async () => {
    // Pre-fix this handler caught the kill rejection and deleted anyway.
    teardownMock.gracefulTeardownAndJournalProject.mockRejectedValue(
      new Error("PTY host disconnected")
    );
    registerScratchHandlers(makeDeps({}));

    await expect(getHandler(CHANNELS.SCRATCH_REMOVE)(fakeEvent, "scratch-throw")).rejects.toThrow();

    expect(scratchStoreMock.removeScratch).not.toHaveBeenCalled();
    expect(broadcastMock.broadcastToRenderer).not.toHaveBeenCalledWith(
      CHANNELS.SCRATCH_REMOVED,
      "scratch-throw"
    );
  });

  it("deletes the scratch when the host is confirmed gone (nothing to journal)", async () => {
    teardownMock.gracefulTeardownAndJournalProject.mockResolvedValue({
      confirmed: true,
      terminalsKilled: 0,
    });
    registerScratchHandlers(makeDeps({}));

    await getHandler(CHANNELS.SCRATCH_REMOVE)(fakeEvent, "scratch-gone");

    expect(scratchStoreMock.removeScratch).toHaveBeenCalledWith("scratch-gone");
    expect(broadcastMock.broadcastToRenderer).toHaveBeenCalledWith(
      CHANNELS.SCRATCH_REMOVED,
      "scratch-gone"
    );
  });

  it("deletes the scratch when no pty client is available", async () => {
    registerScratchHandlers(makeDeps(undefined));

    await getHandler(CHANNELS.SCRATCH_REMOVE)(fakeEvent, "scratch-3");

    expect(teardownMock.gracefulTeardownAndJournalProject).not.toHaveBeenCalled();
    expect(scratchStoreMock.removeScratch).toHaveBeenCalledWith("scratch-3");
  });

  it("rejects a blank scratch id without touching the store", async () => {
    registerScratchHandlers(makeDeps({}));

    await expect(getHandler(CHANNELS.SCRATCH_REMOVE)(fakeEvent, "")).rejects.toThrow();

    expect(teardownMock.gracefulTeardownAndJournalProject).not.toHaveBeenCalled();
    expect(scratchStoreMock.removeScratch).not.toHaveBeenCalled();
  });
});
