import { create } from "zustand";
import type {
  AgentSettings,
  AgentSettingsEntry,
  CliAvailability,
  ResumeOnRestart,
} from "@shared/types";
import { agentSettingsClient } from "@/clients";
import { getSafeBootPromise } from "@/lib/bootPromise";
import { DEFAULT_AGENT_SETTINGS } from "@shared/types";
import { getEffectiveAgentIds } from "../../shared/config/agentRegistry";
import { BUILT_IN_AGENT_IDS } from "../../shared/config/agentIds";
import { isAgentPinned } from "../../shared/utils/agentPinned";
import { isAgentInstalled } from "../../shared/utils/agentAvailability";
import { useCliAvailabilityStore } from "./cliAvailabilityStore";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { setAgentSettingsEntryAccessor, setGlobalUseAltScreenAccessor } from "./storeAccessors";

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
    BUILT_IN_AGENT_IDS.filter((id) => isAgentInstalled(availability[id])).slice(
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

/**
 * A saved slice as this view holds it: migrated and normalized against this
 * view's CLI availability, with any write-backs that implies. Pure, so a
 * change heard from another view can be applied without echoing them.
 */
function normalizeSaved(raw: AgentSettings): {
  settings: AgentSettings;
  agentsToClear: string[];
  initialPinUpdates: Record<string, boolean> | null;
} {
  const { availability, hasRealData } = readAvailabilitySnapshot();
  const initialPinUpdates = buildInitialAgentPinUpdates(raw, availability, hasRealData);
  const { migrated, agentsToClear } = migrateAgentSettings(raw);
  let settings = normalizeAgentSelection(migrated, availability, hasRealData, {
    seedInitialPins: agentsToClear.length === 0,
  });
  if (initialPinUpdates) {
    settings = applyAgentPinUpdates(settings, initialPinUpdates, INITIAL_PIN_SETTINGS_VERSION);
  }
  return { settings, agentsToClear, initialPinUpdates };
}

function scheduleWriteBacks({
  agentsToClear,
  initialPinUpdates,
}: ReturnType<typeof normalizeSaved>): void {
  if (agentsToClear.length > 0) {
    void scheduleMigrationWriteBacks(agentsToClear);
  } else if (initialPinUpdates) {
    void scheduleInitialPinWriteBacks(initialPinUpdates);
  }
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
  /**
   * Take a saved slice another view (or this one) just wrote (#14700). Pure:
   * its migration write-backs are the writer's, so no view echoes them.
   */
  applySaved: (raw: AgentSettings) => void;
  updateAgent: (agentId: string, updates: Partial<AgentSettingsEntry>) => Promise<void>;
  setAgentPinned: (agentId: string, pinned: boolean) => Promise<void>;
  /**
   * Set the global skip-permissions override (#10432). Writes the root-level
   * `globalSkipPermissions` field only — does not mutate any per-agent
   * `dangerousEnabled`. Optimistic with rollback on IPC failure.
   */
  setGlobalSkipPermissions: (value: boolean) => Promise<void>;
  /**
   * Set the global "use alt-screen mode by default" override (#10876). Writes
   * the root-level `globalUseAltScreen` field only — does not mutate any
   * per-agent `inlineMode`. Optimistic with rollback on IPC failure.
   */
  setGlobalUseAltScreen: (value: boolean) => Promise<void>;
  /** Root-level `resumeOnRestart` (#13509); optimistic, rolled back on failure. */
  setResumeOnRestart: (value: ResumeOnRestart) => Promise<void>;
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

/**
 * Saved changes heard from the host (#14700). A read (initialize, refresh)
 * that began before the latest one is older than it and yields. A write's
 * answer doesn't: the host sends its change to every view before answering
 * the writer, so a write's answer is never older than a change already heard.
 */
let savedChangesHeard = 0;

type Patch = (settings: AgentSettings) => AgentSettings;

/**
 * This view's writes still in flight, oldest first. Each saved snapshot gets
 * them laid back on top, so a change heard while typing (another keystroke's
 * save, a host that answers slowly) doesn't take the newer text away.
 */
const pendingPatches = new Map<number, Patch>();
let patchSeq = 0;

/** The newest saved snapshot this view took, without its pending writes. */
let lastSaved: AgentSettings | null = null;

function withPending(settings: AgentSettings): AgentSettings {
  let next = settings;
  for (const patch of pendingPatches.values()) next = patch(next);
  return next;
}

function holdPatch(patch: Patch): () => void {
  const token = ++patchSeq;
  pendingPatches.set(token, patch);
  return () => pendingPatches.delete(token);
}

/** What the store shows once `settings` is saved: it, plus every pending write. */
function takeSaved(settings: AgentSettings): AgentSettings {
  lastSaved = settings;
  return withPending(settings);
}

/**
 * A failed write's rollback: the newest saved snapshot with the writes still
 * in flight, which a change heard meanwhile may have moved past the snapshot
 * the write started from. That one only before anything was saved.
 */
function rollBack(previous: AgentSettings | null): AgentSettings | null {
  return lastSaved ? withPending(lastSaved) : previous;
}

/**
 * What the store shows once a write's answer is in. The answer counts as
 * saved only when no saved change was heard while it travelled: over a remote
 * link the host's answers and pushes travel separately, so an answer can land
 * after a newer change. Otherwise the newest change heard stands, with the
 * writes still in flight. Null leaves the store as it is.
 */
function settleWrite(answer: AgentSettings | null, heardAtStart: number): AgentSettings | null {
  if (answer && heardAtStart === savedChangesHeard) return takeSaved(answer);
  return lastSaved ? withPending(lastSaved) : null;
}

/** {@link settleWrite} for a root field, whose answer is the value written. */
function settleRootWrite<K extends keyof AgentSettings>(
  field: K,
  value: AgentSettings[K],
  heardAtStart: number
): AgentSettings | null {
  if (!lastSaved) return null;
  return settleWrite({ ...lastSaved, [field]: value }, heardAtStart);
}

type StoreSet = (partial: Partial<AgentSettingsStore>) => void;
type StoreGet = () => AgentSettingsStore;

/**
 * One agent's write. `patch` is what it changes in a snapshot, which may be
 * narrower than `updates`: a preset choice sends the agent's whole preset map
 * but changes one worktree's entry, so another view's choice for a different
 * worktree, heard meanwhile, is kept.
 */
async function writeAgentEntry(
  set: StoreSet,
  get: StoreGet,
  agentId: string,
  updates: Partial<AgentSettingsEntry>,
  patch: Patch
): Promise<void> {
  const myEpoch = ++normalizeEpoch;
  const heardAtStart = savedChangesHeard;
  set({ error: null });
  const previous = get().settings;
  const release = holdPatch(patch);
  if (previous) set({ settings: patch(previous) });
  try {
    const raw = await agentSettingsClient.set(agentId, updates);
    release();
    // Run migration against the response too — covers the edge case where
    // `updateAgent` is the first interaction with a legacy store (before
    // initialize() has hydrated) and the IPC response still carries stale
    // concrete pin values for other agents (#7673 review). A newer write of
    // this view's own owns that.
    const saved = myEpoch === normalizeEpoch ? normalizeSaved(raw) : null;
    if (saved) scheduleWriteBacks(saved);
    const next = settleWrite(saved?.settings ?? null, heardAtStart);
    if (next) set({ settings: next });
  } catch (e) {
    release();
    // Reported even when a newer snapshot has landed since.
    const restored = rollBack(previous);
    if (restored) set({ settings: restored });
    set({ error: formatErrorMessage(e, `Failed to update ${agentId} settings`) });
    throw e;
  }
}

export const useAgentSettingsStore = create<AgentSettingsStore>()((set, get) => ({
  settings: null,
  isLoading: true,
  error: null,
  isInitialized: false,

  initialize: () => {
    if (get().isInitialized) return Promise.resolve();
    if (initPromise) return initPromise;

    const myEpoch = ++normalizeEpoch;
    const heardAtStart = savedChangesHeard;
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
        if (myEpoch !== normalizeEpoch || heardAtStart !== savedChangesHeard) {
          // A concurrent refresh/update or a saved change landed — its result is
          // authoritative. Flip `isInitialized` anyway so the store exits the
          // loading state (and future `initialize()` calls no-op as intended).
          set({ isLoading: false, isInitialized: true });
          return;
        }
        const saved = normalizeSaved(raw);
        set({ settings: takeSaved(saved.settings), isLoading: false, isInitialized: true });
        scheduleWriteBacks(saved);
      } catch (e) {
        if (myEpoch !== normalizeEpoch || heardAtStart !== savedChangesHeard) {
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

  applySaved: (raw: AgentSettings) => {
    savedChangesHeard += 1;
    set({
      settings: takeSaved(normalizeSaved(raw).settings),
      isLoading: false,
      isInitialized: true,
    });
  },

  refresh: async () => {
    const myEpoch = ++normalizeEpoch;
    const heardAtStart = savedChangesHeard;
    set({ error: null });
    try {
      // refresh() exists to re-pull external changes (cross-window writes,
      // config reloads) — drop the client's value cache so this read and
      // every later get() see post-change data, not a pre-change snapshot.
      agentSettingsClient.invalidate();
      const raw = (await agentSettingsClient.get()) ?? DEFAULT_AGENT_SETTINGS;
      if (myEpoch !== normalizeEpoch || heardAtStart !== savedChangesHeard) return;
      const saved = normalizeSaved(raw);
      set({ settings: takeSaved(saved.settings) });
      scheduleWriteBacks(saved);
    } catch (e) {
      // Stale failures yield silently — whichever newer op bumped the epoch
      // owns the error surface now, and fire-and-forget callers should not
      // see spurious unhandled rejections from an invalidated attempt.
      if (myEpoch !== normalizeEpoch || heardAtStart !== savedChangesHeard) return;
      set({ error: formatErrorMessage(e, "Failed to refresh agent settings") });
      throw e;
    }
  },

  updateAgent: (agentId: string, updates: Partial<AgentSettingsEntry>) =>
    writeAgentEntry(set, get, agentId, updates, (settings) => ({
      ...settings,
      agents: {
        ...settings.agents,
        [agentId]: { ...settings.agents[agentId], ...updates },
      },
    })),

  setAgentPinned: async (agentId: string, pinned: boolean) => {
    return get().updateAgent(agentId, { pinned });
  },

  setGlobalSkipPermissions: async (value: boolean) => {
    ++normalizeEpoch;
    const heardAtStart = savedChangesHeard;
    set({ error: null });
    const previous = get().settings;
    // Optimistic top-level spread — never route through updateAgent (which
    // merges into the agents record and would not touch this root field, #5514).
    // This must not mutate any per-agent `dangerousEnabled`; it is a live
    // override OR-ed in at flag-generation time (#10432).
    const release = holdPatch((settings) => ({ ...settings, globalSkipPermissions: value }));
    if (previous) {
      set({ settings: { ...previous, globalSkipPermissions: value } });
    }
    try {
      await agentSettingsClient.setGlobal(value);
      release();
      // The IPC response echoes the persisted value; the renderer-normalized
      // agents record is the source of truth for per-agent state, so only the
      // field written is taken from it.
      const next = settleRootWrite("globalSkipPermissions", value, heardAtStart);
      if (next) set({ settings: next });
    } catch (e) {
      release();
      // Reported even when a newer snapshot has landed since.
      const restored = rollBack(previous);
      if (restored) set({ settings: restored });
      set({ error: formatErrorMessage(e, "Failed to update global skip-permissions setting") });
      throw e;
    }
  },

  setGlobalUseAltScreen: async (value: boolean) => {
    ++normalizeEpoch;
    const heardAtStart = savedChangesHeard;
    set({ error: null });
    const previous = get().settings;
    // Optimistic top-level spread — never route through updateAgent (which
    // merges into the agents record and would not touch this root field, #5514).
    // This must not mutate any per-agent `inlineMode`; it is a live override
    // resolved at flag-generation time (#10876).
    const release = holdPatch((settings) => ({ ...settings, globalUseAltScreen: value }));
    if (previous) {
      set({ settings: { ...previous, globalUseAltScreen: value } });
    }
    try {
      await agentSettingsClient.setGlobalInline(value);
      release();
      // The IPC response echoes the persisted value; the renderer-normalized
      // agents record is the source of truth for per-agent state, so only the
      // field written is taken from it.
      const next = settleRootWrite("globalUseAltScreen", value, heardAtStart);
      if (next) set({ settings: next });
    } catch (e) {
      release();
      // Reported even when a newer snapshot has landed since.
      const restored = rollBack(previous);
      if (restored) set({ settings: restored });
      set({ error: formatErrorMessage(e, "Failed to update global alt-screen setting") });
      throw e;
    }
  },

  setResumeOnRestart: async (value: ResumeOnRestart) => {
    ++normalizeEpoch;
    const heardAtStart = savedChangesHeard;
    set({ error: null });
    const previous = get().settings;
    const release = holdPatch((settings) => ({ ...settings, resumeOnRestart: value }));
    if (previous) {
      set({ settings: { ...previous, resumeOnRestart: value } });
    }
    try {
      await agentSettingsClient.setResumeOnRestart(value);
      release();
      const next = settleRootWrite("resumeOnRestart", value, heardAtStart);
      if (next) set({ settings: next });
    } catch (e) {
      release();
      // Reported even when a newer snapshot has landed since.
      const restored = rollBack(previous);
      if (restored) set({ settings: restored });
      set({ error: formatErrorMessage(e, "Failed to update the resume after restart setting") });
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
    await writeAgentEntry(set, get, agentId, { worktreePresets: merged }, (settings) => {
      const entry = settings.agents[agentId];
      const presets: Record<string, string> = { ...entry?.worktreePresets };
      if (presetId === undefined) delete presets[worktreeId];
      else presets[worktreeId] = presetId;
      return {
        ...settings,
        agents: {
          ...settings.agents,
          [agentId]: {
            ...entry,
            worktreePresets: Object.keys(presets).length > 0 ? presets : undefined,
          },
        },
      };
    });
  },

  reset: async (agentId?: string) => {
    const myEpoch = ++normalizeEpoch;
    const heardAtStart = savedChangesHeard;
    set({ error: null });
    try {
      const raw = await agentSettingsClient.reset(agentId);
      if (myEpoch !== normalizeEpoch) return;
      // Reset response may still represent a legacy store (per-agent reset
      // doesn't bump version); run migration to keep tri-state semantics
      // intact (#7673 review).
      const saved = normalizeSaved(raw);
      scheduleWriteBacks(saved);
      const next = settleWrite(saved.settings, heardAtStart);
      if (next) set({ settings: next });
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
  pendingPatches.clear();
  lastSaved = null;
  initPromise = null;
  agentSettingsClient.invalidate();
  useAgentSettingsStore.setState({
    settings: DEFAULT_AGENT_SETTINGS,
    isLoading: true,
    error: null,
    isInitialized: false,
  });
}

// Registered here rather than in the orchestrator so any consumer that reads
// per-agent launch choices through `storeAccessors` (help sessions) sees them
// as soon as this store exists, mirroring projectStore's path-index accessor.
setAgentSettingsEntryAccessor(
  (agentId) => useAgentSettingsStore.getState().settings?.agents?.[agentId]
);
setGlobalUseAltScreenAccessor(() => useAgentSettingsStore.getState().settings?.globalUseAltScreen);
