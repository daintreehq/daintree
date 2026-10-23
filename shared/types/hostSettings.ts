import { z } from "zod";
import { isStorableAssistantAgentId, isStorableDefaultAgent } from "./ipc/agentDefaults.js";
import type { HostId } from "./remoteHosts.js";

/**
 * Settings another machine's Settings or assistant may read and change on a
 * host, by name (#14167). A closed list of host-owned leaves: nothing here is
 * a credential, an environment, a preset or a store path, and nothing this
 * machine owns for itself (its look, its keys) is ever reached this way.
 * `canopyMode` is consent, so it is edited here, deliberately, on the host it
 * names, and never copied (`portableSettings.ts`).
 */
export const HOST_SETTING_KEYS = [
  "canopyMode",
  "agentDefaults.defaultAgent",
  "agentDefaults.assistantAgentId",
  "idleTerminalNotify.enabled",
  "idleTerminalNotify.thresholdMinutes",
] as const;

export type HostSettingKey = (typeof HOST_SETTING_KEYS)[number];

const HOST_SETTING_KEY_SET: ReadonlySet<string> = new Set(HOST_SETTING_KEYS);

export function isHostSettingKey(value: unknown): value is HostSettingKey {
  return typeof value === "string" && HOST_SETTING_KEY_SET.has(value);
}

export const HOST_SETTING_LABELS: Record<HostSettingKey, string> = {
  canopyMode: "Canopy",
  "agentDefaults.defaultAgent": "Default agent",
  "agentDefaults.assistantAgentId": "Assistant agent",
  "idleTerminalNotify.enabled": "Alert about idle terminals",
  "idleTerminalNotify.thresholdMinutes": "Idle alert after (minutes)",
};

export const IDLE_THRESHOLD_MINUTES = { min: 15, max: 1440 } as const;

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
    case "agentDefaults.defaultAgent":
      return value === null || isStorableDefaultAgent(value)
        ? null
        : "Not an agent this host can start.";
    case "agentDefaults.assistantAgentId":
      return value === null || isStorableAssistantAgentId(value)
        ? null
        : "Not an agent that can run the assistant.";
    case "idleTerminalNotify.enabled":
      return typeof value === "boolean" ? null : "Expected on or off.";
    case "idleTerminalNotify.thresholdMinutes":
      return typeof value === "number" &&
        Number.isInteger(value) &&
        value >= IDLE_THRESHOLD_MINUTES.min &&
        value <= IDLE_THRESHOLD_MINUTES.max
        ? null
        : `Expected ${IDLE_THRESHOLD_MINUTES.min} to ${IDLE_THRESHOLD_MINUTES.max} minutes.`;
  }
}

const agentId = z.string().min(1).max(128).nullable();

/** One value per key, each in the shape its own setting stores. */
export const HostSettingsPatchFieldsSchema = z
  .object({
    canopyMode: z.enum(["unset", "on", "hidden"]).optional(),
    "agentDefaults.defaultAgent": agentId.optional(),
    "agentDefaults.assistantAgentId": agentId.optional(),
    "idleTerminalNotify.enabled": z.boolean().optional(),
    "idleTerminalNotify.thresholdMinutes": z
      .number()
      .int()
      .min(IDLE_THRESHOLD_MINUTES.min)
      .max(IDLE_THRESHOLD_MINUTES.max)
      .optional(),
  })
  .strict();

export const HostSettingsPatchSchema = HostSettingsPatchFieldsSchema.refine(
  (patch) => Object.keys(patch).length > 0,
  { message: "nothing to change" }
);

export type HostSettingsPatch = z.infer<typeof HostSettingsPatchSchema>;
export type HostSettingValue = string | number | boolean | null;

const revision = z.string().min(1).max(64);
const instanceId = z.string().min(1).max(64);

/** A setting as the host reads it now, with the revision a change must be made against. */
export const HostSettingLeafSchema = z.object({
  key: z.enum(HOST_SETTING_KEYS),
  value: z.union([z.string().max(128), z.number(), z.boolean(), z.null()]),
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
}

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
