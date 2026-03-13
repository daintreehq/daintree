import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSafeJSONStorage } from "./persistence/safeStorage";

const MAX_HISTORY_SIZE = 100;

export interface PromptHistoryEntry {
  id: string;
  prompt: string;
  agentId: string | null;
  addedAt: number;
}

interface CommandHistoryState {
  history: Record<string, PromptHistoryEntry[]>;
  recordPrompt: (projectId: string, prompt: string, agentId?: string | null) => void;
  getProjectHistory: (projectId: string | undefined) => PromptHistoryEntry[];
  getGlobalHistory: () => PromptHistoryEntry[];
  removeProjectHistory: (projectId: string) => void;
}

export const useCommandHistoryStore = create<CommandHistoryState>()(
  persist(
    (set, get) => ({
      history: {},

      recordPrompt: (projectId, prompt, agentId) =>
        set((state) => {
          const trimmed = prompt.trim();
          if (trimmed === "") return state;

          const projectEntries = [...(state.history[projectId] ?? [])];
          const filtered = projectEntries.filter((e) => e.prompt !== trimmed);
          const entry: PromptHistoryEntry = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            prompt: trimmed,
            agentId: agentId ?? null,
            addedAt: Date.now(),
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
      name: "canopy-command-history",
      storage: createSafeJSONStorage(),
      partialize: (state) => ({ history: state.history }),
    }
  )
);
