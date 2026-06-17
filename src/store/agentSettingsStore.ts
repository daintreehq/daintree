import { create } from "zustand";
import type { AgentSettings, AgentSettingsEntry, CliAvailability } from "@shared/types";
import { agentSettingsClient } from "@/clients";
import { getSafeBootPromise } from "@/lib/bootPromise";
import { DEFAULT_AGENT_SETTINGS } from "@shared/types";
import { getEffectiveAgentIds } from "../../shared/config/agentRegistry";
import { BUILT_IN_AGENT_IDS, LAUNCHABLE_AGENT_IDS } from "../../shared/config/agentIds";
import { isAgentPinned } from "../../shared/utils/agentPinned";
import { isAgentInstalled } from "../../shared/utils/agentAvailability";
import { useCliAvailabilityStore } from "./cliAvailabilityStore";
import { formatErrorMessage } from "@shared/utils/errorMessage";

/** Bump when a future migration needs to run on existing persisted stores. */
const CURRENT_SETTINGS_VERSION = 1;
const INITIAL_PIN_SETTINGS_VERSION = 2;
const INITIAL_PIN_LIMIT = 5;

/**
 * In-memory normalization with tri-state pin semantics. `entry.pinned` is
 * authoritative: explicit `true`/`false` values stand, and `undefined` keeps
 * the #7673 availability-following behavior for migrated/unknown entries.
 *
 * Fresh default installs are the exception. Once real CLI availability exists,
 * Daintree chooses the first five installed built-in agents (registry order is
 * popularity order), pins them, and explicitly unpins the remaining built-ins
 * so toolbar icons and tray pin state agree on first launch.
 *
 * Does NOT persist; callers schedule write-backs for first-install defaults.
 */
export function normalizeAgentSelection(
  settings: AgentSettings,
  availability?: CliAvailability | null,
  hasRealData: boolean = false,
  options: { seedInitialPins?: boolean } = {}
): AgentSettings {
  const { seedInitialPins = true } = options;
  if (seedInitialPins) {
    const initialPinUpdates = buildInitialAgentPinUpdates(settings, availability, hasRealData);
    if (initialPinUpdates) {
      return applyAgentPinUpdates(settings, initialPinUpdates, INITIAL_PIN_SETTINGS_VERSION);
    }
  }

  const registeredIds = getEffectiveAgentIds();
  let changed = false;
  const agents = { ...settings.agents };

  for (const id of registeredIds) {
    if (!agents[id] && hasRealData) {
      agents[id] = {};
      changed = true;
    }
  }

  return changed ? { ...settings, agents } : settings;
}

function isFreshDefaultAgentSettings(settings: AgentSettings): boolean {
  const version = settings.settingsVersion;
  if (version !== undefined && version !== CURRENT_SETTINGS_VERSION) return false;

  const agents = settings.agents;
  if (!agents || typeof agents !== "object") return false;

  const defaultAgents = DEFAULT_AGENT_SETTINGS.agents;
  const defaultIds = new Set(Object.keys(defaultAgents));
  const rawIds = Object.keys(agents);
  if (rawIds.some((id) => !defaultIds.has(id))) return false;

  for (const id of BUILT_IN_AGENT_IDS) {
    const entry = agents[id];
    const defaultEntry = defaultAgents[id];
    if (!entry || !defaultEntry) return false;
    if ("pinned" in entry) return false;

    const entryKeys = Object.keys(entry);
    const defaultKeys = Object.keys(defaultEntry);
    if (entryKeys.length !== defaultKeys.length) return false;
    for (const key of defaultKeys) {
      if (entry[key] !== defaultEntry[key]) return false;
    }
  }

  return true;
}

export function buildInitialAgentPinUpdates(
  settings: AgentSettings,
  availability: CliAvailability | null | undefined,
  hasRealData: boolean
): Record<string, boolean> | null {
  if (!hasRealData || !availability) return null;
  if (!isFreshDefaultAgentSettings(settings)) return null;

  const selected = new Set(
    LAUNCHABLE_AGENT_IDS.filter((id) => isAgentInstalled(availability[id])).slice(
      0,
      INITIAL_PIN_LIMIT
    )
  );

  return Object.fromEntries(BUILT_IN_AGENT_IDS.map((id) => [id, selected.has(id)]));
}

function applyAgentPinUpdates(
  settings: AgentSettings,
  pinUpdates: Record<string, boolean>,
  settingsVersion?: number
): AgentSettings {
  const agents = { ...settings.agents };
  for (const [id, pinned] of Object.entries(pinUpdates)) {
    agents[id] = { ...(agents[id] ?? {}), pinned };
  }
  return {
    ...settings,
    ...(settingsVersion !== undefined ? { settingsVersion } : {}),
    agents,
  };
}

