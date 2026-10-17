import {
  isStorableAssistantAgentId,
  isStorableDefaultAgent,
  type AgentDefaultsLegacyCandidates,
  type AgentDefaultsSnapshot,
} from "@shared/types/ipc/agentDefaults";
import { backupKeyFor, readLocalStorageItemSafely } from "./safeStorage";

/**
 * Where this machine kept the two agent defaults before they moved to the host
 * (#13345). Read once by a local window to migrate them, then removed.
 */
export const LEGACY_HELP_PANEL_KEY = "help-panel-storage";
export const LEGACY_AGENT_PREFERENCES_KEY = "daintree-agent-preferences";
export const LEGACY_TOOLBAR_PREFERENCES_KEY = "daintree-toolbar-preferences";

type Blob = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseBlob(raw: string | null): Blob | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stateOf(blob: Blob | null): Record<string, unknown> | null {
  const state = blob?.state;
  return isRecord(state) ? state : null;
}

/** The live blob, or its last-good backup when the live one is corrupt. */
function readBlob(name: string): { present: boolean; blob: Blob | null } {
  const raw = readLocalStorageItemSafely(name);
  if (raw === null) return { present: false, blob: null };
  return {
    present: true,
    blob: parseBlob(raw) ?? parseBlob(readLocalStorageItemSafely(backupKeyFor(name))),
  };
}

/**
 * The legacy help-panel preference as it sits on disk, when it names an agent.
 * The store persisted `null` whether or not anyone ever chose, so a `null`
 * there is no evidence of a clear and isn't a candidate.
 */
export function legacyHelpPanelAgentId(state: unknown): string | undefined {
  if (!isRecord(state)) return undefined;
  const value = state.preferredAgentId;
  return isStorableAssistantAgentId(value) ? value : undefined;
}

/**
 * What this machine's localStorage says, per leaf. An omitted leaf had nothing
 * there. `daintree-agent-preferences` was only ever written by a choice, so a
 * blob without a valid agent in it is an explicit "no default".
 */
export function readLegacyAgentDefaults(): AgentDefaultsLegacyCandidates {
  const out: AgentDefaultsLegacyCandidates = {};

  const assistant = legacyHelpPanelAgentId(stateOf(readBlob(LEGACY_HELP_PANEL_KEY).blob));
  if (assistant !== undefined) out.assistantAgentId = assistant;

  const preferences = readBlob(LEGACY_AGENT_PREFERENCES_KEY);
  if (preferences.present) {
    const state = stateOf(preferences.blob);
    if (state) {
      out.defaultAgent = isStorableDefaultAgent(state.defaultAgent) ? state.defaultAgent : null;
    }
    return out;
  }

  // Older still: before agentPreferencesStore existed, the toolbar store held it.
  const launcher = stateOf(readBlob(LEGACY_TOOLBAR_PREFERENCES_KEY).blob)?.launcher;
  if (isRecord(launcher) && isStorableDefaultAgent(launcher.defaultAgent)) {
    out.defaultAgent = launcher.defaultAgent;
  }
  return out;
}

export function hasLegacyAgentDefaults(candidates: AgentDefaultsLegacyCandidates): boolean {
  return Object.keys(candidates).length > 0;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Drop one field from a blob and its backup, leaving everything else in it as it was. */
function stripField(name: string, strip: (state: Record<string, unknown>) => boolean): void {
  const ls = storage();
  if (!ls) return;
  for (const key of [name, backupKeyFor(name)]) {
    try {
      const blob = parseBlob(ls.getItem(key));
      const state = stateOf(blob);
      if (!blob || !state || !strip(state)) continue;
      ls.setItem(key, JSON.stringify(blob));
    } catch {
      // A failed strip leaves the value for the next local boot to retry; the
      // host already has its answer, so a retry never changes it.
    }
  }
}

/**
 * Removes the legacy copies of each default the host now holds, so neither a
 * stale view nor a later boot can feed one back in (#11036: copy forward, then
 * delete the source). A default the host didn't confirm keeps its source —
 * that covers a host whose store fell back to memory, and a source that
 * couldn't be read this time.
 */
export function clearLegacyAgentDefaults(settled: AgentDefaultsSnapshot): void {
  if (Object.hasOwn(settled, "defaultAgent")) {
    const ls = storage();
    if (ls) {
      for (const key of [
        LEGACY_AGENT_PREFERENCES_KEY,
        backupKeyFor(LEGACY_AGENT_PREFERENCES_KEY),
      ]) {
        try {
          ls.removeItem(key);
        } catch {
          // Retried on the next local boot.
        }
      }
    }
    stripField(LEGACY_TOOLBAR_PREFERENCES_KEY, (state) => {
      const launcher = state.launcher;
      if (!isRecord(launcher) || !Object.hasOwn(launcher, "defaultAgent")) return false;
      delete launcher.defaultAgent;
      return true;
    });
  }
  if (Object.hasOwn(settled, "assistantAgentId")) {
    stripField(LEGACY_HELP_PANEL_KEY, (state) => {
      if (!Object.hasOwn(state, "preferredAgentId")) return false;
      delete state.preferredAgentId;
      return true;
    });
  }
}
