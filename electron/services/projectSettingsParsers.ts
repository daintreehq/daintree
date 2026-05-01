import type { ProjectTerminalSettings } from "../types/index.js";
import type { FleetSavedScope } from "../../shared/types/project.js";
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
  const ALLOWED_SOUNDS = [
    "chime.wav",
    "ping.wav",
    "complete.wav",
    "waiting.wav",
    "error.wav",
    "pulse.wav",
  ];

  if (
    typeof obj.completedSoundFile === "string" &&
    ALLOWED_SOUNDS.includes(obj.completedSoundFile)
  ) {
    result.completedSoundFile = obj.completedSoundFile;
  } else if (typeof obj.soundFile === "string" && ALLOWED_SOUNDS.includes(obj.soundFile)) {
    result.completedSoundFile = obj.soundFile;
  }
  if (typeof obj.waitingSoundFile === "string" && ALLOWED_SOUNDS.includes(obj.waitingSoundFile)) {
    result.waitingSoundFile = obj.waitingSoundFile;
  }
  if (
    typeof obj.escalationSoundFile === "string" &&
    ALLOWED_SOUNDS.includes(obj.escalationSoundFile)
  ) {
    result.escalationSoundFile = obj.escalationSoundFile;
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
  if (typeof obj.workingPulseEnabled === "boolean") {
    result.workingPulseEnabled = obj.workingPulseEnabled;
  }
  if (
    typeof obj.workingPulseSoundFile === "string" &&
    ALLOWED_SOUNDS.includes(obj.workingPulseSoundFile)
  ) {
    result.workingPulseSoundFile = obj.workingPulseSoundFile;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

const VALID_PREDICATE_SCOPES = new Set(["current", "all"]);
const VALID_PREDICATE_STATES = new Set(["all", "working", "waiting", "finished"]);

export function parseFleetSavedScopes(raw: unknown): FleetSavedScope[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: FleetSavedScope[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    if (typeof o.id !== "string" || !o.id.trim()) continue;
    if (typeof o.name !== "string" || !o.name.trim()) continue;
    if (typeof o.createdAt !== "number" || !Number.isFinite(o.createdAt)) continue;
    if (o.kind === "snapshot") {
      if (!Array.isArray(o.terminalIds)) continue;
      const terminalIds = o.terminalIds.filter((t): t is string => typeof t === "string");
      out.push({
        kind: "snapshot",
        id: o.id,
        name: o.name,
        terminalIds,
        createdAt: o.createdAt,
      });
    } else if (o.kind === "predicate") {
      if (typeof o.scope !== "string" || !VALID_PREDICATE_SCOPES.has(o.scope)) continue;
      if (typeof o.stateFilter !== "string" || !VALID_PREDICATE_STATES.has(o.stateFilter)) continue;
      out.push({
        kind: "predicate",
        id: o.id,
        name: o.name,
        scope: o.scope as "current" | "all",
        stateFilter: o.stateFilter as "all" | "working" | "waiting" | "finished",
        createdAt: o.createdAt,
      });
    }
  }
  return out.length > 0 ? out : undefined;
}