/**
 * One-shot migration for pre-`settingsVersion` persisted stores. Versions
 * before the #7673 fix eagerly seeded `pinned: true/false` from a single
 * availability snapshot, freezing toolbar visibility forever. This pass
 * clears every concrete `pinned` value on legacy stores so the tri-state
 * read-time selector can take over.
 *
 * Pure function — no IPC, no async, no `useCliAvailabilityStore` access.
 * Callers issue fire-and-forget write-backs for `agentsToClear` and only
 * stamp `settingsVersion` once every clear has succeeded (see
 * `scheduleMigrationWriteBacks`).
 */
export function migrateAgentSettings(raw: AgentSettings): {
  migrated: AgentSettings;
  agentsToClear: string[];
} {
  if ((raw.settingsVersion ?? 0) >= CURRENT_SETTINGS_VERSION) {
    return { migrated: raw, agentsToClear: [] };
  }

  const agentsToClear: string[] = [];
  const agents: Record<string, AgentSettingsEntry> = {};
  for (const [id, entry] of Object.entries(raw.agents ?? {})) {
    if (entry && entry.pinned !== undefined) {
      const { pinned: _pinned, ...rest } = entry;
      agents[id] = rest;
      agentsToClear.push(id);
    } else {
      agents[id] = entry;
    }
  }

  return {
    migrated: { ...raw, agents, settingsVersion: CURRENT_SETTINGS_VERSION },
    agentsToClear,
  };
}

/**
 * Clears stale `pinned` values from the persisted store and only stamps
 * `settingsVersion` when every per-agent write has succeeded. If any clear
 * fails the version stays unstamped so the next cold start re-runs
 * migration — preserves the "freeze" fix while never prematurely marking
 * the store migrated (#7673 review feedback).
 *
 * Called fire-and-forget by the renderer hydration paths so initialize()
 * never blocks on IPC round-trips.
 */
async function scheduleMigrationWriteBacks(agentIds: readonly string[]): Promise<void> {
  if (agentIds.length === 0) return;

  const results = await Promise.allSettled(
    agentIds.map((id) =>
      agentSettingsClient.set(id, { pinned: undefined } as Partial<AgentSettingsEntry>)
    )
  );
  const allOk = results.every((r) => r.status === "fulfilled");
  if (!allOk) return;

  try {
    await agentSettingsClient.stampVersion(CURRENT_SETTINGS_VERSION);
  } catch {
    // Leave version unstamped — next cold start retries the (now no-op)
    // per-agent clears and re-attempts the version stamp.
  }
}

