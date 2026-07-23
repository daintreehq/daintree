import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { StorageValue } from "zustand/middleware";
import { createSafeJSONStorage } from "./persistence/safeStorage";
import {
  mergeRecordByWriterDelta,
  type PersistWriteMergeContext,
} from "./persistence/persistWriteMerge";
import { registerPersistedStore } from "./persistence/persistedStoreRegistry";

const MAX_HISTORY_SIZE = 100;

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

function historyOf(
  value: StorageValue<CommandHistoryState> | null
): Record<string, PromptHistoryEntry[]> {
  const history = value?.state?.history;
  return history !== null && typeof history === "object" ? history : {};
}

/**
 * Baseline-aware three-way merge for command-history writes across project views
 * (issue #11351). Each project's history array is one record value: a stale view
 * writing its own project's bucket no longer drops another project's history a
 * sibling view recorded, and a `removeProjectHistory` isn't resurrected.
 * Concurrent writes to the *same* project bucket remain last-writer-wins (the
 * separate same-project multi-window case).
 */
function mergeCommandHistoryPersistedWrite({
  baseline,
  onDisk,
  incoming,
}: PersistWriteMergeContext<CommandHistoryState>): StorageValue<CommandHistoryState> {
  // No shared value on disk yet → nothing to reconcile against.
  if (!onDisk) return incoming;
  return {
    version: incoming.version,
    state: {
      ...incoming.state,
      history: mergeRecordByWriterDelta(
        historyOf(baseline),
        historyOf(incoming),
        historyOf(onDisk)
      ),
    },
  };
}

export const useCommandHistoryStore = create<CommandHistoryState>()(
  persist(
    (set, get) => ({
      history: {},

      recordPrompt: (projectId, prompt, agentId, fleetMeta) =>
        set((state) => {
          const trimmed = prompt.trim();
          if (trimmed === "") return state;

          const projectEntries = [...(state.history[projectId] ?? [])];
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
          return { history: { ...state.history, [projectId]: updated } };
        }),

      getProjectHistory: (projectId) => {
        if (!projectId) return [];
        return get().history[projectId] ?? [];
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
          const { [projectId]: _, ...rest } = state.history;
          return { history: rest };
        }),
    }),
    {
      name: "daintree-command-history",
      storage: createSafeJSONStorage<CommandHistoryState>({
        mergeOnWrite: mergeCommandHistoryPersistedWrite,
      }),
      version: 0,
      migrate: (persistedState) => persistedState as CommandHistoryState,
      partialize: (state) => ({ history: state.history }),
    }
  )
);

registerPersistedStore({
  storeId: "commandHistoryStore",
  store: useCommandHistoryStore,
  persistedStateType: "{ history: Record<string, PromptHistoryEntry[]> }",
});
