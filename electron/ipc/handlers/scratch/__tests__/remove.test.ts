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
  });

  it("kills the scratch's terminals before deleting it", async () => {
    const ptyClient = { killByProject: vi.fn(async () => 2) };
    registerScratchHandlers(makeDeps(ptyClient));

    await getHandler(CHANNELS.SCRATCH_REMOVE)(fakeEvent, "scratch-1");

    expect(ptyClient.killByProject).toHaveBeenCalledWith("scratch-1");
    expect(scratchStoreMock.removeScratch).toHaveBeenCalledWith("scratch-1");

    // Killing after deletion would race the folder removal against live PTYs.
    const killOrder = ptyClient.killByProject.mock.invocationCallOrder[0];
    const removeOrder = scratchStoreMock.removeScratch.mock.invocationCallOrder[0];
    expect(killOrder).toBeLessThan(removeOrder);
  });

  it("still deletes the scratch and notifies renderers when the kill fails", async () => {
    const ptyClient = {
      killByProject: vi.fn(async () => {
        throw new Error("PTY host disconnected");
      }),
    };
    registerScratchHandlers(makeDeps(ptyClient));

    await expect(
      getHandler(CHANNELS.SCRATCH_REMOVE)(fakeEvent, "scratch-2")
    ).resolves.toBeUndefined();

    expect(scratchStoreMock.removeScratch).toHaveBeenCalledWith("scratch-2");
    expect(broadcastMock.broadcastToRenderer).toHaveBeenCalledWith(
      CHANNELS.SCRATCH_REMOVED,
      "scratch-2"
    );
  });

  it("deletes the scratch when no pty client is available", async () => {
    registerScratchHandlers(makeDeps(undefined));

    await getHandler(CHANNELS.SCRATCH_REMOVE)(fakeEvent, "scratch-3");

    expect(scratchStoreMock.removeScratch).toHaveBeenCalledWith("scratch-3");
  });

  it("rejects a blank scratch id without touching the store", async () => {
    const ptyClient = { killByProject: vi.fn(async () => 0) };
    registerScratchHandlers(makeDeps(ptyClient));

    await expect(getHandler(CHANNELS.SCRATCH_REMOVE)(fakeEvent, "")).rejects.toThrow();

    expect(ptyClient.killByProject).not.toHaveBeenCalled();
    expect(scratchStoreMock.removeScratch).not.toHaveBeenCalled();
  });
});