async function scheduleInitialPinWriteBacks(pinUpdates: Record<string, boolean>): Promise<void> {
  const entries = Object.entries(pinUpdates);
  if (entries.length === 0) return;

  const results = await Promise.allSettled(
    entries.map(([id, pinned]) => agentSettingsClient.set(id, { pinned }))
  );
  const allOk = results.every((r) => r.status === "fulfilled");
  if (!allOk) return;

  try {
    await agentSettingsClient.stampVersion(INITIAL_PIN_SETTINGS_VERSION);
  } catch {
    // Best-effort persistence; the current session already has the in-memory defaults.
  }
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
   * Set the global skip-permissions override (#10432). Writes the root-level
   * `globalSkipPermissions` field only — does not mutate any per-agent
   * `dangerousEnabled`. Optimistic with rollback on IPC failure.
   */
  setGlobalSkipPermissions: (value: boolean) => Promise<void>;
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

        // Seed from the in-flight `app:boot` payload instead of firing a
        // duplicate `agentSettings:get` round-trip — the payload carries the
        // same `store.get("agentSettings")` snapshot. BootResult types
        // `agentSettings` as non-optional, but `releaseBootPayload()` nulls it
        // at runtime after hydration — treat it as possibly undefined. The
        // live-IPC fallback intentionally covers three cases: boot failure
        // ({ ok: false }), a re-initialize after `releaseBootPayload()`, and
        // fresh installs where the persisted store has no `agentSettings` key
        // (the payload field is undefined, so the fallback IPC fires — same
        // cost as the old path, not a regression).
        const boot = await getSafeBootPromise();
        const fromBoot = boot.ok
          ? (boot.result.agentSettings as AgentSettings | undefined)
          : undefined;
        const raw = fromBoot ?? (await agentSettingsClient.get()) ?? DEFAULT_AGENT_SETTINGS;
        if (myEpoch !== normalizeEpoch) {
          // A concurrent refresh/update bumped the epoch — its result is
          // authoritative. Flip `isInitialized` anyway so the store exits the
          // loading state (and future `initialize()` calls no-op as intended).
          set({ isLoading: false, isInitialized: true });
          return;
        }
        const { availability, hasRealData } = readAvailabilitySnapshot();
        const initialPinUpdates = buildInitialAgentPinUpdates(raw, availability, hasRealData);
        const { migrated, agentsToClear } = migrateAgentSettings(raw);
        let settings = normalizeAgentSelection(migrated, availability, hasRealData, {
          seedInitialPins: agentsToClear.length === 0,
        });
        if (initialPinUpdates) {
          settings = applyAgentPinUpdates(
            settings,
            initialPinUpdates,
            INITIAL_PIN_SETTINGS_VERSION
          );
        }
        set({ settings, isLoading: false, isInitialized: true });
        if (agentsToClear.length > 0) {
          void scheduleMigrationWriteBacks(agentsToClear);
        } else if (initialPinUpdates) {
          void scheduleInitialPinWriteBacks(initialPinUpdates);
        }
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
      // refresh() exists to re-pull external changes (cross-window writes,
      // config reloads) — drop the client's value cache so this read and
      // every later get() see post-change data, not a pre-change snapshot.
      agentSettingsClient.invalidate();
      const raw = (await agentSettingsClient.get()) ?? DEFAULT_AGENT_SETTINGS;
      if (myEpoch !== normalizeEpoch) return;
      const { availability, hasRealData } = readAvailabilitySnapshot();
      const initialPinUpdates = buildInitialAgentPinUpdates(raw, availability, hasRealData);
      const { migrated, agentsToClear } = migrateAgentSettings(raw);
      let settings = normalizeAgentSelection(migrated, availability, hasRealData, {
        seedInitialPins: agentsToClear.length === 0,
      });
      if (initialPinUpdates) {
        settings = applyAgentPinUpdates(settings, initialPinUpdates, INITIAL_PIN_SETTINGS_VERSION);
      }
      set({ settings });
      if (agentsToClear.length > 0) {
        void scheduleMigrationWriteBacks(agentsToClear);
      } else if (initialPinUpdates) {
        void scheduleInitialPinWriteBacks(initialPinUpdates);
      }
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
      // Run migration against the response too — covers the edge case where
      // `updateAgent` is the first interaction with a legacy store (before
      // initialize() has hydrated) and the IPC response still carries stale
      // concrete pin values for other agents (#7673 review).
      const { availability, hasRealData } = readAvailabilitySnapshot();
      const initialPinUpdates = buildInitialAgentPinUpdates(raw, availability, hasRealData);
      const { migrated, agentsToClear } = migrateAgentSettings(raw);
      let settings = normalizeAgentSelection(migrated, availability, hasRealData, {
        seedInitialPins: agentsToClear.length === 0,
      });
      if (initialPinUpdates) {
        settings = applyAgentPinUpdates(settings, initialPinUpdates, INITIAL_PIN_SETTINGS_VERSION);
      }
      set({ settings });
      if (agentsToClear.length > 0) {
        void scheduleMigrationWriteBacks(agentsToClear);
      } else if (initialPinUpdates) {
        void scheduleInitialPinWriteBacks(initialPinUpdates);
      }
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

  setGlobalSkipPermissions: async (value: boolean) => {
    const myEpoch = ++normalizeEpoch;
    set({ error: null });
    const previous = get().settings;
    // Optimistic top-level spread — never route through updateAgent (which
    // merges into the agents record and would not touch this root field, #5514).
    // This must not mutate any per-agent `dangerousEnabled`; it is a live
    // override OR-ed in at flag-generation time (#10432).
    if (previous) {
      set({ settings: { ...previous, globalSkipPermissions: value } });
    }
    try {
      await agentSettingsClient.setGlobal(value);
      if (myEpoch !== normalizeEpoch) return;
      // The IPC response echoes the persisted value; the optimistic state
      // already reflects it, and the renderer-normalized agents record is the
      // source of truth for per-agent state, so keep it rather than overwriting
      // from the raw response.
    } catch (e) {
      if (myEpoch !== normalizeEpoch) return;
      if (previous) set({ settings: previous });
      set({ error: formatErrorMessage(e, "Failed to update global skip-permissions setting") });
      throw e;
    }
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
      // Reset response may still represent a legacy store (per-agent reset
      // doesn't bump version); run migration to keep tri-state semantics
      // intact (#7673 review).
      const { availability, hasRealData } = readAvailabilitySnapshot();
      const initialPinUpdates = buildInitialAgentPinUpdates(raw, availability, hasRealData);
      const { migrated, agentsToClear } = migrateAgentSettings(raw);
      let settings = normalizeAgentSelection(migrated, availability, hasRealData, {
        seedInitialPins: agentsToClear.length === 0,
      });
      if (initialPinUpdates) {
        settings = applyAgentPinUpdates(settings, initialPinUpdates, INITIAL_PIN_SETTINGS_VERSION);
      }
      set({ settings });
      if (agentsToClear.length > 0) {
        void scheduleMigrationWriteBacks(agentsToClear);
      } else if (initialPinUpdates) {
        void scheduleInitialPinWriteBacks(initialPinUpdates);
      }
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
  agentSettingsClient.invalidate();
  useAgentSettingsStore.setState({
    settings: DEFAULT_AGENT_SETTINGS,
    isLoading: true,
    error: null,
    isInitialized: false,
  });
}
