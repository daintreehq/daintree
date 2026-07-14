// eager-import-allow: manages application lifetime hooks and native deep link triggers on startup
import { app, BrowserWindow } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { CliAvailabilityService } from "../services/CliAvailabilityService.js";
import type { WindowRegistry } from "../window/WindowRegistry.js";
import { handleDirectoryOpen } from "../menu.js";
import { refreshProjectMenuState } from "../projectMenuState.js";
import { getCrashRecoveryService } from "../services/CrashRecoveryService.js";
import { broadcastToRenderer } from "../ipc/utils.js";
import { CHANNELS } from "../ipc/channels.js";
import { setSignalShutdown, setSafetyBeltTimer } from "./signalShutdownState.js";
import { isWindowRecreating } from "./windowRecreationState.js";
import { SAFETY_BELT_TIMEOUT_MS } from "./shutdownConfig.js";
import { extractDaintreeUrl, handleDaintreeUrl } from "../setup/deepLinkInstall.js";

let pendingCliPath: string | null = null;

export function getPendingCliPath(): string | null {
  return pendingCliPath;
}

export function setPendingCliPath(p: string | null): void {
  pendingCliPath = p;
}

export function extractCliPath(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cli-path" && argv[i + 1]) {
      return argv[i + 1];
    }
    if (argv[i].startsWith("--cli-path=")) {
      return argv[i].slice("--cli-path=".length);
    }
  }
  return null;
}

// `.dntr` plugin archives double-clicked on Windows/Linux arrive as bare argv
// entries (no `--flag`) on the `second-instance` event. The OS may supply a
// relative path resolved against the launching shell's cwd, so the second
// instance's `workingDirectory` is used to normalize it. Extension matching is
// case-insensitive for Windows.
export function extractDntrPaths(argv: string[], workingDirectory: string): string[] {
  const paths: string[] = [];
  for (const arg of argv) {
    if (!arg || arg.startsWith("--")) continue;
    // XDG file managers pass `file://` URIs because electron-builder appends
    // `%U` to the Linux .desktop Exec line. Decode to an OS path before the
    // extension check and resolution.
    let candidate = arg;
    if (candidate.startsWith("file://")) {
      try {
        candidate = fileURLToPath(candidate);
      } catch {
        continue;
      }
    }
    if (!candidate.toLowerCase().endsWith(".dntr")) continue;
    paths.push(path.resolve(workingDirectory, candidate));
  }
  return paths;
}

// Queue for `.dntr` paths received before a window exists (cold-launched second
// instance). A `string[]` rather than a scalar because the OS can pass multiple
// archives in one launch; they are drained sequentially through the installer's
// lock. Mirrors the `pendingCliPath` pattern.
let pendingDntrPaths: string[] = [];

export function getPendingDntrPaths(): string[] {
  return [...pendingDntrPaths];
}

export function clearPendingDntrPaths(): void {
  pendingDntrPaths = [];
}

// Zip local-file-header magic. A `.dntr` archive is a zip; anything else is
// rejected before the installer (which assumes valid zip input) ever sees it.
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

async function isValidDntrArchive(filePath: string): Promise<boolean> {
  if (!fs.existsSync(filePath)) return false;
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(filePath, "r");
    const buf = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buf, 0, 4, 0);
    return bytesRead === 4 && buf.equals(ZIP_MAGIC);
  } catch {
    return false;
  } finally {
    // A close() rejection in finally would supersede the return value and
    // escape the catch — swallow it so validation can't throw.
    await handle?.close().catch(() => {});
  }
}

// Validate + sideload a single `.dntr` archive. The magic-byte gate lives here
// (not in the installer); invalid files and install failures surface as error
// toasts. `PluginService` is imported lazily to preserve the #9285 main-process
// module-isolation boundary.
export async function installDntrPath(archivePath: string): Promise<void> {
  if (!(await isValidDntrArchive(archivePath))) {
    broadcastToRenderer(CHANNELS.NOTIFICATION_SHOW_TOAST, {
      type: "error",
      title: "Invalid plugin file",
      message: `"${archivePath}" isn't a valid Daintree plugin archive.`,
    });
    return;
  }
  try {
    const { pluginService } = await import("../services/PluginService.js");
    const result = await pluginService.installPlugin(archivePath, {
      source: "sideload",
      originalUrl: undefined,
    });
    if (result.status === "installed") {
      broadcastToRenderer(CHANNELS.NOTIFICATION_SHOW_TOAST, {
        type: "success",
        title: "Plugin installed",
        message: `Installed "${result.pluginId}".`,
      });
    } else if (result.status === "failed") {
      broadcastToRenderer(CHANNELS.NOTIFICATION_SHOW_TOAST, {
        type: "error",
        title: "Plugin install failed",
        message: result.errors[0]?.message ?? "Couldn't install the plugin.",
      });
    }
  } catch (err) {
    console.error("[MAIN] Failed to install .dntr plugin:", err);
    broadcastToRenderer(CHANNELS.NOTIFICATION_SHOW_TOAST, {
      type: "error",
      title: "Plugin install failed",
      message: `Couldn't install "${archivePath}".`,
    });
  }
}

