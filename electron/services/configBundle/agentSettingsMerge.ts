import {
  AGENT_BYPASS_FIELDS,
  AGENT_PRESET_PORTABLE_FIELDS,
  AGENT_SETTINGS_PORTABLE_FIELDS,
  PRESET_BYPASS_FIELDS,
} from "../../../shared/config/portableSettings.js";
import { isRecord } from "./sectionKit.js";

/**
 * Field-level projection and merge for `agentSettings.agents` (#13346).
 *
 * The bundle carries only the portable fields of each agent and preset, and a
 * value withheld as a secret is absent rather than blank. So nothing here may
 * replace a structure wholesale: env maps merge per name, presets merge per id
 * and per field, and every field the bundle doesn't name (bookkeeping, bypass,
 * whatever a newer build stores) is left exactly as the target has it.
 */

type Entry = Record<string, unknown>;

function pick(source: Entry, fields: readonly string[]): Entry {
  const out: Entry = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field) && source[field] !== undefined) {
      out[field] = source[field];
    }
  }
  return out;
}

function stringEntries(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

/** Names the incoming map sets win; names only the target has are kept. */
export function mergeEnv(current: unknown, incoming: unknown): Record<string, string> {
  return { ...stringEntries(current), ...stringEntries(incoming) };
}

function presetList(value: unknown): Entry[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function presetId(preset: Entry): string | undefined {
  return typeof preset.id === "string" && preset.id !== "" ? preset.id : undefined;
}

function projectPreset(preset: Entry): Entry {
  return pick(preset, AGENT_PRESET_PORTABLE_FIELDS);
}

/** The portable part of one agent's settings, or undefined when nothing portable is set. */
export function projectAgentEntry(entry: unknown): Entry | undefined {
  if (!isRecord(entry)) return undefined;
  const out = pick(entry, AGENT_SETTINGS_PORTABLE_FIELDS);
  if (out.customPresets !== undefined) {
    out.customPresets = presetList(out.customPresets).filter(presetId).map(projectPreset);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function projectAgents(agents: unknown): Record<string, Entry> {
  const out: Record<string, Entry> = {};
  if (!isRecord(agents)) return out;
  for (const [agentId, entry] of Object.entries(agents)) {
    const projected = projectAgentEntry(entry);
    if (projected) out[agentId] = projected;
  }
  return out;
}

/**
 * Presets by id: an incoming preset updates only the fields it carries on the
 * target's preset of the same id, its env per name, and a new one is appended.
 * The target's other presets, and their order, stay as they were.
 */
export function mergePresets(current: unknown, incoming: unknown): Entry[] {
  const merged = presetList(current).map((preset) => ({ ...preset }));
  for (const preset of presetList(incoming)) {
    const id = presetId(preset);
    if (!id) continue;
    const fields = projectPreset(preset);
    const index = merged.findIndex((candidate) => presetId(candidate) === id);
    if (index === -1) {
      if (fields.env !== undefined) fields.env = stringEntries(fields.env);
      merged.push(fields);
      continue;
    }
    const existing = merged[index];
    const next: Entry = { ...existing, ...fields };
    if (fields.env !== undefined) next.env = mergeEnv(existing.env, fields.env);
    merged[index] = next;
  }
  return merged;
}

/**
 * One agent's settings with the incoming portable fields laid over the
 * target's, minus the retired `selected`/`enabled` keys (dropped here as the
 * `agentSettings:set` handler drops them, so a merge also clears a persisted
 * one). `keepPresetId` false leaves the target's default preset alone.
 */
export function mergeAgentEntry(current: unknown, incoming: unknown, keepPresetId = true): Entry {
  const base: Entry = isRecord(current) ? { ...current } : {};
  delete base.selected;
  delete base.enabled;
  if (!isRecord(incoming)) return base;
  for (const field of AGENT_SETTINGS_PORTABLE_FIELDS) {
    const value = incoming[field];
    if (value === undefined) continue;
    if (field === "presetId" && !keepPresetId) continue;
    if (field === "globalEnv") {
      if (isRecord(value)) base.globalEnv = mergeEnv(base.globalEnv, value);
    } else if (field === "customPresets") {
      if (Array.isArray(value)) base.customPresets = mergePresets(base.customPresets, value);
    } else {
      base[field] = value;
    }
  }
  return base;
}

/** Ids of the custom presets an agent entry holds. */
export function customPresetIds(entry: unknown): string[] {
  if (!isRecord(entry)) return [];
  return presetList(entry.customPresets)
    .map(presetId)
    .filter((id): id is string => id !== undefined);
}

export interface BypassAgentPayload {
  dangerousMode?: unknown;
  dangerousEnabled?: unknown;
  dangerousArgs?: unknown;
  presets?: Record<string, Entry>;
}

export interface PermissionBypassPayload {
  globalSkipPermissions?: boolean;
  /** The assistant's own "skip tool prompts". */
  assistant?: boolean;
  agents?: Record<string, BypassAgentPayload>;
}

/** The bypass fields of one agent and of its presets, or undefined when it sets none. */
export function projectBypassAgent(entry: unknown): BypassAgentPayload | undefined {
  if (!isRecord(entry)) return undefined;
  const out: BypassAgentPayload = pick(entry, AGENT_BYPASS_FIELDS);
  const presets: Record<string, Entry> = {};
  for (const preset of presetList(entry.customPresets)) {
    const id = presetId(preset);
    if (!id) continue;
    const fields = pick(preset, PRESET_BYPASS_FIELDS);
    if (Object.keys(fields).length > 0) presets[id] = fields;
  }
  if (Object.keys(presets).length > 0) out.presets = presets;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function projectBypass(
  agentSettings: unknown,
  assistantBypass: unknown
): PermissionBypassPayload {
  const out: PermissionBypassPayload = {};
  const settings = isRecord(agentSettings) ? agentSettings : {};
  if (typeof settings.globalSkipPermissions === "boolean") {
    out.globalSkipPermissions = settings.globalSkipPermissions;
  }
  if (typeof assistantBypass === "boolean") out.assistant = assistantBypass;
  const agents: Record<string, BypassAgentPayload> = {};
  if (isRecord(settings.agents)) {
    for (const [agentId, entry] of Object.entries(settings.agents)) {
      const projected = projectBypassAgent(entry);
      if (projected) agents[agentId] = projected;
    }
  }
  if (Object.keys(agents).length > 0) out.agents = agents;
  return out;
}

const DANGEROUS_MODES: ReadonlySet<unknown> = new Set(["inherit", "on", "off"]);

/** Why an agent's bypass payload can't be written as it is, or null when it can. */
export function invalidBypassAgent(payload: unknown): string | null {
  if (!isRecord(payload)) return "Not a valid bypass setting";
  if (payload.dangerousMode !== undefined && !DANGEROUS_MODES.has(payload.dangerousMode)) {
    return "Not a valid bypass mode";
  }
  if (payload.dangerousEnabled !== undefined && typeof payload.dangerousEnabled !== "boolean") {
    return "Not a valid bypass setting";
  }
  if (payload.dangerousArgs !== undefined && typeof payload.dangerousArgs !== "string") {
    return "Bypass flags aren't text";
  }
  if (payload.presets !== undefined) {
    if (!isRecord(payload.presets)) return "Not a valid bypass setting";
    for (const fields of Object.values(payload.presets)) {
      if (!isRecord(fields)) return "Not a valid bypass setting";
      if (fields.dangerousMode !== undefined && !DANGEROUS_MODES.has(fields.dangerousMode)) {
        return "Not a valid bypass mode";
      }
      if (fields.dangerousEnabled !== undefined && typeof fields.dangerousEnabled !== "boolean") {
        return "Not a valid bypass setting";
      }
    }
  }
  return null;
}

/**
 * The bypass intent in a payload as the canonical mode plus its mirrored
 * legacy boolean, the way Settings writes it: `dangerousMode` wins, and a
 * legacy `dangerousEnabled` alone reads as `on`/`inherit`
 * (`resolveDangerousMode`). Laid over the target's fields this way, a copied
 * intent can't sit beside a target mode that silently outranks it.
 */
function bypassIntent(payload: Entry): Entry {
  const mode =
    typeof payload.dangerousMode === "string"
      ? payload.dangerousMode
      : typeof payload.dangerousEnabled === "boolean"
        ? payload.dangerousEnabled
          ? "on"
          : "inherit"
        : undefined;
  return mode === undefined ? {} : { dangerousMode: mode, dangerousEnabled: mode === "on" };
}

/**
 * Lay one agent's bypass payload over its settings: the agent's own fields,
 * and each preset's override on the target's preset of that id. A preset the
 * target doesn't have is returned in `missingPresets` and left out.
 */
export function mergeBypassAgent(
  current: unknown,
  payload: BypassAgentPayload
): { entry: Entry; missingPresets: string[] } {
  const entry: Entry = isRecord(current) ? { ...current } : {};
  Object.assign(entry, bypassIntent(payload as Entry));
  if (typeof payload.dangerousArgs === "string") entry.dangerousArgs = payload.dangerousArgs;
  const missingPresets: string[] = [];
  if (payload.presets && isRecord(payload.presets)) {
    const presets = presetList(entry.customPresets).map((preset) => ({ ...preset }));
    for (const [id, fields] of Object.entries(payload.presets)) {
      const index = presets.findIndex((candidate) => presetId(candidate) === id);
      if (index === -1) {
        missingPresets.push(id);
        continue;
      }
      presets[index] = { ...presets[index], ...bypassIntent(fields) };
    }
    if (presets.length > 0 || entry.customPresets !== undefined) entry.customPresets = presets;
  }
  return { entry, missingPresets };
}
