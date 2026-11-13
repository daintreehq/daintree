import { create } from "zustand";
import { persist } from "zustand/middleware";
import { hostScopedKey } from "@/hooks/useHostPlatform";
import type { StorageValue } from "zustand/middleware";
import { createSafeJSONStorage } from "./persistence/safeStorage";
import {
  mergeRecordByWriterDelta,
  type PersistWriteMergeContext,
} from "./persistence/persistWriteMerge";
import { registerPersistedStore } from "./persistence/persistedStoreRegistry";

const MAX_HISTORY_SIZE = 100;

/**
 * The bucket the global assistant's prompts are kept in: it belongs to no
 * project, so there is no "This project" list to offer it.
 */
export const GLOBAL_ASSISTANT_HISTORY_ID = "global-assistant";

export interface PromptHistoryEntry {
  id: string;
  prompt: string;
  agentId: string | null;
  addedAt: number;
  /** Armed terminal IDs at the time of fleet broadcast (fleet history only) */
  armedIds?: string[];
  /** Filter spec used when the broadcast was sent (fleet history only) */
  targetSpec?: { scope: "current" | "all"; stateFilter: string };
}

interface CommandHistoryState {
  history: Record<string, PromptHistoryEntry[]>;
  recordPrompt: (
    projectId: string,
    prompt: string,
    agentId?: string | null,
    fleetMeta?: { armedIds?: string[]; targetSpec?: PromptHistoryEntry["targetSpec"] }
  ) => void;
  getProjectHistory: (projectId: string | undefined) => PromptHistoryEntry[];
  getGlobalHistory: () => PromptHistoryEntry[];
  removeProjectHistory: (projectId: string) => void;
}

type CommandHistoryPersistedState = Pick<CommandHistoryState, "history">;

function historyOf(
  value: StorageValue<CommandHistoryPersistedState> | null
): Record<string, PromptHistoryEntry[]> {
  const history = value?.state?.history;
  return history !== null && typeof history === "object" ? history : {};
}

/** What `recordPrompt` treats as one prompt: a fleet send to another armed set is another. */
function promptKey(entry: PromptHistoryEntry): string {
  return `${entry.prompt}\u0000${entry.armedIds?.join(",") ?? ""}`;
}

/**
 * A bucket this writer recorded into, with the entries a sibling recorded into
 * it meanwhile: Canopy's window and the project's own view both keep a run's
 * prompts. Recording only ever adds, so an entry neither the writer's baseline
 * nor its snapshot knew is a sibling's, and stays; one the writer knew and
 * dropped (an older repeat, the cap) stays dropped.
 */
function withSiblingEntries(
  baseline: readonly PromptHistoryEntry[] | undefined,
  incoming: readonly PromptHistoryEntry[],
  onDisk: readonly PromptHistoryEntry[] | undefined
): PromptHistoryEntry[] {
  const known = new Set([...(baseline ?? []), ...incoming].map((entry) => entry.id));
  const added = (onDisk ?? []).filter((entry) => !known.has(entry.id));
  if (added.length === 0) return [...incoming];
  const seen = new Set<string>();
  const merged: PromptHistoryEntry[] = [];
  for (const entry of [...incoming, ...added].sort((a, b) => b.addedAt - a.addedAt)) {
    const key = promptKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged.slice(0, MAX_HISTORY_SIZE);
}

/**
 * Baseline-aware three-way merge for command-history writes across project views
 * (issue #11351). Each project's history array is one record value: a stale view
 * writing its own project's bucket no longer drops another project's history a
 * sibling view recorded, and a `removeProjectHistory` isn't resurrected. A
 * bucket both recorded into keeps both's entries.
 */
function mergeCommandHistoryPersistedWrite({
  baseline,
  onDisk,
  incoming,
}: PersistWriteMergeContext<CommandHistoryPersistedState>): StorageValue<CommandHistoryPersistedState> {
  // No shared value on disk yet → nothing to reconcile against.
  if (!onDisk) return incoming;
  const known = historyOf(baseline);
  const disk = historyOf(onDisk);
  const merged = mergeRecordByWriterDelta(known, historyOf(incoming), disk);
  for (const [key, entries] of Object.entries(merged)) {
    if (entries !== disk[key]) merged[key] = withSiblingEntries(known[key], entries, disk[key]);
  }
  return { version: incoming.version, state: { history: merged } };
}

export const useCommandHistoryStore = create<CommandHistoryState>()(
  persist(
    (set, get) => ({
      history: {},

      recordPrompt: (projectId, prompt, agentId, fleetMeta) =>
        set((state) => {
          const trimmed = prompt.trim();
          if (trimmed === "") return state;

          const projectEntries = [...(state.history[hostScopedKey(projectId)] ?? [])];
          // For fleet entries with armed IDs, only dedup against entries with
          // the same armed set — different targets are different intents.
          const armedKey = fleetMeta?.armedIds?.join(",") ?? "";
          const filtered = projectEntries.filter((e) => {
            if (e.prompt !== trimmed) return true;
            if (armedKey) {
              const existingKey = e.armedIds?.join(",") ?? "";
              return existingKey !== armedKey;
            }
            return false;
          });
          const entry: PromptHistoryEntry = {
            id: `cmdhist-${crypto.randomUUID()}`,
            prompt: trimmed,
            agentId: agentId ?? null,
            addedAt: Date.now(),
            armedIds: fleetMeta?.armedIds,
            targetSpec: fleetMeta?.targetSpec,
          };
          const updated = [entry, ...filtered].slice(0, MAX_HISTORY_SIZE);
          return { history: { ...state.history, [hostScopedKey(projectId)]: updated } };
        }),

      getProjectHistory: (projectId) => {
        if (!projectId) return [];
        return get().history[hostScopedKey(projectId)] ?? [];
      },

      getGlobalHistory: () => {
        const all = Object.values(get().history).flat();
        const seen = new Set<string>();
        const deduped: PromptHistoryEntry[] = [];
        for (const entry of all.sort((a, b) => b.addedAt - a.addedAt)) {
          if (!seen.has(entry.prompt)) {
            seen.add(entry.prompt);
            deduped.push(entry);
          }
        }
        return deduped;
      },

      removeProjectHistory: (projectId) =>
        set((state) => {
          const { [hostScopedKey(projectId)]: _, ...rest } = state.history;
          return { history: rest };
        }),
    }),
    {
      name: "daintree-command-history",
      storage: createSafeJSONStorage<CommandHistoryPersistedState>({
        mergeOnWrite: mergeCommandHistoryPersistedWrite,
      }),
      version: 0,
      migrate: (persistedState) => persistedState as CommandHistoryState,
      partialize: (state): CommandHistoryPersistedState => ({ history: state.history }),
    }
  )
);

registerPersistedStore({
  storeId: "commandHistoryStore",
  store: useCommandHistoryStore,
  persistedStateType: "{ history: Record<string, PromptHistoryEntry[]> }",
});
