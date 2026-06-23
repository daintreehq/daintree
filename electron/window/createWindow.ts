// eager-import-allow: reads persisted window state via store.get synchronously when creating the window
import { app, BrowserWindow, WebContentsView, dialog, ipcMain, session } from "electron";
import {
  getWindowForWebContents,
  registerWebContents,
  registerAppView,
} from "./webContentsRegistry.js";
import { getProjectViewManager } from "./windowRef.js";
import path from "path";
import { createWindowWithState } from "../windowState.js";
import { store } from "../store.js";
import { resolveAppTheme } from "../../shared/theme/index.js";
import type { AppColorScheme } from "../../shared/theme/index.js";
import {
  appCustomSchemesReadSchema,
  appCustomSchemesWriteSchema,
  migrateCustomSchemes,
} from "../schemas/customSchemes.js";

import { canOpenExternalUrl, openExternalUrl } from "../utils/openExternal.js";
import { isTrustedRendererUrl } from "../../shared/utils/trustedRenderer.js";
import { isLocalhostUrl, isDevPreviewProxyUrl } from "../../shared/utils/urlUtils.js";
import { isBrowserPartition } from "../../shared/utils/partitionUtils.js";
import { getDevServerUrl } from "../../shared/config/devServer.js";
import { CHANNELS } from "../ipc/channels.js";
import { sendToRenderer } from "../ipc/handlers.js";
import { getCrashRecoveryService } from "../services/CrashRecoveryService.js";
import { notifyError } from "../ipc/errorHandlers.js";
import { PERF_MARKS } from "../../shared/perf/marks.js";
import {
  buildSkeletonCss,
  insertSkeletonCss,
  injectSkeletonCss,
  resolveInitialColorSchemeId,
  resolveE2EPreloadArgs,
  resolveInstanceRole,
  INITIAL_COLOR_SCHEME_ARG,
  INSTANCE_ROLE_ARG,
} from "./skeletonCss.js";
import { attachRendererConsoleCapture } from "./rendererConsoleCapture.js";
import { markPerformance } from "../utils/performance.js";
import { registerProtocolsForSession, getDistPath } from "../setup/protocols.js";
import { isDemoMode, isSmokeTest } from "../setup/environment.js";
import { isE2EDeferRendererLoad, isE2EMode } from "../setup/runtimeFlags.js";
import { SMOKE_BOOT_TIMEOUT_MS } from "../services/smokeTest.js";
import {
  beginWindowRecreating,
  endWindowRecreating,
  isWindowRecreating,
} from "../lifecycle/windowRecreationState.js";

const CRASH_LOOP_WINDOW_MS = 60_000;
const CRASH_LOOP_THRESHOLD = 3;

function getAvailableMemoryMb(): number | null {
  try {
    const getInfo = (
      process as {
        getSystemMemoryInfo?: () => { free: number; purgeable?: number; total: number };
      }
    ).getSystemMemoryInfo;
    if (typeof getInfo !== "function") return null;
    const info = getInfo.call(process);
    const freeKb = typeof info.free === "number" ? info.free : 0;
    const purgeableKb = typeof info.purgeable === "number" ? info.purgeable : 0;
    const availableKb = freeKb + purgeableKb;
    if (availableKb <= 0) return null;
    return availableKb / 1024;
  } catch {
    return null;
  }
}

let windowIpcHandlersRegistered = false;

