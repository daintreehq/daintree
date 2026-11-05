import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

const dialogMock = vi.hoisted(() => ({
  showSaveDialog: vi.fn(),
}));

const shellMock = vi.hoisted(() => ({
  openPath: vi.fn(async () => ""),
  showItemInFolder: vi.fn(),
}));

const fsMock = vi.hoisted(() => ({
  promises: {
    writeFile: vi.fn(async () => undefined) as ReturnType<typeof vi.fn>,
    access: vi.fn(async () => undefined) as ReturnType<typeof vi.fn>,
    mkdir: vi.fn(async () => undefined) as ReturnType<typeof vi.fn>,
  },
}));

const collectDiagnosticsMock = vi.hoisted(() => vi.fn());

// On Linux the default app opens through xdg-open rather than shell.openPath;
// these tests check what reaches the OS opener, so route it to the shell mock.
vi.mock("../../../utils/openPath.js", async () => {
  const { shell } = await import("electron");
  return { openWithDefaultApp: (target: string) => shell.openPath(target) };
});

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  dialog: dialogMock,
  shell: shellMock,
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
}));

vi.mock("node:fs", () => fsMock);

vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: vi.fn(() => null),
  getAppWebContents: vi.fn(),
  getAllAppWebContents: vi.fn(() => []),
  getProjectForWebContents: vi.fn(() => null),
}));

vi.mock("../../../window/windowRef.js", () => ({
  getProjectViewManager: vi.fn(() => null),
}));

vi.mock("../../../utils/performance.js", () => ({
  isPerformanceCaptureEnabled: vi.fn(() => false),
  markPerformance: vi.fn(),
  sampleIpcTiming: vi.fn(),
}));

vi.mock("../../../services/CrashRecoveryService.js", () => ({
  getCrashRecoveryService: vi.fn(() => ({
    resetToFresh: vi.fn(),
    clearPendingCrash: vi.fn(),
  })),
}));

vi.mock("../../../services/DiagnosticsCollector.js", () => ({
  collectDiagnostics: collectDiagnosticsMock,
}));

vi.mock("../../../utils/logger.js", () => ({
  getLogFilePath: vi.fn(() => "/tmp/daintree/logs/main.log"),
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../../../../shared/config/devServer.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../shared/config/devServer.js")>(
    "../../../../shared/config/devServer.js"
  );
  return {
    ...actual,
    getDevServerUrl: vi.fn(() => "http://localhost:5173"),
  };
});

import { registerRecoveryHandlers } from "../recovery.js";
import { recordAppEntryUrl } from "../../../window/appEntryUrl.js";
import type { HandlerDependencies } from "../../types.js";

function getHandlerFn(channelName: string): (...args: unknown[]) => unknown {
  const call = ipcMainMock.handle.mock.calls.find((c: unknown[]) => c[0] === channelName);
  if (!call) throw new Error(`No handler registered for ${channelName}`);
  return call[1] as (...args: unknown[]) => unknown;
}

const TRUSTED_RECOVERY_URL = "app://daintree/recovery.html";
const UNTRUSTED_URL = "https://evil.com/recovery.html";
const MAIN_RENDERER_URL = "app://daintree/index.html";
const PROD_RECOVERY_URL = "app://daintree/recovery.html?reason=crashed&exitCode=1";
const PROD_STARTUP_VIEW_URL = "app://daintree/index.html?projectId=project-a";

// Vitest runs with NODE_ENV=development, so the default app URL is the dev server.
const DEV_APP_URL = "http://localhost:5173";
const STARTUP_VIEW_URL = "http://localhost:5173/?projectId=project-a";

function buildSender() {
  return {
    id: 1,
    isDestroyed: vi.fn(() => false),
    loadURL: vi.fn<(url: string) => Promise<void>>(async () => undefined),
  };
}

function recordEntry(sender: ReturnType<typeof buildSender>, url: string) {
  recordAppEntryUrl(sender as unknown as Electron.WebContents, url);
}

function buildWindow() {
  return { isDestroyed: vi.fn(() => false), loadURL: vi.fn() };
}

function buildEvent(url: string | null, sender: object = buildSender()) {
  return {
    senderFrame: url === null ? null : { url },
    sender,
  };
}

