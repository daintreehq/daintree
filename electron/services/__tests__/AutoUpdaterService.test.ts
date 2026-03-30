import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const appMock = vi.hoisted(() => ({
  isPackaged: true,
  getVersion: vi.fn(() => "1.0.0"),
}));

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

const windowMock = vi.hoisted(() => ({
  isDestroyed: vi.fn(() => false),
  webContents: {
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  },
}));

const broadcastMock = vi.hoisted(() => vi.fn());

const autoUpdaterMock = vi.hoisted(() => ({
  autoDownload: false,
  autoInstallOnAppQuit: false,
  allowDowngrade: false,
  on: vi.fn(),
  off: vi.fn(),
  checkForUpdatesAndNotify: vi.fn(),
  checkForUpdates: vi.fn(),
  quitAndInstall: vi.fn(),
  setFeedURL: vi.fn(),
}));

const storeMock = vi.hoisted(() => ({
  get: vi.fn((): string | undefined => undefined),
  set: vi.fn(),
}));

const cleanupOnExitMock = vi.hoisted(() => vi.fn());

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
}));

vi.mock("fs", () => fsMock);

vi.mock("../CrashRecoveryService.js", () => ({
  getCrashRecoveryService: () => ({ cleanupOnExit: cleanupOnExitMock }),
}));

vi.mock("electron", () => ({
  app: appMock,
  ipcMain: ipcMainMock,
  BrowserWindow: { getAllWindows: () => [windowMock] },
}));

vi.mock("../../ipc/utils.js", () => ({
  broadcastToRenderer: broadcastMock,
}));

vi.mock("electron-updater", () => ({
  default: { autoUpdater: autoUpdaterMock },
  autoUpdater: autoUpdaterMock,
}));

vi.mock("../../store.js", () => ({
  store: storeMock,
}));

import { autoUpdaterService } from "../AutoUpdaterService.js";
import { CHANNELS } from "../../ipc/channels.js";

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

