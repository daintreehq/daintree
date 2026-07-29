import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import path from "node:path";

const appMock = vi.hoisted(() => ({
  isPackaged: true,
  getVersion: vi.fn(() => "1.0.0"),
  exit: vi.fn(),
}));

const trackEventMock = vi.hoisted(() => vi.fn());

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
  disableWebInstaller: false,
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

// Issue #11104: AutoUpdaterService no longer writes the clean-exit markers itself
// — the shared shutdown chain does, and only once it has actually settled clean.
// These stay mocked so the tests below can prove the duplicated writes are GONE.
const cleanupOnExitMock = vi.hoisted(() => vi.fn());
const markCleanExitMock = vi.hoisted(() => vi.fn());
const markCleanLaunchMock = vi.hoisted(() => vi.fn());

// The shutdown coordinator (issue #11104). The install path now runs the full
// graceful-shutdown chain BEFORE handing off to the updater, so these tests drive
// the handoff explicitly: `requestGracefulShutdownForUpdate` captures the
// continuation, and `settleShutdown(outcome)` plays it back as the real chain would.
const shutdownCoordinatorMock = vi.hoisted(() => {
  type Outcome = "clean" | "dirty";
  const requestGracefulShutdownForUpdate = vi.fn<
    (cb: (outcome: Outcome) => void) => "started" | "already-shutting-down" | "unavailable"
  >(() => "started");
  return {
    requestGracefulShutdownForUpdate,
    settleShutdown: (outcome: Outcome = "clean") => {
      const calls = requestGracefulShutdownForUpdate.mock.calls;
      const last = calls[calls.length - 1];
      if (!last) throw new Error("No coordinated shutdown was requested");
      last[0](outcome);
    },
  };
});

vi.mock("../../lifecycle/shutdownCoordinator.js", () => ({
  requestGracefulShutdownForUpdate: shutdownCoordinatorMock.requestGracefulShutdownForUpdate,
}));

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn((_p: unknown) => false),
  readFileSync: vi.fn(() => ""),
}));

vi.mock("fs", () => fsMock);

vi.mock("../CrashRecoveryService.js", () => ({
  getCrashRecoveryService: () => ({ cleanupOnExit: cleanupOnExitMock }),
}));

vi.mock("../CrashLoopGuardService.js", () => ({
  getCrashLoopGuard: () => ({ markCleanExit: markCleanExitMock }),
}));

vi.mock("../PanelSuspectLedgerService.js", () => ({
  getPanelSuspectLedger: () => ({ markCleanLaunch: markCleanLaunchMock }),
}));

