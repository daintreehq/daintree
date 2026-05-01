/**
 * External Main-Process Watchdog (UtilityProcess entry point).
 *
 * Lives outside the main event loop so a fully-deadlocked main process can
 * still be force-killed. Receives the main PID via `--main-pid=<pid>` argv,
 * expects a "ping" message every HEARTBEAT_INTERVAL_MS, and SIGKILLs main
 * after MAX_MISSED missed beats. CrashRecoveryService and CrashLoopGuard
 * handle the relaunch + safe-mode path.
 *
 * Fail-open: if anything is malformed (no PID, no parentPort, watchdog
 * itself crashes), we exit without killing main. False positives are far
 * worse than missing a deadlock — every kill path is gated.
 */

import { MessagePort } from "node:worker_threads";
import {
  createWatchdog,
  parseMainPid,
  HEARTBEAT_INTERVAL_MS,
  MAX_MISSED,
  type WatchdogMessage,
} from "./watchdog-host-core.js";

const STDIO_DEAD_CODES = new Set(["EPIPE", "EIO", "EBADF", "ECONNRESET"]);
for (const stream of [process.stdout, process.stderr]) {
  if (stream && typeof stream.on === "function") {
    stream.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code && STDIO_DEAD_CODES.has(err.code)) return;
      throw err;
    });
  }
}

if (!process.parentPort) {
  console.error("[WatchdogHost] Must run in UtilityProcess context");
  process.exit(1);
}

const port = process.parentPort as unknown as MessagePort;

const mainPid = parseMainPid(process.argv);

// Without a valid PID we cannot safely fire SIGKILL. Stay alive so main can
// log the misconfiguration; the kill path is permanently disarmed.
if (mainPid === null) {
  console.error("[WatchdogHost] Missing or invalid --main-pid argv; kill path disabled");
}

function isMainAlive(pid: number): boolean {
  // signal 0 is the POSIX existence-check probe. On Windows, Node maps it to
  // OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION). Wrapping in try/catch
  // handles both EPERM (permission) and ESRCH (not found) defensively —
  // only "definitely-alive" returns true.
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const watchdog = createWatchdog({
  killMain: () => {
    if (mainPid === null) return;
    if (!isMainAlive(mainPid)) {
      console.error(
        `[WatchdogHost] Main PID ${mainPid} is not alive; skipping SIGKILL (likely already exited)`
      );
      return;
    }
    console.error(`[WatchdogHost] Sending SIGKILL to main PID ${mainPid}`);
    try {
      process.kill(mainPid, "SIGKILL");
    } catch (err) {
      console.error("[WatchdogHost] SIGKILL failed:", err);
    }
  },
});

const intervalHandle: NodeJS.Timeout = setInterval(() => {
  watchdog.tick();
}, HEARTBEAT_INTERVAL_MS);
// Allow the watchdog process to exit naturally if its parent goes away
// before sending dispose (e.g. main hard-crashes). The interval shouldn't
// hold the event loop open.
intervalHandle.unref();

port.on("message", (rawMsg: unknown) => {
  // parentPort wraps messages as { data, ports } — unwrap defensively.
  const msg =
    rawMsg && typeof rawMsg === "object" && "data" in rawMsg
      ? ((rawMsg as { data: unknown }).data as WatchdogMessage)
      : (rawMsg as WatchdogMessage);

  const handled = watchdog.handleMessage(msg);
  if (!handled) return;

  if (msg.type === "dispose") {
    clearInterval(intervalHandle);
    try {
      port.postMessage({ type: "disposed" });
    } catch {
      // postMessage can throw if the channel is already closed — that just
      // means main has already moved on; nothing to do.
    }
    process.exit(0);
  }
});

console.log(
  `[WatchdogHost] Started; main PID=${mainPid ?? "<missing>"}, interval=${HEARTBEAT_INTERVAL_MS}ms, threshold=${MAX_MISSED}`
);
