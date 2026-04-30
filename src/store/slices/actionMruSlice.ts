import type { StateCreator } from "zustand";
import type { ActionFrecencyEntry } from "@shared/types/actions";
import { computeFrecencyScore, FRECENCY_INCREMENT } from "@shared/utils/frecency";

const MRU_MAX_SIZE = 20;
const SCORE_FLOOR = 0.5;

interface FrecencyEntry {
  score: number;
  lastAccessedAt: number;
}

function migrateLegacyList(legacyList: string[], nowMs: number): ActionFrecencyEntry[] {
  return legacyList.slice(0, MRU_MAX_SIZE).map((id, index) => ({
    id,
    score: (MRU_MAX_SIZE - index) * FRECENCY_INCREMENT,
    lastAccessedAt: nowMs - index * 60_000,
  }));
}

export interface ActionMruSlice {
  actionFrecencyEntries: Map<string, FrecencyEntry>;
  recordActionMru: (id: string) => void;
  hydrateActionMru: (list: ActionFrecencyEntry[] | string[]) => void;
  clearActionMru: () => void;
  getSortedActionMruList: () => ActionFrecencyEntry[];
}

export const createActionMruSlice: StateCreator<ActionMruSlice, [], [], ActionMruSlice> = (
  set,
  get
) => ({
  actionFrecencyEntries: new Map(),

  recordActionMru: (id) => {
    const nowMs = Date.now();
    set((state) => {
      const { score, lastAccessedAt } =
        state.actionFrecencyEntries.get(id) ??
        ({ score: 0, lastAccessedAt: 0 } satisfies FrecencyEntry);
      const newScore = computeFrecencyScore(score, lastAccessedAt, nowMs);

      const nextEntries = new Map();
      for (const [entryId, { score: s, lastAccessedAt: lat }] of state.actionFrecencyEntries) {
        const decayedScore = computeFrecencyScore(s, lat, nowMs);
        if (decayedScore >= SCORE_FLOOR) {
          nextEntries.set(entryId, { score: decayedScore, lastAccessedAt: lat });
        }
      }
      nextEntries.set(id, { score: newScore, lastAccessedAt: nowMs });

      let entries = Array.from(nextEntries.entries());

      entries.sort(([, a], [, b]) => b.score - a.score);

      if (entries.length > MRU_MAX_SIZE) {
        entries = entries.slice(0, MRU_MAX_SIZE);
      }

      const trimmedEntries = new Map(entries);

      if (
        trimmedEntries.size === state.actionFrecencyEntries.size &&
        trimmedEntries.get(id)?.score === newScore
      ) {
        return state;
      }

      return { actionFrecencyEntries: trimmedEntries };
    });
  },

  hydrateActionMru: (list) => {
    const nowMs = Date.now();
    set(() => {
      const isLegacy = list.length > 0 && typeof list[0] === "string";
      const entries = isLegacy
        ? migrateLegacyList(list as string[], nowMs)
        : (list as ActionFrecencyEntry[]).filter(
            (e): e is ActionFrecencyEntry =>
              e != null &&
              typeof e.id === "string" &&
              typeof e.score === "number" &&
              typeof e.lastAccessedAt === "number"
          );

      const trimmed = entries.slice(0, MRU_MAX_SIZE);
      const entryMap = new Map(
        trimmed.map(({ id, score, lastAccessedAt }) => [id, { score, lastAccessedAt }])
      );

      return { actionFrecencyEntries: entryMap };
    });
  },

  clearActionMru: () => {
    set({ actionFrecencyEntries: new Map() });
  },

  getSortedActionMruList: () => {
    const { actionFrecencyEntries } = get();
    return Array.from(actionFrecencyEntries.entries())
      .map(([id, { score, lastAccessedAt }]) => ({ id, score, lastAccessedAt }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.lastAccessedAt !== a.lastAccessedAt) return b.lastAccessedAt - a.lastAccessedAt;
        return a.id.localeCompare(b.id);
      });
  },
});
