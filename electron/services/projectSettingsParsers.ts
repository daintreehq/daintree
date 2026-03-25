import type { ProjectTerminalSettings } from "../types/index.js";
import type { NotificationSettings } from "../../shared/types/ipc/api.js";
import path from "path";
import { normalizeScrollbackLines } from "../../shared/config/scrollback.js";

export function parseTerminalSettings(raw: unknown): ProjectTerminalSettings | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const result: ProjectTerminalSettings = {};

  if (typeof obj.shell === "string" && obj.shell.trim() && path.isAbsolute(obj.shell.trim())) {
    result.shell = obj.shell.trim();
  }
  if (Array.isArray(obj.shellArgs)) {
    const args = obj.shellArgs.filter((a): a is string => typeof a === "string");
    if (args.length > 0) result.shellArgs = args;
  }
  if (
    typeof obj.defaultWorkingDirectory === "string" &&
    obj.defaultWorkingDirectory.trim() &&
    path.isAbsolute(obj.defaultWorkingDirectory.trim())
  ) {
    result.defaultWorkingDirectory = obj.defaultWorkingDirectory.trim();
  }
  if (typeof obj.scrollbackLines === "number" || typeof obj.scrollbackLines === "string") {
    result.scrollbackLines = normalizeScrollbackLines(obj.scrollbackLines);
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

export function parseNotificationOverrides(
  raw: unknown
): Partial<NotificationSettings> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const result: Partial<NotificationSettings> = {};

  if (typeof obj.completedEnabled === "boolean") result.completedEnabled = obj.completedEnabled;
  if (typeof obj.waitingEnabled === "boolean") result.waitingEnabled = obj.waitingEnabled;
  if (typeof obj.soundEnabled === "boolean") result.soundEnabled = obj.soundEnabled;
  if (
    typeof obj.soundFile === "string" &&
    ["chime.wav", "ping.wav", "complete.wav", "waiting.wav", "error.wav"].includes(obj.soundFile)
  ) {
    result.soundFile = obj.soundFile;
  }
  if (typeof obj.waitingEscalationEnabled === "boolean") {
    result.waitingEscalationEnabled = obj.waitingEscalationEnabled;
  }
  if (
    typeof obj.waitingEscalationDelayMs === "number" &&
    Number.isFinite(obj.waitingEscalationDelayMs)
  ) {
    result.waitingEscalationDelayMs = Math.max(
      30_000,
      Math.min(3_600_000, obj.waitingEscalationDelayMs)
    );
  }

  return Object.keys(result).length > 0 ? result : undefined;
}