describe("AutoUpdaterService", () => {
  const originalPlatform = process.platform;
  const originalResourcesPath = process.resourcesPath;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    appMock.isPackaged = true;
    windowMock.isDestroyed.mockReturnValue(false);
    windowMock.webContents.isDestroyed.mockReturnValue(false);
    delete process.env.PORTABLE_EXECUTABLE_FILE;
    delete process.env.APPIMAGE;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    Object.defineProperty(process, "resourcesPath", {
      value: "/mock/resources",
      configurable: true,
    });
    fsMock.existsSync.mockReturnValue(false);
    fsMock.readFileSync.mockReturnValue("");
    autoUpdaterMock.checkForUpdatesAndNotify.mockResolvedValue(undefined);
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    autoUpdaterService.dispose();
  });

  afterEach(() => {
    autoUpdaterService.dispose();
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    Object.defineProperty(process, "resourcesPath", {
      value: originalResourcesPath,
      configurable: true,
    });
    delete process.env.APPIMAGE;
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

  describe("checkForUpdatesManually", () => {
    let notAvailableHandler: (info: object) => void;
    let errorHandler: (err: Error) => void;
    let availableHandler: (info: { version: string }) => void;

    beforeEach(() => {
      autoUpdaterService.initialize();

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

    it("sends in-app toast on update-not-available for manual checks", () => {
      autoUpdaterService.checkForUpdatesManually();
      notAvailableHandler({});

      expect(broadcastMock).toHaveBeenCalledWith(
        CHANNELS.NOTIFICATION_SHOW_TOAST,
        expect.objectContaining({
          type: "info",
          title: "No Updates Available",
        })
      );
    });

    it("does not send toast on update-not-available for automatic checks", () => {
      notAvailableHandler({});

      expect(broadcastMock).not.toHaveBeenCalledWith(
        CHANNELS.NOTIFICATION_SHOW_TOAST,
        expect.anything()
      );
    });

    it("sends error toast with retry action on error event for manual checks", () => {
      autoUpdaterService.checkForUpdatesManually();
      errorHandler(new Error("network error"));

      expect(broadcastMock).toHaveBeenCalledWith(
        CHANNELS.NOTIFICATION_SHOW_TOAST,
        expect.objectContaining({
          type: "error",
          title: "Update Failed",
          action: expect.objectContaining({
            label: "Retry",
            ipcChannel: CHANNELS.UPDATE_CHECK_FOR_UPDATES,
          }),
        })
      );
    });

    it("does not send error toast for automatic check errors", () => {
      errorHandler(new Error("network error"));

      expect(broadcastMock).not.toHaveBeenCalledWith(
        CHANNELS.NOTIFICATION_SHOW_TOAST,
        expect.anything()
      );
    });

    it("resets isManualCheck flag when update-available fires", () => {
      autoUpdaterService.checkForUpdatesManually();
      availableHandler({ version: "2.0.0" });
      notAvailableHandler({});

      expect(broadcastMock).not.toHaveBeenCalledWith(
        CHANNELS.NOTIFICATION_SHOW_TOAST,
        expect.anything()
      );
    });
  });

  describe("quit-and-install", () => {
    let quitAndInstallHandler: () => void;
    let downloadedHandler: (info: { version: string }) => void;

    beforeEach(() => {
      autoUpdaterService.initialize();

      quitAndInstallHandler = (ipcMainMock.handle as Mock).mock.calls.find(
        (args) => args[0] === CHANNELS.UPDATE_QUIT_AND_INSTALL
      )![1];

      downloadedHandler = (autoUpdaterMock.on as Mock).mock.calls.find(
        (args) => args[0] === "update-downloaded"
      )![1];
    });

    it("calls cleanupOnExit before quitAndInstall when update is downloaded", () => {
      downloadedHandler({ version: "2.0.0" });

      quitAndInstallHandler();

      expect(cleanupOnExitMock).toHaveBeenCalledTimes(1);
      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1);
      expect(cleanupOnExitMock.mock.invocationCallOrder[0]).toBeLessThan(
        autoUpdaterMock.quitAndInstall.mock.invocationCallOrder[0]
      );
    });

    it("does not call cleanupOnExit or quitAndInstall when no update is downloaded", () => {
      quitAndInstallHandler();

      expect(cleanupOnExitMock).not.toHaveBeenCalled();
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    });

    it("still calls quitAndInstall when cleanupOnExit throws", () => {
      downloadedHandler({ version: "2.0.0" });
      cleanupOnExitMock.mockImplementationOnce(() => {
        throw new Error("cleanup failed");
      });

      quitAndInstallHandler();

      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1);
    });
  });

  describe("Linux activation guard", () => {
    it("skips initialization on Linux without APPIMAGE and without package-type marker", () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });

      autoUpdaterService.initialize();

      expect(autoUpdaterMock.on).not.toHaveBeenCalled();
      expect(autoUpdaterMock.checkForUpdatesAndNotify).not.toHaveBeenCalled();

      // Manual check should be a no-op since initialized is false
      autoUpdaterService.checkForUpdatesManually();
      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
    });

    it("initializes normally on Linux when APPIMAGE is set", () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      process.env.APPIMAGE = "/path/to/app.AppImage";

      autoUpdaterService.initialize();

      expect(autoUpdaterMock.on).toHaveBeenCalled();
      expect(autoUpdaterMock.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
    });

    it("initializes normally on Linux when package-type marker exists with content", () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue("deb");

      autoUpdaterService.initialize();

      expect(autoUpdaterMock.on).toHaveBeenCalled();
      expect(autoUpdaterMock.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
    });

    it("skips initialization on Linux when package-type file is empty", () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue("  \n  ");

      autoUpdaterService.initialize();

      expect(autoUpdaterMock.on).not.toHaveBeenCalled();
    });

    it("skips initialization on Linux when package-type read throws", () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockImplementation(() => {
        throw new Error("EACCES");
      });

      autoUpdaterService.initialize();

      expect(autoUpdaterMock.on).not.toHaveBeenCalled();
    });

    it("does not schedule periodic checks on blocked Linux init", () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });

      autoUpdaterService.initialize();
      vi.advanceTimersByTime(CHECK_INTERVAL_MS * 2);

      expect(autoUpdaterMock.checkForUpdatesAndNotify).not.toHaveBeenCalled();
    });

    it("does not register IPC handlers on blocked Linux init", () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });

      autoUpdaterService.initialize();

      expect(ipcMainMock.handle).not.toHaveBeenCalled();
    });

    it("probes the correct package-type path", () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });

      autoUpdaterService.initialize();

      expect(fsMock.existsSync).toHaveBeenCalledWith(expect.stringContaining("package-type"));
    });

    it("skips filesystem probe when APPIMAGE is set", () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      process.env.APPIMAGE = "/path/to/app.AppImage";

      autoUpdaterService.initialize();

      expect(fsMock.existsSync).not.toHaveBeenCalled();
    });

    it("does not affect non-Linux platforms", () => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });

      autoUpdaterService.initialize();

      expect(autoUpdaterMock.on).toHaveBeenCalled();
      expect(autoUpdaterMock.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
    });
  });

  describe("update channel", () => {
    it("reads channel from store and calls setFeedURL with stable URL when no stored channel", () => {
      storeMock.get.mockReturnValue(undefined);
      autoUpdaterService.initialize();

      expect(autoUpdaterMock.setFeedURL).toHaveBeenCalledWith({
        provider: "generic",
        url: "https://updates.canopyide.com/releases/",
        channel: "latest",
      });
      expect(autoUpdaterMock.allowDowngrade).toBe(true);
    });

    it("uses nightly URL when stored channel is nightly", () => {
      storeMock.get.mockReturnValue("nightly");
      autoUpdaterService.initialize();

      expect(autoUpdaterMock.setFeedURL).toHaveBeenCalledWith({
        provider: "generic",
        url: "https://updates.canopyide.com/nightly/",
        channel: "nightly",
      });
    });

    it("calls setFeedURL before initial update check", () => {
      autoUpdaterService.initialize();

      const setFeedOrder = autoUpdaterMock.setFeedURL.mock.invocationCallOrder[0];
      const checkOrder = autoUpdaterMock.checkForUpdatesAndNotify.mock.invocationCallOrder[0];
      expect(setFeedOrder).toBeLessThan(checkOrder);
    });

    it("IPC UPDATE_GET_CHANNEL returns persisted channel", () => {
      autoUpdaterService.initialize();

      const getChannelHandler = (ipcMainMock.handle as Mock).mock.calls.find(
        (args) => args[0] === CHANNELS.UPDATE_GET_CHANNEL
      )![1];

      storeMock.get.mockReturnValue("nightly");
      expect(getChannelHandler()).toBe("nightly");
    });

    it("IPC UPDATE_SET_CHANNEL persists new channel and reconfigures feed", () => {
      autoUpdaterService.initialize();
      autoUpdaterMock.setFeedURL.mockClear();

      const setChannelHandler = (ipcMainMock.handle as Mock).mock.calls.find(
        (args) => args[0] === CHANNELS.UPDATE_SET_CHANNEL
      )![1];

      const result = setChannelHandler(null, "nightly");
      expect(result).toBe("nightly");
      expect(storeMock.set).toHaveBeenCalledWith("updateChannel", "nightly");
      expect(autoUpdaterMock.setFeedURL).toHaveBeenCalledWith({
        provider: "generic",
        url: "https://updates.canopyide.com/nightly/",
        channel: "nightly",
      });
    });

    it("IPC UPDATE_SET_CHANNEL coerces unknown value to stable", () => {
      autoUpdaterService.initialize();

      const setChannelHandler = (ipcMainMock.handle as Mock).mock.calls.find(
        (args) => args[0] === CHANNELS.UPDATE_SET_CHANNEL
      )![1];

      expect(setChannelHandler(null, "bogus")).toBe("stable");
      expect(storeMock.set).toHaveBeenCalledWith("updateChannel", "stable");
    });

    it("UPDATE_SET_CHANNEL clears updateDownloaded flag", () => {
      autoUpdaterService.initialize();

      const downloadedHandler = (autoUpdaterMock.on as Mock).mock.calls.find(
        (args) => args[0] === "update-downloaded"
      )![1];
      downloadedHandler({ version: "2.0.0" });

      const setChannelHandler = (ipcMainMock.handle as Mock).mock.calls.find(
        (args) => args[0] === CHANNELS.UPDATE_SET_CHANNEL
      )![1];
      setChannelHandler(null, "nightly");

      const quitHandler = (ipcMainMock.handle as Mock).mock.calls.find(
        (args) => args[0] === CHANNELS.UPDATE_QUIT_AND_INSTALL
      )![1];
      quitHandler();

      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    });

    it("dispose removes UPDATE_GET_CHANNEL and UPDATE_SET_CHANNEL handlers", () => {
      autoUpdaterService.initialize();
      autoUpdaterService.dispose();

      expect(ipcMainMock.removeHandler).toHaveBeenCalledWith(CHANNELS.UPDATE_GET_CHANNEL);
      expect(ipcMainMock.removeHandler).toHaveBeenCalledWith(CHANNELS.UPDATE_SET_CHANNEL);
    });
  });
});
