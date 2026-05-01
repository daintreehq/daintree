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

const downloadedUpdateHelperMock = vi.hoisted(() => ({
  clear: vi.fn().mockResolvedValue(undefined),
}));

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
  // `downloadedUpdateHelper` is `protected` on AppUpdater (lazy-init at first
  // download); the channel-switch invalidation reaches through with a
  // structural cast. Make it always-present in tests so we can assert clear()
  // is called — null path is covered explicitly.
  downloadedUpdateHelper: downloadedUpdateHelperMock as typeof downloadedUpdateHelperMock | null,
}));

const TRUSTED_SENDER = { senderFrame: { url: "app://daintree/index.html" } };

const trustedRendererMock = vi.hoisted(() => ({
  isTrustedRendererUrl: vi.fn((url: string) => url.startsWith("app://daintree")),
  isRecoveryPageUrl: vi.fn(() => false),
  getTrustedOrigins: vi.fn(() => ["app://daintree"]),
}));

const storeMock = vi.hoisted(() => ({
  get: vi.fn((_key: string): unknown => undefined),
  set: vi.fn(),
  delete: vi.fn(),
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

vi.mock("../../../shared/utils/trustedRenderer.js", () => trustedRendererMock);

import { autoUpdaterService } from "../AutoUpdaterService.js";
import { CHANNELS } from "../../ipc/channels.js";

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const STARTUP_JITTER_MAX_MS = 60_000;

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
    autoUpdaterMock.downloadedUpdateHelper = downloadedUpdateHelperMock;
    downloadedUpdateHelperMock.clear.mockReset().mockResolvedValue(undefined);
    // Reset implementations between tests — `vi.clearAllMocks()` only resets
    // call history, so a `mockReturnValue("nightly")` set in an earlier test
    // would otherwise leak into here and trip the same-channel guard.
    storeMock.get.mockReset().mockImplementation((_key: string) => undefined);
    storeMock.set.mockReset();
    storeMock.delete.mockReset();
    trustedRendererMock.isTrustedRendererUrl.mockReset();
    trustedRendererMock.isTrustedRendererUrl.mockImplementation((url: string) =>
      url.startsWith("app://daintree")
    );
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
    // Initial check is now deferred behind startup jitter — verify the throw
    // inside the timer callback is also caught.
    expect(() => vi.advanceTimersByTime(STARTUP_JITTER_MAX_MS)).not.toThrow();
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
          title: "No updates available",
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
          title: "Update failed",
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
      vi.advanceTimersByTime(STARTUP_JITTER_MAX_MS);

      expect(autoUpdaterMock.on).toHaveBeenCalled();
      expect(autoUpdaterMock.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
    });

    it("initializes normally on Linux when package-type marker exists with content", () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue("deb");

      autoUpdaterService.initialize();
      vi.advanceTimersByTime(STARTUP_JITTER_MAX_MS);

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

    it("registers only channel-preference IPC handlers on blocked Linux init", () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });

      autoUpdaterService.initialize();

      const registeredChannels = (ipcMainMock.handle as Mock).mock.calls.map((args) => args[0]);
      expect(registeredChannels).toContain(CHANNELS.UPDATE_GET_CHANNEL);
      expect(registeredChannels).toContain(CHANNELS.UPDATE_SET_CHANNEL);
      expect(registeredChannels).not.toContain(CHANNELS.UPDATE_QUIT_AND_INSTALL);
      expect(registeredChannels).not.toContain(CHANNELS.UPDATE_CHECK_FOR_UPDATES);
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
      vi.advanceTimersByTime(STARTUP_JITTER_MAX_MS);

      expect(autoUpdaterMock.on).toHaveBeenCalled();
      expect(autoUpdaterMock.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
    });
  });

  describe("dev mode (app.isPackaged = false)", () => {
    beforeEach(() => {
      appMock.isPackaged = false;
    });

    it("registers GET and SET channel handlers", () => {
      autoUpdaterService.initialize();

      const registeredChannels = (ipcMainMock.handle as Mock).mock.calls.map((args) => args[0]);
      expect(registeredChannels).toContain(CHANNELS.UPDATE_GET_CHANNEL);
      expect(registeredChannels).toContain(CHANNELS.UPDATE_SET_CHANNEL);
    });

    it("does not register updater-action handlers or attach event listeners", () => {
      autoUpdaterService.initialize();

      const registeredChannels = (ipcMainMock.handle as Mock).mock.calls.map((args) => args[0]);
      expect(registeredChannels).not.toContain(CHANNELS.UPDATE_QUIT_AND_INSTALL);
      expect(registeredChannels).not.toContain(CHANNELS.UPDATE_CHECK_FOR_UPDATES);
      expect(autoUpdaterMock.on).not.toHaveBeenCalled();
      expect(autoUpdaterMock.checkForUpdatesAndNotify).not.toHaveBeenCalled();
    });

    it("SET_CHANNEL persists to store but skips setFeedURL", async () => {
      autoUpdaterService.initialize();

      const setChannelHandler = (ipcMainMock.handle as Mock).mock.calls.find(
        (args) => args[0] === CHANNELS.UPDATE_SET_CHANNEL
      )![1];

      const result = await setChannelHandler(null, "nightly");
      expect(result).toBe("nightly");
      expect(storeMock.set).toHaveBeenCalledWith("updateChannel", "nightly");
      expect(autoUpdaterMock.setFeedURL).not.toHaveBeenCalled();
    });

    it("does not double-register handlers on repeated initialize() calls", () => {
      autoUpdaterService.initialize();
      autoUpdaterService.initialize();

      const getChannelCalls = (ipcMainMock.handle as Mock).mock.calls.filter(
        (args) => args[0] === CHANNELS.UPDATE_GET_CHANNEL
      );
      expect(getChannelCalls).toHaveLength(1);
    });
  });

  describe("Windows portable guard", () => {
    it("registers only channel-preference IPC handlers on Windows portable", () => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      process.env.PORTABLE_EXECUTABLE_FILE = "C:\\portable\\daintree.exe";

      autoUpdaterService.initialize();

      const registeredChannels = (ipcMainMock.handle as Mock).mock.calls.map((args) => args[0]);
      expect(registeredChannels).toContain(CHANNELS.UPDATE_GET_CHANNEL);
      expect(registeredChannels).toContain(CHANNELS.UPDATE_SET_CHANNEL);
      expect(registeredChannels).not.toContain(CHANNELS.UPDATE_QUIT_AND_INSTALL);
      expect(registeredChannels).not.toContain(CHANNELS.UPDATE_CHECK_FOR_UPDATES);
    });
  });

  describe("update channel", () => {
    it("reads channel from store and calls setFeedURL with stable URL when no stored channel", () => {
      storeMock.get.mockReturnValue(undefined);
      autoUpdaterService.initialize();

      // No `channel` field: stable and nightly both serve latest.yml under
      // their respective URL prefixes (URL separation, not channel separation).
      expect(autoUpdaterMock.setFeedURL).toHaveBeenCalledWith({
        provider: "generic",
        url: "https://updates.daintree.org/releases/",
      });
      // Stable channel must never silently downgrade — a regressed latest.yml
      // would otherwise walk installed users backwards.
      expect(autoUpdaterMock.allowDowngrade).toBe(false);
    });

    it("uses nightly URL and enables allowDowngrade when stored channel is nightly", () => {
      storeMock.get.mockReturnValue("nightly");
      autoUpdaterService.initialize();

      expect(autoUpdaterMock.setFeedURL).toHaveBeenCalledWith({
        provider: "generic",
        url: "https://updates.daintree.org/nightly/",
      });
      // Nightly permits downgrade so a stable user opting in can receive
      // semver-lower nightly builds of the same base version.
      expect(autoUpdaterMock.allowDowngrade).toBe(true);
    });

    it("calls setFeedURL before initial update check", () => {
      autoUpdaterService.initialize();
      vi.advanceTimersByTime(STARTUP_JITTER_MAX_MS);

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

    it("IPC UPDATE_SET_CHANNEL persists new channel and reconfigures feed", async () => {
      autoUpdaterService.initialize();
      autoUpdaterMock.setFeedURL.mockClear();

      const setChannelHandler = (ipcMainMock.handle as Mock).mock.calls.find(
        (args) => args[0] === CHANNELS.UPDATE_SET_CHANNEL
      )![1];

      const result = await setChannelHandler(null, "nightly");
      expect(result).toBe("nightly");
      expect(storeMock.set).toHaveBeenCalledWith("updateChannel", "nightly");
      expect(autoUpdaterMock.setFeedURL).toHaveBeenCalledWith({
        provider: "generic",
        url: "https://updates.daintree.org/nightly/",
      });
    });

    it("IPC UPDATE_SET_CHANNEL coerces unknown value to stable", async () => {
      autoUpdaterService.initialize();

      const setChannelHandler = (ipcMainMock.handle as Mock).mock.calls.find(
        (args) => args[0] === CHANNELS.UPDATE_SET_CHANNEL
      )![1];

      expect(await setChannelHandler(null, "bogus")).toBe("stable");
      expect(storeMock.set).toHaveBeenCalledWith("updateChannel", "stable");
    });

    it("UPDATE_SET_CHANNEL clears updateDownloaded flag", async () => {
      autoUpdaterService.initialize();

      const downloadedHandler = (autoUpdaterMock.on as Mock).mock.calls.find(
        (args) => args[0] === "update-downloaded"
      )![1];
      downloadedHandler({ version: "2.0.0" });

      const setChannelHandler = (ipcMainMock.handle as Mock).mock.calls.find(
        (args) => args[0] === CHANNELS.UPDATE_SET_CHANNEL
      )![1];
      await setChannelHandler(null, "nightly");

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

  describe("update-available dedup and dismiss cooldown", () => {
    let availableHandler: (info: { version: string }) => void;
    let downloadedHandler: (info: { version: string }) => void;
    let dismissHandler: (event: unknown, version: unknown) => void;

    const storeState: Record<string, unknown> = {};

    function primeStore(values: Record<string, unknown>): void {
      for (const key of Object.keys(storeState)) delete storeState[key];
      Object.assign(storeState, values);
    }

    beforeEach(() => {
      primeStore({});
      storeMock.get.mockImplementation((key: string) => storeState[key]);
      storeMock.set.mockImplementation((key: string, value: unknown) => {
        storeState[key] = value;
      });
      storeMock.delete.mockImplementation((key: string) => {
        delete storeState[key];
      });

      autoUpdaterService.initialize();

      availableHandler = (autoUpdaterMock.on as Mock).mock.calls.find(
        (args) => args[0] === "update-available"
      )![1];
      downloadedHandler = (autoUpdaterMock.on as Mock).mock.calls.find(
        (args) => args[0] === "update-downloaded"
      )![1];
      dismissHandler = (ipcMainMock.handle as Mock).mock.calls.find(
        (args) => args[0] === CHANNELS.UPDATE_DISMISS_TOAST
      )![1];

      broadcastMock.mockClear();
    });

    it("suppresses repeat periodic broadcasts for the same version in a session", () => {
      availableHandler({ version: "1.1.0" });
      availableHandler({ version: "1.1.0" });

      const availableCalls = broadcastMock.mock.calls.filter(
        ([channel]) => channel === CHANNELS.UPDATE_AVAILABLE
      );
      expect(availableCalls).toHaveLength(1);
      expect(availableCalls[0][1]).toEqual({ version: "1.1.0" });
    });

    it("broadcasts a newer version after having broadcast an older one", () => {
      availableHandler({ version: "1.1.0" });
      broadcastMock.mockClear();

      availableHandler({ version: "1.2.0" });

      expect(broadcastMock).toHaveBeenCalledWith(CHANNELS.UPDATE_AVAILABLE, { version: "1.2.0" });
    });

    it("manual check always broadcasts, even for the same version", () => {
      availableHandler({ version: "1.1.0" });
      broadcastMock.mockClear();

      autoUpdaterService.checkForUpdatesManually();
      availableHandler({ version: "1.1.0" });

      expect(broadcastMock).toHaveBeenCalledWith(CHANNELS.UPDATE_AVAILABLE, { version: "1.1.0" });
    });

    it("suppresses broadcast when a persisted dismissal of the same version is within 24h", () => {
      primeStore({
        dismissedUpdateVersion: "1.1.0",
        dismissedUpdateAt: Date.now() - 60 * 60 * 1000, // 1 hour ago
      });

      availableHandler({ version: "1.1.0" });

      const availableCalls = broadcastMock.mock.calls.filter(
        ([channel]) => channel === CHANNELS.UPDATE_AVAILABLE
      );
      expect(availableCalls).toHaveLength(0);
    });

    it("broadcasts when the persisted dismissal has expired beyond 24h", () => {
      primeStore({
        dismissedUpdateVersion: "1.1.0",
        dismissedUpdateAt: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
      });

      availableHandler({ version: "1.1.0" });

      expect(broadcastMock).toHaveBeenCalledWith(CHANNELS.UPDATE_AVAILABLE, { version: "1.1.0" });
      // Stale record was cleared on expiry.
      expect(storeState.dismissedUpdateVersion).toBeUndefined();
      expect(storeState.dismissedUpdateAt).toBeUndefined();
    });

    it("bypasses the cooldown for a newer semver version", () => {
      primeStore({
        dismissedUpdateVersion: "1.1.0",
        dismissedUpdateAt: Date.now() - 60 * 60 * 1000, // 1 hour ago
      });

      availableHandler({ version: "1.2.0" });

      expect(broadcastMock).toHaveBeenCalledWith(CHANNELS.UPDATE_AVAILABLE, { version: "1.2.0" });
    });

    it("still broadcasts UPDATE_DOWNLOADED even while the Available-stage cooldown is active", () => {
      primeStore({
        dismissedUpdateVersion: "1.1.0",
        dismissedUpdateAt: Date.now() - 60 * 60 * 1000,
      });

      availableHandler({ version: "1.1.0" });
      const availableCalls = broadcastMock.mock.calls.filter(
        ([channel]) => channel === CHANNELS.UPDATE_AVAILABLE
      );
      expect(availableCalls).toHaveLength(0);

      downloadedHandler({ version: "1.1.0" });

      expect(broadcastMock).toHaveBeenCalledWith(CHANNELS.UPDATE_DOWNLOADED, { version: "1.1.0" });
    });

    it("UPDATE_DISMISS_TOAST handler persists version and timestamp", () => {
      const before = Date.now();
      dismissHandler(TRUSTED_SENDER, "1.1.0");
      const after = Date.now();

      expect(storeState.dismissedUpdateVersion).toBe("1.1.0");
      expect(typeof storeState.dismissedUpdateAt).toBe("number");
      expect(storeState.dismissedUpdateAt).toBeGreaterThanOrEqual(before);
      expect(storeState.dismissedUpdateAt).toBeLessThanOrEqual(after);
    });

    it("UPDATE_DISMISS_TOAST ignores empty, whitespace, or non-string versions", () => {
      dismissHandler(TRUSTED_SENDER, "");
      dismissHandler(TRUSTED_SENDER, "   ");
      dismissHandler(TRUSTED_SENDER, 42);
      dismissHandler(TRUSTED_SENDER, null);

      expect(storeState.dismissedUpdateVersion).toBeUndefined();
      expect(storeState.dismissedUpdateAt).toBeUndefined();
    });

    it("dispose resets the session dedup so the next session rebroadcasts the same version", () => {
      availableHandler({ version: "1.1.0" });
      broadcastMock.mockClear();

      autoUpdaterService.dispose();
      primeStore({}); // no persisted dismissal carries across
      autoUpdaterService.initialize();

      const nextAvailableHandler = (autoUpdaterMock.on as Mock).mock.calls
        .filter((args) => args[0] === "update-available")
        .at(-1)![1];
      nextAvailableHandler({ version: "1.1.0" });

      const availableCalls = broadcastMock.mock.calls.filter(
        ([channel]) => channel === CHANNELS.UPDATE_AVAILABLE
      );
      expect(availableCalls).toHaveLength(1);
      expect(availableCalls[0][1]).toEqual({ version: "1.1.0" });
    });

    it("broadcasts at exactly 24h boundary (cooldown window is >=, not >)", () => {
      primeStore({
        dismissedUpdateVersion: "1.1.0",
        dismissedUpdateAt: Date.now() - 24 * 60 * 60 * 1000,
      });

      availableHandler({ version: "1.1.0" });

      expect(broadcastMock).toHaveBeenCalledWith(CHANNELS.UPDATE_AVAILABLE, { version: "1.1.0" });
    });

    it("treats corrupt dismissedUpdateAt (NaN) as missing and clears the record", () => {
      primeStore({
        dismissedUpdateVersion: "1.1.0",
        dismissedUpdateAt: Number.NaN,
      });

      availableHandler({ version: "1.1.0" });

      expect(broadcastMock).toHaveBeenCalledWith(CHANNELS.UPDATE_AVAILABLE, { version: "1.1.0" });
      expect(storeState.dismissedUpdateVersion).toBeUndefined();
      expect(storeState.dismissedUpdateAt).toBeUndefined();
    });

    it("treats a future-dated dismissedUpdateAt (clock skew) as expired and rebroadcasts", () => {
      primeStore({
        dismissedUpdateVersion: "1.1.0",
        dismissedUpdateAt: Date.now() + 60 * 60 * 1000, // 1h in the future
      });

      availableHandler({ version: "1.1.0" });

      expect(broadcastMock).toHaveBeenCalledWith(CHANNELS.UPDATE_AVAILABLE, { version: "1.1.0" });
      expect(storeState.dismissedUpdateVersion).toBeUndefined();
      expect(storeState.dismissedUpdateAt).toBeUndefined();
    });

    it("dispose removes the UPDATE_DISMISS_TOAST handler", () => {
      autoUpdaterService.dispose();

      expect(ipcMainMock.removeHandler).toHaveBeenCalledWith(CHANNELS.UPDATE_DISMISS_TOAST);
    });
  });

  describe("UPDATE_DISMISS_TOAST hardening", () => {
    let dismissHandler: (event: unknown, version: unknown) => void;
    const storeState: Record<string, unknown> = {};

    function primeStore(values: Record<string, unknown>): void {
      for (const key of Object.keys(storeState)) delete storeState[key];
      Object.assign(storeState, values);
    }

    beforeEach(() => {
      primeStore({});
      storeMock.get.mockImplementation((key: string) => storeState[key]);
      storeMock.set.mockImplementation((key: string, value: unknown) => {
        storeState[key] = value;
      });

      autoUpdaterService.initialize();

      dismissHandler = (ipcMainMock.handle as Mock).mock.calls.find(
        (args) => args[0] === CHANNELS.UPDATE_DISMISS_TOAST
      )![1];
    });

    it("drops the call when senderFrame is missing", () => {
      dismissHandler({}, "1.1.0");

      expect(storeState.dismissedUpdateVersion).toBeUndefined();
      expect(storeState.dismissedUpdateAt).toBeUndefined();
    });

    it("drops the call when senderFrame.url is undefined", () => {
      dismissHandler({ senderFrame: {} }, "1.1.0");

      expect(storeState.dismissedUpdateVersion).toBeUndefined();
    });

    it("drops the call from an untrusted origin", () => {
      dismissHandler({ senderFrame: { url: "https://evil.example.com/x.html" } }, "1.1.0");

      expect(storeState.dismissedUpdateVersion).toBeUndefined();
      expect(trustedRendererMock.isTrustedRendererUrl).toHaveBeenCalledWith(
        "https://evil.example.com/x.html"
      );
    });

    it("rejects versions longer than 64 chars", () => {
      const long = `1.${"9".repeat(70)}.0`;
      dismissHandler(TRUSTED_SENDER, long);

      expect(storeState.dismissedUpdateVersion).toBeUndefined();
    });

    it("rejects versions with characters outside the SemVer allowlist", () => {
      // Semver allowlist is [0-9a-zA-Z._+-]; spaces, slashes, semicolons, etc.
      // would slip past `semver.coerce` and corrupt the persisted record.
      dismissHandler(TRUSTED_SENDER, "1.1.0; rm -rf /");
      dismissHandler(TRUSTED_SENDER, "1.1.0/../../etc");
      dismissHandler(TRUSTED_SENDER, "1.1.0 1.2.0");

      expect(storeState.dismissedUpdateVersion).toBeUndefined();
    });

    it("rejects strings that pass the allowlist but are not valid semver", () => {
      // `semver.coerce` would accept these and pull out a version; `semver.valid`
      // is the strict gate the issue requires.
      dismissHandler(TRUSTED_SENDER, "1");
      dismissHandler(TRUSTED_SENDER, "1.2");
      dismissHandler(TRUSTED_SENDER, "v1.2.3");
      dismissHandler(TRUSTED_SENDER, "01.2.3");
      dismissHandler(TRUSTED_SENDER, "abc");

      expect(storeState.dismissedUpdateVersion).toBeUndefined();
    });

    it("accepts a strict semver from a trusted sender", () => {
      dismissHandler(TRUSTED_SENDER, "1.2.3");

      expect(storeState.dismissedUpdateVersion).toBe("1.2.3");
      expect(typeof storeState.dismissedUpdateAt).toBe("number");
    });

    it("accepts a nightly pre-release semver", () => {
      dismissHandler(TRUSTED_SENDER, "0.9.0-nightly.20251231");

      expect(storeState.dismissedUpdateVersion).toBe("0.9.0-nightly.20251231");
    });

    it("stores the trimmed value, not the raw input", () => {
      dismissHandler(TRUSTED_SENDER, "  1.2.3  ");

      expect(storeState.dismissedUpdateVersion).toBe("1.2.3");
    });

    it("validates sender BEFORE inspecting payload (no version-shape leak)", () => {
      // If senderFrame validation runs after typeof checks, an attacker could
      // probe the validation order via type errors. Ensure the untrusted-sender
      // drop is the first gate.
      const untrusted = { senderFrame: { url: "https://evil.example.com/x.html" } };
      dismissHandler(untrusted, { malicious: true });

      expect(storeState.dismissedUpdateVersion).toBeUndefined();
    });
  });

  describe("startup jitter", () => {
    it("does not invoke checkForUpdatesAndNotify synchronously during initialize()", () => {
      autoUpdaterService.initialize();

      expect(autoUpdaterMock.checkForUpdatesAndNotify).not.toHaveBeenCalled();
    });

    it("invokes the initial check after the jitter window elapses", () => {
      autoUpdaterService.initialize();
      vi.advanceTimersByTime(STARTUP_JITTER_MAX_MS);

      expect(autoUpdaterMock.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
    });

    it("never schedules the initial check beyond the 60s ceiling", () => {
      vi.spyOn(Math, "random").mockReturnValueOnce(0.999_999);
      autoUpdaterService.initialize();
      vi.advanceTimersByTime(STARTUP_JITTER_MAX_MS);

      expect(autoUpdaterMock.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
    });

    it("dispose() cancels a pending startup jitter so no check fires", () => {
      autoUpdaterService.initialize();
      autoUpdaterService.dispose();

      vi.advanceTimersByTime(STARTUP_JITTER_MAX_MS * 2);

      expect(autoUpdaterMock.checkForUpdatesAndNotify).not.toHaveBeenCalled();
    });

    it("does not block the periodic check from firing later", () => {
      autoUpdaterService.initialize();
      // Advance past startup jitter and one full periodic interval.
      vi.advanceTimersByTime(STARTUP_JITTER_MAX_MS + CHECK_INTERVAL_MS);

      // Initial + first periodic = 2 calls. (Jitter also runs the initial.)
      expect(autoUpdaterMock.checkForUpdatesAndNotify.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("retry backoff", () => {
    let errorHandler: (err: unknown) => void;
    let availableHandler: (info: { version: string }) => void;
    let notAvailableHandler: (info: object) => void;
    let downloadedHandler: (info: { version: string }) => void;

    beforeEach(() => {
      autoUpdaterService.initialize();
      vi.advanceTimersByTime(STARTUP_JITTER_MAX_MS);

      errorHandler = (autoUpdaterMock.on as Mock).mock.calls.find(
        (args) => args[0] === "error"
      )![1];
      availableHandler = (autoUpdaterMock.on as Mock).mock.calls.find(
        (args) => args[0] === "update-available"
      )![1];
      notAvailableHandler = (autoUpdaterMock.on as Mock).mock.calls.find(
        (args) => args[0] === "update-not-available"
      )![1];
      downloadedHandler = (autoUpdaterMock.on as Mock).mock.calls.find(
        (args) => args[0] === "update-downloaded"
      )![1];

      autoUpdaterMock.checkForUpdatesAndNotify.mockClear();
    });

    it("schedules a retry after a transient ECONNRESET error", () => {
      errorHandler(Object.assign(new Error("conn reset"), { code: "ECONNRESET" }));

      // First retry base is 30s with ±20% jitter — anywhere in [24s, 36s].
      // Advance well past the ceiling to guarantee the timer fires.
      vi.advanceTimersByTime(36_000);

      expect(autoUpdaterMock.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
    });

    it("retries on ETIMEDOUT and ENOTFOUND", () => {
      errorHandler(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
      vi.advanceTimersByTime(36_000);
      expect(autoUpdaterMock.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);

      autoUpdaterMock.checkForUpdatesAndNotify.mockClear();
      // After the retry fires, the next error is at retryCount=1; second retry
      // base is 120s with ±20% — fires by 144s.
      errorHandler(Object.assign(new Error("dns"), { code: "ENOTFOUND" }));
      vi.advanceTimersByTime(144_000);
      expect(autoUpdaterMock.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
    });

    it("retries on HTTP 5xx (statusCode = 503)", () => {
      errorHandler(Object.assign(new Error("service unavailable"), { statusCode: 503 }));
      vi.advanceTimersByTime(36_000);

      expect(autoUpdaterMock.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
    });

    it("does not retry on HTTP 404 (missing latest.yml)", () => {
      errorHandler(Object.assign(new Error("not found"), { statusCode: 404 }));
      vi.advanceTimersByTime(CHECK_INTERVAL_MS);

      // Only the periodic interval tick should have fired.
      expect(autoUpdaterMock.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
    });

    it("does not retry on cert errors", () => {
      errorHandler(Object.assign(new Error("expired"), { code: "CERT_HAS_EXPIRED" }));
      vi.advanceTimersByTime(60_000);

      expect(autoUpdaterMock.checkForUpdatesAndNotify).not.toHaveBeenCalled();
    });

    it("does not retry an uncategorized error (fail closed)", () => {
      errorHandler(new Error("mystery"));
      vi.advanceTimersByTime(60_000);

      expect(autoUpdaterMock.checkForUpdatesAndNotify).not.toHaveBeenCalled();
    });

    it("does not retry a manual check error (user holds the retry button)", () => {
      autoUpdaterService.checkForUpdatesManually();
      autoUpdaterMock.checkForUpdatesAndNotify.mockClear();

      errorHandler(Object.assign(new Error("conn reset"), { code: "ECONNRESET" }));
      vi.advanceTimersByTime(60_000);

      expect(autoUpdaterMock.checkForUpdatesAndNotify).not.toHaveBeenCalled();
    });

    it("caps retries at 3 attempts", () => {
      // First three transient errors should each schedule a retry.
      errorHandler(Object.assign(new Error("a"), { code: "ECONNRESET" }));
      vi.advanceTimersByTime(36_000); // ≥ 30s * 1.2
      errorHandler(Object.assign(new Error("b"), { code: "ECONNRESET" }));
      vi.advanceTimersByTime(144_000); // ≥ 120s * 1.2
      errorHandler(Object.assign(new Error("c"), { code: "ECONNRESET" }));
      vi.advanceTimersByTime(576_000); // ≥ 480s * 1.2

      expect(autoUpdaterMock.checkForUpdatesAndNotify).toHaveBeenCalledTimes(3);
      autoUpdaterMock.checkForUpdatesAndNotify.mockClear();

      // Fourth error: cap reached, no retry.
      errorHandler(Object.assign(new Error("d"), { code: "ECONNRESET" }));
      vi.advanceTimersByTime(CHECK_INTERVAL_MS);

      // Only the periodic interval tick.
      expect(autoUpdaterMock.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
    });

    it("update-available resets retry count so a future failure starts fresh", () => {
      errorHandler(Object.assign(new Error("a"), { code: "ECONNRESET" }));
      vi.advanceTimersByTime(36_000);
      errorHandler(Object.assign(new Error("b"), { code: "ECONNRESET" }));
      vi.advanceTimersByTime(144_000);

      availableHandler({ version: "2.0.0" });
      autoUpdaterMock.checkForUpdatesAndNotify.mockClear();

      // Next transient error should retry at base 30s, not at the 8m ceiling.
      errorHandler(Object.assign(new Error("c"), { code: "ECONNRESET" }));
      vi.advanceTimersByTime(36_000);

      expect(autoUpdaterMock.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
    });

    it("update-not-available resets retry count", () => {
      errorHandler(Object.assign(new Error("a"), { code: "ECONNRESET" }));
      vi.advanceTimersByTime(36_000);

      notAvailableHandler({});
      autoUpdaterMock.checkForUpdatesAndNotify.mockClear();

      errorHandler(Object.assign(new Error("b"), { code: "ECONNRESET" }));
      vi.advanceTimersByTime(36_000);

      expect(autoUpdaterMock.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
    });

    it("update-downloaded resets retry count", () => {
      errorHandler(Object.assign(new Error("a"), { code: "ECONNRESET" }));
      vi.advanceTimersByTime(36_000);

      downloadedHandler({ version: "2.0.0" });
      autoUpdaterMock.checkForUpdatesAndNotify.mockClear();

      errorHandler(Object.assign(new Error("b"), { code: "ECONNRESET" }));
      vi.advanceTimersByTime(36_000);

      expect(autoUpdaterMock.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
    });

    it("dispose() cancels a pending retry timer", () => {
      errorHandler(Object.assign(new Error("a"), { code: "ECONNRESET" }));
      autoUpdaterService.dispose();

      vi.advanceTimersByTime(60_000);

      expect(autoUpdaterMock.checkForUpdatesAndNotify).not.toHaveBeenCalled();
    });

    it("retry uses ±20% jitter (lower bound)", () => {
      vi.spyOn(Math, "random").mockReturnValueOnce(0); // jitterFactor = 0.8
      errorHandler(Object.assign(new Error("a"), { code: "ECONNRESET" }));

      // 30000 * 0.8 = 24000ms exactly.
      vi.advanceTimersByTime(23_999);
      expect(autoUpdaterMock.checkForUpdatesAndNotify).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(autoUpdaterMock.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
    });

    it("retry uses ±20% jitter (upper bound)", () => {
      vi.spyOn(Math, "random").mockReturnValueOnce(0.999_999_999); // jitterFactor ≈ 1.2
      errorHandler(Object.assign(new Error("a"), { code: "ECONNRESET" }));

      // 30000 * 1.2 = 36000ms (Math.floor lowers it to 35999).
      vi.advanceTimersByTime(35_998);
      expect(autoUpdaterMock.checkForUpdatesAndNotify).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2);
      expect(autoUpdaterMock.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
    });
  });

  describe("channel-switch invalidation", () => {
    let setChannelHandler: (event: unknown, channel: unknown) => Promise<unknown>;
    let downloadedHandler: (info: { version: string }) => void;
    let availableHandler: (info: { version: string }) => void;

    beforeEach(() => {
      autoUpdaterService.initialize();
      vi.advanceTimersByTime(STARTUP_JITTER_MAX_MS);

      setChannelHandler = (ipcMainMock.handle as Mock).mock.calls.find(
        (args) => args[0] === CHANNELS.UPDATE_SET_CHANNEL
      )![1];
      downloadedHandler = (autoUpdaterMock.on as Mock).mock.calls.find(
        (args) => args[0] === "update-downloaded"
      )![1];
      availableHandler = (autoUpdaterMock.on as Mock).mock.calls.find(
        (args) => args[0] === "update-available"
      )![1];
    });

    it("clears the staged installer cache when channel changes", async () => {
      downloadedHandler({ version: "2.0.0" });

      await setChannelHandler(null, "nightly");

      expect(downloadedUpdateHelperMock.clear).toHaveBeenCalledTimes(1);
    });

    it("resets lastBroadcastVersion so a same-version update broadcasts after switch", async () => {
      availableHandler({ version: "2.0.0" });
      broadcastMock.mockClear();

      await setChannelHandler(null, "nightly");
      availableHandler({ version: "2.0.0" });

      // Without the lastBroadcastVersion reset the second `update-available`
      // would be silently swallowed by the in-session dedup.
      expect(broadcastMock).toHaveBeenCalledWith(CHANNELS.UPDATE_AVAILABLE, { version: "2.0.0" });
    });

    it("resets the updateDownloaded flag so quit-and-install no-ops after switch", async () => {
      downloadedHandler({ version: "2.0.0" });

      await setChannelHandler(null, "nightly");

      const quitHandler = (ipcMainMock.handle as Mock).mock.calls.find(
        (args) => args[0] === CHANNELS.UPDATE_QUIT_AND_INSTALL
      )![1];
      quitHandler();

      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    });

    it("cancels any in-flight retry timer on channel switch", async () => {
      const errorHandler = (autoUpdaterMock.on as Mock).mock.calls.find(
        (args) => args[0] === "error"
      )![1];
      errorHandler(Object.assign(new Error("a"), { code: "ECONNRESET" }));
      autoUpdaterMock.checkForUpdatesAndNotify.mockClear();

      await setChannelHandler(null, "nightly");
      vi.advanceTimersByTime(60_000);

      expect(autoUpdaterMock.checkForUpdatesAndNotify).not.toHaveBeenCalled();
    });

    it("is a no-op (and does not throw) when downloadedUpdateHelper is null", async () => {
      autoUpdaterMock.downloadedUpdateHelper = null;

      await expect(setChannelHandler(null, "nightly")).resolves.toBe("nightly");
      expect(downloadedUpdateHelperMock.clear).not.toHaveBeenCalled();
    });

    it("still resets in-memory state when clear() rejects", async () => {
      downloadedHandler({ version: "2.0.0" });
      downloadedUpdateHelperMock.clear.mockRejectedValueOnce(new Error("EACCES"));

      await expect(setChannelHandler(null, "nightly")).resolves.toBe("nightly");

      const quitHandler = (ipcMainMock.handle as Mock).mock.calls.find(
        (args) => args[0] === CHANNELS.UPDATE_QUIT_AND_INSTALL
      )![1];
      quitHandler();

      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    });

    it("still invalidates state when configureFeedForChannel throws", async () => {
      // Regression: if setFeedURL throws after the user changes channel, the
      // staged installer for the old channel must still be discarded —
      // otherwise quit-and-install would run the wrong channel's payload.
      downloadedHandler({ version: "2.0.0" });
      autoUpdaterMock.setFeedURL.mockImplementationOnce(() => {
        throw new Error("setFeedURL boom");
      });

      // The handler is allowed to throw or resolve; what matters is that the
      // state cleanup ran first.
      await setChannelHandler(null, "nightly").catch(() => {});

      expect(downloadedUpdateHelperMock.clear).toHaveBeenCalledTimes(1);

      const quitHandler = (ipcMainMock.handle as Mock).mock.calls.find(
        (args) => args[0] === CHANNELS.UPDATE_QUIT_AND_INSTALL
      )![1];
      quitHandler();

      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    });

    it("is a no-op when the channel is unchanged (preserves staged installer)", async () => {
      // Default channel after init is "stable". Re-saving "stable" should not
      // discard a validly-staged installer.
      downloadedHandler({ version: "2.0.0" });
      downloadedUpdateHelperMock.clear.mockClear();
      autoUpdaterMock.setFeedURL.mockClear();

      // Make the store reflect the current "stable" preference so the guard
      // sees previousChannel === validated.
      storeMock.get.mockImplementation((key: string) =>
        key === "updateChannel" ? "stable" : undefined
      );

      const result = await setChannelHandler(null, "stable");
      expect(result).toBe("stable");
      expect(downloadedUpdateHelperMock.clear).not.toHaveBeenCalled();
      expect(autoUpdaterMock.setFeedURL).not.toHaveBeenCalled();

      const quitHandler = (ipcMainMock.handle as Mock).mock.calls.find(
        (args) => args[0] === CHANNELS.UPDATE_QUIT_AND_INSTALL
      )![1];
      quitHandler();

      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1);
    });
  });

  describe("error classification edge cases", () => {
    let errorHandler: (err: unknown) => void;

    beforeEach(() => {
      autoUpdaterService.initialize();
      vi.advanceTimersByTime(STARTUP_JITTER_MAX_MS);

      errorHandler = (autoUpdaterMock.on as Mock).mock.calls.find(
        (args) => args[0] === "error"
      )![1];

      autoUpdaterMock.checkForUpdatesAndNotify.mockClear();
    });

    it("treats a cert error as permanent even when statusCode is 5xx", () => {
      // The cert-code check runs before the statusCode check — an error that
      // tunnels both must NOT be retried (cert wins).
      errorHandler(
        Object.assign(new Error("expired"), {
          code: "CERT_HAS_EXPIRED",
          statusCode: 503,
        })
      );

      vi.advanceTimersByTime(60_000);

      expect(autoUpdaterMock.checkForUpdatesAndNotify).not.toHaveBeenCalled();
    });

    it("retries on HTTP 408 (request timeout)", () => {
      errorHandler(Object.assign(new Error("timeout"), { statusCode: 408 }));
      vi.advanceTimersByTime(36_000);

      expect(autoUpdaterMock.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
    });

    it("retries on HTTP 429 (rate limited)", () => {
      errorHandler(Object.assign(new Error("rate limited"), { statusCode: 429 }));
      vi.advanceTimersByTime(36_000);

      expect(autoUpdaterMock.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
    });

    it("does not retry on HTTP 401 (unauthorized)", () => {
      errorHandler(Object.assign(new Error("unauthorized"), { statusCode: 401 }));
      vi.advanceTimersByTime(60_000);

      expect(autoUpdaterMock.checkForUpdatesAndNotify).not.toHaveBeenCalled();
    });

    it("does not retry on HTTP 403 (forbidden)", () => {
      errorHandler(Object.assign(new Error("forbidden"), { statusCode: 403 }));
      vi.advanceTimersByTime(60_000);

      expect(autoUpdaterMock.checkForUpdatesAndNotify).not.toHaveBeenCalled();
    });
  });
});
