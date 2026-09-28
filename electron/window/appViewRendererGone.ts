/**
 * Window-level render-process-gone recovery for the window's own app view —
 * the startup view, or the project picker in an unbound window. Views the
 * ProjectViewManager creates later carry their own copy in
 * ProjectViewHandlers. Extracted from createWindow so it can be tested
 * against the real handler.
 */

import { app, BrowserWindow, type WebContents } from "electron";
import { getCrashRecoveryService } from "../services/CrashRecoveryService.js";
import { notifyError } from "../ipc/errorHandlers.js";
import {
  beginWindowRecreating,
  endWindowRecreating,
  isWindowRecreating,
} from "../lifecycle/windowRecreationState.js";
import { readAvailableSystemMemoryMb } from "../utils/systemMemory.js";
import { logError, logWarn } from "../utils/logger.js";
import type { ProjectViewManager } from "./ProjectViewManager.js";
import { rendererReloadNotice } from "./rendererReloadNotice.js";
import { getTerminationIntent } from "../services/processTerminationIntent.js";

const CRASH_LOOP_WINDOW_MS = 60_000;
const CRASH_LOOP_THRESHOLD = 3;

export interface AppViewRendererGoneOptions {
  win: BrowserWindow;
  appWebContents: WebContents;
  /** Resolved per event: services are wired after the window is created. */
  getProjectViewManager: () => ProjectViewManager | null;
  getRecoveryUrl: (reason: string, exitCode: number) => string;
  onRecreateWindow?: () => Promise<void>;
}

