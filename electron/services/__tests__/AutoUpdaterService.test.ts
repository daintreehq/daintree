import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const appMock = vi.hoisted(() => ({
  isPackaged: true,
}));

const autoUpdaterMock = vi.hoisted(() => ({
  autoDownload: false,
  autoInstallOnAppQuit: false,
  on: vi.fn(),
  off: vi.fn(),
  checkForUpdatesAndNotify: vi.fn(),
}));

vi.mock("electron", () => ({
  app: appMock,
}));

vi.mock("electron-updater", () => ({
  autoUpdater: autoUpdaterMock,
}));

import { autoUpdaterService } from "../AutoUpdaterService.js";

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

describe("AutoUpdaterService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    appMock.isPackaged = true;
    delete process.env.PORTABLE_EXECUTABLE_FILE;
    autoUpdaterMock.checkForUpdatesAndNotify.mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

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

    expect(() => autoUpdaterService.initialize()).not.toThrow();
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

    autoUpdaterService.initialize();

    expect(() => vi.advanceTimersByTime(CHECK_INTERVAL_MS + 1)).not.toThrow();
  });

  it("detaches every registered listener on dispose", () => {
    autoUpdaterService.initialize();
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

    expect(() => autoUpdaterService.initialize()).not.toThrow();

    (autoUpdaterMock.on as Mock).mockClear();
    expect(() => autoUpdaterService.initialize()).not.toThrow();
    expect((autoUpdaterMock.on as Mock).mock.calls.length).toBeGreaterThan(0);
  });
});
