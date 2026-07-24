// eager-import-allow: manages application lifetime hooks and native deep link triggers on startup
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CliAvailabilityService } from "../services/CliAvailabilityService.js";
import type { WindowRegistry } from "../window/WindowRegistry.js";
import { handleDirectoryOpen } from "../menu.js";
import { refreshProjectMenuState } from "../projectMenuState.js";
import { getCrashRecoveryService } from "../services/CrashRecoveryService.js";
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

const CLI_PATH_FLAG = "--cli-path";
const CLI_PATH_PREFIX = `${CLI_PATH_FLAG}=`;

// `\` separates path segments only on Windows; on POSIX it is a legal filename
// character, so `~\foo` there names a file and must not be home-expanded.
const TILDE_PREFIX = process.platform === "win32" ? /^~(?=[/\\]|$)/ : /^~(?=\/|$)/;

// A `--`-prefixed token is a switch, never a path. Chromium injects its own
// switches into the reconstructed `second-instance` command line, so this is
// the guard that stops one being mistaken for a project directory (#11410).
// Bare argv tokens only — the value of `--cli-path=<path>` is unambiguous even
// when the directory is itself named `--something`.
function isSwitchToken(arg: string | undefined): arg is undefined | string {
  return !arg || arg.startsWith("--");
}

// Decode an argv token to an OS path, without resolving it. Callers that care
// about the literal filename see it before `path.resolve` collapses a trailing
// `.`/`..` into an ancestor directory's name.
function decodeArgPath(arg: string | undefined): string | null {
  if (!arg) return null;

  // XDG file managers pass `file://` URIs because electron-builder appends
  // `%U` to the Linux .desktop Exec line, and macOS Shortcuts/Automator produce
  // them by default.
  let candidate = arg;
  if (candidate.startsWith("file://")) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      return null;
    }
  }

  // Only the current user's own `~` — `~other` would need an account lookup.
  // The function replacer keeps a `$` in the home path from being read as a
  // replacement pattern.
  return candidate.replace(TILDE_PREFIX, () => os.homedir());
}

// Shared normalization for every path-shaped argv token, used by both
// `extractCliPath` and `extractDntrPaths` so the two can't drift (#11283). The
// OS may supply a path relative to the launching shell's cwd, so it resolves
// against the launching instance's `workingDirectory`.
function normalizeArgPath(arg: string | undefined, workingDirectory: string): string | null {
  const decoded = decodeArgPath(arg);
  return decoded === null ? null : path.resolve(workingDirectory, decoded);
}

// As `normalizeArgPath`, but only returns candidates that are an existing
// directory. `statSync` follows symlinks (a symlinked project dir is valid) and
// the try/catch covers absence, permission errors, and anything else stat can
// throw, all of which mean "not usable as a project path".
function normalizeArgDirectory(arg: string | undefined, workingDirectory: string): string | null {
  const resolved = normalizeArgPath(arg, workingDirectory);
  if (!resolved) return null;
  try {
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

// Single reporting point for a `--cli-path` that was asked for but couldn't be
// resolved. Error surfacing in the UI is #11409 — this is the hook it replaces.
function reportUnresolvedCliPath(arg: string | undefined, workingDirectory: string): void {
  console.error("[MAIN] Failed to resolve --cli-path to an existing directory", {
    argument: arg ?? null,
    workingDirectory,
  });
}

// The `commandLine` array Electron hands the `second-instance` event is not the
// literal argv of the second process — it's Chromium's `base::CommandLine`
// reconstruction, which groups switches ahead of positional arguments and may
// inject its own switches between them. In the two-token `--cli-path <path>`
// form the flag parses as a valueless switch and the folder as a positional, so
// the adjacent token can be an unrelated switch (#11410 saw
// `--allow-file-access-from-files` land there). Hence: the single-token
// `--cli-path=<path>` form is authoritative, the adjacent token is only trusted
// when it resolves to a real directory, and otherwise we search the remaining
// positionals for the displaced path.
//
// Returns an absolute path to an existing directory, or null.
export function extractCliPath(argv: string[], workingDirectory: string): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    // Single-token form: unambiguous, so its value is final. Never fall back to
    // a positional here — that could silently open a directory the user never
    // named in place of the one they did.
    if (arg.startsWith(CLI_PATH_PREFIX)) {
      const raw = arg.slice(CLI_PATH_PREFIX.length);
      const resolved = normalizeArgDirectory(raw, workingDirectory);
      if (!resolved) reportUnresolvedCliPath(raw, workingDirectory);
      return resolved;
    }

    if (arg !== CLI_PATH_FLAG) continue;

    const adjacent = argv[i + 1];
    if (adjacent !== undefined && !adjacent.startsWith("--")) {
      // Nothing displaced the value — this token is what the launcher passed.
      // If it doesn't name a directory the request has failed; substituting
      // some other positional would open a project the user never asked for.
      const adjacentPath = normalizeArgDirectory(adjacent, workingDirectory);
      if (!adjacentPath) reportUnresolvedCliPath(adjacent, workingDirectory);
      return adjacentPath;
    }

    // An injected switch sits where the value should be (#11410). Chromium
    // orders positionals after the switches, so the displaced path is further
    // along — never behind the flag. Take the first token past the displaced
    // slot that names a directory; a `.dntr` archive is a file, so the
    // directory check keeps it out of the running.
    for (let j = i + 2; j < argv.length; j++) {
      if (isSwitchToken(argv[j])) continue;
      const fallback = normalizeArgDirectory(argv[j], workingDirectory);
      if (fallback) return fallback;
    }

    reportUnresolvedCliPath(adjacent, workingDirectory);
    return null;
  }

  // No `--cli-path` was asked for. Stay silent — and never treat a bare
  // positional directory as a project-open request on its own.
  return null;
}