vi.mock("../TelemetryService.js", () => ({
  trackEvent: trackEventMock,
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

// Partial factories shadow every other export of the module, so the failure
// classification list has to be re-exported here or the service's import of it
// resolves to undefined and every test in this file throws.
vi.mock("../../store.js", () => ({
  store: storeMock,
  PENDING_UPDATE_INSTALL_FAILURES: ["updater-error", "handoff-threw", "handoff-timeout"],
}));

vi.mock("../../../shared/utils/trustedRenderer.js", () => trustedRendererMock);

import { autoUpdaterService } from "../AutoUpdaterService.js";
import { CHANNELS } from "../../ipc/channels.js";

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const STARTUP_JITTER_MAX_MS = 60_000;
const CHECKING_MENU_DELAY_MS = 400;

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
    delete process.env.FLATPAK_ID;
    delete process.env.SNAP;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    Object.defineProperty(process, "resourcesPath", {
      value: "/mock/resources",
      configurable: true,
    });
    // app-update.yml exists by default (distributable build); the Linux
    // package-type marker does not. Tests for the local-package guard override
    // this per-path.
    fsMock.existsSync
      .mockReset()
      .mockImplementation((p: unknown) => String(p).endsWith("app-update.yml"));
    fsMock.readFileSync.mockReturnValue("");
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
    appMock.getVersion.mockReset().mockReturnValue("1.0.0");
    appMock.exit.mockReset();
    trackEventMock.mockReset();
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
    delete process.env.FLATPAK_ID;
    delete process.env.SNAP;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not throw when initial update check throws synchronously", () => {
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      throw new Error("sync initial failure");
    });

    expect(() => autoUpdaterService.initialize()).not.toThrow();
    // Initial check is now deferred behind startup jitter — verify the throw
    // inside the timer callback is also caught.
    expect(() => vi.advanceTimersByTime(STARTUP_JITTER_MAX_MS)).not.toThrow();
  });

  it("does not crash on synchronous throw during periodic checks", () => {
    let callCount = 0;
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
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
      autoUpdaterMock.checkForUpdates.mockClear();
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

    it("does not schedule background retry for manual-check transient errors", () => {
      // Manual checks own their own retry button — the background retry path
      // would shadow it. The wasManual guard must short-circuit even when the
      // error would otherwise classify as transient (issue #7592).
      vi.advanceTimersByTime(STARTUP_JITTER_MAX_MS);

      autoUpdaterService.checkForUpdatesManually();
      // Clear AFTER the manual call, not before: automatic and manual checks now
      // share `checkForUpdates`, so the manual invocation itself would otherwise
      // satisfy the assertion below and hide a retry that really did fire.
      autoUpdaterMock.checkForUpdates.mockClear();
      errorHandler(new Error("net::ERR_INTERNET_DISCONNECTED"));
      vi.advanceTimersByTime(60_000);

      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
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
    let quitAndInstallHandler: (event: unknown) => void;
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

    it("requests a coordinated shutdown instead of installing immediately", () => {
      downloadedHandler({ version: "2.0.0" });

      quitAndInstallHandler(TRUSTED_SENDER);

      // The whole point of #11104: the graceful chain runs FIRST. Nothing may
      // reach the updater until the coordinator says the chain has settled.
      expect(shutdownCoordinatorMock.requestGracefulShutdownForUpdate).toHaveBeenCalledTimes(1);
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    });

    it("installs once the coordinated shutdown settles clean", () => {
      downloadedHandler({ version: "2.0.0" });

      quitAndInstallHandler(TRUSTED_SENDER);
      shutdownCoordinatorMock.settleShutdown("clean");

      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1);
    });

    it("still installs when the cleanup chain settles dirty", () => {
      downloadedHandler({ version: "2.0.0" });

      quitAndInstallHandler(TRUSTED_SENDER);
      shutdownCoordinatorMock.settleShutdown("dirty");

      // A timed-out or failed cleanup must not swallow the update the user asked
      // for — the dirty marker it leaves behind is what protects their data.
      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1);
    });

    it("never writes the clean-exit markers itself — the shutdown chain owns them", () => {
      downloadedHandler({ version: "2.0.0" });

      quitAndInstallHandler(TRUSTED_SENDER);
      shutdownCoordinatorMock.settleShutdown("clean");

      // Before #11104 these three were hand-copied here (and in the menu path),
      // written eagerly at click time for work that hadn't happened yet.
      expect(cleanupOnExitMock).not.toHaveBeenCalled();
      expect(markCleanExitMock).not.toHaveBeenCalled();
      expect(markCleanLaunchMock).not.toHaveBeenCalled();
    });

    it("disarms autoInstallOnAppQuit for the whole cleanup window, not just the install", () => {
      downloadedHandler({ version: "2.0.0" });
      autoUpdaterMock.autoInstallOnAppQuit = true;

      quitAndInstallHandler(TRUSTED_SENDER);

      // Cleanup is now multi-second. A Cmd+Q landing inside that window would
      // otherwise be a second, concurrent install trigger.
      expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(false);
    });

    it("restores autoInstallOnAppQuit and keeps the update staged when the coordinator declines", () => {
      downloadedHandler({ version: "2.0.0" });
      autoUpdaterMock.autoInstallOnAppQuit = true;
      shutdownCoordinatorMock.requestGracefulShutdownForUpdate.mockReturnValueOnce(
        "already-shutting-down"
      );

      quitAndInstallHandler(TRUSTED_SENDER);

      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
      expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(true);
      // The staged update must stay installable rather than be silently consumed.
      expect(autoUpdaterService.getMenuState()).not.toBe("idle");
    });

    it("does not request a shutdown when no update is downloaded", () => {
      quitAndInstallHandler(TRUSTED_SENDER);

      expect(shutdownCoordinatorMock.requestGracefulShutdownForUpdate).not.toHaveBeenCalled();
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    });

    it("rejects untrusted sender frame", () => {
      downloadedHandler({ version: "2.0.0" });

      quitAndInstallHandler({ senderFrame: { url: "https://evil.example.com/x.html" } });

      expect(shutdownCoordinatorMock.requestGracefulShutdownForUpdate).not.toHaveBeenCalled();
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    });

    it("rejects missing senderFrame", () => {
      downloadedHandler({ version: "2.0.0" });

      quitAndInstallHandler({});

      expect(shutdownCoordinatorMock.requestGracefulShutdownForUpdate).not.toHaveBeenCalled();
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    });

    it("coordinates one shutdown and one install on a rapid double-IPC", () => {
      downloadedHandler({ version: "2.0.0" });

      quitAndInstallHandler(TRUSTED_SENDER);
      quitAndInstallHandler(TRUSTED_SENDER);

      expect(shutdownCoordinatorMock.requestGracefulShutdownForUpdate).toHaveBeenCalledTimes(1);
      shutdownCoordinatorMock.settleShutdown("clean");
      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1);
    });
  });

  describe("Linux activation guard", () => {
    it("skips initialization on Linux without APPIMAGE and without package-type marker", () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });

      autoUpdaterService.initialize();

      expect(autoUpdaterMock.on).not.toHaveBeenCalled();
      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();

      // Manual check should be a no-op since initialized is false
      autoUpdaterService.checkForUpdatesManually();
      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
    });

    it("skips initialization on Linux when FLATPAK_ID is set", () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      process.env.FLATPAK_ID = "com.daintreehq.Daintree";

      autoUpdaterService.initialize();

      expect(autoUpdaterMock.on).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("Linux Flatpak sandbox detected")
      );

      autoUpdaterService.checkForUpdatesManually();
      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
    });

    it("skips initialization on Linux when SNAP is set", () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      process.env.SNAP = "/snap/daintree/current";

      autoUpdaterService.initialize();

      expect(autoUpdaterMock.on).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("Linux Snap sandbox detected")
      );

      autoUpdaterService.checkForUpdatesManually();
      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
    });

    it("skips initialization on Linux when both FLATPAK_ID and APPIMAGE are set", () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      process.env.FLATPAK_ID = "com.daintreehq.Daintree";
      process.env.APPIMAGE = "/path/to/app.AppImage";

      autoUpdaterService.initialize();

      expect(autoUpdaterMock.on).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("Linux Flatpak sandbox detected")
      );
    });

    it("initializes normally on Linux when APPIMAGE is set", () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      process.env.APPIMAGE = "/path/to/app.AppImage";

      autoUpdaterService.initialize();
      vi.advanceTimersByTime(STARTUP_JITTER_MAX_MS);

      expect(autoUpdaterMock.on).toHaveBeenCalled();
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it("initializes normally on Linux when package-type marker exists with content", () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue("deb");

      autoUpdaterService.initialize();
      vi.advanceTimersByTime(STARTUP_JITTER_MAX_MS);

      expect(autoUpdaterMock.on).toHaveBeenCalled();
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
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

      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
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

      expect(fsMock.existsSync).toHaveBeenCalledWith(path.join("/mock/resources", "package-type"));
    });

    it("skips the package-type probe when APPIMAGE is set", () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      process.env.APPIMAGE = "/path/to/app.AppImage";

      autoUpdaterService.initialize();

      expect(fsMock.existsSync).not.toHaveBeenCalledWith(
        path.join("/mock/resources", "package-type")
      );
    });

    it("does not affect macOS", () => {
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

      autoUpdaterService.initialize();
      vi.advanceTimersByTime(STARTUP_JITTER_MAX_MS);

      expect(autoUpdaterMock.on).toHaveBeenCalled();
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
    });
  });

  describe("local-package guard (missing app-update.yml)", () => {
    it("skips initialization when app-update.yml is absent", () => {
      fsMock.existsSync.mockReturnValue(false);

      autoUpdaterService.initialize();
      vi.advanceTimersByTime(STARTUP_JITTER_MAX_MS);

      expect(fsMock.existsSync).toHaveBeenCalledWith(
        path.join("/mock/resources", "app-update.yml")
      );
      expect(autoUpdaterMock.on).not.toHaveBeenCalled();
      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("app-update.yml not found"));

      autoUpdaterService.checkForUpdatesManually();
      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
    });

    it("still registers channel-preference IPC handlers when blocked", () => {
      fsMock.existsSync.mockReturnValue(false);

      autoUpdaterService.initialize();

      const registeredChannels = (ipcMainMock.handle as Mock).mock.calls.map((args) => args[0]);
      expect(registeredChannels).toContain(CHANNELS.UPDATE_GET_CHANNEL);
      expect(registeredChannels).toContain(CHANNELS.UPDATE_SET_CHANNEL);
      expect(registeredChannels).not.toContain(CHANNELS.UPDATE_QUIT_AND_INSTALL);
      expect(registeredChannels).not.toContain(CHANNELS.UPDATE_CHECK_FOR_UPDATES);
    });

    it("still consumes the pendingUpdateVersion marker when blocked", () => {
      fsMock.existsSync.mockReturnValue(false);
      storeMock.get.mockImplementation((key: string) =>
        key === "pendingUpdateVersion" ? "2.0.0" : undefined
      );

      autoUpdaterService.initialize();

      expect(storeMock.delete).toHaveBeenCalledWith("pendingUpdateVersion");
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
      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
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

  describe("Windows Store updater guard", () => {
    afterEach(() => {
      // isWindowsStoreBuild() now reads process.windowsStore. Reset it after
      // each test so unrelated tests in this file start from the NSIS default.
      Reflect.deleteProperty(process, "windowsStore");
    });

    it("registers only channel-preference IPC handlers on Windows Store builds", () => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      Object.defineProperty(process, "windowsStore", { value: true, configurable: true });

      autoUpdaterService.initialize();

      const registeredChannels = (ipcMainMock.handle as Mock).mock.calls.map((args) => args[0]);
      expect(registeredChannels).toContain(CHANNELS.UPDATE_GET_CHANNEL);
      expect(registeredChannels).toContain(CHANNELS.UPDATE_SET_CHANNEL);
      expect(registeredChannels).not.toContain(CHANNELS.UPDATE_QUIT_AND_INSTALL);
      expect(registeredChannels).not.toContain(CHANNELS.UPDATE_CHECK_FOR_UPDATES);
      expect(autoUpdaterMock.on).not.toHaveBeenCalled();
      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
    });

    it("manual checks are no-ops on Windows Store builds", () => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      Object.defineProperty(process, "windowsStore", { value: true, configurable: true });

      autoUpdaterService.initialize();
      autoUpdaterService.checkForUpdatesManually();

      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
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
      const checkOrder = autoUpdaterMock.checkForUpdates.mock.invocationCallOrder[0];
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
      quitHandler(TRUSTED_SENDER);

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
    it("does not invoke the initial check synchronously during initialize()", () => {
      autoUpdaterService.initialize();

      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
    });

    it("invokes the initial check after the jitter window elapses", () => {
      autoUpdaterService.initialize();
      vi.advanceTimersByTime(STARTUP_JITTER_MAX_MS);

      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it("never schedules the initial check beyond the 60s ceiling", () => {
      vi.spyOn(Math, "random").mockReturnValueOnce(0.999_999);
      autoUpdaterService.initialize();
      vi.advanceTimersByTime(STARTUP_JITTER_MAX_MS);

      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it("dispose() cancels a pending startup jitter so no check fires", () => {
      autoUpdaterService.initialize();
      autoUpdaterService.dispose();

      vi.advanceTimersByTime(STARTUP_JITTER_MAX_MS * 2);

      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
    });

    it("does not block the periodic check from firing later", () => {
      autoUpdaterService.initialize();
      // Advance past startup jitter and one full periodic interval.
      vi.advanceTimersByTime(STARTUP_JITTER_MAX_MS + CHECK_INTERVAL_MS);

      // Initial + first periodic = 2 calls. (Jitter also runs the initial.)
      expect(autoUpdaterMock.checkForUpdates.mock.calls.length).toBeGreaterThanOrEqual(2);
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

      autoUpdaterMock.checkForUpdates.mockClear();
    });

    it("schedules a retry after a transient ECONNRESET error", () => {
      errorHandler(Object.assign(new Error("conn reset"), { code: "ECONNRESET" }));

      // First retry base is 30s with ±20% jitter — anywhere in [24s, 36s].
      // Advance well past the ceiling to guarantee the timer fires.
      vi.advanceTimersByTime(36_000);

      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it("retries on ETIMEDOUT and ENOTFOUND", () => {
      errorHandler(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
      vi.advanceTimersByTime(36_000);
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);

      autoUpdaterMock.checkForUpdates.mockClear();
      // After the retry fires, the next error is at retryCount=1; second retry
      // base is 120s with ±20% — fires by 144s.
      errorHandler(Object.assign(new Error("dns"), { code: "ENOTFOUND" }));
      vi.advanceTimersByTime(144_000);
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it("retries on HTTP 5xx (statusCode = 503)", () => {
      errorHandler(Object.assign(new Error("service unavailable"), { statusCode: 503 }));
      vi.advanceTimersByTime(36_000);

      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it("does not retry on HTTP 404 (missing latest.yml)", () => {
      errorHandler(Object.assign(new Error("not found"), { statusCode: 404 }));
      vi.advanceTimersByTime(CHECK_INTERVAL_MS);

      // Only the periodic interval tick should have fired.
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it("does not retry on cert errors", () => {
      errorHandler(Object.assign(new Error("expired"), { code: "CERT_HAS_EXPIRED" }));
      vi.advanceTimersByTime(60_000);

      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
    });

    it("does not retry an uncategorized error (fail closed)", () => {
      errorHandler(new Error("mystery"));
      vi.advanceTimersByTime(60_000);

      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
    });

    it("does not retry a manual check error (user holds the retry button)", () => {
      autoUpdaterService.checkForUpdatesManually();
      autoUpdaterMock.checkForUpdates.mockClear();

      errorHandler(Object.assign(new Error("conn reset"), { code: "ECONNRESET" }));
      vi.advanceTimersByTime(60_000);

      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
    });

    it("caps retries at 3 attempts", () => {
      // First three transient errors should each schedule a retry.
      errorHandler(Object.assign(new Error("a"), { code: "ECONNRESET" }));
      vi.advanceTimersByTime(36_000); // ≥ 30s * 1.2
      errorHandler(Object.assign(new Error("b"), { code: "ECONNRESET" }));
      vi.advanceTimersByTime(144_000); // ≥ 120s * 1.2
      errorHandler(Object.assign(new Error("c"), { code: "ECONNRESET" }));
      vi.advanceTimersByTime(576_000); // ≥ 480s * 1.2

      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(3);
      autoUpdaterMock.checkForUpdates.mockClear();

      // Fourth error: cap reached, no retry.
      errorHandler(Object.assign(new Error("d"), { code: "ECONNRESET" }));
      vi.advanceTimersByTime(CHECK_INTERVAL_MS);

      // Only the periodic interval tick.
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it("update-available resets retry count so a future failure starts fresh", () => {
      errorHandler(Object.assign(new Error("a"), { code: "ECONNRESET" }));
      vi.advanceTimersByTime(36_000);
      errorHandler(Object.assign(new Error("b"), { code: "ECONNRESET" }));
      vi.advanceTimersByTime(144_000);

      availableHandler({ version: "2.0.0" });
      autoUpdaterMock.checkForUpdates.mockClear();

      // Next transient error should retry at base 30s, not at the 8m ceiling.
      errorHandler(Object.assign(new Error("c"), { code: "ECONNRESET" }));
      vi.advanceTimersByTime(36_000);

      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it("update-not-available resets retry count", () => {
      errorHandler(Object.assign(new Error("a"), { code: "ECONNRESET" }));
      vi.advanceTimersByTime(36_000);

      notAvailableHandler({});
      autoUpdaterMock.checkForUpdates.mockClear();

      errorHandler(Object.assign(new Error("b"), { code: "ECONNRESET" }));
      vi.advanceTimersByTime(36_000);

      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it("update-downloaded resets retry count", () => {
      errorHandler(Object.assign(new Error("a"), { code: "ECONNRESET" }));
      vi.advanceTimersByTime(36_000);

      downloadedHandler({ version: "2.0.0" });
      autoUpdaterMock.checkForUpdates.mockClear();

      errorHandler(Object.assign(new Error("b"), { code: "ECONNRESET" }));
      vi.advanceTimersByTime(36_000);

      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it("dispose() cancels a pending retry timer", () => {
      errorHandler(Object.assign(new Error("a"), { code: "ECONNRESET" }));
      autoUpdaterService.dispose();

      vi.advanceTimersByTime(60_000);

      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
    });

    it("retry uses ±20% jitter (lower bound)", () => {
      vi.spyOn(Math, "random").mockReturnValueOnce(0); // jitterFactor = 0.8
      errorHandler(Object.assign(new Error("a"), { code: "ECONNRESET" }));

      // 30000 * 0.8 = 24000ms exactly.
      vi.advanceTimersByTime(23_999);
      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it("retry uses ±20% jitter (upper bound)", () => {
      vi.spyOn(Math, "random").mockReturnValueOnce(0.999_999_999); // jitterFactor ≈ 1.2
      errorHandler(Object.assign(new Error("a"), { code: "ECONNRESET" }));

      // 30000 * 1.2 = 36000ms (Math.floor lowers it to 35999).
      vi.advanceTimersByTime(35_998);
      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2);
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
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
      quitHandler(TRUSTED_SENDER);

      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    });

    it("cancels any in-flight retry timer on channel switch", async () => {
      const errorHandler = (autoUpdaterMock.on as Mock).mock.calls.find(
        (args) => args[0] === "error"
      )![1];
      errorHandler(Object.assign(new Error("a"), { code: "ECONNRESET" }));
      autoUpdaterMock.checkForUpdates.mockClear();

      await setChannelHandler(null, "nightly");
      vi.advanceTimersByTime(60_000);

      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
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
      quitHandler(TRUSTED_SENDER);

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
      quitHandler(TRUSTED_SENDER);

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
      quitHandler(TRUSTED_SENDER);
      shutdownCoordinatorMock.settleShutdown("clean");

      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1);
    });

    it("treats a missing stored channel as 'stable' so save-stable is a no-op on fresh installs", async () => {
      // Regression for fresh-install bug: initialize() reads the channel with
      // a `?? "stable"` fallback, but UPDATE_SET_CHANNEL must mirror that
      // fallback when computing previousChannel — otherwise saving "stable"
      // on a fresh install (no stored key) would discard a validly-staged
      // installer because `"stable" === undefined` is false.
      downloadedHandler({ version: "2.0.0" });
      downloadedUpdateHelperMock.clear.mockClear();
      autoUpdaterMock.setFeedURL.mockClear();

      // Store has no `updateChannel` key — get() returns undefined.
      storeMock.get.mockImplementation(() => undefined);

      const result = await setChannelHandler(null, "stable");
      expect(result).toBe("stable");
      expect(downloadedUpdateHelperMock.clear).not.toHaveBeenCalled();
      expect(autoUpdaterMock.setFeedURL).not.toHaveBeenCalled();
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

      autoUpdaterMock.checkForUpdates.mockClear();
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

      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
    });

    it("retries on HTTP 408 (request timeout)", () => {
      errorHandler(Object.assign(new Error("timeout"), { statusCode: 408 }));
      vi.advanceTimersByTime(36_000);

      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it("retries on HTTP 429 (rate limited)", () => {
      errorHandler(Object.assign(new Error("rate limited"), { statusCode: 429 }));
      vi.advanceTimersByTime(36_000);

      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it("does not retry on HTTP 401 (unauthorized)", () => {
      errorHandler(Object.assign(new Error("unauthorized"), { statusCode: 401 }));
      vi.advanceTimersByTime(60_000);

      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
    });

    it("does not retry on HTTP 403 (forbidden)", () => {
      errorHandler(Object.assign(new Error("forbidden"), { statusCode: 403 }));
      vi.advanceTimersByTime(60_000);

      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
    });

    it("retries on Electron net::ERR_INTERNET_DISCONNECTED (issue #7592)", () => {
      // Telemetry shows Electron net errors arrive with the token only in
      // err.message, no err.code — must be classified as transient.
      errorHandler(new Error("net::ERR_INTERNET_DISCONNECTED"));
      vi.advanceTimersByTime(36_000);

      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it("retries on Electron net::ERR_NETWORK_CHANGED", () => {
      errorHandler(new Error("net::ERR_NETWORK_CHANGED"));
      vi.advanceTimersByTime(36_000);

      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it("retries on Electron net token nested under err.cause", () => {
      const cause = new Error("net::ERR_INTERNET_DISCONNECTED");
      const wrapper = Object.assign(new Error("request failed"), { cause });

      errorHandler(wrapper);
      vi.advanceTimersByTime(36_000);

      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it("does not retry on Electron net::ERR_CERT_AUTHORITY_INVALID", () => {
      errorHandler(new Error("net::ERR_CERT_AUTHORITY_INVALID"));
      vi.advanceTimersByTime(60_000);

      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
    });

    it("permanent net token in cause wins over transient outer message", () => {
      const cause = new Error("net::ERR_CERT_AUTHORITY_INVALID");
      const wrapper = Object.assign(new Error("net::ERR_INTERNET_DISCONNECTED"), { cause });

      errorHandler(wrapper);
      vi.advanceTimersByTime(60_000);

      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
    });

    it("does not retry on unknown Electron net token (fail closed)", () => {
      errorHandler(new Error("net::ERR_SOME_UNKNOWN_VALUE"));
      vi.advanceTimersByTime(60_000);

      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
    });

    it("retries on Electron net::ERR_CONNECTION_REFUSED", () => {
      // Symmetry with the Node `ECONNREFUSED` code in TRANSIENT_ERROR_CODES —
      // a brief firewall block or server restart is recoverable.
      errorHandler(new Error("net::ERR_CONNECTION_REFUSED"));
      vi.advanceTimersByTime(36_000);

      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it("permanent net token wins when both tokens appear in same message", () => {
      // Even if a transient token appears first in the message, a permanent
      // cert token elsewhere in the same string must short-circuit. Real
      // Electron messages are single-token, but the invariant must hold.
      errorHandler(
        new Error("net::ERR_INTERNET_DISCONNECTED chained with net::ERR_CERT_AUTHORITY_INVALID")
      );
      vi.advanceTimersByTime(60_000);

      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
    });
  });

  describe("menu state lifecycle", () => {
    let availableHandler: (info: { version: string }) => void;
    let notAvailableHandler: (info: object) => void;
    let errorHandler: (err: unknown) => void;
    let downloadedHandler: (info: { version: string }) => void;
    let setChannelHandler: (event: unknown, channel: unknown) => Promise<unknown>;

    beforeEach(() => {
      autoUpdaterService.initialize();
      vi.advanceTimersByTime(STARTUP_JITTER_MAX_MS);

      availableHandler = (autoUpdaterMock.on as Mock).mock.calls.find(
        (args) => args[0] === "update-available"
      )![1];
      notAvailableHandler = (autoUpdaterMock.on as Mock).mock.calls.find(
        (args) => args[0] === "update-not-available"
      )![1];
      errorHandler = (autoUpdaterMock.on as Mock).mock.calls.find(
        (args) => args[0] === "error"
      )![1];
      downloadedHandler = (autoUpdaterMock.on as Mock).mock.calls.find(
        (args) => args[0] === "update-downloaded"
      )![1];
      setChannelHandler = (ipcMainMock.handle as Mock).mock.calls.find(
        (args) => args[0] === CHANNELS.UPDATE_SET_CHANNEL
      )![1];

      autoUpdaterMock.checkForUpdates.mockClear();
    });

    it("starts in idle state", () => {
      expect(autoUpdaterService.getMenuState()).toBe("idle");
    });

    it("a fast manual check (resolves before 400ms) leaves menu state at idle", () => {
      autoUpdaterService.checkForUpdatesManually();

      // Round-trip resolves at 200ms with update-not-available — well inside
      // the 400ms Doherty gate.
      vi.advanceTimersByTime(200);
      notAvailableHandler({});

      // The 400ms timer would have fired at +400ms, but the check resolved
      // first and cleared it.
      vi.advanceTimersByTime(500);

      expect(autoUpdaterService.getMenuState()).toBe("idle");
    });

    it("a slow manual check (still in flight at 400ms) flips menu state to checking", () => {
      autoUpdaterService.checkForUpdatesManually();

      vi.advanceTimersByTime(CHECKING_MENU_DELAY_MS);

      expect(autoUpdaterService.getMenuState()).toBe("checking");

      // After the round-trip eventually completes, state goes back to idle.
      notAvailableHandler({});
      expect(autoUpdaterService.getMenuState()).toBe("idle");
    });

    it("background polls do not show the checking state (only manual checks)", () => {
      // Simulate the periodic checking-for-update event firing without a
      // prior checkForUpdatesManually() call.
      vi.advanceTimersByTime(CHECK_INTERVAL_MS + CHECKING_MENU_DELAY_MS * 2);

      expect(autoUpdaterService.getMenuState()).toBe("idle");
    });

    it("update-available transitions to idle (not ready — only download completion is ready)", () => {
      autoUpdaterService.checkForUpdatesManually();
      vi.advanceTimersByTime(CHECKING_MENU_DELAY_MS);
      expect(autoUpdaterService.getMenuState()).toBe("checking");

      availableHandler({ version: "2.0.0" });

      expect(autoUpdaterService.getMenuState()).toBe("idle");
    });

    it("update-downloaded transitions to ready", () => {
      downloadedHandler({ version: "2.0.0" });

      expect(autoUpdaterService.getMenuState()).toBe("ready");
    });

    it("ready persists past subsequent manual checks (no flicker back to idle)", () => {
      downloadedHandler({ version: "2.0.0" });
      expect(autoUpdaterService.getMenuState()).toBe("ready");

      // A second manual check while staged must not unset Ready — the user
      // can still restart-to-install while a probe is in flight.
      autoUpdaterService.checkForUpdatesManually();
      vi.advanceTimersByTime(CHECKING_MENU_DELAY_MS * 2);
      expect(autoUpdaterService.getMenuState()).toBe("ready");

      notAvailableHandler({});
      // Even update-not-available shouldn't drop Ready — the staged
      // installer is still valid for the current channel.
      expect(autoUpdaterService.getMenuState()).toBe("ready");
    });

    it("channel switch resets ready state and cancels any pending Doherty flip", async () => {
      downloadedHandler({ version: "2.0.0" });
      expect(autoUpdaterService.getMenuState()).toBe("ready");

      await setChannelHandler(null, "nightly");

      expect(autoUpdaterService.getMenuState()).toBe("idle");
    });

    it("channel switch mid-check cancels the pending checking flip", async () => {
      autoUpdaterService.checkForUpdatesManually();
      // Don't advance past 400ms yet — channel switch should cancel.
      vi.advanceTimersByTime(100);

      await setChannelHandler(null, "nightly");

      // Without the timer cancellation, this advance would flip state to
      // "checking" against the now-discarded prior-channel feed.
      vi.advanceTimersByTime(CHECKING_MENU_DELAY_MS * 2);
      expect(autoUpdaterService.getMenuState()).toBe("idle");
    });

    it("error event resets menu state to idle", () => {
      autoUpdaterService.checkForUpdatesManually();
      vi.advanceTimersByTime(CHECKING_MENU_DELAY_MS);
      expect(autoUpdaterService.getMenuState()).toBe("checking");

      errorHandler(Object.assign(new Error("conn reset"), { code: "ECONNRESET" }));

      expect(autoUpdaterService.getMenuState()).toBe("idle");
    });

    it("error event does NOT clobber Ready", () => {
      downloadedHandler({ version: "2.0.0" });
      expect(autoUpdaterService.getMenuState()).toBe("ready");

      // A subsequent retry/error must not erase the user's restart-to-install
      // affordance — the staged installer is still valid.
      errorHandler(Object.assign(new Error("conn reset"), { code: "ECONNRESET" }));

      expect(autoUpdaterService.getMenuState()).toBe("ready");
    });

    it("notifies registered listeners on each transition", () => {
      const listener = vi.fn();
      autoUpdaterService.onMenuStateChange(listener);

      autoUpdaterService.checkForUpdatesManually();
      vi.advanceTimersByTime(CHECKING_MENU_DELAY_MS);
      expect(listener).toHaveBeenCalledWith("checking");

      downloadedHandler({ version: "2.0.0" });
      expect(listener).toHaveBeenLastCalledWith("ready");
    });

    it("does not notify listeners when state is unchanged (no-op dedup)", () => {
      const listener = vi.fn();
      autoUpdaterService.onMenuStateChange(listener);

      // Already idle — these should not fire the listener.
      notAvailableHandler({});
      errorHandler(Object.assign(new Error("conn reset"), { code: "ECONNRESET" }));

      expect(listener).not.toHaveBeenCalled();
    });

    it("onMenuStateChange returns an unsubscribe function", () => {
      const listener = vi.fn();
      const unsubscribe = autoUpdaterService.onMenuStateChange(listener);

      unsubscribe();

      downloadedHandler({ version: "2.0.0" });
      expect(listener).not.toHaveBeenCalled();
    });

    it("a thrown listener does not block other listeners or state transitions", () => {
      const throwing = vi.fn(() => {
        throw new Error("listener boom");
      });
      const surviving = vi.fn();
      autoUpdaterService.onMenuStateChange(throwing);
      autoUpdaterService.onMenuStateChange(surviving);

      downloadedHandler({ version: "2.0.0" });

      expect(throwing).toHaveBeenCalled();
      expect(surviving).toHaveBeenCalledWith("ready");
      expect(autoUpdaterService.getMenuState()).toBe("ready");
    });

    it("dispose clears menu state and removes listeners", () => {
      const listener = vi.fn();
      autoUpdaterService.onMenuStateChange(listener);
      downloadedHandler({ version: "2.0.0" });
      listener.mockClear();

      autoUpdaterService.dispose();

      // The listener should have been called once with "idle" as the final
      // transition before being cleared.
      expect(listener).toHaveBeenCalledWith("idle");
      expect(autoUpdaterService.getMenuState()).toBe("idle");
    });
  });

  describe("quitAndInstallIfReady", () => {
    let downloadedHandler: (info: { version: string }) => void;

    beforeEach(() => {
      autoUpdaterService.initialize();

      downloadedHandler = (autoUpdaterMock.on as Mock).mock.calls.find(
        (args) => args[0] === "update-downloaded"
      )![1];
    });

    it("returns false and does nothing when state is idle", () => {
      expect(autoUpdaterService.quitAndInstallIfReady()).toBe(false);
      vi.advanceTimersByTime(0);

      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
      expect(shutdownCoordinatorMock.requestGracefulShutdownForUpdate).not.toHaveBeenCalled();
    });

    it("returns false when state is checking (no install staged)", () => {
      autoUpdaterService.checkForUpdatesManually();
      vi.advanceTimersByTime(CHECKING_MENU_DELAY_MS);

      expect(autoUpdaterService.quitAndInstallIfReady()).toBe(false);
      vi.advanceTimersByTime(0);
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    });

    it("coordinates the shutdown when ready, and installs only once it settles", () => {
      downloadedHandler({ version: "2.0.0" });

      const result = autoUpdaterService.quitAndInstallIfReady();

      expect(result).toBe(true);
      expect(shutdownCoordinatorMock.requestGracefulShutdownForUpdate).toHaveBeenCalledTimes(1);
      // The chain is still running — the updater must not be touched yet.
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();

      shutdownCoordinatorMock.settleShutdown("clean");
      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1);
    });

    it("installs on a dirty outcome too", () => {
      downloadedHandler({ version: "2.0.0" });

      expect(autoUpdaterService.quitAndInstallIfReady()).toBe(true);
      shutdownCoordinatorMock.settleShutdown("dirty");

      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1);
    });

    it("never writes the clean-exit markers itself — the shutdown chain owns them", () => {
      downloadedHandler({ version: "2.0.0" });

      expect(autoUpdaterService.quitAndInstallIfReady()).toBe(true);
      shutdownCoordinatorMock.settleShutdown("clean");

      expect(cleanupOnExitMock).not.toHaveBeenCalled();
      expect(markCleanExitMock).not.toHaveBeenCalled();
      expect(markCleanLaunchMock).not.toHaveBeenCalled();
    });

    it("a rapid double-call coordinates one shutdown and one install (idempotency)", () => {
      downloadedHandler({ version: "2.0.0" });

      // The second call must read idle and bail. Otherwise a double-click would
      // start two cleanup chains and hand two installs to a non-reentrant updater
      // (MacUpdater.quitAndInstall has no guard of its own).
      const first = autoUpdaterService.quitAndInstallIfReady();
      const second = autoUpdaterService.quitAndInstallIfReady();

      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(shutdownCoordinatorMock.requestGracefulShutdownForUpdate).toHaveBeenCalledTimes(1);

      shutdownCoordinatorMock.settleShutdown("clean");
      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1);
    });

    it("disarms autoInstallOnAppQuit for the whole cleanup window", () => {
      downloadedHandler({ version: "2.0.0" });
      autoUpdaterMock.autoInstallOnAppQuit = true;

      autoUpdaterService.quitAndInstallIfReady();

      // Disarmed at the START of the window, before the chain runs — not just in
      // the instant before installing.
      expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(false);
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    });

    it("rolls back and keeps the update staged when the coordinator is unavailable", () => {
      downloadedHandler({ version: "2.0.0" });
      autoUpdaterMock.autoInstallOnAppQuit = true;
      shutdownCoordinatorMock.requestGracefulShutdownForUpdate.mockReturnValueOnce("unavailable");

      expect(autoUpdaterService.quitAndInstallIfReady()).toBe(false);

      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
      expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(true);
      // Still installable — a declined request must not consume the staged update.
      expect(autoUpdaterService.getMenuState()).toBe("ready");
      expect(autoUpdaterService.quitAndInstallIfReady()).toBe(true);
    });
  });

  describe("disableWebInstaller", () => {
    it("sets disableWebInstaller to true during initialization", () => {
      autoUpdaterService.initialize();

      expect(autoUpdaterMock.disableWebInstaller).toBe(true);
    });
  });

  describe("channel-switch autoInstallOnAppQuit disarm", () => {
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

    it("disarms autoInstallOnAppQuit on channel change", async () => {
      autoUpdaterMock.autoInstallOnAppQuit = true;

      await setChannelHandler(null, "nightly");

      expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(false);
    });

    it("re-arms autoInstallOnAppQuit in update-downloaded handler", async () => {
      autoUpdaterMock.autoInstallOnAppQuit = true;
      await setChannelHandler(null, "nightly");
      expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(false);

      // Fire update-available to sync downloadGeneration with the new channel
      // before the download completes.
      availableHandler({ version: "2.0.0-nightly.1" });
      downloadedHandler({ version: "2.0.0-nightly.1" });

      expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(true);
    });

    it("does not disarm when channel is unchanged", async () => {
      autoUpdaterMock.autoInstallOnAppQuit = true;
      storeMock.get.mockImplementation((key: string) =>
        key === "updateChannel" ? "stable" : undefined
      );

      await setChannelHandler(null, "stable");

      expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(true);
    });
  });

  describe("channel-switch await race (Critical #1)", () => {
    let setChannelHandler: (event: unknown, channel: unknown) => Promise<unknown>;
    let downloadedHandler: (info: { version: string }) => void;
    let quitAndInstallHandler: (event: unknown) => void;
    let clearResolve: () => void;

    beforeEach(() => {
      autoUpdaterService.initialize();
      vi.advanceTimersByTime(STARTUP_JITTER_MAX_MS);

      setChannelHandler = (ipcMainMock.handle as Mock).mock.calls.find(
        (args) => args[0] === CHANNELS.UPDATE_SET_CHANNEL
      )![1];
      downloadedHandler = (autoUpdaterMock.on as Mock).mock.calls.find(
        (args) => args[0] === "update-downloaded"
      )![1];
      quitAndInstallHandler = (ipcMainMock.handle as Mock).mock.calls.find(
        (args) => args[0] === CHANNELS.UPDATE_QUIT_AND_INSTALL
      )![1];

      // Defer clear resolution so the await gap is observable.
      downloadedUpdateHelperMock.clear.mockImplementation(
        () =>
          new Promise((resolve) => {
            clearResolve = resolve as () => void;
          })
      );

      downloadedHandler({ version: "2.0.0" });
    });

    afterEach(() => {
      downloadedUpdateHelperMock.clear.mockReset().mockResolvedValue(undefined);
    });

    it("blocks IPC quit-and-install while clear is in-flight", () => {
      const channelPromise = setChannelHandler(null, "nightly");

      quitAndInstallHandler(TRUSTED_SENDER);

      // IPC handler must reject — updateDownloaded was reset synchronously
      // before the await.
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
      expect(shutdownCoordinatorMock.requestGracefulShutdownForUpdate).not.toHaveBeenCalled();

      clearResolve();
      return channelPromise;
    });

    it("blocks quitAndInstallIfReady while clear is in-flight", () => {
      const channelPromise = setChannelHandler(null, "nightly");

      // menuState was reset to idle synchronously — the guard reads idle
      // and returns false.
      const result = autoUpdaterService.quitAndInstallIfReady();

      expect(result).toBe(false);
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();

      clearResolve();
      return channelPromise;
    });
  });

  describe("stale download epoch guard (Critical #2)", () => {
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

    it("ignores stale update-downloaded event after channel switch", async () => {
      // Download initiated on stable: update-available captures downloadGeneration=0.
      availableHandler({ version: "2.0.0" });
      downloadedHandler({ version: "2.0.0" });
      expect(autoUpdaterService.getMenuState()).toBe("ready");

      // Channel switch increments channelGeneration to 1.
      await setChannelHandler(null, "nightly");
      expect(autoUpdaterService.getMenuState()).toBe("idle");
      expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(false);

      // Old stable download (downloadGeneration=0) fires late —
      // channelGeneration(1) !== downloadGeneration(0), must no-op.
      downloadedHandler({ version: "2.0.0" });

      expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(false);
      expect(autoUpdaterService.getMenuState()).toBe("idle");
    });
  });

  describe("transient error codes (expanded set)", () => {
    let errorHandler: (err: unknown) => void;

    beforeEach(() => {
      autoUpdaterService.initialize();
      vi.advanceTimersByTime(STARTUP_JITTER_MAX_MS);

      errorHandler = (autoUpdaterMock.on as Mock).mock.calls.find(
        (args) => args[0] === "error"
      )![1];

      autoUpdaterMock.checkForUpdates.mockClear();
    });

    it("retries on ENETDOWN", () => {
      errorHandler(Object.assign(new Error("network down"), { code: "ENETDOWN" }));
      vi.advanceTimersByTime(36_000);
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it("retries on EHOSTUNREACH", () => {
      errorHandler(Object.assign(new Error("host unreachable"), { code: "EHOSTUNREACH" }));
      vi.advanceTimersByTime(36_000);
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it("retries on EHOSTDOWN", () => {
      errorHandler(Object.assign(new Error("host down"), { code: "EHOSTDOWN" }));
      vi.advanceTimersByTime(36_000);
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it("retries on ECONNABORTED", () => {
      errorHandler(Object.assign(new Error("aborted"), { code: "ECONNABORTED" }));
      vi.advanceTimersByTime(36_000);
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
    });
  });

  describe("err.cause unwrap in isTransientUpdateError", () => {
    let errorHandler: (err: unknown) => void;

    beforeEach(() => {
      autoUpdaterService.initialize();
      vi.advanceTimersByTime(STARTUP_JITTER_MAX_MS);

      errorHandler = (autoUpdaterMock.on as Mock).mock.calls.find(
        (args) => args[0] === "error"
      )![1];

      autoUpdaterMock.checkForUpdates.mockClear();
    });

    it("classifies a transient code nested under err.cause", () => {
      const cause = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
      const wrapper = Object.assign(new Error("request failed"), { cause });

      errorHandler(wrapper);
      vi.advanceTimersByTime(36_000);

      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it("returns false for a permanent code nested under err.cause", () => {
      const cause = Object.assign(new Error("not found"), { statusCode: 404 });
      const wrapper = Object.assign(new Error("request failed"), { cause });

      errorHandler(wrapper);
      vi.advanceTimersByTime(60_000);

      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
    });

    it("cert error at any cause depth immediately returns false", () => {
      const deepCause = Object.assign(new Error("expired"), { code: "CERT_HAS_EXPIRED" });
      const middle = Object.assign(new Error("middle"), { code: "ECONNRESET", cause: deepCause });
      const top = Object.assign(new Error("top"), { cause: middle });

      errorHandler(top);
      vi.advanceTimersByTime(60_000);

      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
    });

    it("deeply nested transient code is still found", () => {
      const deepCause = Object.assign(new Error("dns"), { code: "ENOTFOUND" });
      const level3 = Object.assign(new Error("level3"), { cause: deepCause });
      const level2 = Object.assign(new Error("level2"), { cause: level3 });
      const top = Object.assign(new Error("top"), { cause: level2 });

      errorHandler(top);
      vi.advanceTimersByTime(36_000);

      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
    });
  });

  describe("UPDATE_DISMISS_TOAST in dev mode", () => {
    beforeEach(() => {
      appMock.isPackaged = false;
    });

    it("registers UPDATE_DISMISS_TOAST handler even when not packaged", () => {
      autoUpdaterService.initialize();

      const registeredChannels = (ipcMainMock.handle as Mock).mock.calls.map((args) => args[0]);
      expect(registeredChannels).toContain(CHANNELS.UPDATE_DISMISS_TOAST);
    });
  });

  describe("quit-and-install watchdog (issue #9261)", () => {
    let quitAndInstallHandler: (event: unknown) => void;
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

    it("arms a 5s app.exit(0) watchdog after quitAndInstall fires", () => {
      downloadedHandler({ version: "2.0.0" });
      quitAndInstallHandler(TRUSTED_SENDER);
      shutdownCoordinatorMock.settleShutdown("clean");

      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1);
      expect(appMock.exit).not.toHaveBeenCalled();

      vi.advanceTimersByTime(4_999);
      expect(appMock.exit).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(appMock.exit).toHaveBeenCalledTimes(1);
      expect(appMock.exit).toHaveBeenCalledWith(0);
    });

    // Issue #11104 widened this from macOS-only. BaseUpdater (win32/linux) only
    // schedules its app.quit() when install() SUCCEEDS — and the install is now
    // preceded by the full teardown, so a failed one would leave a process with
    // no DB, no PTYs and no IPC that never quits. The watchdog is the only thing
    // between that and a zombie.
    it.each(["win32", "linux"])("arms the watchdog on %s too", (platform) => {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      downloadedHandler({ version: "2.0.0" });
      quitAndInstallHandler(TRUSTED_SENDER);
      shutdownCoordinatorMock.settleShutdown("clean");

      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1);
      expect(appMock.exit).not.toHaveBeenCalled();

      vi.advanceTimersByTime(5_000);
      expect(appMock.exit).toHaveBeenCalledWith(0);
    });

    it("does not arm the watchdog while the cleanup chain is still running", () => {
      downloadedHandler({ version: "2.0.0" });
      quitAndInstallHandler(TRUSTED_SENDER);

      // The chain has NOT settled. The two budgets must run strictly in sequence:
      // arming the 5s force-exit now would kill a cleanup that is still allowed
      // up to CLEANUP_TIMEOUT_MS to finish.
      vi.advanceTimersByTime(60_000);
      expect(appMock.exit).not.toHaveBeenCalled();
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    });

    it("swallows a thrown app.exit so the watchdog callback never escapes", () => {
      appMock.exit.mockImplementation(() => {
        throw new Error("exit refused");
      });
      downloadedHandler({ version: "2.0.0" });
      quitAndInstallHandler(TRUSTED_SENDER);
      shutdownCoordinatorMock.settleShutdown("clean");

      expect(() => vi.advanceTimersByTime(5_000)).not.toThrow();
      expect(appMock.exit).toHaveBeenCalledTimes(1);
    });

    it("quitAndInstallIfReady also arms the watchdog", () => {
      downloadedHandler({ version: "2.0.0" });
      expect(autoUpdaterService.quitAndInstallIfReady()).toBe(true);
      shutdownCoordinatorMock.settleShutdown("clean");

      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1);
      expect(appMock.exit).not.toHaveBeenCalled();

      vi.advanceTimersByTime(5_000);
      expect(appMock.exit).toHaveBeenCalledTimes(1);
    });

    // The cleanup chain disposes this service as part of its own teardown. On a
    // chain that hit its hard timeout, that disposal can land AFTER the handoff
    // already armed the watchdog — disarming the one guarantee against a zombie.
    it("dispose() during an in-flight install does not disarm the armed watchdog", () => {
      downloadedHandler({ version: "2.0.0" });
      quitAndInstallHandler(TRUSTED_SENDER);
      shutdownCoordinatorMock.settleShutdown("dirty");
      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1);

      autoUpdaterService.dispose();

      vi.advanceTimersByTime(5_000);
      expect(appMock.exit).toHaveBeenCalledWith(0);
    });

    it("does not schedule a retry when the updater errors during an in-flight install", () => {
      downloadedHandler({ version: "2.0.0" });
      const errorHandler = (autoUpdaterMock.on as Mock).mock.calls.find(
        (args) => args[0] === "error"
      )![1];
      // Flush the jittered launch check first, so the advance below can only
      // surface a retry — not the startup check that was already pending.
      vi.advanceTimersByTime(STARTUP_JITTER_MAX_MS);
      quitAndInstallHandler(TRUSTED_SENDER);
      autoUpdaterMock.checkForUpdates.mockClear();

      // Teardown is already underway. A retry timer armed now would fire against a
      // service the cleanup chain is in the middle of disposing.
      errorHandler(new Error("net::ERR_CONNECTION_RESET"));
      vi.advanceTimersByTime(60_000);

      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
    });

    it("still arms the watchdog when autoUpdater.quitAndInstall throws", () => {
      autoUpdaterMock.quitAndInstall.mockImplementationOnce(() => {
        throw new Error("no staged installer");
      });
      downloadedHandler({ version: "2.0.0" });
      quitAndInstallHandler(TRUSTED_SENDER);

      expect(() => shutdownCoordinatorMock.settleShutdown("clean")).not.toThrow();
      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(5_000);
      expect(appMock.exit).toHaveBeenCalledTimes(1);
    });
  });

  describe("pendingUpdateVersion persistence (issue #9261)", () => {
    let downloadedHandler: (info: { version?: unknown }) => void;

    beforeEach(() => {
      autoUpdaterService.initialize();
      downloadedHandler = (autoUpdaterMock.on as Mock).mock.calls.find(
        (args) => args[0] === "update-downloaded"
      )![1];
    });

    it("persists a valid version on update-downloaded", () => {
      downloadedHandler({ version: "2.0.0" });
      expect(storeMock.set).toHaveBeenCalledWith("pendingUpdateVersion", "2.0.0");
    });

    it("persists a pre-release version", () => {
      downloadedHandler({ version: "0.9.0-nightly.20251231" });
      expect(storeMock.set).toHaveBeenCalledWith("pendingUpdateVersion", "0.9.0-nightly.20251231");
    });

    it("trims surrounding whitespace before persisting", () => {
      downloadedHandler({ version: "  2.0.0  " });
      expect(storeMock.set).toHaveBeenCalledWith("pendingUpdateVersion", "2.0.0");
    });

    it("ignores a non-string version", () => {
      downloadedHandler({ version: 42 });
      expect(storeMock.set).not.toHaveBeenCalledWith("pendingUpdateVersion", expect.anything());
    });

    it("ignores an empty version", () => {
      downloadedHandler({ version: "   " });
      expect(storeMock.set).not.toHaveBeenCalledWith("pendingUpdateVersion", expect.anything());
    });

    it("ignores a malformed semver", () => {
      downloadedHandler({ version: "not-a-version" });
      expect(storeMock.set).not.toHaveBeenCalledWith("pendingUpdateVersion", expect.anything());
    });

    it("does not persist when the download belongs to a stale channel", () => {
      const availableHandler = (autoUpdaterMock.on as Mock).mock.calls.find(
        (args) => args[0] === "update-available"
      )![1] as (info: { version: string }) => void;
      availableHandler({ version: "2.0.0" });

      const setChannelHandler = (ipcMainMock.handle as Mock).mock.calls.find(
        (args) => args[0] === CHANNELS.UPDATE_SET_CHANNEL
      )![1] as (event: unknown, channel: string) => Promise<unknown>;
      storeMock.get.mockReturnValueOnce("stable");
      void setChannelHandler({}, "nightly");

      storeMock.set.mockClear();
      downloadedHandler({ version: "2.0.0" });
      expect(storeMock.set).not.toHaveBeenCalledWith("pendingUpdateVersion", expect.anything());
    });

    it("does not throw if store.set rejects", () => {
      storeMock.set.mockImplementationOnce(() => {
        throw new Error("disk full");
      });
      expect(() => downloadedHandler({ version: "2.0.0" })).not.toThrow();
    });

    it("persists before broadcasting UPDATE_DOWNLOADED so a crash mid-event leaves the marker on disk", () => {
      downloadedHandler({ version: "2.0.0" });

      const setOrder =
        (storeMock.set as Mock).mock.calls
          .map((args, i) => ({ args, order: (storeMock.set as Mock).mock.invocationCallOrder[i] }))
          .find((c) => c.args[0] === "pendingUpdateVersion")?.order ?? Infinity;
      const broadcastOrder =
        (broadcastMock as Mock).mock.calls
          .map((args, i) => ({ args, order: (broadcastMock as Mock).mock.invocationCallOrder[i] }))
          .find((c) => c.args[0] === CHANNELS.UPDATE_DOWNLOADED)?.order ?? -1;

      expect(setOrder).toBeLessThan(broadcastOrder);
    });

    it("stores the canonical semver form (no leading v prefix)", () => {
      downloadedHandler({ version: "v2.0.0" });
      expect(storeMock.set).toHaveBeenCalledWith("pendingUpdateVersion", "2.0.0");
    });
  });

  describe("pendingUpdateVersion channel-switch clear (issue #9261)", () => {
    it("clears the marker when the user switches channels", async () => {
      autoUpdaterService.initialize();
      const downloadedHandler = (autoUpdaterMock.on as Mock).mock.calls.find(
        (args) => args[0] === "update-downloaded"
      )![1] as (info: { version: string }) => void;
      const setChannelHandler = (ipcMainMock.handle as Mock).mock.calls.find(
        (args) => args[0] === CHANNELS.UPDATE_SET_CHANNEL
      )![1] as (event: unknown, channel: string) => Promise<unknown>;

      downloadedHandler({ version: "2.0.0" });
      expect(storeMock.set).toHaveBeenCalledWith("pendingUpdateVersion", "2.0.0");

      storeMock.get.mockImplementation((key: string) =>
        key === "updateChannel" ? "stable" : undefined
      );
      storeMock.delete.mockClear();
      await setChannelHandler({}, "nightly");

      expect(storeMock.delete).toHaveBeenCalledWith("pendingUpdateVersion");
    });

    it("does not clear the marker on a same-channel re-save", async () => {
      autoUpdaterService.initialize();
      const setChannelHandler = (ipcMainMock.handle as Mock).mock.calls.find(
        (args) => args[0] === CHANNELS.UPDATE_SET_CHANNEL
      )![1] as (event: unknown, channel: string) => Promise<unknown>;

      storeMock.get.mockImplementation((key: string) =>
        key === "updateChannel" ? "stable" : undefined
      );
      storeMock.delete.mockClear();
      await setChannelHandler({}, "stable");

      expect(storeMock.delete).not.toHaveBeenCalledWith("pendingUpdateVersion");
    });

    it("does not throw if store.delete rejects during channel switch", async () => {
      autoUpdaterService.initialize();
      const setChannelHandler = (ipcMainMock.handle as Mock).mock.calls.find(
        (args) => args[0] === CHANNELS.UPDATE_SET_CHANNEL
      )![1] as (event: unknown, channel: string) => Promise<unknown>;

      storeMock.get.mockImplementation((key: string) =>
        key === "updateChannel" ? "stable" : undefined
      );
      storeMock.delete.mockImplementationOnce(() => {
        throw new Error("disk full");
      });
      await expect(setChannelHandler({}, "nightly")).resolves.toBe("nightly");
    });
  });

  describe("boot-time install verification (issue #9261)", () => {
    it("fires trackEvent on version mismatch in packaged mode", () => {
      appMock.getVersion.mockReturnValue("1.0.0");
      storeMock.get.mockImplementation((key: string) =>
        key === "pendingUpdateVersion" ? "2.0.0" : undefined
      );

      autoUpdaterService.initialize();

      expect(storeMock.delete).toHaveBeenCalledWith("pendingUpdateVersion");
      expect(trackEventMock).toHaveBeenCalledWith("auto_update_install_version_mismatch", {
        expectedVersion: "2.0.0",
        actualVersion: "1.0.0",
        platform: "darwin",
        installFailure: "none",
      });
    });

    it("does not fire trackEvent when versions match", () => {
      appMock.getVersion.mockReturnValue("2.0.0");
      storeMock.get.mockImplementation((key: string) =>
        key === "pendingUpdateVersion" ? "2.0.0" : undefined
      );

      autoUpdaterService.initialize();

      expect(storeMock.delete).toHaveBeenCalledWith("pendingUpdateVersion");
      expect(trackEventMock).not.toHaveBeenCalled();
    });

    it("clears the marker but does not fire trackEvent in non-packaged mode", () => {
      appMock.isPackaged = false;
      storeMock.get.mockImplementation((key: string) =>
        key === "pendingUpdateVersion" ? "2.0.0" : undefined
      );

      autoUpdaterService.initialize();

      expect(storeMock.delete).not.toHaveBeenCalledWith("pendingUpdateVersion");
      expect(trackEventMock).not.toHaveBeenCalled();
    });

    it("is a no-op when no pendingUpdateVersion is stored", () => {
      storeMock.get.mockReturnValue(undefined);

      autoUpdaterService.initialize();

      expect(trackEventMock).not.toHaveBeenCalled();
    });

    it("clears but does not fire trackEvent on an invalid stored value", () => {
      storeMock.get.mockImplementation((key: string) =>
        key === "pendingUpdateVersion" ? "not-a-version" : undefined
      );

      autoUpdaterService.initialize();

      expect(storeMock.delete).toHaveBeenCalledWith("pendingUpdateVersion");
      expect(trackEventMock).not.toHaveBeenCalled();
    });

    it("clears but does not fire trackEvent on a non-string stored value", () => {
      storeMock.get.mockImplementation((key: string) =>
        key === "pendingUpdateVersion" ? 42 : undefined
      );

      autoUpdaterService.initialize();

      expect(storeMock.delete).toHaveBeenCalledWith("pendingUpdateVersion");
      expect(trackEventMock).not.toHaveBeenCalled();
    });

    it("propagates the actual platform on linux", () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      process.env.APPIMAGE = "/path/to/app.AppImage";
      appMock.getVersion.mockReturnValue("1.0.0");
      storeMock.get.mockImplementation((key: string) =>
        key === "pendingUpdateVersion" ? "2.0.0" : undefined
      );

      autoUpdaterService.initialize();

      expect(trackEventMock).toHaveBeenCalledWith(
        "auto_update_install_version_mismatch",
        expect.objectContaining({ platform: "linux" })
      );
    });

    it("does not crash when store.delete throws", () => {
      storeMock.get.mockImplementation((key: string) =>
        key === "pendingUpdateVersion" ? "2.0.0" : undefined
      );
      storeMock.delete.mockImplementationOnce(() => {
        throw new Error("disk full");
      });

      expect(() => autoUpdaterService.initialize()).not.toThrow();
      // trackEvent still fires because the delete failure is logged but
      // doesn't abort the comparison path.
      expect(trackEventMock).toHaveBeenCalledTimes(1);
    });

    it("swallows a thrown trackEvent so initialize never throws", () => {
      storeMock.get.mockImplementation((key: string) =>
        key === "pendingUpdateVersion" ? "2.0.0" : undefined
      );
      trackEventMock.mockImplementationOnce(() => {
        throw new Error("sentry offline");
      });

      expect(() => autoUpdaterService.initialize()).not.toThrow();
    });
  });

  // Issue #11481. Squirrel.Mac validates the staged bundle against a code
  // requirement derived from the RUNNING app, so an installation replaced by an
  // ad-hoc local build can never accept a Developer ID update. Before this the
  // rejection was invisible: the error listener was already detached, the
  // watchdog force-exited, and the next boot only wrote telemetry — so the user
  // sat in an unbreakable loop with no idea why.
  describe("install-failure classification (issue #11481)", () => {
    const FAILURE_KEY = "pendingUpdateInstallFailure";

    function persistedFailures() {
      return (storeMock.set as Mock).mock.calls
        .filter((args) => args[0] === FAILURE_KEY)
        .map((args) => args[1] as unknown);
    }

    describe("capture at handoff", () => {
      let quitAndInstallHandler: (event: unknown) => void;
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

      // The macOS path in practice: the shutdown chain disposes this service
      // (detaching the error listener) before the handoff, so nothing observes
      // Squirrel's rejection except the process failing to die.
      it("records the failure before force-exiting when nothing else reports one", () => {
        downloadedHandler({ version: "2.0.0" });
        quitAndInstallHandler(TRUSTED_SENDER);
        shutdownCoordinatorMock.settleShutdown("clean");
        storeMock.set.mockClear();

        vi.advanceTimersByTime(5_000);

        expect(persistedFailures()).toEqual(["handoff-timeout"]);
        // Ordering is the whole point: a marker written after app.exit() would
        // never reach disk.
        const writeOrder = (storeMock.set as Mock).mock.invocationCallOrder[0]!;
        const exitOrder = (appMock.exit as Mock).mock.invocationCallOrder[0]!;
        expect(writeOrder).toBeLessThan(exitOrder);
      });

      it("keeps the specific reason when a synchronous throw already classified it", () => {
        autoUpdaterMock.quitAndInstall.mockImplementationOnce(() => {
          throw new Error("no staged installer");
        });
        storeMock.get.mockImplementation((key: string) =>
          key === FAILURE_KEY ? "handoff-threw" : undefined
        );
        downloadedHandler({ version: "2.0.0" });
        quitAndInstallHandler(TRUSTED_SENDER);
        shutdownCoordinatorMock.settleShutdown("clean");

        vi.advanceTimersByTime(5_000);

        // The watchdog always runs after a failed handoff; without the
        // preferExisting guard it would flatten every reason to a timeout.
        expect(persistedFailures()).toEqual(["handoff-threw"]);
      });

      it("records a synchronous handoff throw and still force-exits", () => {
        autoUpdaterMock.quitAndInstall.mockImplementationOnce(() => {
          throw new Error("no staged installer");
        });
        downloadedHandler({ version: "2.0.0" });
        quitAndInstallHandler(TRUSTED_SENDER);
        shutdownCoordinatorMock.settleShutdown("clean");

        expect(persistedFailures()).toContain("handoff-threw");
        vi.advanceTimersByTime(5_000);
        expect(appMock.exit).toHaveBeenCalledWith(0);
      });

      it("records an updater error that lands before the service is disposed", () => {
        downloadedHandler({ version: "2.0.0" });
        const errorHandler = (autoUpdaterMock.on as Mock).mock.calls.find(
          (args) => args[0] === "error"
        )![1];
        quitAndInstallHandler(TRUSTED_SENDER);
        storeMock.set.mockClear();

        errorHandler(new Error("net::ERR_CONNECTION_RESET"));

        expect(persistedFailures()).toEqual(["updater-error"]);
      });

      // Persisting runs from an EventEmitter "error" listener and from inside
      // the watchdog. A throw in either place would become a second error event
      // or block the exit.
      it("never lets a failed marker write escape or block the exit", () => {
        storeMock.set.mockImplementation(() => {
          throw new Error("disk full");
        });
        downloadedHandler({ version: "2.0.0" });
        quitAndInstallHandler(TRUSTED_SENDER);

        expect(() => shutdownCoordinatorMock.settleShutdown("clean")).not.toThrow();
        expect(() => vi.advanceTimersByTime(5_000)).not.toThrow();
        expect(appMock.exit).toHaveBeenCalledWith(0);
      });

      // electron-updater and Squirrel embed absolute cache paths in their
      // messages; persisting one would write the user's home directory into the
      // config file.
      it("persists only closed-enum values, never updater error text", () => {
        const secret = new Error(
          "Code signature at URL file:///Users/someone/Library/Caches/daintree-updater/update.zip did not pass validation"
        );
        downloadedHandler({ version: "2.0.0" });
        const errorHandler = (autoUpdaterMock.on as Mock).mock.calls.find(
          (args) => args[0] === "error"
        )![1];
        quitAndInstallHandler(TRUSTED_SENDER);
        errorHandler(secret);
        shutdownCoordinatorMock.settleShutdown("clean");
        vi.advanceTimersByTime(5_000);

        const allowed = new Set(["updater-error", "handoff-threw", "handoff-timeout"]);
        for (const value of persistedFailures()) {
          expect(allowed.has(value as string)).toBe(true);
        }
        const everyWrite = JSON.stringify((storeMock.set as Mock).mock.calls);
        expect(everyWrite).not.toContain("/Users/someone");
        expect(everyWrite).not.toContain("did not pass validation");
      });
    });

    describe("marker hygiene", () => {
      it("drops a stale failure when a new payload is staged", () => {
        autoUpdaterService.initialize();
        const downloadedHandler = (autoUpdaterMock.on as Mock).mock.calls.find(
          (args) => args[0] === "update-downloaded"
        )![1];

        downloadedHandler({ version: "2.0.0" });

        // Otherwise a failure recorded against an earlier version is read back
        // alongside THIS version's marker and blamed on it.
        expect(storeMock.delete).toHaveBeenCalledWith(FAILURE_KEY);
      });

      it("does not drop the failure when the staged version is unusable", () => {
        autoUpdaterService.initialize();
        const downloadedHandler = (autoUpdaterMock.on as Mock).mock.calls.find(
          (args) => args[0] === "update-downloaded"
        )![1];
        storeMock.delete.mockClear();

        downloadedHandler({ version: "not-a-version" });

        // No version marker was written, so there is no new attempt for the old
        // failure to be confused with — clearing it would lose the signal.
        expect(storeMock.delete).not.toHaveBeenCalledWith(FAILURE_KEY);
      });

      it("clears both markers on a channel switch even when the first delete throws", async () => {
        autoUpdaterService.initialize();
        const setChannelHandler = (ipcMainMock.handle as Mock).mock.calls.find(
          (args) => args[0] === CHANNELS.UPDATE_SET_CHANNEL
        )![1];
        storeMock.get.mockImplementation((key: string) =>
          key === "updateChannel" ? "stable" : undefined
        );
        storeMock.delete.mockImplementation((key: string) => {
          if (key === "pendingUpdateVersion") throw new Error("disk full");
        });

        await setChannelHandler({}, "nightly");

        // The keys are only meaningful as a pair — a surviving failure marker
        // would attach itself to the next channel's first staged update.
        expect(storeMock.delete).toHaveBeenCalledWith(FAILURE_KEY);
      });
    });

    describe("boot-time recovery prompt", () => {
      function bootWith({
        pending,
        failure,
        running = "1.0.0",
      }: {
        pending?: unknown;
        failure?: unknown;
        running?: string;
      }) {
        appMock.getVersion.mockReturnValue(running);
        storeMock.get.mockImplementation((key: string) => {
          if (key === "pendingUpdateVersion") return pending;
          if (key === FAILURE_KEY) return failure;
          return undefined;
        });
        autoUpdaterService.initialize();
        return (broadcastMock as Mock).mock.calls.filter(
          (args) => args[0] === CHANNELS.NOTIFICATION_SHOW_TOAST
        );
      }

      it("prompts once with a single recovery action when a watched attempt failed", () => {
        const toasts = bootWith({ pending: "2.0.0", failure: "handoff-timeout" });

        expect(toasts).toHaveLength(1);
        const payload = toasts[0]![1] as {
          type: string;
          message: string;
          action: { label: string; ipcChannel: string; data: string };
        };
        expect(payload.type).toBe("error");
        // One action, and it is a recovery — never a bare dismiss.
        expect(payload.action.ipcChannel).toBe(CHANNELS.SYSTEM_OPEN_EXTERNAL);
        const target = new URL(payload.action.data);
        expect(target.protocol).toBe("https:");
        expect(target.hostname).toBe("daintree.org");
        // The body has to name both versions or it can't explain the loop the
        // user is stuck in.
        expect(payload.message).toContain("2.0.0");
        expect(payload.message).toContain("1.0.0");
      });

      it("clear-on-read means the same failed attempt cannot prompt twice", () => {
        bootWith({ pending: "2.0.0", failure: "handoff-timeout" });
        expect(storeMock.delete).toHaveBeenCalledWith(FAILURE_KEY);
        expect(storeMock.delete).toHaveBeenCalledWith("pendingUpdateVersion");

        // Second boot reads what a real store would now return.
        autoUpdaterService.dispose();
        broadcastMock.mockClear();
        const toasts = bootWith({ pending: undefined, failure: undefined });
        expect(toasts).toHaveLength(0);
      });

      // An app killed before autoInstallOnAppQuit could run leaves the version
      // marker behind with nothing having gone wrong — the staged installer is
      // still good, so claiming it failed would be a lie.
      it("stays silent on a bare mismatch with no observed failure", () => {
        const toasts = bootWith({ pending: "2.0.0" });

        expect(toasts).toHaveLength(0);
        expect(trackEventMock).toHaveBeenCalledWith(
          "auto_update_install_version_mismatch",
          expect.objectContaining({ installFailure: "none" })
        );
      });

      it("reports the observed failure class in telemetry when there is one", () => {
        bootWith({ pending: "2.0.0", failure: "handoff-timeout" });

        expect(trackEventMock).toHaveBeenCalledWith(
          "auto_update_install_version_mismatch",
          expect.objectContaining({ installFailure: "handoff-timeout" })
        );
      });

      it("stays silent when the install actually landed", () => {
        // A slow-but-successful handoff can trip the watchdog and leave a marker
        // behind; the version proves it worked.
        const toasts = bootWith({
          pending: "2.0.0",
          failure: "handoff-timeout",
          running: "2.0.0",
        });

        expect(toasts).toHaveLength(0);
        expect(trackEventMock).not.toHaveBeenCalled();
      });

      it("refuses to prompt on a failure class it does not recognize", () => {
        const toasts = bootWith({ pending: "2.0.0", failure: "../../etc/passwd" });

        expect(toasts).toHaveLength(0);
        expect(trackEventMock).toHaveBeenCalledWith(
          "auto_update_install_version_mismatch",
          expect.objectContaining({ installFailure: "none" })
        );
      });

      it("still prompts when telemetry reporting throws", () => {
        trackEventMock.mockImplementationOnce(() => {
          throw new Error("sentry offline");
        });

        const toasts = bootWith({ pending: "2.0.0", failure: "handoff-timeout" });

        // Recovery must not be hostage to an analytics outage.
        expect(toasts).toHaveLength(1);
      });

      it("does not send Windows Store users to a download page the Store owns", () => {
        Object.defineProperty(process, "windowsStore", { value: true, configurable: true });
        try {
          const toasts = bootWith({ pending: "2.0.0", failure: "handoff-timeout" });
          expect(toasts).toHaveLength(0);
          // Markers are still consumed, or they would replay forever.
          expect(storeMock.delete).toHaveBeenCalledWith(FAILURE_KEY);
        } finally {
          Object.defineProperty(process, "windowsStore", { value: undefined, configurable: true });
        }
      });
    });
  });

  // The native OS notification electron-updater fires from
  // `checkForUpdatesAndNotify()` lands on top of the in-app "Update ready" toast
  // this app already renders from the same event, so the user is told twice
  // (issue #11111). Every automatic context must use the plain call. This is
  // invisible in dev — Electron 42 silently fails the native notification on an
  // unsigned build — so only an assertion protects it.
  describe("automatic checks never double-notify", () => {
    it("uses the plain check for the jittered initial check", () => {
      autoUpdaterService.initialize();
      vi.advanceTimersByTime(STARTUP_JITTER_MAX_MS);

      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalled();
      expect(autoUpdaterMock.checkForUpdatesAndNotify).not.toHaveBeenCalled();
    });

    it("uses the plain check for the periodic tick", () => {
      autoUpdaterService.initialize();
      vi.advanceTimersByTime(STARTUP_JITTER_MAX_MS);
      vi.advanceTimersByTime(CHECK_INTERVAL_MS + 1);

      expect(autoUpdaterMock.checkForUpdates.mock.calls.length).toBeGreaterThan(1);
      expect(autoUpdaterMock.checkForUpdatesAndNotify).not.toHaveBeenCalled();
    });

    it("uses the plain check for the transient-error retry", () => {
      autoUpdaterService.initialize();
      vi.advanceTimersByTime(STARTUP_JITTER_MAX_MS);
      const errorHandler = (autoUpdaterMock.on as Mock).mock.calls.find(
        (args) => args[0] === "error"
      )![1];
      autoUpdaterMock.checkForUpdates.mockClear();

      errorHandler(new Error("net::ERR_INTERNET_DISCONNECTED"));
      vi.advanceTimersByTime(60_000);

      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalled();
      expect(autoUpdaterMock.checkForUpdatesAndNotify).not.toHaveBeenCalled();
    });
  });

  // UPDATE_AVAILABLE / UPDATE_DOWNLOADED are one-shot broadcasts, so a renderer
  // created after they fired — a second project view, a new window, a view
  // rebuilt after LRU eviction — never learned an update was waiting. This
  // snapshot is what such a renderer pulls (issue #11111).
  describe("UPDATE_GET_LATEST snapshot for late renderers", () => {
    const storeState: Record<string, unknown> = {};

    function primeStore(values: Record<string, unknown>): void {
      for (const key of Object.keys(storeState)) delete storeState[key];
      Object.assign(storeState, values);
    }

    function grabHandler<T>(channel: string): T {
      return (ipcMainMock.handle as Mock).mock.calls.find((args) => args[0] === channel)![1] as T;
    }

    // The IPC handler is registered eagerly in globalServicesInit (the deferred
    // queue that starts this service drains too late to answer the renderer's
    // first pull), so it reads this method through the service ref. Exercise the
    // method — it is the whole of the logic.
    function getLatest(): { version: string; downloaded: boolean } | null {
      return autoUpdaterService.getLatestUpdate();
    }

    function handlers() {
      return {
        available: (autoUpdaterMock.on as Mock).mock.calls.find(
          (args) => args[0] === "update-available"
        )![1] as (info: { version: string }) => void,
        downloaded: (autoUpdaterMock.on as Mock).mock.calls.find(
          (args) => args[0] === "update-downloaded"
        )![1] as (info: { version: string }) => void,
        dismiss: grabHandler<(event: unknown, version: unknown) => void>(
          CHANNELS.UPDATE_DISMISS_TOAST
        ),
      };
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
    });

    it("returns null before any update is detected", () => {
      autoUpdaterService.initialize();

      expect(getLatest()).toBeNull();
    });

    it("replays the available stage to a renderer that missed the broadcast", () => {
      autoUpdaterService.initialize();
      handlers().available({ version: "2.0.0" });

      expect(getLatest()).toEqual({ version: "2.0.0", downloaded: false });
    });

    it("replays the downloaded stage to a renderer that missed the broadcast", () => {
      autoUpdaterService.initialize();
      const { available, downloaded } = handlers();
      available({ version: "2.0.0" });
      downloaded({ version: "2.0.0" });

      expect(getLatest()).toEqual({ version: "2.0.0", downloaded: true });
    });

    it("keeps a deduped version pullable — a new window has still never seen it", () => {
      autoUpdaterService.initialize();
      const { available } = handlers();
      available({ version: "2.0.0" });
      // The second poll is swallowed as an in-session repeat and never
      // broadcasts, but the snapshot must survive it.
      available({ version: "2.0.0" });

      expect(getLatest()).toEqual({ version: "2.0.0", downloaded: false });
    });

    it("does not let a repeat available event downgrade a completed download", () => {
      autoUpdaterService.initialize();
      const { available, downloaded } = handlers();
      available({ version: "2.0.0" });
      downloaded({ version: "2.0.0" });
      // electron-updater refires `update-available` for the version it has
      // already staged on every subsequent poll — that must not roll the
      // snapshot back to "downloading".
      available({ version: "2.0.0" });

      expect(getLatest()).toEqual({ version: "2.0.0", downloaded: true });
    });

    it("supersedes the snapshot when a newer version appears", () => {
      autoUpdaterService.initialize();
      const { available } = handlers();
      available({ version: "2.0.0" });
      available({ version: "2.1.0" });

      expect(getLatest()).toEqual({ version: "2.1.0", downloaded: false });
    });

    it("withdraws the snapshot as soon as the user dismisses the toast", () => {
      autoUpdaterService.initialize();
      const { available, dismiss } = handlers();
      available({ version: "2.0.0" });

      dismiss(TRUSTED_SENDER, "2.0.0");

      // Without this, a window opened between the dismissal and the next poll
      // would hydrate the very toast the user just closed.
      expect(getLatest()).toBeNull();
    });

    it("keeps a dismissed version withdrawn when a later poll refires it", () => {
      autoUpdaterService.initialize();
      const { available, dismiss } = handlers();
      available({ version: "2.0.0" });
      dismiss(TRUSTED_SENDER, "2.0.0");

      // The refire is suppressed for BOTH reasons at once. Dismissal has to win:
      // classifying it as an in-session dedup would repopulate the snapshot with
      // a version the user explicitly waved off, and re-nag them in every window
      // they open for the next 24 hours.
      available({ version: "2.0.0" });

      expect(getLatest()).toBeNull();
    });

    it("still replays a finished download for a dismissed version", () => {
      autoUpdaterService.initialize();
      const { available, downloaded, dismiss } = handlers();
      available({ version: "2.0.0" });
      dismiss(TRUSTED_SENDER, "2.0.0");

      // Dismissing "downloading…" is not dismissing "ready to install" — the
      // finished install stays separately actionable.
      downloaded({ version: "2.0.0" });

      expect(getLatest()).toEqual({ version: "2.0.0", downloaded: true });
    });

    it("does not replay a download that belongs to the channel the user left", () => {
      autoUpdaterService.initialize();
      const { available, downloaded } = handlers();
      available({ version: "2.0.0" });

      const setChannel = grabHandler<(event: unknown, channel: unknown) => Promise<string>>(
        CHANNELS.UPDATE_SET_CHANNEL
      );
      void setChannel({}, "nightly");
      // Arrives after the switch — the stale-generation guard refuses it install
      // authorization, so it must not be handed to a renderer as installable.
      downloaded({ version: "2.0.0" });

      expect(getLatest()).toBeNull();
    });

    it("clears the snapshot once an install is accepted", () => {
      autoUpdaterService.initialize();
      const { available, downloaded } = handlers();
      available({ version: "2.0.0" });
      downloaded({ version: "2.0.0" });

      grabHandler<(event: unknown) => void>(CHANNELS.UPDATE_QUIT_AND_INSTALL)(TRUSTED_SENDER);

      // A view created during the multi-second shutdown chain must not be told
      // to restart into an update that is already installing.
      expect(getLatest()).toBeNull();
    });

    it("keeps the snapshot when the coordinator declines the install", () => {
      autoUpdaterService.initialize();
      const { available, downloaded } = handlers();
      available({ version: "2.0.0" });
      downloaded({ version: "2.0.0" });

      shutdownCoordinatorMock.requestGracefulShutdownForUpdate.mockReturnValueOnce(
        "already-shutting-down"
      );
      grabHandler<(event: unknown) => void>(CHANNELS.UPDATE_QUIT_AND_INSTALL)(TRUSTED_SENDER);

      // A declined install leaves the update installable, so it must stay
      // pullable too.
      expect(getLatest()).toEqual({ version: "2.0.0", downloaded: true });
    });

    it("answers with null on builds where the updater never activates", () => {
      appMock.isPackaged = false;

      autoUpdaterService.initialize();

      expect(getLatest()).toBeNull();
    });

    it("withdraws an in-progress version once the feed stops offering it", () => {
      autoUpdaterService.initialize();
      const { available } = handlers();
      const notAvailable = (autoUpdaterMock.on as Mock).mock.calls.find(
        (args) => args[0] === "update-not-available"
      )![1] as (info: unknown) => void;
      available({ version: "2.0.0" });

      // Release pulled before the download finished.
      notAvailable({});

      // Otherwise every window opened from here on claims 2.0.0 is downloading.
      expect(getLatest()).toBeNull();
    });

    it("keeps a staged installer even after the feed stops offering it", () => {
      autoUpdaterService.initialize();
      const { available, downloaded } = handlers();
      const notAvailable = (autoUpdaterMock.on as Mock).mock.calls.find(
        (args) => args[0] === "update-not-available"
      )![1] as (info: unknown) => void;
      available({ version: "2.0.0" });
      downloaded({ version: "2.0.0" });

      notAvailable({});

      // The installer is on disk and still installable, whatever the feed says.
      expect(getLatest()).toEqual({ version: "2.0.0", downloaded: true });
    });

    it("stays silent for the whole install window, even if a download lands inside it", () => {
      autoUpdaterService.initialize();
      const { available, downloaded } = handlers();
      available({ version: "2.0.0" });
      downloaded({ version: "2.0.0" });
      grabHandler<(event: unknown) => void>(CHANNELS.UPDATE_QUIT_AND_INSTALL)(TRUSTED_SENDER);

      // The shutdown chain runs for seconds before the updater takes the
      // process, and the updater keeps emitting throughout. A view created in
      // that window must not be offered a restart for an update already
      // installing.
      downloaded({ version: "2.1.0" });

      expect(getLatest()).toBeNull();
    });

    it("hands back a copy, so a renderer round-trip cannot mutate service state", () => {
      autoUpdaterService.initialize();
      handlers().available({ version: "2.0.0" });

      const first = getLatest();
      first!.version = "9.9.9";

      expect(getLatest()).toEqual({ version: "2.0.0", downloaded: false });
    });

    it("reports nothing pending once disposed", () => {
      autoUpdaterService.initialize();
      handlers().available({ version: "2.0.0" });

      autoUpdaterService.dispose();

      expect(getLatest()).toBeNull();
    });

    it("survives an unwritable store rather than aborting the check", () => {
      autoUpdaterService.initialize();
      const { available } = handlers();
      primeStore({
        dismissedUpdateVersion: "2.0.0",
        dismissedUpdateAt: Date.now() - 48 * 60 * 60 * 1000,
      });
      storeMock.delete.mockImplementation(() => {
        throw new Error("EACCES");
      });

      // Pruning the expired record throws. It runs inside an EventEmitter
      // listener, so an escaping throw becomes an updater `error` — which this
      // service classifies as permanent and never retries, killing the check.
      expect(() => available({ version: "2.0.0" })).not.toThrow();
      expect(getLatest()).toEqual({ version: "2.0.0", downloaded: false });
    });
  });
});
