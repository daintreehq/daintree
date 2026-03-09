import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const appMock = vi.hoisted(() => ({
  isPackaged: true,
  getVersion: vi.fn(() => "1.0.0"),
}));

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

const dialogMock = vi.hoisted(() => ({
  showMessageBox: vi.fn().mockResolvedValue({ response: 1 }),
}));

const windowMock = vi.hoisted(() => ({
  isDestroyed: vi.fn(() => false),
  webContents: {
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  },
}));

const autoUpdaterMock = vi.hoisted(() => ({
  autoDownload: false,
  autoInstallOnAppQuit: false,
  on: vi.fn(),
  off: vi.fn(),
  checkForUpdatesAndNotify: vi.fn(),
  checkForUpdates: vi.fn(),
}));

vi.mock("electron", () => ({
  app: appMock,
  ipcMain: ipcMainMock,
  dialog: dialogMock,
}));

vi.mock("electron-updater", () => ({
  default: { autoUpdater: autoUpdaterMock },
  autoUpdater: autoUpdaterMock,
}));

import { autoUpdaterService } from "../AutoUpdaterService.js";

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

describe("AutoUpdaterService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    appMock.isPackaged = true;
    windowMock.isDestroyed.mockReturnValue(false);
    windowMock.webContents.isDestroyed.mockReturnValue(false);
    delete process.env.PORTABLE_EXECUTABLE_FILE;
    autoUpdaterMock.checkForUpdatesAndNotify.mockResolvedValue(undefined);
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined);
    dialogMock.showMessageBox.mockResolvedValue({ response: 1 });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    autoUpdaterService.dispose();
  });

  afterEach(() => {
    autoUpdaterService.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not throw when initial update check throws synchronously", () => {
    autoUpdaterMock.checkForUpdatesAndNotify.mockImplementation(() => {
      throw new Error("sync initial failure");
    });

    expect(() => autoUpdaterService.initialize(windowMock as any)).not.toThrow();
  });

  it("does not crash on synchronous throw during periodic checks", () => {
    let callCount = 0;
    autoUpdaterMock.checkForUpdatesAndNotify.mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve(undefined);
      }
      throw new Error("sync periodic failure");
    });

    autoUpdaterService.initialize(windowMock as any);

    expect(() => vi.advanceTimersByTime(CHECK_INTERVAL_MS + 1)).not.toThrow();
  });

  it("detaches every registered listener on dispose", () => {
    autoUpdaterService.initialize(windowMock as any);
    autoUpdaterService.dispose();

    const expectedEvents = [
      "checking-for-update",
      "update-available",
      "update-not-available",
      "error",
      "download-progress",
      "update-downloaded",
    ];

    for (const event of expectedEvents) {
      expect((autoUpdaterMock.off as Mock).mock.calls.some(([name]) => name === event)).toBe(true);
    }
  });

  it("fails gracefully when listener registration throws and allows retry", () => {
    (autoUpdaterMock.on as Mock).mockImplementationOnce(() => {
      throw new Error("listener registration failed");
    });

    expect(() => autoUpdaterService.initialize(windowMock as any)).not.toThrow();

    (autoUpdaterMock.on as Mock).mockClear();
    expect(() => autoUpdaterService.initialize(windowMock as any)).not.toThrow();
    expect((autoUpdaterMock.on as Mock).mock.calls.length).toBeGreaterThan(0);
  });

  describe("checkForUpdatesManually", () => {
    let notAvailableHandler: (info: object) => void;
    let errorHandler: (err: Error) => void;
    let availableHandler: (info: { version: string }) => void;

    beforeEach(() => {
      autoUpdaterService.initialize(windowMock as any);

      notAvailableHandler = (autoUpdaterMock.on as Mock).mock.calls.find(
        (args) => args[0] === "update-not-available"
      )![1];
      errorHandler = (autoUpdaterMock.on as Mock).mock.calls.find(
        (args) => args[0] === "error"
      )![1];
      availableHandler = (autoUpdaterMock.on as Mock).mock.calls.find(
        (args) => args[0] === "update-available"
      )![1];

      autoUpdaterMock.checkForUpdates.mockClear();
      autoUpdaterMock.checkForUpdatesAndNotify.mockClear();
    });

    it("calls checkForUpdates (not checkForUpdatesAndNotify)", () => {
      autoUpdaterService.checkForUpdatesManually();

      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
      expect(autoUpdaterMock.checkForUpdatesAndNotify).not.toHaveBeenCalled();
    });

    it("does not throw when checkForUpdates throws synchronously", () => {
      autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        throw new Error("sync manual check failure");
      });

      expect(() => autoUpdaterService.checkForUpdatesManually()).not.toThrow();
    });

    it("shows up-to-date dialog on update-not-available for manual checks", async () => {
      autoUpdaterService.checkForUpdatesManually();
      notAvailableHandler({});

      await Promise.resolve();

      expect(dialogMock.showMessageBox).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          type: "info",
          title: "No Updates Available",
        })
      );
    });

    it("does not show dialog on update-not-available for automatic checks", async () => {
      // Do NOT call checkForUpdatesManually — simulate an automatic check
      notAvailableHandler({});

      await Promise.resolve();

      expect(dialogMock.showMessageBox).not.toHaveBeenCalled();
    });

    it("shows error dialog with retry on error event for manual checks", async () => {
      dialogMock.showMessageBox.mockResolvedValue({ response: 1 }); // Cancel

      autoUpdaterService.checkForUpdatesManually();
      errorHandler(new Error("network error"));

      await Promise.resolve();

      expect(dialogMock.showMessageBox).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          type: "error",
          title: "Update Failed",
          buttons: ["Retry", "Cancel"],
        })
      );
    });

    it("does not show error dialog for automatic check errors", async () => {
      // Automatic check error — no manual flag
      errorHandler(new Error("network error"));

      await Promise.resolve();

      expect(dialogMock.showMessageBox).not.toHaveBeenCalled();
    });

    it("retries when user clicks Retry in error dialog", async () => {
      dialogMock.showMessageBox.mockResolvedValue({ response: 0 }); // Retry

      autoUpdaterService.checkForUpdatesManually();
      errorHandler(new Error("transient error"));

      await Promise.resolve();

      // checkForUpdates should have been called twice: once for the initial manual check,
      // once more after clicking Retry
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2);
    });

    it("resets isManualCheck flag when update-available fires", async () => {
      autoUpdaterService.checkForUpdatesManually();
      // Simulate update-available clearing the flag
      availableHandler({ version: "2.0.0" });
      // Then a subsequent automatic not-available should NOT show dialog
      notAvailableHandler({});

      await Promise.resolve();

      expect(dialogMock.showMessageBox).not.toHaveBeenCalled();
    });
  });
});
