/**
 * Persistent per-view WebContents handlers for ProjectViewManager — security
 * guards (window-open, navigation, webview attach), input shortcuts, the
 * did-finish-load onViewReady hook, and render-process-gone crash recovery
 * (crash-loop detection, OOM window recreate, OS memory-eviction handling).
 * Extracted from ProjectViewManager (#11004).
 */

import { app, BrowserWindow, type WebContentsView } from "electron";
import path from "path";
import { canOpenExternalUrl, openExternalUrl } from "../utils/openExternal.js";
import { getCrashRecoveryService } from "../services/CrashRecoveryService.js";
import { isRendererOwnedShortcut } from "../services/menuAccelerators.js";
import { isTrustedRendererUrl } from "../../shared/utils/trustedRenderer.js";
import { isLocalhostUrl, isDevPreviewProxyUrl } from "../../shared/utils/urlUtils.js";
import { isBrowserPartition } from "../../shared/utils/partitionUtils.js";
import { CHANNELS } from "../ipc/channels.js";
import { notifyError } from "../ipc/errorHandlers.js";
import { getDevServerUrl } from "../../shared/config/devServer.js";
import {
  attachRendererConsoleCapture,
  detachRendererConsoleCapture,
} from "./rendererConsoleCapture.js";
import {
  beginWindowRecreating,
  endWindowRecreating,
  isWindowRecreating,
} from "../lifecycle/windowRecreationState.js";
import { evictDeadView, getAvailableMemoryMb } from "./ProjectViewEvictionController.js";
import type { ProjectViewManager } from "./ProjectViewManager.js";
import type { ViewEntry } from "./ProjectViewManagerTypes.js";

const CRASH_LOOP_WINDOW_MS = 60_000;
const CRASH_LOOP_THRESHOLD = 3;

