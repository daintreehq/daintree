import { z } from "zod";
import { isStorableAssistantAgentId, isStorableDefaultAgent } from "./ipc/agentDefaults.js";
import { isCanopyModelId } from "./ipc/canopy.js";
import { isIdleShellThresholdMinutes } from "./ipc/idleBackgroundAutoClose.js";
import { isResumeOnRestart, RESUME_ON_RESTART_VALUES } from "./agentSettings.js";
import type { HostId } from "./remoteHosts.js";

/**
 * Settings another machine's Settings may read and change on a host, by name
 * (#14167, #14706). A closed list of host-owned leaves: nothing here is a
 * credential, a consent, a trust decision, a preset or a store path, and
 * nothing this machine owns for itself (its look, its keys) is ever reached
 * this way. `canopyMode` is edited here, deliberately, on the host it names,
 * and never copied (`portableSettings.ts`). `canopyModel` reads the model that
 * host reads with, and is how a Shell tells a host that reads locally from one
 * on a Daintree from before. There is one model, so writing it changes
 * nothing; any of the publisher's readers passes, as a host on an earlier
 * build may still report the one it chose. The host's global environment is
 * here for the Settings that edits it, never for an assistant
 * (`ASSISTANT_HOST_SETTING_KEYS`).
 */
export const HOST_SETTING_KEYS = [
  "canopyMode",
  "canopyModel",
  "agentDefaults.defaultAgent",
  "agentDefaults.assistantAgentId",
  "idleTerminalNotify.enabled",
  "idleTerminalNotify.thresholdMinutes",
  "agentSettings.resumeOnRestart",
  "agentSettings.globalUseAltScreen",
  "globalEnvironmentVariables",
  "terminalConfig.resourceMonitoringEnabled",
  "terminalConfig.memoryLeakDetectionEnabled",
  "terminalConfig.memoryLeakAutoRestartThresholdMb",
  "sessionRestore.enabled",
  "idleBackgroundAutoClose.enabled",
  "idleBackgroundAutoClose.thresholdMinutes",
  "idleBackgroundAutoClose.includeIdleShells",
  "idleBackgroundAutoClose.idleShellThresholdMinutes",
] as const;

export type HostSettingKey = (typeof HOST_SETTING_KEYS)[number];

/**
 * What a host from before #14706 knows, and all it is asked about: it has no
 * way to say which keys it takes, and refuses a whole read naming one it
 * doesn't.
 */
export const LEGACY_HOST_SETTING_KEYS = [
  "canopyMode",
  "canopyModel",
  "agentDefaults.defaultAgent",
  "agentDefaults.assistantAgentId",
  "idleTerminalNotify.enabled",
  "idleTerminalNotify.thresholdMinutes",
] as const satisfies readonly HostSettingKey[];

/**
 * What this machine's assistants may read and change on a host: the same six
 * as before #14706. The rest are for the person in Settings.
 */
export const ASSISTANT_HOST_SETTING_KEYS = LEGACY_HOST_SETTING_KEYS;
export type AssistantHostSettingKey = (typeof ASSISTANT_HOST_SETTING_KEYS)[number];

const HOST_SETTING_KEY_SET: ReadonlySet<string> = new Set(HOST_SETTING_KEYS);
const ASSISTANT_HOST_SETTING_KEY_SET: ReadonlySet<string> = new Set(ASSISTANT_HOST_SETTING_KEYS);

export function isHostSettingKey(value: unknown): value is HostSettingKey {
  return typeof value === "string" && HOST_SETTING_KEY_SET.has(value);
}

export function isAssistantHostSettingKey(value: unknown): value is AssistantHostSettingKey {
  return typeof value === "string" && ASSISTANT_HOST_SETTING_KEY_SET.has(value);
}

export const HOST_SETTING_LABELS: Record<HostSettingKey, string> = {
  canopyMode: "Canopy",
  canopyModel: "Canopy model",
  "agentDefaults.defaultAgent": "Default agent",
  "agentDefaults.assistantAgentId": "Assistant agent",
  "idleTerminalNotify.enabled": "Alert about idle terminals",
  "idleTerminalNotify.thresholdMinutes": "Idle alert after (minutes)",
  "agentSettings.resumeOnRestart": "Resume agents after a restart",
  "agentSettings.globalUseAltScreen": "Use alt-screen mode by default",
  globalEnvironmentVariables: "Global environment variables",
  "terminalConfig.resourceMonitoringEnabled": "Resource monitoring",
  "terminalConfig.memoryLeakDetectionEnabled": "Memory leak detection",
  "terminalConfig.memoryLeakAutoRestartThresholdMb": "Restart leaking agents above (MB)",
  "sessionRestore.enabled": "Restore terminal sessions",
  "idleBackgroundAutoClose.enabled": "Sleep idle background projects",
  "idleBackgroundAutoClose.thresholdMinutes": "Sleep after (minutes)",
  "idleBackgroundAutoClose.includeIdleShells": "Include projects with idle terminals",
  "idleBackgroundAutoClose.idleShellThresholdMinutes": "Idle terminals sleep after (minutes)",
};

