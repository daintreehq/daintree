import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { CHANNELS } from "../channels.js";
import type { HandlerDependencies } from "../types.js";
import { getCrashRecoveryService } from "../../services/CrashRecoveryService.js";
import { getDevServerUrl } from "../../../shared/config/devServer.js";
import { isRecoveryPageUrl } from "../../../shared/utils/trustedRenderer.js";
import { collectDiagnostics } from "../../services/DiagnosticsCollector.js";
import { getLogFilePath } from "../../utils/logger.js";
import { typedHandle } from "../utils.js";

function getAppUrl(): string {
  if (process.env.NODE_ENV === "development") {
    return getDevServerUrl();
  }
  return "app://daintree/index.html";
}

export function registerRecoveryHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  handlers.push(
    typedHandle(CHANNELS.RECOVERY_RELOAD_APP, () => {
      const win = deps.windowRegistry?.getPrimary()?.browserWindow ?? deps.mainWindow;
      if (win && !win.isDestroyed()) {
        console.log("[MAIN] Recovery: reloading app");
        win.loadURL(getAppUrl());
      }
    })
  );

  handlers.push(
    typedHandle(CHANNELS.RECOVERY_RESET_AND_RELOAD, () => {
      const win = deps.windowRegistry?.getPrimary()?.browserWindow ?? deps.mainWindow;
      if (win && !win.isDestroyed()) {
        console.log("[MAIN] Recovery: resetting state and reloading app");
        getCrashRecoveryService().resetToFresh();
        win.loadURL(getAppUrl());
      }
    })
  );

  // These two handlers use raw ipcMain.handle to access event.senderFrame.url
  // synchronously before any await. They are only callable from recovery.html
  // (not the main renderer), so we scope the allowed origin accordingly.
  ipcMain.handle(CHANNELS.RECOVERY_EXPORT_DIAGNOSTICS, async (event): Promise<boolean> => {
    const senderUrl = event.senderFrame?.url;
    if (!senderUrl || !isRecoveryPageUrl(senderUrl)) {
      throw new Error(
        `recovery:export-diagnostics rejected: untrusted sender (url=${senderUrl ?? "unknown"})`
      );
    }

    const payload = await collectDiagnostics(deps);
    const json = JSON.stringify(payload, null, 2);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const parentWin =
      BrowserWindow.fromWebContents(event.sender) ??
      deps.windowRegistry?.getPrimary()?.browserWindow ??
      deps.mainWindow;
    const dialogOpts = {
      title: "Save Diagnostics",
      defaultPath: `daintree-diagnostics-${timestamp}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    };
    const { filePath, canceled } =
      parentWin && !parentWin.isDestroyed()
        ? await dialog.showSaveDialog(parentWin, dialogOpts)
        : await dialog.showSaveDialog(dialogOpts);

    if (canceled || !filePath) return false;

    await fs.writeFile(filePath, json, "utf-8");
    shell.showItemInFolder(filePath);
    return true;
  });
  handlers.push(() => ipcMain.removeHandler(CHANNELS.RECOVERY_EXPORT_DIAGNOSTICS));

  ipcMain.handle(CHANNELS.RECOVERY_OPEN_LOGS, async (event): Promise<void> => {
    const senderUrl = event.senderFrame?.url;
    if (!senderUrl || !isRecoveryPageUrl(senderUrl)) {
      throw new Error(
        `recovery:open-logs rejected: untrusted sender (url=${senderUrl ?? "unknown"})`
      );
    }

    const logFilePath = getLogFilePath();
    const dir = dirname(logFilePath);
    const attempts: string[] = [];

    const tryOpen = async (target: string): Promise<boolean> => {
      const result = await shell.openPath(target);
      if (result) {
        attempts.push(`${target}: ${result}`);
        return false;
      }
      return true;
    };

    try {
      await fs.access(logFilePath);
      if (await tryOpen(logFilePath)) return;
      if (await tryOpen(dir)) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(logFilePath, "", "utf8");
          if (await tryOpen(logFilePath)) return;
        } catch (createErr) {
          attempts.push(`create ${logFilePath}: ${(createErr as Error).message}`);
        }
      } else {
        attempts.push(`access ${logFilePath}: ${(error as Error).message}`);
      }
      if (await tryOpen(dir)) return;
    }

    throw new Error(`recovery:open-logs failed: ${attempts.join("; ") || "unknown error"}`);
  });
  handlers.push(() => ipcMain.removeHandler(CHANNELS.RECOVERY_OPEN_LOGS));

  return () => handlers.forEach((cleanup) => cleanup());
}
