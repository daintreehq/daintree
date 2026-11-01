import { create } from "zustand";
import type { AgentSettings, AgentSettingsEntry, ResumeOnRestart } from "@shared/types";
import { agentSettingsClient } from "@/clients";
import { getSafeBootPromise } from "@/lib/bootPromise";
import { DEFAULT_AGENT_SETTINGS } from "@shared/types";
import { getEffectiveAgentIds } from "../../shared/config/agentRegistry";
import { useCliAvailabilityStore } from "./cliAvailabilityStore";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { setAgentSettingsEntryAccessor, setGlobalUseAltScreenAccessor } from "./storeAccessors";

/**
 * In-memory normalization: once real CLI availability exists, every registered
 * agent gets an entry. Toolbar pins aren't agent settings any more; they're
 * this machine's (#14702, `agentToolbarPinsStore`).
 *
 * Does NOT persist.
 */
export function normalizeAgentSelection(
  settings: AgentSettings,
  hasRealData: boolean = false
): AgentSettings {
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

/**
 * A saved slice as this view holds it, normalized against this view's CLI
 * availability. Pure, so a change heard from another view can be applied
 * as it is.
 */
function normalizeSaved(raw: AgentSettings): AgentSettings {
  return normalizeAgentSelection(raw, useCliAvailabilityStore.getState().hasRealData);
}

interface AgentSettingsState {
  settings: AgentSettings | null;
  isLoading: boolean;
  error: string | null;
  isInitialized: boolean;
}

interface AgentSettingsActions {
  initialize: () => Promise<void>;
  /**
   * Read the saved settings again. `read` stands in for the host read when
   * the answer comes from elsewhere (a resync's hydrate answer); the read
   * still counts from when this was called.
   */
  refresh: (read?: () => Promise<AgentSettings | undefined>) => Promise<void>;
  /** Take a saved slice another view (or this one) just wrote (#14700). */
  applySaved: (raw: AgentSettings) => void;
  updateAgent: (agentId: string, updates: Partial<AgentSettingsEntry>) => Promise<void>;
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
   * Passing `undefined` removes the key (the worktree inherits the agent-level
   * default again); `null` pins the bare agent to this worktree. The map
   * collapses to `undefined` when empty.
   */
  updateWorktreePreset: (
    agentId: string,
    worktreeId: string,
    presetId: string | null | undefined
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

/**
 * Bumped by each write this view starts, and by cleanup. Only a write's own
 * successor (or a cleanup) makes its answer stale; a read started after it
 * doesn't, so the answer to a write made before boot finished still counts.
 */
let writeEpoch = 0;

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
  heardAtStart: number,
  myWrite: number
): AgentSettings | null {
  if (!lastSaved) return null;
  const answer = myWrite === writeEpoch ? { ...lastSaved, [field]: value } : null;
  return settleWrite(answer, heardAtStart);
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
  ++normalizeEpoch;
  const myWrite = ++writeEpoch;
  const heardAtStart = savedChangesHeard;
  set({ error: null });
  const previous = get().settings;
  const release = holdPatch(patch);
  if (previous) set({ settings: patch(previous) });
  try {
    const raw = await agentSettingsClient.set(agentId, updates);
    release();
    // A newer write of this view's own owns the answer.
    const saved = myWrite === writeEpoch ? normalizeSaved(raw) : null;
    const next = settleWrite(saved, heardAtStart);
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
        set({ settings: takeSaved(normalizeSaved(raw)), isLoading: false, isInitialized: true });
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
      settings: takeSaved(normalizeSaved(raw)),
      isLoading: false,
      isInitialized: true,
    });
  },

  refresh: async (read) => {
    const myEpoch = ++normalizeEpoch;
    const heardAtStart = savedChangesHeard;
    set({ error: null });
    try {
      // refresh() exists to re-pull external changes (cross-window writes,
      // config reloads) — drop the client's value cache so this read and
      // every later get() see post-change data, not a pre-change snapshot.
      agentSettingsClient.invalidate();
      const raw = (await (read ?? agentSettingsClient.get)()) ?? DEFAULT_AGENT_SETTINGS;
      if (myEpoch !== normalizeEpoch || heardAtStart !== savedChangesHeard) return;
      set({ settings: takeSaved(normalizeSaved(raw)) });
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

  setGlobalSkipPermissions: async (value: boolean) => {
    ++normalizeEpoch;
    const myWrite = ++writeEpoch;
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
      const next = settleRootWrite("globalSkipPermissions", value, heardAtStart, myWrite);
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
    const myWrite = ++writeEpoch;
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
      const next = settleRootWrite("globalUseAltScreen", value, heardAtStart, myWrite);
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
    const myWrite = ++writeEpoch;
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
      const next = settleRootWrite("resumeOnRestart", value, heardAtStart, myWrite);
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
    presetId: string | null | undefined
  ) => {
    if (!worktreeId) return;
    const current = get().settings?.agents?.[agentId]?.worktreePresets ?? {};
    const next: Record<string, string | null> = { ...current };
    if (presetId === undefined) {
      delete next[worktreeId];
    } else {
      next[worktreeId] = presetId;
    }
    const merged = Object.keys(next).length > 0 ? next : undefined;
    await writeAgentEntry(set, get, agentId, { worktreePresets: merged }, (settings) => {
      const entry = settings.agents[agentId];
      const presets: Record<string, string | null> = { ...entry?.worktreePresets };
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
      const next = settleWrite(normalizeSaved(raw), heardAtStart);
      if (next) set({ settings: next });
    } catch (e) {
      if (myEpoch !== normalizeEpoch) return;
      set({ error: formatErrorMessage(e, "Failed to reset agent settings") });
      throw e;
    }
  },
}));

export function cleanupAgentSettingsStore() {
  normalizeEpoch++;
  writeEpoch++;
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
