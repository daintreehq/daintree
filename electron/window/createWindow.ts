import {
  app,
  BrowserWindow,
  WebContentsView,
  dialog,
  ipcMain,
  nativeTheme,
  session,
} from "electron";
import {
  getWindowForWebContents,
  registerWebContents,
  registerAppView,
} from "./webContentsRegistry.js";
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
import { isLocalhostUrl } from "../../shared/utils/urlUtils.js";
import { getDevServerUrl } from "../../shared/config/devServer.js";
import { CHANNELS } from "../ipc/channels.js";
import { sendToRenderer } from "../ipc/handlers.js";
import { getCrashRecoveryService } from "../services/CrashRecoveryService.js";
import { notifyError } from "../ipc/errorHandlers.js";
import { PERF_MARKS } from "../../shared/perf/marks.js";
import { injectSkeletonCss } from "./skeletonCss.js";
import { attachRendererConsoleCapture } from "./rendererConsoleCapture.js";
import { markPerformance } from "../utils/performance.js";
import { registerProtocolsForSession, getDistPath } from "../setup/protocols.js";
import { isSmokeTest } from "../setup/environment.js";
import { SMOKE_BOOT_TIMEOUT_MS } from "../services/smokeTest.js";

const CRASH_LOOP_WINDOW_MS = 60_000;
const CRASH_LOOP_THRESHOLD = 3;

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
  let colorSchemeId: string;
  if (
    themeConfig &&
    typeof themeConfig === "object" &&
    !Array.isArray(themeConfig) &&
    "colorSchemeId" in themeConfig &&
    typeof themeConfig.colorSchemeId === "string" &&
    themeConfig.colorSchemeId
  ) {
    colorSchemeId = themeConfig.colorSchemeId.trim();
  } else {
    colorSchemeId = nativeTheme.shouldUseDarkColors ? "daintree" : "bondi";
  }

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
                height: 36,
              },
            }
          : {}),
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
  if (process.env.DAINTREE_E2E_MODE) {
    win.loadURL("data:text/html,<!doctype html><html><body></body></html>");
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
      v8CacheOptions: "code",
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
            appWebContents.forcefullyCrashRenderer();
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
  const loadRenderer = (reason: string, projectId?: string): void => {
    if (!win || win.isDestroyed() || rendererLoadRequested) return;
    rendererLoadRequested = true;

    // insertCSS is navigation-scoped, so re-inject once the new document has
    // parsed. Listen for every dom-ready (not once) so the skeleton survives
    // renderer-crash auto-reloads. Inline fallbacks in index.html cover the
    // gap before dom-ready fires.
    appWebContents.on("dom-ready", () => {
      injectSkeletonCss(appWebContents);
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

    // Show the window as soon as the navigation is in flight so the HTML
    // skeleton in index.html paints during bundle parse instead of leaving
    // the user with a blank background while JS loads.
    if (!win.isDestroyed()) win.show();
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
    const allowedPartitions = ["persist:browser", "persist:dev-preview"];
    const isAllowedLocalhostUrl = isLocalhostUrl(params.src);
    const isValidPartition =
      allowedPartitions.includes(params.partition || "") ||
      (params.partition?.startsWith("persist:dev-preview-") ?? false);

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

  // Prevent Cmd+W / Ctrl+W from closing the window — listen on app view's webContents
  appWebContents.on("before-input-event", (_event, input) => {
    const isMac = process.platform === "darwin";
    const isCloseShortcut =
      input.type === "keyDown" &&
      input.key.toLowerCase() === "w" &&
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
    getCrashRecoveryService().recordCrash(
      new Error(`Renderer process gone: ${details.reason} (exit code ${details.exitCode})`)
    );

    if (win.isDestroyed()) return;

    const now = Date.now();
    while (
      rendererCrashTimestamps.length > 0 &&
      now - rendererCrashTimestamps[0] > CRASH_LOOP_WINDOW_MS
    ) {
      rendererCrashTimestamps.shift();
    }
    rendererCrashTimestamps.push(now);

    const isOom = details.reason === "oom";

    if (rendererCrashTimestamps.length >= CRASH_LOOP_THRESHOLD) {
      console.error("[MAIN] Crash loop detected, loading recovery page");
      setImmediate(() => {
        if (win.isDestroyed()) return;
        const recoveryUrl = getRecoveryUrl(details.reason, details.exitCode);
        appWebContents.loadURL(recoveryUrl);
      });
    } else if (isOom && onRecreateWindow) {
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
          if (!win.isDestroyed()) win.destroy();
          onRecreateWindow().catch((err) => {
            console.error("[MAIN] Failed to recreate window after OOM:", err);
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