function registerWindowIpcHandlers(onCreateWindow?: (projectPath?: string) => Promise<void>): void {
  if (windowIpcHandlersRegistered) return;
  windowIpcHandlersRegistered = true;

  if (onCreateWindow) {
    ipcMain.handle(CHANNELS.WINDOW_NEW, (_event, projectPath?: string) =>
      onCreateWindow(projectPath ?? undefined)
    );
  }

  ipcMain.handle(CHANNELS.WINDOW_TOGGLE_FULLSCREEN, (event) => {
    const bw = getWindowForWebContents(event.sender);
    if (bw && !bw.isDestroyed()) {
      const isSimpleFullScreen = bw.isSimpleFullScreen();
      bw.setSimpleFullScreen(!isSimpleFullScreen);
      return !isSimpleFullScreen;
    }
    return false;
  });

  ipcMain.handle(CHANNELS.WINDOW_RELOAD, (event) => {
    event.sender.reload();
  });

  ipcMain.handle(CHANNELS.WINDOW_FORCE_RELOAD, (event) => {
    event.sender.reloadIgnoringCache();
  });

  ipcMain.handle(CHANNELS.WINDOW_TOGGLE_DEVTOOLS, (event) => {
    if (!app.isPackaged) {
      event.sender.toggleDevTools();
    }
  });

  const getZoomStep = () => 0.5;

  ipcMain.handle(CHANNELS.WINDOW_ZOOM_IN, (event) => {
    const current = event.sender.getZoomLevel();
    event.sender.setZoomLevel(current + getZoomStep());
  });

  ipcMain.handle(CHANNELS.WINDOW_ZOOM_OUT, (event) => {
    const current = event.sender.getZoomLevel();
    event.sender.setZoomLevel(current - getZoomStep());
  });

  ipcMain.handle(CHANNELS.WINDOW_ZOOM_RESET, (event) => {
    event.sender.setZoomLevel(0);
  });

  ipcMain.handle(CHANNELS.WINDOW_CLOSE, (event) => {
    const bw = getWindowForWebContents(event.sender);
    bw?.close();
  });
}

export interface SetupBrowserWindowOptions {
  onRecreateWindow?: () => Promise<void>;
  onCreateWindow?: (projectPath?: string) => Promise<void>;
  projectPath?: string | null;
  /** Last-active projectId read synchronously from DB before window creation.
   *  Used to assign the correct session partition to the initial view. */
  initialProjectId?: string;
}

export interface CreateWindowResult {
  win: BrowserWindow;
  appView: WebContentsView;
  loadRenderer: (reason: string, projectId?: string) => void;
  smokeTestTimer: ReturnType<typeof setTimeout> | undefined;
  smokeRendererUnresponsive: () => boolean;
}