export const IDLE_THRESHOLD_MINUTES = { min: 15, max: 1440 } as const;
export const LEAK_RESTART_THRESHOLD_MB = { min: 1024, max: 32768 } as const;

/**
 * Bounds on a host's global environment as it travels: generous enough for
 * any set a person keeps, small enough that one reply stays well inside a
 * link frame. Names follow what the host's own Settings stores, not only the
 * POSIX form its form asks for, so a variable kept from before still reads.
 */
export const HOST_ENV_LIMITS = { entries: 500, nameLength: 256, valueLength: 32_768 } as const;

function envRefusal(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "Expected a set of variables.";
  }
  const entries = Object.entries(value);
  if (entries.length > HOST_ENV_LIMITS.entries) {
    return `At most ${HOST_ENV_LIMITS.entries} variables.`;
  }
  for (const [name, text] of entries) {
    if (name.length === 0 || name.length > HOST_ENV_LIMITS.nameLength) {
      return "A variable name is empty or too long.";
    }
    if (name.includes("=") || name.includes("\0")) return `${name} isn't a variable name.`;
    if (typeof text !== "string") return `${name} needs a text value.`;
    if (text.length > HOST_ENV_LIMITS.valueLength) return `${name}'s value is too long.`;
    if (text.includes("\0")) return `${name}'s value can't hold a null character.`;
  }
  return null;
}

function booleanRefusal(value: unknown): string | null {
  return typeof value === "boolean" ? null : "Expected on or off.";
}

function minutesRefusal(value: unknown, bounds: { min: number; max: number }, unit: string) {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= bounds.min &&
    value <= bounds.max
    ? null
    : `Expected ${bounds.min} to ${bounds.max} ${unit}.`;
}

/**
 * Why a host won't store a value, or null when it would: the same rules its
 * own Settings applies, so a preview here refuses what the host would.
 */
export function hostSettingRefusal(key: HostSettingKey, value: unknown): string | null {
  switch (key) {
    case "canopyMode":
      return value === "unset" || value === "on" || value === "hidden"
        ? null
        : "Not a Canopy mode.";
    case "canopyModel":
      return isCanopyModelId(value) ? null : "Not one of Canopy's models.";
    case "agentDefaults.defaultAgent":
      return value === null || isStorableDefaultAgent(value)
        ? null
        : "Not an agent this host can start.";
    case "agentDefaults.assistantAgentId":
      return value === null || isStorableAssistantAgentId(value)
        ? null
        : "Not an agent that can run the assistant.";
    case "idleTerminalNotify.enabled":
    case "agentSettings.globalUseAltScreen":
    case "terminalConfig.resourceMonitoringEnabled":
    case "terminalConfig.memoryLeakDetectionEnabled":
    case "sessionRestore.enabled":
    case "idleBackgroundAutoClose.enabled":
    case "idleBackgroundAutoClose.includeIdleShells":
      return booleanRefusal(value);
    case "idleTerminalNotify.thresholdMinutes":
    case "idleBackgroundAutoClose.thresholdMinutes":
      return minutesRefusal(value, IDLE_THRESHOLD_MINUTES, "minutes");
    case "terminalConfig.memoryLeakAutoRestartThresholdMb":
      return minutesRefusal(value, LEAK_RESTART_THRESHOLD_MB, "MB");
    case "idleBackgroundAutoClose.idleShellThresholdMinutes":
      return isIdleShellThresholdMinutes(value) ? null : "Expected 1, 2, 4 or 8 hours.";
    case "agentSettings.resumeOnRestart":
      return isResumeOnRestart(value) ? null : "Not a way to resume agents.";
    case "globalEnvironmentVariables":
      return envRefusal(value);
  }
}

const agentId = z.string().min(1).max(128).nullable();
const idleMinutes = z
  .number()
  .int()
  .min(IDLE_THRESHOLD_MINUTES.min)
  .max(IDLE_THRESHOLD_MINUTES.max);
const envVariables = z
  .record(z.string(), z.string())
  .refine((value) => envRefusal(value) === null, { message: "not a set of variables" });

/** One value per key, each in the shape its own setting stores. */
export const HostSettingsPatchFieldsSchema = z
  .object({
    canopyMode: z.enum(["unset", "on", "hidden"]).optional(),
    canopyModel: z.string().max(120).refine(isCanopyModelId).optional(),
    "agentDefaults.defaultAgent": agentId.optional(),
    "agentDefaults.assistantAgentId": agentId.optional(),
    "idleTerminalNotify.enabled": z.boolean().optional(),
    "idleTerminalNotify.thresholdMinutes": idleMinutes.optional(),
    "agentSettings.resumeOnRestart": z.enum(RESUME_ON_RESTART_VALUES).optional(),
    "agentSettings.globalUseAltScreen": z.boolean().optional(),
    globalEnvironmentVariables: envVariables.optional(),
    "terminalConfig.resourceMonitoringEnabled": z.boolean().optional(),
    "terminalConfig.memoryLeakDetectionEnabled": z.boolean().optional(),
    "terminalConfig.memoryLeakAutoRestartThresholdMb": z
      .number()
      .int()
      .min(LEAK_RESTART_THRESHOLD_MB.min)
      .max(LEAK_RESTART_THRESHOLD_MB.max)
      .optional(),
    "sessionRestore.enabled": z.boolean().optional(),
    "idleBackgroundAutoClose.enabled": z.boolean().optional(),
    "idleBackgroundAutoClose.thresholdMinutes": idleMinutes.optional(),
    "idleBackgroundAutoClose.includeIdleShells": z.boolean().optional(),
    "idleBackgroundAutoClose.idleShellThresholdMinutes": z
      .number()
      .refine(isIdleShellThresholdMinutes)
      .optional(),
  })
  .strict();