// True when argv asks for a project directory at all, whether or not it
// resolves. Lets a caller retire a one-shot `process.argv` read even when the
// request failed, instead of re-parsing — and re-reporting — it per window.
export function hasCliPathFlag(argv: string[]): boolean {
  return argv.some((arg) => arg === CLI_PATH_FLAG || arg.startsWith(CLI_PATH_PREFIX));
}

// `.dntr` plugin archives double-clicked on Windows/Linux arrive as bare argv
// entries (no `--flag`) on the `second-instance` event. Extension matching is
// case-insensitive for Windows. No existence check: the archive-preview
// pipeline owns missing-file failures.
export function extractDntrPaths(argv: string[], workingDirectory: string): string[] {
  const paths: string[] = [];
  for (const arg of argv) {
    if (isSwitchToken(arg)) continue;
    const decoded = decodeArgPath(arg);
    // Match the literal filename: resolving first would collapse a trailing
    // `.`/`..` and route `some.dntr/..` to an ancestor named `*.dntr`.
    if (!decoded || !path.basename(decoded).toLowerCase().endsWith(".dntr")) continue;
    paths.push(path.resolve(workingDirectory, decoded));
  }
  return paths;
}

// Queue a `.dntr` archive for install confirmation (#11280). The archive is
// never installed here: `archiveInstallIntent` reads its manifest without
// extracting, then prompts the user in the primary window, and only an approved
// prompt reaches the installer. That module owns the no-window case too — an
// intent is held until a window paints — so this file no longer keeps its own
// pending-path queue.
export async function queueDntrPaths(archivePaths: readonly string[]): Promise<void> {
  const { enqueueArchiveInstallIntents } = await import("../setup/archiveInstallIntent.js");
  await enqueueArchiveInstallIntents(archivePaths);
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
    const cliPath = extractCliPath(commandLine, workingDirectory);
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
      // Enqueued whether or not a window is live: the intent queue holds each
      // preview until the primary window paints, so there is no separate
      // windowless path to keep in sync.
      console.log("[MAIN] Queuing .dntr paths for install confirmation:", dntrPaths);
      void queueDntrPaths(dntrPaths).catch((err) =>
        console.error("[MAIN] Failed to queue .dntr plugin(s):", err)
      );
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

  app.on("browser-window-created", (_event, win) => {
    win.once("closed", () => {
      // Closing the focused window promotes a survivor that may never take focus
      // (minimized/hidden), so `browser-window-focus` can't be relied on here.
      // Deferred because WindowRegistry attaches its own "closed" listener at
      // register() — after this one — and that listener performs the promotion
      // synchronously; refreshing inline would still read the closing window. A
      // microtask runs once every listener for this emit has, which is exactly
      // the ordering we need.
      queueMicrotask(() => refreshProjectMenuState());
    });
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
