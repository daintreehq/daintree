import { describe, it, expect, vi, beforeEach } from "vitest";

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

const browserWindowMock = vi.hoisted(() => ({
  fromWebContents: vi.fn<() => null | { isDestroyed: () => boolean }>(() => null),
}));

const fsMock = vi.hoisted(() => ({
  promises: {
    writeFile: vi.fn(async () => undefined) as ReturnType<typeof vi.fn>,
    access: vi.fn(async () => undefined) as ReturnType<typeof vi.fn>,
    mkdir: vi.fn(async () => undefined) as ReturnType<typeof vi.fn>,
  },
}));

const collectDiagnosticsMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  dialog: dialogMock,
  shell: shellMock,
  BrowserWindow: browserWindowMock,
}));

vi.mock("node:fs", () => fsMock);

vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: vi.fn(() => null),
  getAppWebContents: vi.fn(),
  getAllAppWebContents: vi.fn(() => []),
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
  })),
}));

vi.mock("../../../services/DiagnosticsCollector.js", () => ({
  collectDiagnostics: collectDiagnosticsMock,
}));

vi.mock("../../../utils/logger.js", () => ({
  getLogFilePath: vi.fn(() => "/tmp/daintree/logs/main.log"),
}));

import { registerRecoveryHandlers } from "../recovery.js";
import type { HandlerDependencies } from "../../types.js";

function getHandlerFn(channelName: string): (...args: unknown[]) => unknown {
  const call = ipcMainMock.handle.mock.calls.find((c: unknown[]) => c[0] === channelName);
  if (!call) throw new Error(`No handler registered for ${channelName}`);
  return call[1] as (...args: unknown[]) => unknown;
}

const TRUSTED_RECOVERY_URL = "app://daintree/recovery.html";
const UNTRUSTED_URL = "https://evil.com/recovery.html";
const MAIN_RENDERER_URL = "app://daintree/index.html";

const SENDER = { id: 1 };

function buildEvent(url: string | null) {
  return {
    senderFrame: url === null ? null : { url },
    sender: SENDER,
  };
}

describe("registerRecoveryHandlers", () => {
  const deps = { mainWindow: undefined } as HandlerDependencies;

  beforeEach(() => {
    vi.clearAllMocks();
    shellMock.openPath.mockResolvedValue("");
    browserWindowMock.fromWebContents.mockReturnValue(null);
    fsMock.promises.access.mockResolvedValue(undefined);
    fsMock.promises.writeFile.mockResolvedValue(undefined);
    fsMock.promises.mkdir.mockResolvedValue(undefined);
    collectDiagnosticsMock.mockResolvedValue({ version: "test", platform: "darwin" });
  });

  it("registers export-diagnostics and open-logs via typedHandleWithContext", () => {
    registerRecoveryHandlers(deps);
    expect(ipcMainMock.handle).toHaveBeenCalledWith(
      "recovery:export-diagnostics",
      expect.any(Function)
    );
    expect(ipcMainMock.handle).toHaveBeenCalledWith("recovery:open-logs", expect.any(Function));
  });

  it("cleanup removes the handlers", () => {
    const cleanup = registerRecoveryHandlers(deps);
    cleanup();
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("recovery:export-diagnostics");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("recovery:open-logs");
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

    it("rejects the main renderer URL (not the recovery page)", async () => {
      registerRecoveryHandlers(deps);
      const handler = getHandlerFn("recovery:export-diagnostics");
      await expect(handler(buildEvent(MAIN_RENDERER_URL))).rejects.toThrow(
        "recovery:export-diagnostics rejected: untrusted sender"
      );
      expect(dialogMock.showSaveDialog).not.toHaveBeenCalled();
    });

    it("rejects missing senderFrame", async () => {
      registerRecoveryHandlers(deps);
      const handler = getHandlerFn("recovery:export-diagnostics");
      await expect(handler(buildEvent(null))).rejects.toThrow(
        "recovery:export-diagnostics rejected: untrusted sender"
      );
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

    it("parents the save dialog to the sender's BrowserWindow when available", async () => {
      const parentWin = { isDestroyed: vi.fn(() => false) };
      browserWindowMock.fromWebContents.mockReturnValue(parentWin);
      dialogMock.showSaveDialog.mockResolvedValue({
        canceled: false,
        filePath: "/tmp/diagnostics.json",
      });
      registerRecoveryHandlers(deps);
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