/** The patch an assistant may propose: its own six keys and nothing else. */
export const AssistantHostSettingsPatchFieldsSchema = HostSettingsPatchFieldsSchema.pick({
  canopyMode: true,
  canopyModel: true,
  "agentDefaults.defaultAgent": true,
  "agentDefaults.assistantAgentId": true,
  "idleTerminalNotify.enabled": true,
  "idleTerminalNotify.thresholdMinutes": true,
});

export const HostSettingsPatchSchema = HostSettingsPatchFieldsSchema.refine(
  (patch) => Object.keys(patch).length > 0,
  { message: "nothing to change" }
);

export type HostSettingsPatch = z.infer<typeof HostSettingsPatchSchema>;
export type HostSettingValue = string | number | boolean | null | Record<string, string>;

const revision = z.string().min(1).max(64);
const instanceId = z.string().min(1).max(64);

/** A setting as the host reads it now, with the revision a change must be made against. */
export const HostSettingLeafSchema = z.object({
  key: z.enum(HOST_SETTING_KEYS),
  value: z.union([
    z.string().max(128),
    z.number(),
    z.boolean(),
    z.null(),
    z.record(z.string(), z.string()),
  ]),
  revision,
});
export type HostSettingLeaf = z.infer<typeof HostSettingLeafSchema>;

/**
 * What the host answers about its settings. `instanceId` names the launch the
 * revisions were counted in: one from before a restart is never current.
 */
export const HostSettingsReadingSchema = z.object({
  instanceId,
  settings: z.array(HostSettingLeafSchema).max(HOST_SETTING_KEYS.length),
});
export type HostSettingsReading = z.infer<typeof HostSettingsReadingSchema>;

export const HostSettingsExpectSchema = z.object({
  instanceId,
  revisions: z.partialRecord(z.enum(HOST_SETTING_KEYS), revision),
});
export type HostSettingsExpect = z.infer<typeof HostSettingsExpectSchema>;

/**
 * `applied`: every key was written, and `settings` is the host's readback.
 * `conflict`: something changed since `expect` (or the host restarted), so
 * nothing was written; `settings` is how the keys stand now.
 */
export const HostSettingsUpdateReplySchema = z.object({
  outcome: z.enum(["applied", "conflict"]),
  instanceId,
  settings: z.array(HostSettingLeafSchema).max(HOST_SETTING_KEYS.length),
});
export type HostSettingsUpdateReply = z.infer<typeof HostSettingsUpdateReplySchema>;

/** A host's settings as this Shell shows them: whose, and at what scope. */
export interface HostSettingsSnapshot extends HostSettingsReading {
  hostId: HostId;
  hostName: string;
  /** Always the host's own settings, never this machine's or a project's. */
  scope: "host";
  /**
   * Keys asked about that this host's Daintree doesn't know: it is on a build
   * from before them, and updating it there is what makes them editable.
   */
  unavailable: HostSettingKey[];
}

/**
 * What a host says it can be asked about. Keys this Shell doesn't know (a
 * newer host's) are dropped, never refused, so a newer host still reads.
 */
export const HostSettingsDescriptionSchema = z.object({
  instanceId,
  keys: z.array(z.string().max(128)).max(256),
});
export type HostSettingsDescription = z.infer<typeof HostSettingsDescriptionSchema>;

export interface HostSettingsReadPayload {
  hostId: HostId;
  keys?: HostSettingKey[];
}

export interface HostSettingsUpdatePayload {
  hostId: HostId;
  patch: HostSettingsPatch;
  expect: HostSettingsExpect;
}

/**
 * When the host's reply was lost, its settings are read back to tell: a change
 * the readback shows is `applied` with `confirmedBy: "readback"`, which says
 * the host now holds what was asked for (Canopy's own count also says it was
 * this change), and one it shows never landed is `not-applied`. `unconfirmed`: the host couldn't be read back
 * either, so whether the change landed is unknown until it is read again.
 */
export interface HostSettingsUpdateResult {
  hostId: HostId;
  hostName: string;
  scope: "host";
  outcome: "applied" | "conflict" | "not-applied" | "unconfirmed";
  /**
   * How the outcome is known: the host's own answer, or what a readback after
   * a lost answer showed. Only the host's own `conflict` says nothing was
   * written; one seen in a readback may follow this change having landed.
   */
  confirmedBy: "reply" | "readback" | null;
  instanceId: string | null;
  settings: HostSettingLeaf[];
}
