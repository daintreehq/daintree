import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

const MAX_LOG_SIZE = 1024 * 1024; // 1MB

function getUserDataSafe(): string {
  try {
    return app.getPath("userData");
  } catch {
    return process.cwd();
  }
}

export function getMainCrashLogPath(): string {
  return path.join(getUserDataSafe(), "crashes", "main-crash.log");
}

export function appendMainCrashLog(lines: string): void {
  try {
    const logFile = getMainCrashLogPath();
    mkdirSync(path.dirname(logFile), { recursive: true });

    try {
      const stat = statSync(logFile);
      if (stat.size > MAX_LOG_SIZE) {
        writeFileSync(logFile, lines, "utf8");
        return;
      }
    } catch {
      // File doesn't exist yet — will be created by appendFileSync
    }

    appendFileSync(logFile, lines, "utf8");
  } catch {
    // best-effort only
  }
}

export function emergencyLogMainFatal(kind: string, error: unknown): void {
  const timestamp = new Date().toISOString();
  const pid = process.pid;
  const uptimeMs = Math.round(process.uptime() * 1000);
  const memory = process.memoryUsage();
  const details =
    error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { message: String(error) };

  appendMainCrashLog(
    [
      "============================================================",
      `[${timestamp}] [${kind}] pid=${pid} uptimeMs=${uptimeMs}`,
      `electron=${process.versions.electron ?? "unknown"} node=${process.version} platform=${process.platform} arch=${process.arch}`,
      `memory.rss=${memory.rss} heapUsed=${memory.heapUsed} heapTotal=${memory.heapTotal} external=${memory.external}`,
      `error=${JSON.stringify(details)}`,
      "",
    ].join("\n")
  );
}