export function setupBrowserWindow(
  dirname: string,
  options: SetupBrowserWindowOptions = {}
): CreateWindowResult {
  const { onRecreateWindow, onCreateWindow, projectPath } = options;
  let smokeTestTimer: ReturnType<typeof setTimeout> | undefined;
  let _smokeRendererUnresponsive = false;

  if (isSmokeTest) {
    console.error("[SMOKE] Starting %ds startup safety timeout", SMOKE_BOOT_TIMEOUT_MS / 1000);
    smokeTestTimer = setTimeout(() => {
      console.error("[SMOKE] FAILED — app did not finish loading within startup timeout");
      app.exit(1);
    }, SMOKE_BOOT_TIMEOUT_MS);
    smokeTestTimer.unref();
  }

  // Resolve the saved theme to set the correct background color at construction time,
  // avoiding a dark flash when a light theme is active.
  const themeConfig = store.get("appTheme");
  // Daintree always defaults to its dark theme on first run, regardless of the
  // OS color-scheme preference. Users who want light or system-following
  // behavior can opt in via Settings → Appearance.
  const colorSchemeId = resolveInitialColorSchemeId(themeConfig);

  // Apply lazy migration for legacy string-encoded customSchemes
  let customSchemes: AppColorScheme[] = [];
  const rawSchemes =
    themeConfig && typeof themeConfig === "object" && !Array.isArray(themeConfig)
      ? (themeConfig as Record<string, unknown>).customSchemes
      : undefined;
  if (rawSchemes !== undefined) {
    const result = migrateCustomSchemes(
      rawSchemes,
      appCustomSchemesReadSchema,
      appCustomSchemesWriteSchema
    );
    customSchemes = result.schemes;
    if (result.migrated) {
      try {
        store.set("appTheme", {
          ...(themeConfig as Record<string, unknown>),
          customSchemes: result.schemes.length > 0 ? result.schemes : [],
        });
      } catch {
        // Non-fatal: config persisted but migration write failed
      }
    }
  }

  const scheme = resolveAppTheme(colorSchemeId, customSchemes);
  const windowBg = scheme.tokens["surface-canvas"];

  // ── Create BrowserWindow as a thin host ──
  // The BrowserWindow itself does NOT load the app — it's a shell.
  // The React app lives in a WebContentsView attached to win.contentView.
  console.log("[MAIN] Creating window...");
  const win = createWindowWithState(
    {
      show: false,
      minWidth: 800,
      minHeight: 600,
      ...(process.platform === "darwin"
        ? {
            titleBarStyle: "hiddenInset" as const,
            trafficLightPosition: { x: 12, y: 18 },
          }
        : process.platform === "win32"
          ? {
              titleBarStyle: "hidden" as const,
              titleBarOverlay: {
                color: windowBg,
                symbolColor: "#a1a1aa",
                height: 48,
              },
              // Hide the native menu bar so the custom 48px toolbar is the
              // only chrome; Alt still reveals the menu. Must be set in the
              // constructor — calling setAutoHideMenuBar after creation can
              // cause Window Controls Overlay layout shifts.
              autoHideMenuBar: true,
            }
          : { autoHideMenuBar: true }),
      backgroundColor: windowBg,
    },
    projectPath ?? undefined
  );
  markPerformance(PERF_MARKS.MAIN_WINDOW_CREATED);

  // Register the window's own webContents for getWindowForWebContents() fallback
  registerWebContents(win.webContents, win);

  // E2E: load a sentinel page into the BrowserWindow shell so Playwright's
  // electron.launch() receives a CDP 'page' target and resolves.
  // Without this, the BW stays at about:blank (no Target.targetCreated event)
  // and electron.launch() times out after the WebContentsView migration.
  if (isE2EMode) {
    win.loadURL("data:text/html,<!doctype html><html><body></body></html>").catch((err) => {
      console.warn("[MAIN] Failed to load E2E BrowserWindow sentinel:", err);
    });
    if (isE2EDeferRendererLoad && !win.isDestroyed()) {
      win.show();
    }
  }

  // ── Create WebContentsView for the React app ──
  // All project views share a single session partition for V8 code cache reuse.
  const viewSession = session.fromPartition("persist:daintree");
  const dist = getDistPath();
  if (dist) registerProtocolsForSession(viewSession, dist);

  const appView = new WebContentsView({
    webPreferences: {
      preload: path.join(dirname, "preload.cjs"),
      session: viewSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      navigateOnDragDrop: false,
      // bypassHeatCheck writes the V8 code cache on the first load instead of
      // Chromium's default third-load heat check, so launch 2 after an
      // install/update is already warm. Dev-server URLs churn constantly, so
      // keep the default heuristic there.
      v8CacheOptions: app.isPackaged ? "bypassHeatCheck" : "code",
      // Seed the renderer with the persisted theme so first paint applies the
      // saved scheme instead of a prefers-color-scheme default (#9169). The
      // instance role rides along so worker instances suppress automatic
      // background GitHub polling (#10123).
      additionalArguments: [
        `${INITIAL_COLOR_SCHEME_ARG}=${colorSchemeId}`,
        `${INSTANCE_ROLE_ARG}=${resolveInstanceRole()}`,
        ...resolveE2EPreloadArgs(),
        // Thread the demo-mode flag into renderer argv (Electron does not
        // forward main-process CLI switches), so window.electron.demo and the
        // demo overlay components are available when launched with --demo-mode.
        ...(isDemoMode ? ["--demo-mode"] : []),
      ],
    },
  });

  // Register the app view so IPC helpers route to the correct webContents
  registerAppView(win, appView);

  // Attach the view to the window and size it to fill the content area.
  // Ongoing resize handling is delegated to ProjectViewManager (which tracks the active view).
  // We only need to set the initial bounds here.
  win.contentView.addChildView(appView);
  if (!win.isDestroyed()) {
    const { width, height } = win.getContentBounds();
    appView.setBounds({ x: 0, y: 0, width, height });
  }

  // The app view's webContents is the "renderer" for all purposes
  const appWebContents = appView.webContents;
  attachRendererConsoleCapture(appWebContents);

  // Match the appView's background to the window chrome so the frame and
  // content area reveal a single colour when the window is shown before the
  // first paint; WebContentsView defaults to white otherwise.
  appView.setBackgroundColor(windowBg);

  if (isSmokeTest) {
    win.on("unresponsive", () => {
      _smokeRendererUnresponsive = true;
      console.error("[SMOKE] FAILED — main window became unresponsive");
    });
  } else {
    let unresponsiveDialogId = 0;
    let unresponsiveDialogOpen = false;

    win.on("unresponsive", () => {
      if (unresponsiveDialogOpen || win.isDestroyed()) return;
      unresponsiveDialogOpen = true;
      const dialogId = ++unresponsiveDialogId;
      console.warn("[MAIN] Window became unresponsive");

      dialog
        .showMessageBox(win, {
          type: "warning",
          buttons: ["Wait", "Restart view"],
          defaultId: 0,
          title: "Window Not Responding",
          message: "The window is not responding.",
          detail:
            "You can wait for it to recover, or force-restart the view. Force-restarting will immediately terminate and recover the view.",
        })
        .then(({ response }) => {
          if (dialogId !== unresponsiveDialogId) return;
          unresponsiveDialogOpen = false;
          if (response === 1 && !win.isDestroyed()) {
            console.warn("[MAIN] User triggered force-restart of unresponsive renderer");
            const activeWc = getProjectViewManager()?.getActiveView()?.webContents;
            const target = activeWc && !activeWc.isDestroyed() ? activeWc : appWebContents;
            if (!target.isDestroyed()) target.forcefullyCrashRenderer();
          }
        })
        .catch(() => {
          unresponsiveDialogOpen = false;
        });
    });

    win.on("responsive", () => {
      if (unresponsiveDialogOpen) {
        unresponsiveDialogId++;
        unresponsiveDialogOpen = false;
        console.log("[MAIN] Window became responsive again");
      }
    });
  }

  let rendererLoadRequested = false;
  const SHOW_FALLBACK_MS = 5_000;
  const loadRenderer = (reason: string, projectId?: string): void => {
    if (!win || win.isDestroyed() || rendererLoadRequested) return;
    rendererLoadRequested = true;

    // insertCSS is navigation-scoped, so re-inject once the new document has
    // parsed. Listen for every dom-ready (not once) so the skeleton survives
    // renderer-crash auto-reloads. Inline fallbacks in index.html cover the
    // gap before dom-ready fires. The CSS string is precomputed before
    // loadURL so the boot-path dom-ready handler (which gates win.show())
    // skips the synchronous config.json re-reads; later dom-ready events
    // (crash auto-reloads) rebuild it so the skeleton reflects current
    // theme/sidebar/focus state.
    const precomputedSkeletonCss = buildSkeletonCss(undefined, themeConfig);
    let firstDomReady = true;
    appWebContents.on("dom-ready", () => {
      if (firstDomReady) {
        firstDomReady = false;
        insertSkeletonCss(appWebContents, precomputedSkeletonCss);
      } else {
        injectSkeletonCss(appWebContents);
      }
    });

    // Gate win.show() on the skeleton markup being parsed so the OS never
    // maps a blank window. Primary signal: the APP_SKELETON_PARSED send from
    // public/skeleton-ready.js, which fires as soon as the skeleton is in the
    // DOM — well before dom-ready, which waits for the deferred module graph
    // to evaluate. dom-ready stays as a backstop (`ready-to-show` on
    // BrowserWindow does NOT cover child WebContentsView paint, and fires
    // immediately for the sentinel data: page). 5s timeout fallback ensures a
    // hung renderer doesn't leave the window permanently hidden — strictly
    // worse than a brief blank.
    let shown = false;
    const showOnce = (viaFallback = false): void => {
      if (shown) return;
      shown = true;
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      if (!win.isDestroyed()) {
        markPerformance(PERF_MARKS.MAIN_WINDOW_SHOWN, viaFallback ? { fallback: true } : undefined);
        win.show();
      }
    };
    let fallbackTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      fallbackTimer = null;
      console.warn(
        `[MAIN] dom-ready not received after ${SHOW_FALLBACK_MS}ms — showing window anyway`
      );
      showOnce(true);
    }, SHOW_FALLBACK_MS);
    // WebContents-scoped ipc — project views loading the same index.html send
    // on their own webContents and never reach this listener.
    appWebContents.ipc.once(CHANNELS.APP_SKELETON_PARSED, () => showOnce(false));
    appWebContents.once("dom-ready", () => showOnce(false));
    win.once("closed", () => {
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      if (!appWebContents.isDestroyed()) {
        appWebContents.ipc.removeAllListeners(CHANNELS.APP_SKELETON_PARSED);
      }
    });

    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    console.log(`[MAIN] Loading renderer (${reason})...`);
    if (process.env.NODE_ENV === "development") {
      const devServerUrl = getDevServerUrl();
      console.log(`[MAIN] Loading Vite dev server at ${devServerUrl}${qs}`);
      appWebContents.loadURL(`${devServerUrl}${qs}`);
    } else {
      console.log("[MAIN] Loading production build via app:// protocol");
      appWebContents.loadURL(`app://daintree/index.html${qs}`);
    }
  };

  // Window open handler — on the app view's webContents
  appWebContents.setWindowOpenHandler(({ url }) => {
    if (url && canOpenExternalUrl(url)) {
      void openExternalUrl(url).catch((error) => {
        console.error("[MAIN] Failed to open external URL:", error);
      });
    } else {
      console.warn(`[MAIN] Blocked window.open for unsupported/empty URL: ${url}`);
    }
    return { action: "deny" };
  });

  // Block same-window navigations to untrusted origins
  appWebContents.on("will-navigate", (event, navigationUrl) => {
    if (!isTrustedRendererUrl(navigationUrl)) {
      console.error(
        "[MAIN] Blocked navigation to untrusted URL:",
        navigationUrl,
        "from:",
        appWebContents.getURL()
      );
      event.preventDefault();
    }
  });

  appWebContents.on("will-redirect", (event, redirectUrl) => {
    if (!isTrustedRendererUrl(redirectUrl)) {
      console.error(
        "[MAIN] Blocked redirect to untrusted URL:",
        redirectUrl,
        "from:",
        appWebContents.getURL()
      );
      event.preventDefault();
    }
  });

  // Harden webview security — on the app view's webContents
  appWebContents.on("will-attach-webview", (event, webPreferences, params) => {
    // Dev-preview webviews now load the stable proxy origin (dp-*.localhost), which
    // isLocalhostUrl rejects — accept it explicitly (#9100).
    const isAllowedLocalhostUrl = isLocalhostUrl(params.src) || isDevPreviewProxyUrl(params.src);
    const partition = params.partition ?? "";
    const isValidPartition =
      isBrowserPartition(partition) ||
      partition === "persist:dev-preview" ||
      partition.startsWith("persist:dev-preview-");

    if (!isAllowedLocalhostUrl || !isValidPartition) {
      console.warn(
        `[MAIN] Blocked webview attachment: url=${params.src}, partition=${params.partition}`
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
    // Preserve the validated partition so the webview uses the correct
    // persistent session (#4564).
    webPreferences.partition = params.partition;
  });

  // Prevent Cmd+W / Ctrl+W from closing the window, and route Ctrl+Tab terminal
  // focus shortcuts for the initial app view. ProjectViewManager installs the
  // same Ctrl+Tab bridge for cold-started project views.
  appWebContents.on("before-input-event", (event, input) => {
    const key = input.key.toLowerCase();
    const isTerminalFocusShortcut =
      input.type === "keyDown" &&
      (key === "tab" || input.code === "Tab") &&
      input.control &&
      !input.meta &&
      !input.alt;
    if (isTerminalFocusShortcut) {
      event.preventDefault();
      appWebContents.send(CHANNELS.MENU_ACTION, {
        actionId: input.shift ? "terminal.focusPrevious" : "terminal.focusNext",
      });
      return;
    }

    const isMac = process.platform === "darwin";
    const isCloseShortcut =
      input.type === "keyDown" &&
      key === "w" &&
      ((isMac && input.meta && !input.control) || (!isMac && input.control && !input.meta)) &&
      !input.alt;

    appWebContents.setIgnoreMenuShortcuts(isCloseShortcut);
  });

  // Crash loop detection and renderer recovery
  const rendererCrashTimestamps: number[] = [];
  const oomRecreationTimestamps: number[] = [];

  appWebContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    console.error("[MAIN] Renderer process gone:", details.reason, details.exitCode);
    // Memory eviction is not a crash — skip the one-shot crash log so a
    // genuine crash in the same session can still be recorded.
    if (details.reason !== "memory-eviction") {
      getCrashRecoveryService().recordCrash(
        new Error(`Renderer process gone: ${details.reason} (exit code ${details.exitCode})`)
      );
    }

    if (win.isDestroyed()) return;

    // OS-pressure memory eviction: reload without counting toward crash-loop
    // guard (the view goes blank and will not auto-recover on its own).
    if (details.reason === "memory-eviction") {
      notifyError(new Error("The renderer was reloaded due to memory pressure."), {
        source: "renderer-crash",
      });
      setImmediate(() => {
        if (win.isDestroyed()) return;
        appWebContents.reload();
      });
      return;
    }

    const availableMb = getAvailableMemoryMb();
    const lowMemThresholdMb = getProjectViewManager()?.getLowMemoryFreeThresholdMb() ?? null;
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
    } else {
      console.log("[MAIN] Renderer crash, auto-reloading");
      notifyError(new Error("The renderer process crashed and was automatically reloaded."), {
        source: "renderer-crash",
      });
      setImmediate(() => {
        if (win.isDestroyed()) return;
        appWebContents.reload();
      });
    }
  });

  // Fullscreen events
  const sendFullscreen = (isFullscreen: boolean) => {
    sendToRenderer(win, CHANNELS.EVENTS_PUSH, {
      name: "window:fullscreen-change",
      payload: isFullscreen,
    });
  };
  win.on("enter-full-screen", () => sendFullscreen(true));
  win.on("leave-full-screen", () => sendFullscreen(false));
  win.on("enter-html-full-screen", () => sendFullscreen(true));
  win.on("leave-html-full-screen", () => sendFullscreen(false));

  // Memory reclamation: clear renderer caches after sustained minimize
  const RECLAIM_DELAY_MS = 5_000;
  let reclaimTimer: ReturnType<typeof setTimeout> | null = null;

  win.on("minimize", () => {
    if (reclaimTimer) clearTimeout(reclaimTimer);
    reclaimTimer = setTimeout(() => {
      reclaimTimer = null;
      if (!win.isDestroyed() && win.isMinimized()) {
        sendToRenderer(win, CHANNELS.EVENTS_PUSH, {
          name: "window:reclaim-memory",
          payload: { reason: "minimize" },
        });
      }
    }, RECLAIM_DELAY_MS);
  });

  win.on("restore", () => {
    if (reclaimTimer) {
      clearTimeout(reclaimTimer);
      reclaimTimer = null;
    }
  });

  win.once("closed", () => {
    if (reclaimTimer) {
      clearTimeout(reclaimTimer);
      reclaimTimer = null;
    }
    // Explicitly close the app view's webContents — Electron does NOT auto-destroy
    // WebContentsView renderers when the host window closes.
    if (!appWebContents.isDestroyed()) {
      appWebContents.close();
    }
  });

  registerWindowIpcHandlers(onCreateWindow);

  function getRecoveryUrl(reason: string, exitCode: number): string {
    const params = new URLSearchParams({ reason, exitCode: String(exitCode) });
    const backupTimestamp = getCrashRecoveryService().getLastBackupTimestamp();
    if (backupTimestamp !== null) {
      params.set("backupTimestamp", String(backupTimestamp));
    }
    if (process.env.NODE_ENV === "development") {
      const devServerUrl = getDevServerUrl();
      return `${devServerUrl}/recovery.html?${params}`;
    }
    return `app://daintree/recovery.html?${params}`;
  }

  return {
    win,
    appView,
    loadRenderer,
    smokeTestTimer,
    smokeRendererUnresponsive: () => _smokeRendererUnresponsive,
  };
}