describe("registerRecoveryHandlers", () => {
  const deps = { mainWindow: undefined } as HandlerDependencies;

  beforeEach(() => {
    vi.clearAllMocks();
    shellMock.openPath.mockResolvedValue("");
    fsMock.promises.access.mockResolvedValue(undefined);
    fsMock.promises.writeFile.mockResolvedValue(undefined);
    fsMock.promises.mkdir.mockResolvedValue(undefined);
    collectDiagnosticsMock.mockResolvedValue({ version: "test", platform: "darwin" });
  });

  describe("recovery:reload-app", () => {
    it("rejects untrusted sender and does not call loadURL", async () => {
      const sender = buildSender();
      registerRecoveryHandlers(deps);
      const handler = getHandlerFn("recovery:reload-app");

      await expect(handler(buildEvent(UNTRUSTED_URL, sender))).rejects.toThrow(
        "recovery:reload-app rejected: untrusted sender"
      );
      expect(sender.loadURL).not.toHaveBeenCalled();
    });

    it("rejects the main renderer URL (not the recovery page)", async () => {
      const sender = buildSender();
      registerRecoveryHandlers(deps);
      const handler = getHandlerFn("recovery:reload-app");

      await expect(handler(buildEvent(MAIN_RENDERER_URL, sender))).rejects.toThrow(
        "recovery:reload-app rejected: untrusted sender"
      );
      expect(sender.loadURL).not.toHaveBeenCalled();
    });

    it("rejects missing senderFrame", async () => {
      const sender = buildSender();
      registerRecoveryHandlers(deps);
      const handler = getHandlerFn("recovery:reload-app");

      await expect(handler(buildEvent(null, sender))).rejects.toThrow(
        "recovery:reload-app rejected: untrusted sender"
      );
      expect(sender.loadURL).not.toHaveBeenCalled();
    });

    it("loads the app into the view showing the recovery page, not the primary window", async () => {
      const primary = buildWindow();
      const sender = buildSender();
      const localDeps = {
        mainWindow: primary,
        windowRegistry: { getPrimary: () => ({ browserWindow: primary }) },
      } as unknown as HandlerDependencies;
      registerRecoveryHandlers(localDeps);
      const handler = getHandlerFn("recovery:reload-app");

      await handler(buildEvent(TRUSTED_RECOVERY_URL, sender));

      expect(sender.loadURL).toHaveBeenCalledTimes(1);
      expect(sender.loadURL).toHaveBeenCalledWith(DEV_APP_URL);
      expect(primary.loadURL).not.toHaveBeenCalled();
    });

    it("restores the startup view's project-scoped entry URL", async () => {
      const sender = buildSender();
      recordEntry(sender, STARTUP_VIEW_URL);
      registerRecoveryHandlers(deps);
      const handler = getHandlerFn("recovery:reload-app");

      await handler(buildEvent(TRUSTED_RECOVERY_URL, sender));

      expect(sender.loadURL).toHaveBeenCalledWith(STARTUP_VIEW_URL);
    });

    it("restores each view's own entry URL, not another window's", async () => {
      const otherWindowView = buildSender();
      recordEntry(otherWindowView, "http://localhost:5173/?projectId=project-b");
      const sender = buildSender();
      recordEntry(sender, STARTUP_VIEW_URL);
      registerRecoveryHandlers(deps);
      const handler = getHandlerFn("recovery:reload-app");

      await handler(buildEvent(TRUSTED_RECOVERY_URL, sender));

      expect(sender.loadURL).toHaveBeenCalledWith(STARTUP_VIEW_URL);
      expect(otherWindowView.loadURL).not.toHaveBeenCalled();
    });

    it("logs a rejected navigation instead of leaving it unhandled", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const sender = buildSender();
        sender.loadURL.mockRejectedValueOnce(new Error("ERR_FAILED"));
        registerRecoveryHandlers(deps);
        const handler = getHandlerFn("recovery:reload-app");

        await expect(handler(buildEvent(TRUSTED_RECOVERY_URL, sender))).resolves.toBeUndefined();
        await vi.waitFor(() =>
          expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining("reload failed to load"),
            expect.objectContaining({ message: "ERR_FAILED" })
          )
        );
      } finally {
        errorSpy.mockRestore();
      }
    });

    describe("in production", () => {
      beforeEach(() => vi.stubEnv("NODE_ENV", "production"));
      afterEach(() => vi.unstubAllEnvs());

      it("restores the project-scoped app:// entry URL", async () => {
        const sender = buildSender();
        recordEntry(sender, PROD_STARTUP_VIEW_URL);
        registerRecoveryHandlers(deps);
        const handler = getHandlerFn("recovery:reload-app");

        await handler(buildEvent(PROD_RECOVERY_URL, sender));

        expect(sender.loadURL).toHaveBeenCalledWith(PROD_STARTUP_VIEW_URL);
      });

      it("loads the static app:// entry into a project view, whose project rides in its preload args", async () => {
        const sender = buildSender();
        registerRecoveryHandlers(deps);
        const handler = getHandlerFn("recovery:reload-app");

        await handler(buildEvent(PROD_RECOVERY_URL, sender));

        expect(sender.loadURL).toHaveBeenCalledWith(MAIN_RENDERER_URL);
      });
    });

    it("is a no-op when the sender's webContents is destroyed", async () => {
      const sender = buildSender();
      sender.isDestroyed.mockReturnValue(true);
      registerRecoveryHandlers(deps);
      const handler = getHandlerFn("recovery:reload-app");

      await expect(handler(buildEvent(TRUSTED_RECOVERY_URL, sender))).resolves.toBeUndefined();
      expect(sender.loadURL).not.toHaveBeenCalled();
    });
  });

  describe("recovery:reset-and-reload", () => {
    it("rejects untrusted sender and does not reset state or reload", async () => {
      const { getCrashRecoveryService: getCrash } =
        await import("../../../services/CrashRecoveryService.js");
      const resetMock = vi.fn();
      vi.mocked(getCrash).mockReturnValue({
        resetToFresh: resetMock,
      } as unknown as ReturnType<typeof getCrash>);

      const sender = buildSender();
      registerRecoveryHandlers(deps);
      const handler = getHandlerFn("recovery:reset-and-reload");

      await expect(handler(buildEvent(UNTRUSTED_URL, sender))).rejects.toThrow(
        "recovery:reset-and-reload rejected: untrusted sender"
      );
      expect(resetMock).not.toHaveBeenCalled();
      expect(sender.loadURL).not.toHaveBeenCalled();
    });

    it("resets state, clears the pending crash, then reloads the sending view", async () => {
      const { getCrashRecoveryService: getCrash } =
        await import("../../../services/CrashRecoveryService.js");
      const resetMock = vi.fn();
      const clearMock = vi.fn();
      vi.mocked(getCrash).mockReturnValue({
        resetToFresh: resetMock,
        clearPendingCrash: clearMock,
      } as unknown as ReturnType<typeof getCrash>);

      const primary = buildWindow();
      const sender = buildSender();
      recordEntry(sender, STARTUP_VIEW_URL);
      const localDeps = {
        mainWindow: primary,
        windowRegistry: { getPrimary: () => ({ browserWindow: primary }) },
      } as unknown as HandlerDependencies;
      registerRecoveryHandlers(localDeps);
      const handler = getHandlerFn("recovery:reset-and-reload");

      await handler(buildEvent(TRUSTED_RECOVERY_URL, sender));

      expect(resetMock).toHaveBeenCalledTimes(1);
      // Without clearing the in-memory record, the reload's app:boot re-reads
      // it and re-presents the dialog with the backup already gone (#10809).
      expect(clearMock).toHaveBeenCalledTimes(1);
      expect(sender.loadURL).toHaveBeenCalledTimes(1);
      expect(sender.loadURL).toHaveBeenCalledWith(STARTUP_VIEW_URL);
      expect(primary.loadURL).not.toHaveBeenCalled();
      expect(resetMock.mock.invocationCallOrder[0]).toBeLessThan(
        clearMock.mock.invocationCallOrder[0]
      );
      expect(clearMock.mock.invocationCallOrder[0]).toBeLessThan(
        sender.loadURL.mock.invocationCallOrder[0]
      );
    });

    it("does not reset when the sender's webContents is destroyed", async () => {
      const { getCrashRecoveryService: getCrash } =
        await import("../../../services/CrashRecoveryService.js");
      const resetMock = vi.fn();
      vi.mocked(getCrash).mockReturnValue({
        resetToFresh: resetMock,
      } as unknown as ReturnType<typeof getCrash>);

      const sender = buildSender();
      sender.isDestroyed.mockReturnValue(true);
      registerRecoveryHandlers(deps);
      const handler = getHandlerFn("recovery:reset-and-reload");

      await expect(handler(buildEvent(TRUSTED_RECOVERY_URL, sender))).resolves.toBeUndefined();
      expect(resetMock).not.toHaveBeenCalled();
      expect(sender.loadURL).not.toHaveBeenCalled();
    });
  });

  describe("recovery:export-diagnostics", () => {
    it("rejects untrusted sender and does not collect diagnostics, show dialog, or write file", async () => {
      registerRecoveryHandlers(deps);
      const handler = getHandlerFn("recovery:export-diagnostics");
      await expect(handler(buildEvent(UNTRUSTED_URL))).rejects.toThrow(
        "recovery:export-diagnostics rejected: untrusted sender"
      );
      expect(collectDiagnosticsMock).not.toHaveBeenCalled();
      expect(dialogMock.showSaveDialog).not.toHaveBeenCalled();
      expect(fsMock.promises.writeFile).not.toHaveBeenCalled();
    });

    it("propagates fs.writeFile failures without calling showItemInFolder", async () => {
      dialogMock.showSaveDialog.mockResolvedValue({
        canceled: false,
        filePath: "/tmp/diagnostics.json",
      });
      fsMock.promises.writeFile.mockRejectedValueOnce(
        Object.assign(new Error("no space"), { code: "ENOSPC" })
      );
      registerRecoveryHandlers(deps);
      const handler = getHandlerFn("recovery:export-diagnostics");

      await expect(handler(buildEvent(TRUSTED_RECOVERY_URL))).rejects.toThrow("no space");
      expect(shellMock.showItemInFolder).not.toHaveBeenCalled();
    });

    it("writes file and reveals it on success", async () => {
      dialogMock.showSaveDialog.mockResolvedValue({
        canceled: false,
        filePath: "/tmp/diagnostics.json",
      });
      registerRecoveryHandlers(deps);
      const handler = getHandlerFn("recovery:export-diagnostics");

      const result = await handler(buildEvent(TRUSTED_RECOVERY_URL));

      expect(result).toBe(true);
      expect(fsMock.promises.writeFile).toHaveBeenCalledWith(
        "/tmp/diagnostics.json",
        expect.stringContaining('"version"'),
        "utf-8"
      );
      expect(shellMock.showItemInFolder).toHaveBeenCalledWith("/tmp/diagnostics.json");
    });

    it("returns false and does not write when user cancels", async () => {
      dialogMock.showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined });
      registerRecoveryHandlers(deps);
      const handler = getHandlerFn("recovery:export-diagnostics");

      const result = await handler(buildEvent(TRUSTED_RECOVERY_URL));

      expect(result).toBe(false);
      expect(fsMock.promises.writeFile).not.toHaveBeenCalled();
      expect(shellMock.showItemInFolder).not.toHaveBeenCalled();
    });

    it("parents the save dialog to the window that owns the sending view", async () => {
      const { getWindowForWebContents } = await import("../../../window/webContentsRegistry.js");
      const parentWin = { isDestroyed: vi.fn(() => false) };
      const primary = { isDestroyed: vi.fn(() => false) };
      vi.mocked(getWindowForWebContents).mockReturnValueOnce(
        parentWin as unknown as ReturnType<typeof getWindowForWebContents>
      );
      const localDeps = {
        windowRegistry: { getPrimary: () => ({ browserWindow: primary }) },
      } as unknown as HandlerDependencies;
      dialogMock.showSaveDialog.mockResolvedValue({
        canceled: false,
        filePath: "/tmp/diagnostics.json",
      });
      registerRecoveryHandlers(localDeps);
      const handler = getHandlerFn("recovery:export-diagnostics");

      await handler(buildEvent(TRUSTED_RECOVERY_URL));

      expect(dialogMock.showSaveDialog).toHaveBeenCalledWith(parentWin, expect.any(Object));
    });

    it("falls back to parentless dialog when no parent window is available", async () => {
      dialogMock.showSaveDialog.mockResolvedValue({
        canceled: false,
        filePath: "/tmp/diagnostics.json",
      });
      registerRecoveryHandlers(deps);
      const handler = getHandlerFn("recovery:export-diagnostics");

      await handler(buildEvent(TRUSTED_RECOVERY_URL));

      expect(dialogMock.showSaveDialog).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Save Diagnostics" })
      );
    });
  });

  describe("recovery:open-logs", () => {
    it("rejects untrusted sender and does not open anything", async () => {
      registerRecoveryHandlers(deps);
      const handler = getHandlerFn("recovery:open-logs");
      await expect(handler(buildEvent(UNTRUSTED_URL))).rejects.toThrow(
        "recovery:open-logs rejected: untrusted sender"
      );
      expect(shellMock.openPath).not.toHaveBeenCalled();
    });

    it("opens the log file exactly once when the file exists and openPath succeeds", async () => {
      fsMock.promises.access.mockResolvedValue(undefined);
      shellMock.openPath.mockResolvedValue("");
      registerRecoveryHandlers(deps);
      const handler = getHandlerFn("recovery:open-logs");

      await handler(buildEvent(TRUSTED_RECOVERY_URL));

      expect(shellMock.openPath).toHaveBeenCalledTimes(1);
      expect(shellMock.openPath).toHaveBeenCalledWith("/tmp/daintree/logs/main.log");
    });

    it("creates the log file and opens it when ENOENT", async () => {
      const enoent = Object.assign(new Error("not found"), { code: "ENOENT" });
      fsMock.promises.access.mockRejectedValue(enoent);
      fsMock.promises.mkdir.mockResolvedValue(undefined);
      fsMock.promises.writeFile.mockResolvedValue(undefined);
      shellMock.openPath.mockResolvedValue("");
      registerRecoveryHandlers(deps);
      const handler = getHandlerFn("recovery:open-logs");

      await handler(buildEvent(TRUSTED_RECOVERY_URL));

      expect(fsMock.promises.mkdir).toHaveBeenCalledWith("/tmp/daintree/logs", {
        recursive: true,
      });
      expect(fsMock.promises.writeFile).toHaveBeenCalledWith(
        "/tmp/daintree/logs/main.log",
        "",
        "utf8"
      );
      expect(shellMock.openPath).toHaveBeenCalledWith("/tmp/daintree/logs/main.log");
    });

    it("falls back to opening the log directory on non-ENOENT errors", async () => {
      fsMock.promises.access.mockRejectedValue(
        Object.assign(new Error("permission denied"), { code: "EACCES" })
      );
      shellMock.openPath.mockResolvedValue("");
      registerRecoveryHandlers(deps);
      const handler = getHandlerFn("recovery:open-logs");

      await handler(buildEvent(TRUSTED_RECOVERY_URL));

      expect(shellMock.openPath).toHaveBeenCalledWith("/tmp/daintree/logs");
    });

    it("falls back to opening the directory when openPath returns an error string", async () => {
      fsMock.promises.access.mockResolvedValue(undefined);
      shellMock.openPath.mockResolvedValueOnce("Error: no association").mockResolvedValueOnce("");
      registerRecoveryHandlers(deps);
      const handler = getHandlerFn("recovery:open-logs");

      await handler(buildEvent(TRUSTED_RECOVERY_URL));

      expect(shellMock.openPath).toHaveBeenNthCalledWith(1, "/tmp/daintree/logs/main.log");
      expect(shellMock.openPath).toHaveBeenNthCalledWith(2, "/tmp/daintree/logs");
    });

    it("throws when every openPath attempt returns an error string", async () => {
      fsMock.promises.access.mockResolvedValue(undefined);
      shellMock.openPath.mockResolvedValue("Error: no association");
      registerRecoveryHandlers(deps);
      const handler = getHandlerFn("recovery:open-logs");

      await expect(handler(buildEvent(TRUSTED_RECOVERY_URL))).rejects.toThrow(
        "recovery:open-logs failed"
      );
      expect(shellMock.openPath).toHaveBeenNthCalledWith(1, "/tmp/daintree/logs/main.log");
      expect(shellMock.openPath).toHaveBeenNthCalledWith(2, "/tmp/daintree/logs");
    });

    it("throws when ENOENT recovery also fails to open the directory", async () => {
      const enoent = Object.assign(new Error("not found"), { code: "ENOENT" });
      fsMock.promises.access.mockRejectedValue(enoent);
      fsMock.promises.mkdir.mockResolvedValue(undefined);
      fsMock.promises.writeFile.mockResolvedValue(undefined);
      shellMock.openPath.mockResolvedValue("Error: no association");
      registerRecoveryHandlers(deps);
      const handler = getHandlerFn("recovery:open-logs");

      await expect(handler(buildEvent(TRUSTED_RECOVERY_URL))).rejects.toThrow(
        "recovery:open-logs failed"
      );
    });
  });
});
