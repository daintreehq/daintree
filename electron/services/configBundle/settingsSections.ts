// eager-import-allow: reads portable config via store.get synchronously while building a bundle
import { store } from "../../store.js";
import {
  getAssistantWiredAgentIds,
  getEffectiveAgentConfig,
} from "../../../shared/config/agentRegistry.js";
import { isAgentInstalled } from "../../../shared/utils/agentAvailability.js";
import { isSensitiveEnvKey } from "../../../shared/utils/envVars.js";
import { findSecretInValue } from "../../../shared/utils/secretScrubber.js";
import type { ConfigImportLeafResult } from "../../../shared/types/configBundle.js";
import { sanitizeModelId, sanitizeModelIdMap } from "../../utils/helpAssistantModels.js";
import {
  asBoolean,
  boundedInteger,
  diffRecord,
  emptyCheck,
  isRecord,
  recordLeafValue,
  sameValue,
  scalarSection,
  skippedLeaf,
  unchangedLeaf,
  withRecordLeaf,
  type SectionContext,
  type SectionDiff,
  type SectionHandler,
} from "./sectionKit.js";
import {
  invalidBypassAgent,
  mergeAgentEntry,
  mergeBypassAgent,
  projectBypass,
  projectBypassAgent,
  customPresetIds,
  type BypassAgentPayload,
  type PermissionBypassPayload,
} from "./agentSettingsMerge.js";

/**
 * The sections added for Copy settings (#13346). Each writes through the
 * setter its Settings page uses, so a running service (the hibernation timer,
 * the idle checks, the plugin update checker) changes with it rather than on
 * the next launch.
 */

const hours = (value: unknown) =>
  typeof value === "number" ? `${value} ${value === 1 ? "hour" : "hours"}` : undefined;
const minutes = (value: unknown) => (typeof value === "number" ? `${value} min` : undefined);

function agentName(agentId: string): string {
  return getEffectiveAgentConfig(agentId)?.name ?? agentId;
}

export function hibernationSection(): SectionHandler {
  return scalarSection({
    id: "hibernation",
    fields: {
      enabled: { label: "Hibernate unused projects", normalize: asBoolean },
      inactiveThresholdHours: {
        label: "Hibernate after",
        normalize: boundedInteger(1, 168),
        display: hours,
      },
    },
    read: () => store.get("hibernation"),
    write: async (patch) => {
      const { getHibernationService } = await import("../HibernationService.js");
      getHibernationService().updateConfig(patch);
    },
  });
}

export function sessionRestoreSection(): SectionHandler {
  return scalarSection({
    id: "sessionRestore",
    fields: { enabled: { label: "Reopen every live project", normalize: asBoolean } },
    read: () => store.get("sessionRestore"),
    // Read once at startup, so there is no running service to tell.
    write: (patch) => {
      if (typeof patch.enabled === "boolean")
        store.set("sessionRestore", { enabled: patch.enabled });
    },
  });
}

export function idleTerminalNotifySection(): SectionHandler {
  return scalarSection({
    id: "idleTerminalNotify",
    fields: {
      enabled: { label: "Alert about idle terminals", normalize: asBoolean },
      thresholdMinutes: {
        label: "Alert after",
        normalize: boundedInteger(15, 1440),
        display: minutes,
      },
    },
    read: () => store.get("idleTerminalNotify"),
    write: async (patch) => {
      const { getIdleTerminalNotificationService } =
        await import("../IdleTerminalNotificationService.js");
      getIdleTerminalNotificationService().updateConfig(patch);
    },
  });
}

export function idleBackgroundAutoCloseSection(): SectionHandler {
  return scalarSection({
    id: "idleBackgroundAutoClose",
    fields: {
      enabled: { label: "Close idle background terminals", normalize: asBoolean },
      thresholdMinutes: {
        label: "Close after",
        normalize: boundedInteger(15, 1440),
        display: minutes,
      },
    },
    read: () => store.get("idleBackgroundAutoClose"),
    write: async (patch) => {
      const { getIdleBackgroundAutoCloseService } =
        await import("../IdleBackgroundAutoCloseService.js");
      getIdleBackgroundAutoCloseService().updateConfig(patch);
    },
  });
}