export function attachAppViewRendererGoneHandler(opts: AppViewRendererGoneOptions): void {
  const { win, appWebContents, getProjectViewManager, getRecoveryUrl, onRecreateWindow } = opts;
  const rendererCrashTimestamps: number[] = [];
  const oomRecreationTimestamps: number[] = [];

  appWebContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    const pvm = getProjectViewManager();
    const projectId = pvm?.getProjectIdForWebContents(appWebContents.id) ?? undefined;
    // Straight to daintree.log, so a diagnostics bundle can say why the
    // renderer died (#12954). Eviction is routine and logged as a warning.
    const goneContext = {
      process: "app-view",
      reason: details.reason,
      exitCode: details.exitCode,
      webContentsId: appWebContents.id,
      windowId: win.isDestroyed() ? undefined : win.id,
      projectId,
    };
    if (details.reason === "memory-eviction") {
      logWarn("Renderer process gone", goneContext);
    } else {
      logError("Renderer process gone", undefined, goneContext);
    }
    // Main survives this renderer's death, so it is recorded as a non-fatal
    // event, never as the session's crash. Memory eviction is routine and not
    // recorded at all.
    if (details.reason !== "memory-eviction") {
      getCrashRecoveryService().recordRendererGone({
        process: "app-view",
        projectId,
        webContentsId: appWebContents.id,
        reason: details.reason,
        exitCode: details.exitCode,
      });
    }

    if (win.isDestroyed()) return;

    // Once registerInitialView has claimed this webContents as the active
    // project view, it gets the same crash hook as every other project view
    // (#12954): the PTY port is torn down before the reload re-issues one
    // (#6244), and the assistant is capture-revoked so the reopened panel
    // resumes the conversation instead of displacing a live orphan. Fired
    // synchronously, ahead of every recovery branch, exactly as
    // ProjectViewHandlers does.
    pvm?.notifyActiveViewCrashed(appWebContents);

    // OS-pressure memory eviction: reload without counting toward crash-loop
    // guard (the view goes blank and will not auto-recover on its own).
    if (details.reason === "memory-eviction") {
      // A cached startup view is evicted instead, as ProjectViewHandlers does
      // for every other cached view: reloading a renderer the OS just reclaimed
      // would respawn it under the same pressure.
      if (pvm?.evictCrashedCachedView(appWebContents, "memory-eviction")) return;
      notifyError(new Error("The renderer was reloaded due to memory pressure."), {
        source: "renderer-crash",
      });
      setImmediate(() => {
        if (win.isDestroyed()) return;
        appWebContents.reload();
      });
      return;
    }

    const availableMb = readAvailableSystemMemoryMb();
    const lowMemThresholdMb = pvm?.getLowMemoryFreeThresholdMb() ?? null;
    const isProbableOom =
      details.reason === "oom" ||
      ((details.reason === "crashed" || details.reason === "killed") &&
        lowMemThresholdMb !== null &&
        availableMb !== null &&
        availableMb < lowMemThresholdMb);

    const now = Date.now();
    while (
      rendererCrashTimestamps.length > 0 &&
      now - rendererCrashTimestamps[0] > CRASH_LOOP_WINDOW_MS
    ) {
      rendererCrashTimestamps.shift();
    }
    rendererCrashTimestamps.push(now);

    if (rendererCrashTimestamps.length >= CRASH_LOOP_THRESHOLD) {
      console.error("[MAIN] Crash loop detected, loading recovery page");
      setImmediate(() => {
        if (win.isDestroyed()) return;
        const recoveryUrl = getRecoveryUrl(details.reason, details.exitCode);
        appWebContents.loadURL(recoveryUrl);
      });
    } else if (isProbableOom && onRecreateWindow) {
      const now2 = Date.now();
      while (
        oomRecreationTimestamps.length > 0 &&
        now2 - oomRecreationTimestamps[0] > CRASH_LOOP_WINDOW_MS
      ) {
        oomRecreationTimestamps.shift();
      }
      oomRecreationTimestamps.push(now2);

      if (oomRecreationTimestamps.length >= CRASH_LOOP_THRESHOLD) {
        console.error("[MAIN] OOM crash loop detected, loading recovery page");
        setImmediate(() => {
          if (win.isDestroyed()) return;
          const recoveryUrl = getRecoveryUrl(details.reason, details.exitCode);
          appWebContents.loadURL(recoveryUrl);
        });
      } else {
        console.warn("[MAIN] OOM crash detected, destroying and recreating window");
        notifyError(
          new Error(
            "The window ran out of memory and was automatically recreated. Some state may have been lost."
          ),
          { source: "renderer-crash" }
        );
        setImmediate(() => {
          // Increment the guard before `destroy()` — Electron emits
          // `window-all-closed` synchronously inside the destroy call.
          beginWindowRecreating();
          if (!win.isDestroyed()) win.destroy();
          onRecreateWindow()
            .catch((err) => {
              console.error("[MAIN] Failed to recreate window after OOM:", err);
            })
            .finally(() => {
              endWindowRecreating();
              // The suppressed `window-all-closed` event must be replayed if
              // the recreation failed — otherwise on non-darwin the process
              // hangs headless with no windows and no quit path. Skip when
              // another OOM recreate is still in flight or any window remains
              // (the natural `window-all-closed` path will cover those cases).
              if (
                !isWindowRecreating() &&
                process.platform !== "darwin" &&
                BrowserWindow.getAllWindows().length === 0
              ) {
                app.quit();
              }
            });
        });
      }
    } else if (pvm?.evictCrashedCachedView(appWebContents, "crash")) {
      // Cached behind another project: evicted, not reloaded, so the assistant
      // pinned to it is capture-revoked through the eviction hook exactly as
      // for any other cached view (#12954). Nothing on screen, so no toast.
    } else {
      console.log("[MAIN] Renderer crash, auto-reloading");
      notifyError(
        new Error(
          rendererReloadNotice(
            "The renderer process",
            details.reason,
            getTerminationIntent({ webContentsId: appWebContents.id })
          )
        ),
        {
          source: "renderer-crash",
        }
      );
      setImmediate(() => {
        if (win.isDestroyed()) return;
        appWebContents.reload();
      });
    }
  });
}
