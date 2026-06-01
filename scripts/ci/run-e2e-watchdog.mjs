#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const WATCHDOG_EXIT_CODE = 124;
export const DEFAULT_TIMEOUT_MINUTES = 45;
export const DEFAULT_HEARTBEAT_SECONDS = 60;
const KILL_GRACE_MS = 15_000;
const TREE_KILL_TIMEOUT_MS = 5_000;

function parsePositiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number, got ${value}`);
  }
  return parsed;
}

export function parseArgs(argv) {
  let timeoutMinutes = DEFAULT_TIMEOUT_MINUTES;
  let heartbeatSeconds = DEFAULT_HEARTBEAT_SECONDS;
  const separatorIndex = argv.indexOf("--");

  if (separatorIndex === -1) {
    throw new Error("missing -- command separator");
  }

  const options = argv.slice(0, separatorIndex);
  const command = argv[separatorIndex + 1];
  const args = argv.slice(separatorIndex + 2);

  if (!command) {
    throw new Error("missing command after --");
  }

  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === "--timeout-minutes") {
      timeoutMinutes = parsePositiveNumber(options[++index], option);
    } else if (option === "--heartbeat-seconds") {
      heartbeatSeconds = parsePositiveNumber(options[++index], option);
    } else {
      throw new Error(`unknown option ${option}`);
    }
  }

  return {
    args,
    command,
    heartbeatMs: Math.round(heartbeatSeconds * 1000),
    timeoutMs: Math.round(timeoutMinutes * 60 * 1000),
  };
}

export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function tailLinesFromFile(filePath, maxLines = 3) {
  if (!filePath) return [];
  try {
    return readFileSync(filePath, "utf8").trimEnd().split(/\r?\n/).slice(-maxLines);
  } catch {
    return [];
  }
}

function terminateProcessTree(pid) {
  return new Promise((resolve) => {
    if (!pid) {
      resolve();
      return;
    }

    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        shell: false,
      });
      const timeout = setTimeout(() => {
        killer.kill();
        resolve();
      }, TREE_KILL_TIMEOUT_MS);
      killer.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      killer.once("error", () => {
        clearTimeout(timeout);
        resolve();
      });
      return;
    }

    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Process is already gone.
      }
    }

    resolve();
  });
}

function forceDetachChild(child) {
  try {
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Process group may already be gone.
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // Child may already be gone.
      }
    } else if (process.platform === "win32") {
      void terminateProcessTree(child.pid);
    }
  } catch {
    // Best effort only; the wrapper must still exit.
  }
  child.unref();
}

export function runCommandWithWatchdog({ args, command, heartbeatMs, timeoutMs }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let timedOut = false;

    console.log(
      `[e2e-watchdog] running with ${formatDuration(timeoutMs)} timeout: ${[command, ...args].join(
        " "
      )}`
    );

    const child = spawn(command, args, {
      detached: process.platform !== "win32",
      env: process.env,
      shell: process.platform === "win32",
      stdio: "inherit",
    });

    const heartbeat = setInterval(() => {
      console.log(`[e2e-watchdog] heartbeat elapsed=${formatDuration(Date.now() - startedAt)}`);
      for (const line of tailLinesFromFile(process.env.E2E_LAUNCH_TELEMETRY_FILE)) {
        console.log(`[e2e-watchdog] launch-telemetry ${line}`);
      }
    }, heartbeatMs);
    heartbeat.unref();

    const hardExit = setTimeout(() => {
      if (settled) return;
      console.error(
        `::error::e2e watchdog timed out after ${formatDuration(timeoutMs)}; killing process tree`
      );
      timedOut = true;
      void terminateProcessTree(child.pid);
      setTimeout(() => {
        if (settled) return;
        settled = true;
        clearInterval(heartbeat);
        clearTimeout(hardExit);
        forceDetachChild(child);
        console.error(
          `[e2e-watchdog] process tree did not close after ${formatDuration(
            KILL_GRACE_MS
          )}; forcing watchdog exit`
        );
        resolve(WATCHDOG_EXIT_CODE);
      }, KILL_GRACE_MS);
    }, timeoutMs);

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      clearTimeout(hardExit);
      console.error(`[e2e-watchdog] failed to start ${command}: ${error.message}`);
      resolve(1);
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      clearTimeout(hardExit);
      if (timedOut) {
        resolve(WATCHDOG_EXIT_CODE);
        return;
      }
      if (signal) {
        console.error(`[e2e-watchdog] command exited via signal ${signal}`);
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    process.exit(await runCommandWithWatchdog(parsed));
  } catch (error) {
    console.error(`[e2e-watchdog] ${error.message}`);
    process.exit(2);
  }
}
