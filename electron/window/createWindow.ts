import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from "electron";
import path from "path";
import { createWindowWithState } from "../windowState.js";
import { store } from "../store.js";
import { resolveAppTheme, normalizeAppColorScheme } from "../../shared/theme/index.js";
import type { AppColorScheme } from "../../shared/theme/index.js";

import { canOpenExternalUrl, openExternalUrl } from "../utils/openExternal.js";
import { isTrustedRendererUrl } from "../../shared/utils/trustedRenderer.js";
import { isLocalhostUrl } from "../../shared/utils/urlUtils.js";
import { getDevServerUrl } from "../../shared/config/devServer.js";
import { CHANNELS } from "../ipc/channels.js";
import { sendToRenderer } from "../ipc/handlers.js";
import { getCrashRecoveryService } from "../services/CrashRecoveryService.js";
import { notifyError } from "../ipc/errorHandlers.js";
import { PERF_MARKS } from "../../shared/perf/marks.js";
import { markPerformance } from "../utils/performance.js";
import { isSmokeTest } from "../setup/environment.js";
import { SMOKE_BOOT_TIMEOUT_MS } from "../services/smokeTest.js";

const CRASH_LOOP_WINDOW_MS = 60_000;
const CRASH_LOOP_THRESHOLD = 3;

const oomRecreationTimestamps: number[] = [];

let windowIpcHandlersRegistered = false;

function registerWindowIpcHandlers(): void {
  if (windowIpcHandlersRegistered) return;
  windowIpcHandlersRegistered = true;

  ipcMain.handle(CHANNELS.WINDOW_TOGGLE_FULLSCREEN, (event) => {
    const bw = BrowserWindow.fromWebContents(event.sender);
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
    const bw = BrowserWindow.fromWebContents(event.sender);
    bw?.close();
  });
}

export interface SetupBrowserWindowOptions {
  onRecreateWindow?: () => Promise<void>;
}

export interface CreateWindowResult {
  win: BrowserWindow;
  loadRenderer: (reason: string) => void;
  smokeTestTimer: ReturnType<typeof setTimeout> | undefined;
  smokeRendererUnresponsive: () => boolean;
}

