import { create } from "zustand";
import type { AgentSettings, AgentSettingsEntry, CliAvailability } from "@shared/types";
import { agentSettingsClient } from "@/clients";
import { DEFAULT_AGENT_SETTINGS } from "@shared/types";
import { getEffectiveAgentIds } from "../../shared/config/agentRegistry";
import { isAgentPinned } from "../../shared/utils/agentPinned";
import { isAgentInstalled } from "../../shared/utils/agentAvailability";
import { useCliAvailabilityStore } from "./cliAvailabilityStore";
import { formatErrorMessage } from "@shared/utils/errorMessage";

/**
 * In-memory normalization with two distinct paths:
 *
 *  - No entry at all for a registered agent → seed `pinned: false` (opt-in
 *    default — see #5109 and the welcome card in #5111). Fresh installs
 *    show an empty toolbar until the user pins via the welcome card or
 *    the tray.
 *  - Entry exists but `pinned` is undefined → synthesize from current
 *    availability (installed/ready → true, missing → false). This
 *    preserves the implicit pin for 0.7.x upgraders who already have
 *    agent-settings entries from prior sessions — otherwise their
 *    toolbar would collapse and the AgentSetupWizard would auto-open on
 *    every launch (see #5158 and review on #5111).
 *
 * Before real data (`hasRealData === false`) the flag stays absent so
 * the renderer can re-run normalization once the first probe completes.
 * Explicit `pinned: true` / `pinned: false` values from the persisted
 * store are always preserved. Does NOT persist.
 */
export function normalizeAgentSelection(
  settings: AgentSettings,
  availability?: CliAvailability | null,
  hasRealData: boolean = false
): AgentSettings {
  const registeredIds = getEffectiveAgentIds();
  let changed = false;
  const agents = { ...settings.agents };

  for (const id of registeredIds) {
    const entry = agents[id];

    if (!entry) {
      if (hasRealData) {
        agents[id] = { pinned: false };
        changed = true;
      }
      continue;
    }

    if (entry.pinned === undefined && hasRealData) {
      agents[id] = { ...entry, pinned: isAgentInstalled(availability?.[id]) };
      changed = true;
    }
  }

  return changed ? { ...settings, agents } : settings;
}

function readAvailabilitySnapshot(): {
  availability: CliAvailability;
  hasRealData: boolean;
} {
  const state = useCliAvailabilityStore.getState();
  return { availability: state.availability, hasRealData: state.hasRealData };
}

interface AgentSettingsState {
  settings: AgentSettings | null;
  isLoading: boolean;
  error: string | null;
  isInitialized: boolean;
}

interface AgentSettingsActions {
  initialize: () => Promise<void>;
  refresh: () => Promise<void>;
  updateAgent: (agentId: string, updates: Partial<AgentSettingsEntry>) => Promise<void>;
  setAgentPinned: (agentId: string, pinned: boolean) => Promise<void>;
  /**
   * Set or clear the worktree-scoped preset override for an agent. Reads the
   * current `worktreePresets` map, spreads sibling keys, then writes the merged
   * map — bypasses the IPC handler's shallow-merge clobber on the submap.
   * Passing `undefined` removes the key; the map collapses to `undefined` when
   * empty.
   */
  updateWorktreePreset: (
    agentId: string,
    worktreeId: string,
    presetId: string | undefined
  ) => Promise<void>;
  reset: (agentId?: string) => Promise<void>;
}

type AgentSettingsStore = AgentSettingsState & AgentSettingsActions;

let initPromise: Promise<void> | null = null;
// Monotonic counter that guards stale async writes. `cleanupAgentSettingsStore`
// and concurrent `refresh`/`updateAgent`/`reset` calls all bump this so a
// slower in-flight normalization result can't overwrite a newer snapshot
// (see lesson #1377).
let normalizeEpoch = 0;

