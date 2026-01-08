import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export function getEmergencyLogPath(): string {
  const userData = process.env.CANOPY_USER_DATA;
  const logDir = userData
    ? path.join(userData, "logs")
    : process.env.NODE_ENV === "development"
      ? path.join(process.cwd(), "logs")
      : path.join(process.cwd(), "logs");
  return path.join(logDir, "pty-host.log");
}

export function appendEmergencyLog(lines: string): void {
  try {
    const logFile = getEmergencyLogPath();
    mkdirSync(path.dirname(logFile), { recursive: true });
    appendFileSync(logFile, lines, "utf8");
  } catch {
    // best-effort only
  }
}

export function emergencyLogFatal(kind: string, error: unknown): void {
  const timestamp = new Date().toISOString();
  const pid = process.pid;
  const uptimeMs = Math.round(process.uptime() * 1000);
  const memory = process.memoryUsage();
  const details =
    error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { message: String(error) };

  appendEmergencyLog(
    [
      "============================================================",
      `[${timestamp}] [${kind}] pid=${pid} uptimeMs=${uptimeMs}`,
      `node=${process.version} platform=${process.platform} arch=${process.arch}`,
      `memory.rss=${memory.rss} heapUsed=${memory.heapUsed} heapTotal=${memory.heapTotal} external=${memory.external}`,
      `error=${JSON.stringify(details)}`,
      "",
    ].join("\n")
  );
}