export function setupViewHandlers(
  host: ProjectViewManager,
  view: WebContentsView,
  entry: ViewEntry
): void {
  const wc = view.webContents;
  const win = host.win;

  attachRendererConsoleCapture(wc);

  wc.setWindowOpenHandler(({ url }) => {
    if (url && canOpenExternalUrl(url)) {
      void openExternalUrl(url).catch((error) => {
        console.error("[ProjectViewManager] Failed to open external URL:", error);
      });
    } else {
      console.warn(`[ProjectViewManager] Blocked window.open for unsupported URL: ${url}`);
    }
    return { action: "deny" };
  });

  const handleWillNavigate = (event: Electron.Event, navigationUrl: string) => {
    if (!isTrustedRendererUrl(navigationUrl)) {
      console.error("[ProjectViewManager] Blocked navigation to untrusted URL:", navigationUrl);
      event.preventDefault();
    }
  };

  const handleWillRedirect = (event: Electron.Event, redirectUrl: string) => {
    if (!isTrustedRendererUrl(redirectUrl)) {
      console.error("[ProjectViewManager] Blocked redirect to untrusted URL:", redirectUrl);
      event.preventDefault();
    }
  };

  const handleWillAttachWebview = (
    event: Electron.Event,
    webPreferences: Electron.WebPreferences,
    params: Record<string, string>
  ) => {
    // Dev-preview webviews load the stable proxy origin (dp-*.localhost), which
    // isLocalhostUrl rejects — accept it explicitly (#9100).
    const isAllowedLocalhostUrl = isLocalhostUrl(params.src) || isDevPreviewProxyUrl(params.src);
    const partition = params.partition ?? "";
    const isValidPartition =
      isBrowserPartition(partition) ||
      partition === "persist:dev-preview" ||
      partition.startsWith("persist:dev-preview-");

    if (!isAllowedLocalhostUrl || !isValidPartition) {
      console.warn(
        `[ProjectViewManager] Blocked webview: url=${params.src}, partition=${params.partition}`
      );
      event.preventDefault();
      return;
    }

    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.navigateOnDragDrop = false;
    webPreferences.disableBlinkFeatures = "Auxclick";
    webPreferences.partition = params.partition;
  };

  const handleBeforeInputEvent = (event: Electron.Event, input: Electron.Input) => {
    const isMac = process.platform === "darwin";
    const key = input.key.toLowerCase();
    const isTerminalFocusShortcut =
      input.type === "keyDown" &&
      (key === "tab" || input.code === "Tab") &&
      input.control &&
      !input.meta &&
      !input.alt;
    if (isTerminalFocusShortcut) {
      event.preventDefault();
      wc.send(CHANNELS.MENU_ACTION, {
        actionId: input.shift ? "terminal.focusPrevious" : "terminal.focusNext",
      });
      return;
    }

    const isCloseShortcut =
      input.type === "keyDown" &&
      key === "w" &&
      ((isMac && input.meta && !input.control) || (!isMac && input.control && !input.meta)) &&
      !input.alt;
    // Mirrors createWindow.ts: renderer-owned menu accelerators yield to the
    // renderer's KeybindingService per-event on every platform
    // (see menuAccelerators.ts).
    wc.setIgnoreMenuShortcuts(isCloseShortcut || isRendererOwnedShortcut(input));
  };

  // Fire onViewReady on load/reload, but ONLY for the active view.
  // A cached view reloading (e.g. after crash recovery) must not steal
  // the PTY MessagePort from the currently visible view.
  const handleDidFinishLoad = () => {
    if (wc.isDestroyed()) return;
    const projectId = host.webContentsToProject.get(wc.id);
    if (projectId && projectId === host.activeProjectId) {
      host.onViewReady?.(wc);
    }
  };

  const handleRenderProcessGone = (
    _event: Electron.Event,
    details: Electron.RenderProcessGoneDetails
  ) => {
    if (details.reason === "clean-exit") return;

    const projectId = host.webContentsToProject.get(wc.id);
    console.error(
      `[ProjectViewManager] View renderer gone (project: ${projectId}):`,
      details.reason,
      details.exitCode
    );
    // Memory eviction is not a crash — skip the one-shot crash log so a
    // genuine crash in the same session can still be recorded.
    if (details.reason !== "memory-eviction") {
      getCrashRecoveryService().recordCrash(
        new Error(`View renderer gone: ${details.reason} (exit code ${details.exitCode})`)
      );
    }

    if (win.isDestroyed()) return;

    const crashEntry = projectId ? host.views.get(projectId) : null;

    // If the view is still loading, loadView's one-shot handler will handle
    // the failure and trigger rollback — skip crash recovery here.
    if (crashEntry?.state === "loading") return;

    // Synchronously notify subscribers (e.g. PtyClient) so per-window
    // MessagePorts can be torn down before reload re-issues fresh ones.
    // Without this, a stale port can keep PortQueueManager wedged in a
    // backpressure-pause loop for the entire reload window (#6244).
    // Scoped to the active project: only the active view ever owns the
    // per-window port (handleDidFinishLoad gates onViewReady on
    // activeProjectId), so a cached-view crash must not tear it down.
    if (projectId && projectId === host.activeProjectId) {
      host.onViewCrashed?.(wc);
    }

    // "oom" is Windows-specific (pagefile exhaustion). On macOS/Linux, V8
    // heap exhaustion surfaces as "crashed" and the OS OOM-killer surfaces
    // as "killed". We detect probable OOM by checking available memory
    // against the profile threshold. exitCode is intentionally not used —
    // sources disagree on its value for V8 heap OOM (5 vs 132).
    // Performance profile sets the threshold to null to disable the
    // heuristic for memory-unconstrained sessions.
    const availableMb = getAvailableMemoryMb();
    const isProbableOom =
      details.reason === "oom" ||
      ((details.reason === "crashed" || details.reason === "killed") &&
        host.lowMemoryFreeThresholdMb !== null &&
        availableMb !== null &&
        availableMb < host.lowMemoryFreeThresholdMb);

    // OS-pressure memory eviction is distinct from a crash: the renderer is
    // reclaimed by the OS without a V8 abort. For the ACTIVE view the blank
    // frame is user-visible, so an explicit reload is required. It does not
    // count toward the crash-loop guard because repeated OS evictions under
    // memory pressure are not a sign of a looping crash bug.
    if (details.reason === "memory-eviction") {
      if (projectId && projectId === host.activeProjectId) {
        notifyError(new Error("A project view was reloaded due to memory pressure."), {
          source: "renderer-crash",
        });
        setImmediate(() => {
          if (!wc.isDestroyed()) wc.reload();
        });
        return;
      }
      // Cached view: the OS reclaimed this renderer precisely because
      // memory is scarce. A background reload would immediately respawn a
      // full renderer (~100-500 MB) under the same pressure — and since
      // memory-eviction is exempt from the crash-loop guard, the
      // evict→reload→evict cycle has no backstop. Treat it as an LRU
      // eviction instead: memory stays reclaimed and the next visit goes
      // through the existing cold-start paint-gate path.
      if (projectId && crashEntry?.state === "cached") {
        console.warn(
          `[ProjectViewManager] Cached view reclaimed by OS memory pressure; evicting (project: ${projectId})`
        );
        evictDeadView(host, projectId, wc, "memory-eviction");
        return;
      }
      setImmediate(() => {
        if (!wc.isDestroyed()) wc.reload();
      });
      return;
    }

    const crashTimestamps = crashEntry?.crashTimestamps ?? [];
    const now = Date.now();
    while (crashTimestamps.length > 0 && now - crashTimestamps[0] > CRASH_LOOP_WINDOW_MS) {
      crashTimestamps.shift();
    }
    crashTimestamps.push(now);

    if (crashTimestamps.length >= CRASH_LOOP_THRESHOLD) {
      console.error("[ProjectViewManager] Crash loop detected, loading recovery page");
      setImmediate(() => {
        if (wc.isDestroyed()) return;
        const params = new URLSearchParams({
          reason: details.reason,
          exitCode: String(details.exitCode),
        });
        if (crashEntry?.projectPath) {
          params.set("project", path.basename(crashEntry.projectPath));
        }
        const recoverySvc = getCrashRecoveryService();
        const backupTimestamp = recoverySvc.getLastBackupTimestamp();
        if (backupTimestamp !== null) {
          params.set("backupTimestamp", String(backupTimestamp));
        }
        const panelCount = recoverySvc.getBackupPanelCount(true);
        if (panelCount !== null) {
          params.set("panelCount", String(panelCount));
        }
        if (process.env.NODE_ENV === "development") {
          wc.loadURL(`${getDevServerUrl()}/recovery.html?${params}`);
        } else {
          wc.loadURL(`app://daintree/recovery.html?${params}`);
        }
      });
    } else if (isProbableOom && host.onRecreateWindow) {
      console.warn("[ProjectViewManager] OOM crash, destroying and recreating window");
      notifyError(new Error("A project view ran out of memory and the window was recreated."), {
        source: "renderer-crash",
      });
      setImmediate(() => {
        // Increment the guard before `destroy()` — Electron emits
        // `window-all-closed` synchronously inside the destroy call.
        beginWindowRecreating();
        if (!win.isDestroyed()) win.destroy();
        host.onRecreateWindow!()
          .catch((err) => {
            console.error("[ProjectViewManager] Failed to recreate window after OOM:", err);
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
    } else if (projectId && projectId !== host.activeProjectId && crashEntry?.state === "cached") {
      // A crashed cached view has no user-visible reason to be resurrected
      // in the background — evict it and let the next visit cold-start
      // instead of paying a full renderer respawn now.
      console.warn(
        `[ProjectViewManager] Cached view crashed; evicting instead of background reload (project: ${projectId})`
      );
      evictDeadView(host, projectId, wc, "crash");
    } else {
      console.log("[ProjectViewManager] Renderer crash, auto-reloading view");
      if (projectId && projectId === host.activeProjectId) {
        notifyError(new Error("A project view crashed and was automatically reloaded."), {
          source: "renderer-crash",
        });
      }
      setImmediate(() => {
        if (!wc.isDestroyed()) wc.reload();
      });
    }
  };

  wc.on("will-navigate", handleWillNavigate);
  wc.on("will-redirect", handleWillRedirect);
  wc.on("will-attach-webview", handleWillAttachWebview);
  wc.on("before-input-event", handleBeforeInputEvent);
  wc.on("did-finish-load", handleDidFinishLoad);
  wc.on("render-process-gone", handleRenderProcessGone);

  // Capture wc in closure: post-eviction the view's webContents getter may be
  // undefined (Electron #50249). Removing listeners must happen before close()
  // so any queued event from Chromium cannot fire against stale view state.
  let cleaned = false;
  entry.cleanupHandlers = () => {
    if (cleaned) return;
    wc.removeListener("will-navigate", handleWillNavigate);
    wc.removeListener("will-redirect", handleWillRedirect);
    wc.removeListener("will-attach-webview", handleWillAttachWebview);
    wc.removeListener("before-input-event", handleBeforeInputEvent);
    wc.removeListener("did-finish-load", handleDidFinishLoad);
    wc.removeListener("render-process-gone", handleRenderProcessGone);
    detachRendererConsoleCapture(wc);
    cleaned = true;
  };

  // Fullscreen events are handled by the window-level resize handler
  // and the sendToRenderer in createWindow.ts — no per-view listeners needed.
}