export function setupBrowserWindow(
  dirname: string,
  options: SetupBrowserWindowOptions = {}
): CreateWindowResult {
  const { onRecreateWindow } = options;
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

  let customSchemes: AppColorScheme[] = [];
  if (
    themeConfig &&
    typeof themeConfig === "object" &&
    !Array.isArray(themeConfig) &&
    "customSchemes" in themeConfig &&
    typeof themeConfig.customSchemes === "string"
  ) {
    try {
      const parsed = JSON.parse(themeConfig.customSchemes);
      if (Array.isArray(parsed))
        customSchemes = parsed.map((s: AppColorScheme) => normalizeAppColorScheme(s));
    } catch {
      // Malformed custom schemes — fall back to built-in only
    }
  }

  const scheme = resolveAppTheme(colorSchemeId, customSchemes);
  const windowBg = scheme.tokens["surface-canvas"];

  console.log("[MAIN] Creating window...");
  const win = createWindowWithState({
    show: false,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      navigateOnDragDrop: false,
      v8CacheOptions: "code",
    },
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
  });
  markPerformance(PERF_MARKS.MAIN_WINDOW_CREATED);

  // Defer showing the window until first paint to prevent background flash
  let isShown = false;
  const showWindow = () => {
    if (isShown || win.isDestroyed()) return;
    isShown = true;
    clearTimeout(showTimeout);
    win.show();
  };
  win.once("ready-to-show", showWindow);
  const showTimeout = setTimeout(showWindow, 2500);
  win.once("closed", () => clearTimeout(showTimeout));

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
          buttons: ["Wait", "Reload"],
          defaultId: 0,
          title: "Window Not Responding",
          message: "The window is not responding.",
          detail: "You can wait for it to recover or reload the window.",
        })
        .then(({ response }) => {
          if (dialogId !== unresponsiveDialogId) return;
          unresponsiveDialogOpen = false;
          if (response === 1 && !win.isDestroyed()) {
            win.webContents.reload();
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
  const loadRenderer = (reason: string): void => {
    if (!win || win.isDestroyed() || rendererLoadRequested) return;
    rendererLoadRequested = true;
    console.log(`[MAIN] Loading renderer (${reason})...`);
    if (process.env.NODE_ENV === "development") {
      const devServerUrl = getDevServerUrl();
      console.log(`[MAIN] Loading Vite dev server at ${devServerUrl}`);
      win.loadURL(devServerUrl);
    } else {
      console.log("[MAIN] Loading production build via app:// protocol");
      win.loadURL("app://canopy/index.html");
    }
  };

  // Window open handler
  win.webContents.setWindowOpenHandler(({ url }) => {
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
  const webContents = win.webContents;
  webContents.on("will-navigate", (event, navigationUrl) => {
    if (!isTrustedRendererUrl(navigationUrl)) {
      console.error(
        "[MAIN] Blocked navigation to untrusted URL:",
        navigationUrl,
        "from:",
        webContents.getURL()
      );
      event.preventDefault();
    }
  });

  webContents.on("will-redirect", (event, redirectUrl) => {
    if (!isTrustedRendererUrl(redirectUrl)) {
      console.error(
        "[MAIN] Blocked redirect to untrusted URL:",
        redirectUrl,
        "from:",
        webContents.getURL()
      );
      event.preventDefault();
    }
  });

  // Harden webview security
  win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
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
  });

  // Prevent Cmd+W / Ctrl+W from closing the window
  const wc = win.webContents;
  wc.on("before-input-event", (_event, input) => {
    const isMac = process.platform === "darwin";
    const isCloseShortcut =
      input.type === "keyDown" &&
      input.key.toLowerCase() === "w" &&
      ((isMac && input.meta && !input.control) || (!isMac && input.control && !input.meta)) &&
      !input.alt;

    wc.setIgnoreMenuShortcuts(isCloseShortcut);
  });

  // Crash loop detection and renderer recovery
  const rendererCrashTimestamps: number[] = [];

  win.webContents.on("render-process-gone", (_event, details) => {
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
        win.webContents.loadURL(recoveryUrl);
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
          win.webContents.loadURL(recoveryUrl);
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
        win.webContents.reload();
      });
    }
  });

  // Fullscreen events
  win.on("enter-full-screen", () => {
    sendToRenderer(win, CHANNELS.WINDOW_FULLSCREEN_CHANGE, true);
  });
  win.on("leave-full-screen", () => {
    sendToRenderer(win, CHANNELS.WINDOW_FULLSCREEN_CHANGE, false);
  });
  win.on("enter-html-full-screen", () => {
    sendToRenderer(win, CHANNELS.WINDOW_FULLSCREEN_CHANGE, true);
  });
  win.on("leave-html-full-screen", () => {
    sendToRenderer(win, CHANNELS.WINDOW_FULLSCREEN_CHANGE, false);
  });

  // Memory reclamation: clear renderer caches after sustained minimize
  const RECLAIM_DELAY_MS = 5_000;
  let reclaimTimer: ReturnType<typeof setTimeout> | null = null;

  win.on("minimize", () => {
    if (reclaimTimer) clearTimeout(reclaimTimer);
    reclaimTimer = setTimeout(() => {
      reclaimTimer = null;
      if (!win.isDestroyed() && win.isMinimized()) {
        sendToRenderer(win, CHANNELS.WINDOW_RECLAIM_MEMORY, { reason: "minimize" });
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
  });

  registerWindowIpcHandlers();

  function getRecoveryUrl(reason: string, exitCode: number): string {
    const params = new URLSearchParams({ reason, exitCode: String(exitCode) });
    if (process.env.NODE_ENV === "development") {
      const devServerUrl = getDevServerUrl();
      return `${devServerUrl}/recovery.html?${params}`;
    }
    return `app://canopy/recovery.html?${params}`;
  }

  return {
    win,
    loadRenderer,
    smokeTestTimer,
    smokeRendererUnresponsive: () => _smokeRendererUnresponsive,
  };
}