// Drain the pending `.dntr` queue once a window is ready. The snapshot is
// cleared up front so a `second-instance` event firing mid-drain appends to a
// fresh queue rather than re-installing in-flight paths. Installs run
// sequentially through the installer's lock.
export async function drainPendingDntrPaths(): Promise<void> {
  const queued = getPendingDntrPaths();
  clearPendingDntrPaths();
  for (const archivePath of queued) {
    await installDntrPath(archivePath);
  }
}

export interface AppLifecycleOptions {
  onCreateWindow: () => void | Promise<void>;
  onCreateWindowForPath?: (cliPath: string) => void | Promise<void>;
  getMainWindow: () => BrowserWindow | null;
  getCliAvailabilityService: () => CliAvailabilityService | null;
  windowRegistry?: WindowRegistry;
}

export function registerAppLifecycleHandlers(opts: AppLifecycleOptions): void {
  // Initialize crash recovery only in the winning instance
  getCrashRecoveryService();

  // Graceful shutdown on OS signals (macOS/Linux SIGTERM/SIGINT, Windows Ctrl+C,
  // plus SIGUSR2 — nodemon's restart signal in dev, and SIGHUP — terminal-close
  // in dev). Triggers `before-quit` via `app.quit()` so the shutdown handler
  // runs the full cleanup chain, including `CrashLoopGuard.markCleanExit()`.
  // Without the SIGUSR2 entry, every nodemon restart bypassed `before-quit` and
  // CrashLoopGuard counted it as a crash — after three rebuilds in a minute the
  // dev app booted into safe mode for no reason. SIGHUP gets the same treatment
  // for the same reason: closing the dev terminal sends SIGHUP and would
  // otherwise terminate the process without the markCleanExit call.
  //
  // The safety-belt timer must outlast the full graceful-shutdown chain so it
  // doesn't fire mid-cleanup. `SAFETY_BELT_TIMEOUT_MS` budgets the 10s cleanup
  // race plus a 3000ms historical buffer plus 2500ms for closeTelemetry()
  // (Sentry init-wait cap 500ms + close timeout 2000ms — see TelemetryService.ts).
  // The handle is captured and stored in signalShutdownState.ts so shutdown.ts
  // can `clearSafetyBeltTimer()` it before its own `app.exit()` calls; without
  // that, a slow closeTelemetry() could let the belt fire after a normal exit
  // and report the wrong exit code to systemd/nodemon. The belt fires
  // `app.exit(1)` (dirty exit) — never `process.exit(0)` — so process
  // supervisors get the correct signal and Electron's native teardown still runs.
  // A second signal within 2000ms force-exits with status 1 — escape hatch
  // when shutdown stalls. After that window, repeat signals are ignored
  // (cleanup is already in progress).
  //
  // SIGHUP is dev-only: packaged builds are TTY-detached, and process managers
  // (launchd/systemd) conventionally use SIGHUP to mean "reload config" — we
  // shouldn't intercept that. On Windows, `taskkill /F` (TerminateProcess)
  // bypasses all Node.js shutdown hooks; that case is handled by
  // CrashRecoveryService on next startup.
  let firstSignalTime: number | null = null;
  const signalHandler = () => {
    if (firstSignalTime !== null) {
      if (Date.now() - firstSignalTime < 2000) {
        process.exit(1);
      }
      return;
    }
    firstSignalTime = Date.now();
    setSignalShutdown();
    const handle = setTimeout(() => {
      setSafetyBeltTimer(null);
      app.exit(1);
    }, SAFETY_BELT_TIMEOUT_MS);
    handle.unref();
    setSafetyBeltTimer(handle);
    app.quit();
  };
  process.on("SIGTERM", signalHandler);
  process.on("SIGINT", signalHandler);
  process.on("SIGUSR2", signalHandler);
  if (!app.isPackaged) {
    process.on("SIGHUP", signalHandler);
  }

  app.on("second-instance", (_event, commandLine, workingDirectory) => {
    console.log("[MAIN] Second instance detected");
    const mainWindow = opts.windowRegistry?.getPrimary()?.browserWindow ?? opts.getMainWindow();
    const liveWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const cliPath = extractCliPath(commandLine);
    const dntrPaths = extractDntrPaths(commandLine, workingDirectory);
    // Windows/Linux: a warm `daintree://` deep link arrives as an argv entry on
    // the relaunched second instance. Route it through the same handler as the
    // macOS `open-url` path — it targets the primary window itself.
    const daintreeUrl = extractDaintreeUrl(commandLine);
    if (daintreeUrl) {
      handleDaintreeUrl(daintreeUrl);
    }

    if (cliPath) {
      if (liveWindow && opts.onCreateWindowForPath) {
        console.log("[MAIN] Creating new window for CLI path:", cliPath);
        opts.onCreateWindowForPath(cliPath);
      } else if (liveWindow) {
        console.log("[MAIN] Opening CLI path in existing window:", cliPath);
        handleDirectoryOpen(
          cliPath,
          liveWindow,
          opts.getCliAvailabilityService() ?? undefined
        ).catch((err) => console.error("[MAIN] Failed to open CLI path:", err));
      } else {
        pendingCliPath = cliPath;
        console.log("[MAIN] Queuing CLI path for when window is ready:", cliPath);
      }
    }

    if (dntrPaths.length > 0) {
      if (liveWindow) {
        console.log("[MAIN] Installing .dntr paths from second instance:", dntrPaths);
        void (async () => {
          for (const archivePath of dntrPaths) {
            await installDntrPath(archivePath);
          }
        })().catch((err) => console.error("[MAIN] Failed to install .dntr plugin(s):", err));
      } else {
        pendingDntrPaths.push(...dntrPaths);
        console.log("[MAIN] Queuing .dntr paths for when window is ready:", dntrPaths);
      }
    }

    // Bring the primary window to the front for `.dntr` installs and for plain
    // re-launches (no path argument). The CLI-path branch manages its own
    // window via onCreateWindowForPath / handleDirectoryOpen, so it is excluded.
    if (liveWindow && (dntrPaths.length > 0 || !cliPath)) {
      if (liveWindow.isMinimized()) liveWindow.restore();
      liveWindow.focus();
    }
  });

  // The application menu is process-global but its project gates track the
  // focused window, so every focus change can flip them (#11136).
  app.on("browser-window-focus", () => {
    refreshProjectMenuState();
  });

  app.on("window-all-closed", () => {
    // `BrowserWindow.destroy()` in the OOM recreate path synchronously emits
    // `window-all-closed` before the replacement window registers. On
    // non-darwin this would call `app.quit()` mid-recreate; the flag suppresses
    // that until the recreation settles. See `windowRecreationState.ts`.
    if (isWindowRecreating()) return;

    // `browser-window-focus` never fires when focus drops to zero windows, so
    // this is the only signal that clears the gates on macOS, where the app
    // survives windowless with just its menu bar.
    refreshProjectMenuState();

    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("activate", () => {
    // A Dock click during a slow startup fires `activate` before
    // `app.whenReady()` resolves; creating a BrowserWindow then throws. The
    // startup path in main.ts always creates the initial window once ready,
    // so dropping a pre-ready activation loses nothing.
    if (!app.isReady()) return;
    const hasWindows = opts.windowRegistry
      ? opts.windowRegistry.size > 0
      : BrowserWindow.getAllWindows().length > 0;
    if (!hasWindows) {
      opts.onCreateWindow();
    }
  });
}

// Windows-only: route `WM_ENDSESSION` (planned shutdown, logoff, restart,
// Windows Update reboot, Fast Startup) through the same `before-quit` cleanup
// chain as the signal path. Without this, Windows tears the process down
// directly and `running.lock` stays on disk — the next launch then thinks we
// crashed. Best-effort: the OS `HungAppTimeout` is 5s by default and the
// full cleanup chain (`CLEANUP_TIMEOUT_MS` + safety belt) exceeds that, so
// cleanup may be truncated mid-flight. The dirty-marker fallback in
// `CrashRecoveryService` covers truncation. `TerminateProcess`/`taskkill /F`
// bypass `WM_ENDSESSION` entirely; that case is also handled by the marker
// fallback. See `docs/architecture/fatal-error-spine.md`.
export function registerWindowSessionEndHandler(win: BrowserWindow): void {
  if (process.platform !== "win32") return;
  win.on("session-end", () => {
    setSignalShutdown();
    app.quit();
  });
}