export function agentUpdateChecksSection(): SectionHandler {
  const read = () => store.get("agentUpdateSettings");
  return scalarSection({
    id: "agentUpdateChecks",
    fields: {
      autoCheck: { label: "Check for agent CLI updates", normalize: asBoolean },
      // Refused rather than clamped, as the Settings handler refuses it.
      checkFrequencyHours: {
        label: "Check every",
        normalize: (value) =>
          typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 168
            ? value
            : undefined,
        invalidReason: "Not between 1 and 168 hours",
        display: hours,
      },
    },
    read,
    // The timestamp of the last check is this machine's, so it is carried over.
    write: (patch) => {
      const current = read();
      store.set("agentUpdateSettings", {
        autoCheck: typeof current?.autoCheck === "boolean" ? current.autoCheck : true,
        checkFrequencyHours:
          typeof current?.checkFrequencyHours === "number" ? current.checkFrequencyHours : 24,
        lastAutoCheck: typeof current?.lastAutoCheck === "number" ? current.lastAutoCheck : null,
        ...patch,
      } as never);
    },
  });
}

export function pluginUpdateChecksSection(): SectionHandler {
  return scalarSection({
    id: "pluginUpdateChecks",
    fields: { enabled: { label: "Check for plugin updates", normalize: asBoolean } },
    read: () => store.get("pluginBackgroundUpdateCheck"),
    write: async (patch) => {
      const { getPluginUpdateCheckService } = await import("../PluginUpdateCheckService.js");
      getPluginUpdateCheckService().updateSettings(patch);
    },
  });
}

/** Why the assistant on this machine couldn't use `agentId`, or null when it can. */
function assistantRefusal(agentId: string, ctx: Pick<SectionContext, "availability">) {
  if (!getAssistantWiredAgentIds().includes(agentId)) return "Can't run the assistant";
  if (ctx.availability && !isAgentInstalled(ctx.availability[agentId])) {
    return "Its CLI isn't installed";
  }
  return null;
}

