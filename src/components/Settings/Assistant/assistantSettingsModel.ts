import { getSavedAssistantModelId } from "@shared/config/agentRegistry";
import type { HelpAssistantSettings } from "@shared/types";

export type SaveGroup = "agent" | "launch" | "behavior" | "security" | "privacy" | "content";

export const SAVE_GROUP_BY_KEY: Record<keyof HelpAssistantSettings, SaveGroup> = {
  modelIds: "agent",
  customArgs: "launch",
  docSearch: "behavior",
  daintreeControl: "behavior",
  runbookSearch: "behavior",
  idleHibernateMinutes: "launch",
  tier: "security",
  bypassPermissions: "security",
  daintreeConfirmations: "security",
  auditRetention: "privacy",
  loadGlobalHooksAndServers: "content",
  acceptRemoteControl: "security",
};

const SETTING_KEYS: readonly (keyof HelpAssistantSettings)[] = [
  "modelIds",
  "customArgs",
  "docSearch",
  "daintreeControl",
  "runbookSearch",
  "idleHibernateMinutes",
  "tier",
  "bypassPermissions",
  "daintreeConfirmations",
  "auditRetention",
  "loadGlobalHooksAndServers",
  "acceptRemoteControl",
];

export function patchedKeys(
  patch: Partial<HelpAssistantSettings>
): (keyof HelpAssistantSettings)[] {
  return SETTING_KEYS.filter((key) => key in patch);
}

export function saveGroupOf(patch: Partial<HelpAssistantSettings>): SaveGroup {
  const [first] = patchedKeys(patch);
  return first ? SAVE_GROUP_BY_KEY[first] : "agent";
}

function copySetting<K extends keyof HelpAssistantSettings>(
  target: HelpAssistantSettings,
  source: HelpAssistantSettings,
  key: K
): void {
  target[key] = source[key];
}

type ModelIdMap = HelpAssistantSettings["modelIds"];

// A `modelIds` patch names only the agents it changes; `null` removes that
// agent's entry, mirroring how main merges it.
function mergeModelIds(current: ModelIdMap, patch: ModelIdMap): ModelIdMap {
  const next = { ...current };
  for (const [agentId, modelId] of Object.entries(patch)) {
    if (modelId === null) delete next[agentId];
    else next[agentId] = modelId;
  }
  return next;
}

export function applySettingsPatch(
  current: HelpAssistantSettings,
  patch: Partial<HelpAssistantSettings>
): HelpAssistantSettings {
  const next = { ...current, ...patch };
  if (patch.modelIds) next.modelIds = mergeModelIds(current.modelIds, patch.modelIds);
  return next;
}

// Puts the attempted keys back, unless a later change has already moved them.
// Model entries are restored per agent so a failed save for one agent never
// touches another agent's choice.
export function revertSettingsPatch(
  current: HelpAssistantSettings,
  previous: HelpAssistantSettings,
  patch: Partial<HelpAssistantSettings>
): HelpAssistantSettings {
  const reverted: HelpAssistantSettings = { ...current };
  for (const key of patchedKeys(patch)) {
    if (key === "modelIds") continue;
    if (current[key] === patch[key]) copySetting(reverted, previous, key);
  }
  if (patch.modelIds) {
    const restore: ModelIdMap = {};
    for (const [agentId, attempted] of Object.entries(patch.modelIds)) {
      if (getSavedAssistantModelId(current.modelIds, agentId) !== attempted) continue;
      restore[agentId] = getSavedAssistantModelId(previous.modelIds, agentId);
    }
    reverted.modelIds = mergeModelIds(current.modelIds, restore);
  }
  return reverted;
}

export const SETTING_LABEL: Record<keyof HelpAssistantSettings, string> = {
  modelIds: "Model",
  customArgs: "Custom CLI args",
  docSearch: "Search documentation",
  daintreeControl: "Daintree control",
  runbookSearch: "Follow runbooks",
  idleHibernateMinutes: "Hibernate after",
  tier: "Tool set",
  bypassPermissions: "Bypass",
  auditRetention: "Audit log retention",
  loadGlobalHooksAndServers: "Load my MCP servers and hooks",
  daintreeConfirmations: "Daintree confirmations",
  acceptRemoteControl: "Let other machines' assistants work here",
};

export interface SaveFailure {
  group: SaveGroup;
  patch: Partial<HelpAssistantSettings>;
}

export const DEFAULT_SETTINGS: HelpAssistantSettings = {
  docSearch: true,
  daintreeControl: true,
  runbookSearch: true,
  tier: "core",
  bypassPermissions: false,
  auditRetention: 7,
  modelIds: {},
  customArgs: "",
  idleHibernateMinutes: 5,
  loadGlobalHooksAndServers: false,
  daintreeConfirmations: "inherit",
  acceptRemoteControl: true,
};
