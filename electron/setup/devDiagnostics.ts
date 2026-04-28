import { app, ipcMain } from "electron";
import fs from "node:fs";

const SWEEP_INTERVAL_MS = 10_000;
const LISTENER_THRESHOLD = 5;
const FD_GROWTH_THRESHOLD = 10;

let started = false;
let listenerSweepTimer: NodeJS.Timeout | null = null;
let fdSweepTimer: NodeJS.Timeout | null = null;
let fdBaseline = 0;
let fdPath: string | null = null;

function handleProcessWarning(warning: Error): void {
  if (warning.name !== "MaxListenersExceededWarning") {
    return;
  }
  console.warn("[DEV] MaxListenersExceededWarning:", warning.stack ?? warning.message);
  // app.exit(1) skips before-quit/will-quit/quit so the CrashLoopGuard does not
  // count this as a crash, and Chromium subprocesses are torn down cleanly.
  // throw would route through globalErrorHandlers' relaunch path; process.exit
  // would orphan child processes.
  app.exit(1);
}

function resolveFdPath(): string | null {
  if (process.platform === "darwin") return "/dev/fd";
  if (process.platform === "linux") return "/proc/self/fd";
  return null;
}

function readFdCount(path: string): number {
  try {
    return fs.readdirSync(path).length;
  } catch {
    return 0;
  }
}

function sweepListeners(): void {
  try {
    checkEmitter("app", app.eventNames(), (name) => app.listenerCount(name));
    checkEmitter("ipcMain", ipcMain.eventNames(), (name) => ipcMain.listenerCount(name));
  } catch (error) {
    console.warn("[DEV] Listener sweep failed:", error);
  }
}

function checkEmitter(
  label: string,
  names: ReadonlyArray<string | symbol>,
  countFor: (name: string | symbol) => number
): void {
  for (const name of names) {
    const count = countFor(name);
    if (count > LISTENER_THRESHOLD) {
      console.warn(
        `[DEV] Listener leak suspected on ${label}: '${String(name)}' has ${count} listeners (threshold ${LISTENER_THRESHOLD})`
      );
    }
  }
}

function sweepFds(): void {
  if (!fdPath) return;
  const current = readFdCount(fdPath);
  if (current === 0) return;
  if (current - fdBaseline > FD_GROWTH_THRESHOLD) {
    console.warn(
      `[DEV] fd leak suspected: ${current} open fds vs baseline ${fdBaseline} (growth ${current - fdBaseline}, threshold ${FD_GROWTH_THRESHOLD})`
    );
  }
}

function scheduleListenerSweep(): void {
  listenerSweepTimer = setTimeout(() => {
    sweepListeners();
    if (started) scheduleListenerSweep();
  }, SWEEP_INTERVAL_MS);
  listenerSweepTimer.unref();
}

function scheduleFdSweep(): void {
  fdSweepTimer = setTimeout(() => {
    sweepFds();
    if (started) scheduleFdSweep();
  }, SWEEP_INTERVAL_MS);
  fdSweepTimer.unref();
}

export function startDevDiagnostics(): void {
  if (started) return;
  started = true;

  process.traceProcessWarnings = true;
  process.on("warning", handleProcessWarning);

  fdPath = resolveFdPath();
  fdBaseline = fdPath ? readFdCount(fdPath) : 0;

  scheduleListenerSweep();
  if (fdPath) scheduleFdSweep();
}

export function stopDevDiagnostics(): void {
  if (!started) return;
  started = false;

  process.off("warning", handleProcessWarning);

  if (listenerSweepTimer) {
    clearTimeout(listenerSweepTimer);
    listenerSweepTimer = null;
  }
  if (fdSweepTimer) {
    clearTimeout(fdSweepTimer);
    fdSweepTimer = null;
  }
}

/** @internal Reset module state for testing only. */
export function _resetDevDiagnosticsForTesting(): void {
  started = false;
  if (listenerSweepTimer) {
    clearTimeout(listenerSweepTimer);
    listenerSweepTimer = null;
  }
  if (fdSweepTimer) {
    clearTimeout(fdSweepTimer);
    fdSweepTimer = null;
  }
  fdBaseline = 0;
  fdPath = null;
}
