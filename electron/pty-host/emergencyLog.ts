import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { scrubSecrets } from "../../shared/utils/secretScrubber.js";

const MAX_LOG_SIZE = 1024 * 1024; // 1MB

export function getEmergencyLogPath(): string {
  const userData = process.env.DAINTREE_USER_DATA;
  const logDir = userData ? path.join(userData, "logs") : path.join(process.cwd(), "logs");
  return path.join(logDir, "pty-host.log");
}

export function appendEmergencyLog(lines: string): void {
  try {
    const logFile = getEmergencyLogPath();
    mkdirSync(path.dirname(logFile), { recursive: true });

    try {
      const stat = statSync(logFile);
      if (stat.size > MAX_LOG_SIZE) {
        writeFileSync(logFile, lines, { encoding: "utf8", flush: true });
        return;
      }
    } catch {
      // File doesn't exist yet — will be created by appendFileSync
    }

    appendFileSync(logFile, lines, { encoding: "utf8", flush: true });
  } catch {
    // best-effort only
  }
}

export function emergencyLogFatal(kind: string, error: unknown): void {
  const timestamp = new Date().toISOString();
  const pid = process.pid;
  const uptimeMs = Math.round(process.uptime() * 1000);
  const memory = process.memoryUsage();
  let details: unknown;
  try {
    details =
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { message: String(error) };
  } catch {
    details = { message: "[unable to serialize error]" };
  }

  appendEmergencyLog(
    scrubSecrets(
      [
        "============================================================",
        `[${timestamp}] [${kind}] pid=${pid} uptimeMs=${uptimeMs}`,
        `node=${process.version} platform=${process.platform} arch=${process.arch}`,
        `memory.rss=${memory.rss} heapUsed=${memory.heapUsed} heapTotal=${memory.heapTotal} external=${memory.external}`,
        `error=${JSON.stringify(details)}`,
        "",
      ].join("\n")
    )
  );
}