/** The assistant's model per agent (`helpAssistant.modelIds`), merged per agent. */
export function assistantModelsSection(
  availability: () => SectionContext["availability"]
): SectionHandler {
  const read = (): Record<string, string> => {
    const raw = store.get("helpAssistant");
    return sanitizeModelIdMap(isRecord(raw) ? raw.modelIds : undefined) ?? {};
  };
  const refusal = (agentId: string, value: unknown, ctx: Pick<SectionContext, "availability">) => {
    if (typeof sanitizeModelId(value) !== "string") return "Not a valid model id";
    return assistantRefusal(agentId, ctx);
  };
  const modelName = (agentId: string, value: unknown) => {
    if (value === "") return "CLI default";
    if (typeof value !== "string") return undefined;
    return getEffectiveAgentConfig(agentId)?.models?.find((m) => m.id === value)?.name ?? value;
  };

  return {
    id: "assistantModels",
    read: async () => read(),
    diff: diffRecord,
    check: async (incoming, _current, ctx) => {
      const check = emptyCheck();
      if (!isRecord(incoming)) return check;
      // A custom agent this same copy defines isn't in the registry yet, so
      // whether it can run the assistant is only known once it lands: the
      // apply decides, and can only skip what the preview listed, never add.
      const arriving = isRecord(ctx.incoming.userAgentRegistry)
        ? ctx.incoming.userAgentRegistry
        : {};
      for (const [agentId, value] of Object.entries(incoming)) {
        const reason = Object.prototype.hasOwnProperty.call(arriving, agentId)
          ? typeof sanitizeModelId(value) === "string"
            ? null
            : "Not a valid model id"
          : refusal(agentId, value, ctx);
        if (reason) check.skipped.set(agentId, reason);
      }
      return check;
    },
    describe: (key, kind, incoming, current) => ({
      key,
      kind,
      label: agentName(key),
      from: kind === "update" && isRecord(current) ? modelName(key, current[key]) : undefined,
      to: isRecord(incoming) ? modelName(key, incoming[key]) : undefined,
    }),
    apply: async (incoming, current) => {
      const results: ConfigImportLeafResult[] = [];
      if (!isRecord(incoming)) return results;
      const currentMap = isRecord(current) ? current : {};
      const merged: Record<string, unknown> = { ...currentMap };
      const pending: string[] = [];
      const ctx = { availability: availability() };
      for (const [agentId, value] of Object.entries(incoming)) {
        const reason = refusal(agentId, value, ctx);
        if (reason) {
          results.push(skippedLeaf(agentId, reason));
          continue;
        }
        const model = sanitizeModelId(value) as string;
        if (sameValue(model, currentMap[agentId])) {
          results.push(unchangedLeaf(agentId));
          continue;
        }
        merged[agentId] = model;
        pending.push(agentId);
      }
      if (pending.length === 0) return results;
      store.set("helpAssistant.modelIds" as never, merged as never);
      const readBack = read();
      for (const agentId of pending) {
        results.push(
          sameValue(readBack[agentId], merged[agentId])
            ? { key: agentId, status: "applied" }
            : skippedLeaf(agentId, "Value did not persist")
        );
      }
      return results;
    },
    restore: async (snapshot) => {
      store.set("helpAssistant.modelIds" as never, (isRecord(snapshot) ? snapshot : {}) as never);
    },
  };
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Why a global variable doesn't travel, or null when it does. Checked again on the receiving side. */
function envRefusal(name: string, value: unknown): string | null {
  if (!ENV_NAME.test(name)) return "Not a valid variable name";
  if (typeof value !== "string") return "Not a text value";
  if (isSensitiveEnvKey(name) || findSecretInValue(value)) {
    return "Looks like a secret, so it stays on each machine";
  }
  return null;
}

/** `globalEnvironmentVariables`, merged per name: a variable the target alone has is kept. */
export function globalEnvironmentSection(): SectionHandler {
  const read = (): Record<string, string> => {
    const raw = store.get("globalEnvironmentVariables");
    const out: Record<string, string> = {};
    if (!isRecord(raw)) return out;
    for (const [name, value] of Object.entries(raw)) {
      if (typeof value === "string") out[name] = value;
    }
    return out;
  };

  return {
    id: "globalEnvironment",
    read: async () => read(),
    diff: diffRecord,
    check: async (incoming) => {
      const check = emptyCheck();
      if (!isRecord(incoming)) return check;
      for (const [name, value] of Object.entries(incoming)) {
        const reason = envRefusal(name, value);
        if (reason) check.skipped.set(name, reason);
      }
      return check;
    },
    // Names only: a value is often a path or a host name a person may not want on screen.
    describe: (key, kind) => ({ key, kind, label: key }),
    apply: async (incoming, current) => {
      const results: ConfigImportLeafResult[] = [];
      if (!isRecord(incoming)) return results;
      const currentMap = isRecord(current) ? current : {};
      const merged: Record<string, string> = { ...(currentMap as Record<string, string>) };
      const pending: string[] = [];
      for (const [name, value] of Object.entries(incoming)) {
        const reason = envRefusal(name, value);
        if (reason) {
          results.push(skippedLeaf(name, reason));
          continue;
        }
        if (sameValue(value, currentMap[name])) {
          results.push(unchangedLeaf(name));
          continue;
        }
        merged[name] = value as string;
        pending.push(name);
      }
      if (pending.length === 0) return results;
      store.set("globalEnvironmentVariables", merged);
      const readBack = read();
      for (const name of pending) {
        results.push(
          readBack[name] === merged[name]
            ? { key: name, status: "applied" }
            : skippedLeaf(name, "Value did not persist")
        );
      }
      return results;
    },
    restore: async (snapshot) => {
      store.set("globalEnvironmentVariables", (isRecord(snapshot) ? snapshot : {}) as never);
    },
  };
}

interface BypassSnapshot {
  agents: Record<string, unknown>;
  globalSkipPermissions?: boolean;
  assistant?: boolean;
}

const GLOBAL_KEY = "globalSkipPermissions";
const ASSISTANT_KEY = "assistant";
const agentKey = (agentId: string) => `agents.${agentId}`;
const presetKey = (agentId: string, presetId: string) => `agents.${agentId}.presets.${presetId}`;

const MODE_LABELS: Record<string, string> = {
  on: "Always skip",
  off: "Never skip",
  inherit: "Follow the global setting",
};

function bypassModeLabel(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (typeof payload.dangerousMode === "string") return MODE_LABELS[payload.dangerousMode];
  if (typeof payload.dangerousEnabled === "boolean") {
    return payload.dangerousEnabled ? MODE_LABELS.on : MODE_LABELS.inherit;
  }
  return undefined;
}

/**
 * "Never skip; Fast: Always skip" — an agent's own bypass and each preset
 * override `like` names, so a change confined to one preset is shown as one.
 */
function bypassSummary(
  payload: unknown,
  like: BypassAgentPayload,
  presetNames: Map<string, string>
): string | undefined {
  if (!isRecord(payload)) return undefined;
  const parts: string[] = [];
  const ownIntent = like.dangerousMode !== undefined || like.dangerousEnabled !== undefined;
  if (ownIntent) parts.push(bypassModeLabel(payload) ?? MODE_LABELS.inherit);
  const presets = isRecord(payload.presets) ? payload.presets : {};
  for (const id of Object.keys(like.presets ?? {})) {
    const mode = bypassModeLabel(presets[id]) ?? MODE_LABELS.inherit;
    parts.push(`${presetNames.get(id) ?? id}: ${mode}`);
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}

function presetNamesOf(...entries: unknown[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const entry of entries) {
    if (!isRecord(entry) || !Array.isArray(entry.customPresets)) continue;
    for (const preset of entry.customPresets) {
      if (isRecord(preset) && typeof preset.id === "string" && typeof preset.name === "string") {
        names.set(preset.id, preset.name);
      }
    }
  }
  return names;
}

/**
 * Permission bypass (#13346): the global "Skip permission prompts", each
 * agent's own bypass and each preset's override, and the assistant's. Kept
 * out of Agent settings so it only travels when asked for, and never in a file.
 */
export function permissionBypassSection(): SectionHandler {
  const readSnapshot = (): BypassSnapshot => {
    const settings = store.get("agentSettings");
    const assistant = store.get("helpAssistant");
    const snapshot: BypassSnapshot = {
      agents: isRecord(settings) && isRecord(settings.agents) ? settings.agents : {},
    };
    if (isRecord(settings) && typeof settings.globalSkipPermissions === "boolean") {
      snapshot.globalSkipPermissions = settings.globalSkipPermissions;
    }
    if (isRecord(assistant) && typeof assistant.bypassPermissions === "boolean") {
      snapshot.assistant = assistant.bypassPermissions;
    }
    return snapshot;
  };
  const asSnapshot = (value: unknown): BypassSnapshot =>
    isRecord(value) && isRecord(value.agents)
      ? (value as unknown as BypassSnapshot)
      : { agents: {} };
  const asPayload = (value: unknown): PermissionBypassPayload =>
    isRecord(value) ? (value as PermissionBypassPayload) : {};

  /** Presets the target will have once the same copy's Agent settings land. */
  const presetsAfterCopy = (agentId: string, current: BypassSnapshot, ctx: SectionContext) => {
    const ids = new Set(customPresetIds(current.agents[agentId]));
    const incomingAgents = ctx.incoming.agentSettings;
    if (isRecord(incomingAgents)) {
      for (const id of customPresetIds(incomingAgents[agentId])) ids.add(id);
    }
    return ids;
  };

  return {
    id: "permissionBypass",
    read: async () => readSnapshot(),
    export: (current) => {
      const snapshot = asSnapshot(current);
      return projectBypass(
        { agents: snapshot.agents, globalSkipPermissions: snapshot.globalSkipPermissions },
        snapshot.assistant
      );
    },
    diff: (incoming, current, ctx) => {
      const result: SectionDiff = { add: [], update: [], unchanged: [] };
      const payload = asPayload(incoming);
      const snapshot = asSnapshot(current);
      // Agent settings land first, so a preset they add can take an override here.
      const arriving = ctx?.incoming.agentSettings;
      const incomingAgents = isRecord(arriving) ? arriving : {};
      const baseFor = (agentId: string) =>
        isRecord(incomingAgents[agentId])
          ? mergeAgentEntry(snapshot.agents[agentId], incomingAgents[agentId])
          : snapshot.agents[agentId];
      const scalar = (key: string, next: unknown, now: unknown) => {
        if (next === undefined) return;
        if (now === undefined) result.add.push(key);
        else if (sameValue(next, now)) result.unchanged.push(key);
        else result.update.push(key);
      };
      scalar(GLOBAL_KEY, payload.globalSkipPermissions, snapshot.globalSkipPermissions);
      scalar(ASSISTANT_KEY, payload.assistant, snapshot.assistant);
      for (const [agentId, agentPayload] of Object.entries(
        isRecord(payload.agents) ? payload.agents : {}
      )) {
        const key = agentKey(agentId);
        const base = baseFor(agentId);
        if (!isRecord(agentPayload)) {
          result.update.push(key);
          continue;
        }
        const { entry } = mergeBypassAgent(base, agentPayload as BypassAgentPayload);
        if (sameValue(entry, base ?? {})) result.unchanged.push(key);
        else if (projectBypassAgent(snapshot.agents[agentId]) === undefined) result.add.push(key);
        else result.update.push(key);
      }
      return result;
    },
    check: async (incoming, current, ctx) => {
      const check = emptyCheck();
      const payload = asPayload(incoming);
      const snapshot = asSnapshot(current);
      if (payload.globalSkipPermissions !== undefined) {
        if (typeof payload.globalSkipPermissions !== "boolean") {
          check.skipped.set(GLOBAL_KEY, "Not a valid bypass setting");
        }
      }
      if (payload.assistant !== undefined && typeof payload.assistant !== "boolean") {
        check.skipped.set(ASSISTANT_KEY, "Not a valid bypass setting");
      }
      for (const [agentId, agentPayload] of Object.entries(
        isRecord(payload.agents) ? payload.agents : {}
      )) {
        const invalid = invalidBypassAgent(agentPayload);
        if (invalid) {
          check.skipped.set(agentKey(agentId), invalid);
          continue;
        }
        const known = presetsAfterCopy(agentId, snapshot, ctx);
        for (const presetId of Object.keys((agentPayload as BypassAgentPayload).presets ?? {})) {
          if (!known.has(presetId)) {
            check.skipped.set(presetKey(agentId, presetId), "That preset isn't defined");
          }
        }
      }
      return check;
    },
    describe: (key, kind, incoming, current, ctx) => {
      const payload = asPayload(incoming);
      const snapshot = asSnapshot(current);
      const onOff = (value: unknown) =>
        typeof value === "boolean" ? (value ? "On" : "Off") : undefined;
      if (key === GLOBAL_KEY) {
        return {
          key,
          kind,
          label: "Skip permission prompts for agents",
          from: kind === "update" ? onOff(snapshot.globalSkipPermissions) : undefined,
          to: onOff(payload.globalSkipPermissions),
        };
      }
      if (key === ASSISTANT_KEY) {
        return {
          key,
          kind,
          label: "Assistant skips tool prompts",
          from: kind === "update" ? onOff(snapshot.assistant) : undefined,
          to: onOff(payload.assistant),
        };
      }
      const agentId = key.slice("agents.".length);
      const raw = payload.agents?.[agentId];
      const asked: BypassAgentPayload = isRecord(raw) ? (raw as BypassAgentPayload) : {};
      const arriving = isRecord(ctx.incoming.agentSettings)
        ? ctx.incoming.agentSettings[agentId]
        : undefined;
      const names = presetNamesOf(snapshot.agents[agentId], arriving);
      return {
        key,
        kind,
        label: agentName(agentId),
        from:
          kind === "update"
            ? bypassSummary(projectBypassAgent(snapshot.agents[agentId]) ?? {}, asked, names)
            : undefined,
        to: bypassSummary(asked, asked, names),
      };
    },
    apply: async (incoming, current) => {
      const results: ConfigImportLeafResult[] = [];
      const payload = asPayload(incoming);
      const snapshot = asSnapshot(current);
      // Agent settings may have been written by this same import a moment ago,
      // so the presets are read now rather than from the snapshot.
      const settings = store.get("agentSettings");
      const agents: Record<string, unknown> = {
        ...(isRecord(settings) && isRecord(settings.agents) ? settings.agents : {}),
      };

      const scalar = (key: string, next: unknown, now: unknown, path: string) => {
        if (next === undefined) return;
        if (typeof next !== "boolean") {
          results.push(skippedLeaf(key, "Not a valid bypass setting"));
          return;
        }
        if (next === now) {
          results.push(unchangedLeaf(key));
          return;
        }
        store.set(path as never, next as never);
        results.push(
          store.get(path as never) === next
            ? { key, status: "applied" }
            : skippedLeaf(key, "Value did not persist")
        );
      };
      scalar(
        GLOBAL_KEY,
        payload.globalSkipPermissions,
        snapshot.globalSkipPermissions,
        "agentSettings.globalSkipPermissions"
      );
      scalar(
        ASSISTANT_KEY,
        payload.assistant,
        snapshot.assistant,
        "helpAssistant.bypassPermissions"
      );

      const pending = new Map<string, Record<string, unknown>>();
      for (const [agentId, agentPayload] of Object.entries(
        isRecord(payload.agents) ? payload.agents : {}
      )) {
        const key = agentKey(agentId);
        const invalid = invalidBypassAgent(agentPayload);
        if (invalid) {
          results.push(skippedLeaf(key, invalid));
          continue;
        }
        const { entry, missingPresets } = mergeBypassAgent(
          agents[agentId],
          agentPayload as BypassAgentPayload
        );
        for (const presetId of missingPresets) {
          results.push(skippedLeaf(presetKey(agentId, presetId), "That preset isn't defined"));
        }
        if (sameValue(entry, agents[agentId] ?? {})) {
          results.push(unchangedLeaf(key));
          continue;
        }
        agents[agentId] = entry;
        pending.set(agentId, entry);
      }
      if (pending.size === 0) return results;
      store.set("agentSettings.agents", agents as never);
      const readBack = store.get("agentSettings");
      const stored = isRecord(readBack) && isRecord(readBack.agents) ? readBack.agents : {};
      for (const [agentId, entry] of pending) {
        results.push(
          sameValue(stored[agentId], entry)
            ? { key: agentKey(agentId), status: "applied" }
            : skippedLeaf(agentKey(agentId), "Value did not persist")
        );
      }
      return results;
    },
    // `agents.<id>` is that agent's whole entry; the id is the rest of the key, dots and all.
    leafValue: (value, key) => {
      const snapshot = asSnapshot(value);
      return key.startsWith("agents.")
        ? recordLeafValue(snapshot.agents, key.slice("agents.".length))
        : recordLeafValue(snapshot, key);
    },
    withLeaf: (value, key, leaf) => {
      const snapshot = asSnapshot(value);
      return key.startsWith("agents.")
        ? {
            ...snapshot,
            agents: withRecordLeaf(snapshot.agents, key.slice("agents.".length), leaf),
          }
        : withRecordLeaf(snapshot, key, leaf);
    },
    restore: async (snapshot) => {
      const prior = asSnapshot(snapshot);
      const settings = store.get("agentSettings");
      const nextSettings: Record<string, unknown> = {
        ...(isRecord(settings) ? settings : {}),
        agents: prior.agents,
      };
      if (prior.globalSkipPermissions === undefined) delete nextSettings.globalSkipPermissions;
      else nextSettings.globalSkipPermissions = prior.globalSkipPermissions;
      store.set("agentSettings", nextSettings as never);

      const assistant = store.get("helpAssistant");
      const assistantRecord: Record<string, unknown> = isRecord(assistant) ? assistant : {};
      if (assistantRecord.bypassPermissions === prior.assistant) return;
      const nextAssistant: Record<string, unknown> = { ...assistantRecord };
      if (prior.assistant === undefined) delete nextAssistant.bypassPermissions;
      else nextAssistant.bypassPermissions = prior.assistant;
      store.set("helpAssistant", nextAssistant as never);
    },
  };
}