export const useAgentSettingsStore = create<AgentSettingsStore>()((set, get) => ({
  settings: null,
  isLoading: true,
  error: null,
  isInitialized: false,

  initialize: () => {
    if (get().isInitialized) return Promise.resolve();
    if (initPromise) return initPromise;

    const myEpoch = ++normalizeEpoch;
    // Use a holder so the `finally` block can reach back to the promise
    // reference that will exist immediately after the IIFE synchronously
    // returns. Strict TS won't let a `let`/`const` captured in the IIFE be
    // compared before assignment, but a property assignment is fine.
    const ref: { current: Promise<void> | null } = { current: null };
    const promise = (async () => {
      try {
        set({ isLoading: true, error: null });

        const raw = (await agentSettingsClient.get()) ?? DEFAULT_AGENT_SETTINGS;
        if (myEpoch !== normalizeEpoch) {
          // A concurrent refresh/update bumped the epoch — its result is
          // authoritative. Flip `isInitialized` anyway so the store exits the
          // loading state (and future `initialize()` calls no-op as intended).
          set({ isLoading: false, isInitialized: true });
          return;
        }
        const { availability, hasRealData } = readAvailabilitySnapshot();
        const settings = normalizeAgentSelection(raw, availability, hasRealData);
        set({ settings, isLoading: false, isInitialized: true });
      } catch (e) {
        if (myEpoch !== normalizeEpoch) {
          set({ isLoading: false, isInitialized: true });
          return;
        }
        set({
          error: formatErrorMessage(e, "Failed to load agent settings"),
          isLoading: false,
          isInitialized: true,
        });
      } finally {
        // Clear the cached promise so a later `initialize()` can retry after
        // cleanup/reset, even if this run was superseded by a concurrent op.
        if (initPromise === ref.current) initPromise = null;
      }
    })();

    ref.current = promise;
    initPromise = promise;
    return promise;
  },

  refresh: async () => {
    const myEpoch = ++normalizeEpoch;
    set({ error: null });
    try {
      const raw = (await agentSettingsClient.get()) ?? DEFAULT_AGENT_SETTINGS;
      if (myEpoch !== normalizeEpoch) return;
      const { availability, hasRealData } = readAvailabilitySnapshot();
      const settings = normalizeAgentSelection(raw, availability, hasRealData);
      set({ settings });
    } catch (e) {
      // Stale failures yield silently — whichever newer op bumped the epoch
      // owns the error surface now, and fire-and-forget callers should not
      // see spurious unhandled rejections from an invalidated attempt.
      if (myEpoch !== normalizeEpoch) return;
      set({ error: formatErrorMessage(e, "Failed to refresh agent settings") });
      throw e;
    }
  },

  updateAgent: async (agentId: string, updates: Partial<AgentSettingsEntry>) => {
    const myEpoch = ++normalizeEpoch;
    set({ error: null });
    const previous = get().settings;
    if (previous) {
      set({
        settings: {
          ...previous,
          agents: {
            ...previous.agents,
            [agentId]: { ...previous.agents[agentId], ...updates },
          },
        },
      });
    }
    try {
      const raw = await agentSettingsClient.set(agentId, updates);
      if (myEpoch !== normalizeEpoch) return;
      const { availability, hasRealData } = readAvailabilitySnapshot();
      const settings = normalizeAgentSelection(raw, availability, hasRealData);
      set({ settings });
    } catch (e) {
      if (myEpoch !== normalizeEpoch) return;
      if (previous) set({ settings: previous });
      set({ error: formatErrorMessage(e, `Failed to update ${agentId} settings`) });
      throw e;
    }
  },

  setAgentPinned: async (agentId: string, pinned: boolean) => {
    return get().updateAgent(agentId, { pinned });
  },

  updateWorktreePreset: async (
    agentId: string,
    worktreeId: string,
    presetId: string | undefined
  ) => {
    if (!worktreeId) return;
    const current = get().settings?.agents?.[agentId]?.worktreePresets ?? {};
    const next: Record<string, string> = { ...current };
    if (presetId === undefined) {
      delete next[worktreeId];
    } else {
      next[worktreeId] = presetId;
    }
    const merged = Object.keys(next).length > 0 ? next : undefined;
    await get().updateAgent(agentId, { worktreePresets: merged });
  },

  reset: async (agentId?: string) => {
    const myEpoch = ++normalizeEpoch;
    set({ error: null });
    try {
      const raw = await agentSettingsClient.reset(agentId);
      if (myEpoch !== normalizeEpoch) return;
      const { availability, hasRealData } = readAvailabilitySnapshot();
      const settings = normalizeAgentSelection(raw, availability, hasRealData);
      set({ settings });
    } catch (e) {
      if (myEpoch !== normalizeEpoch) return;
      set({ error: formatErrorMessage(e, "Failed to reset agent settings") });
      throw e;
    }
  },
}));

export function getPinnedAgents(): string[] {
  const settings = useAgentSettingsStore.getState().settings;
  if (!settings?.agents) return [];
  return Object.entries(settings.agents)
    .filter(([, entry]) => isAgentPinned(entry))
    .map(([id]) => id);
}

export function cleanupAgentSettingsStore() {
  normalizeEpoch++;
  initPromise = null;
  useAgentSettingsStore.setState({
    settings: DEFAULT_AGENT_SETTINGS,
    isLoading: true,
    error: null,
    isInitialized: false,
  });
}
