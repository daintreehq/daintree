import { dialog, shell, type WebContents } from "electron";
import { openWithDefaultApp } from "../../utils/openPath.js";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { CHANNELS } from "../channels.js";
import type { HandlerDependencies } from "../types.js";
import { getCrashRecoveryService } from "../../services/CrashRecoveryService.js";
import { getAppEntryUrl } from "../../window/appEntryUrl.js";
import { isRecoveryPageUrl } from "../../../shared/utils/trustedRenderer.js";
// Lazy-imported below (recovery export is only triggered from recovery.html
// by user action — keeps DiagnosticsCollector and its archiver/v8 deps out
// of the eager-import graph).
import { getLogFilePath } from "../../utils/logger.js";
import { typedHandleWithContext } from "../utils.js";

function loadAppInView(sender: WebContents, label: string): void {
  const url = getAppEntryUrl(sender);
  sender.loadURL(url).catch((err: unknown) => {
    console.error(`[MAIN] Recovery: ${label} failed to load ${url}:`, err);
  });
}

// All four recovery handlers validate event.senderFrame.url synchronously
// (before any await) to accept calls only from recovery.html — not the main
// renderer or arbitrary frames. typedHandleWithContext exposes the event via
// ctx so the origin check runs before any side effects.
export function registerRecoveryHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  handlers.push(
    typedHandleWithContext(CHANNELS.RECOVERY_RELOAD_APP, async (ctx): Promise<void> => {
      const senderUrl = ctx.event?.senderFrame?.url;
      if (!senderUrl || !isRecoveryPageUrl(senderUrl)) {
        throw new Error(
          `recovery:reload-app rejected: untrusted sender (url=${senderUrl ?? "unknown"})`
        );
      }

      const sender = ctx.event?.sender;
      if (!sender || sender.isDestroyed()) return;
      console.log("[MAIN] Recovery: reloading app");
      loadAppInView(sender, "reload");
    })
  );

  handlers.push(
    typedHandleWithContext(CHANNELS.RECOVERY_RESET_AND_RELOAD, async (ctx): Promise<void> => {
      const senderUrl = ctx.event?.senderFrame?.url;
      if (!senderUrl || !isRecoveryPageUrl(senderUrl)) {
        throw new Error(
          `recovery:reset-and-reload rejected: untrusted sender (url=${senderUrl ?? "unknown"})`
        );
      }

      const sender = ctx.event?.sender;
      if (!sender || sender.isDestroyed()) return;
      console.log("[MAIN] Recovery: resetting state and reloading app");
      const service = getCrashRecoveryService();
      service.resetToFresh();
      // Drop the in-memory pending-crash record too — the reload below
      // fires app:boot, which re-reads getPendingCrash(); without this the
      // recovery dialog reappears immediately with the backup already
      // deleted from disk (#10809, same surface as LRU switch-back).
      service.clearPendingCrash();
      loadAppInView(sender, "reset-and-reload");
    })
  );

  handlers.push(
    typedHandleWithContext(CHANNELS.RECOVERY_EXPORT_DIAGNOSTICS, async (ctx): Promise<boolean> => {
      const senderUrl = ctx.event?.senderFrame?.url;
      if (!senderUrl || !isRecoveryPageUrl(senderUrl)) {
        throw new Error(
          `recovery:export-diagnostics rejected: untrusted sender (url=${senderUrl ?? "unknown"})`
        );
      }

      const { collectDiagnostics } = await import("../../services/DiagnosticsCollector.js");
      const payload = await collectDiagnostics(deps);
      const json = JSON.stringify(payload, null, 2);

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      // BrowserWindow.fromWebContents() is null for a WebContentsView, which is
      // where recovery.html lives; senderWindow resolves through the registry.
      const parentWin =
        ctx.senderWindow ?? deps.windowRegistry?.getPrimary()?.browserWindow ?? deps.mainWindow;
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
    })
  );

  handlers.push(
    typedHandleWithContext(CHANNELS.RECOVERY_OPEN_LOGS, async (ctx): Promise<void> => {
      const senderUrl = ctx.event?.senderFrame?.url;
      if (!senderUrl || !isRecoveryPageUrl(senderUrl)) {
        throw new Error(
          `recovery:open-logs rejected: untrusted sender (url=${senderUrl ?? "unknown"})`
        );
      }

      const logFilePath = getLogFilePath();
      const dir = dirname(logFilePath);
      const attempts: string[] = [];

      const tryOpen = async (target: string): Promise<boolean> => {
        const result = await openWithDefaultApp(target);
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
    })
  );

  return () => handlers.forEach((cleanup) => cleanup());
}
