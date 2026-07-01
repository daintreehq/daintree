import type { StateCreator } from "zustand";
import type { ActionFrecencyEntry, ActionUsageEntry } from "@shared/types/actions";
import { MAX_USES_PER_ENTRY, pruneUses } from "@shared/utils/actionUsage";

const MRU_MAX_SIZE = 20;

interface UsageEntry {
  /** Sorted-ascending use timestamps, pruned to the rolling window. */
  uses: number[];
}

function lastUse(entry: UsageEntry): number {
  return entry.uses.length > 0 ? entry.uses[entry.uses.length - 1]! : 0;
}

// Trim/sort order: primary = in-window usage count, tiebreak = most recent use.
function compareUsage(a: UsageEntry, b: UsageEntry): number {
  if (b.uses.length !== a.uses.length) return b.uses.length - a.uses.length;
  return lastUse(b) - lastUse(a);
}

function trimToCap(entries: Map<string, UsageEntry>): Map<string, UsageEntry> {
  if (entries.size <= MRU_MAX_SIZE) return entries;
  const kept = Array.from(entries.entries())
    .sort(([, a], [, b]) => compareUsage(a, b))
    .slice(0, MRU_MAX_SIZE);
  return new Map(kept);
}

// Prior frecency entries ({ score, lastAccessedAt }) carry no per-use
// timestamps, so approximate: replay round(score) uses at lastAccessedAt. If
// that timestamp predates the window the entry prunes away — intended decay.
function synthesizeFromScore(score: unknown, lastAccessedAt: unknown, nowMs: number): number[] {
  // A legacy entry with no valid timestamp can't be placed in the window — drop
  // it rather than resurrecting it as freshly-used. Mirrors the main-process
  // sanitizer, which treats a missing lastAccessedAt as out-of-window.
  if (typeof lastAccessedAt !== "number" || !Number.isFinite(lastAccessedAt)) return [];
  const safeScore = typeof score === "number" && Number.isFinite(score) ? score : 0;
  const count = Math.max(1, Math.min(MAX_USES_PER_ENTRY, Math.round(safeScore)));
  return pruneUses(new Array(count).fill(lastAccessedAt), nowMs);
}

export interface ActionMruSlice {
  actionUsageEntries: Map<string, UsageEntry>;
  recordActionMru: (id: string) => void;
  hydrateActionMru: (list: ActionUsageEntry[] | ActionFrecencyEntry[] | string[]) => void;
  clearActionMru: () => void;
  getSortedActionMruList: () => ActionFrecencyEntry[];
}

export const createActionMruSlice: StateCreator<ActionMruSlice, [], [], ActionMruSlice> = (
  set,
  get
) => ({
  actionUsageEntries: new Map(),

  recordActionMru: (id) => {
    const nowMs = Date.now();
    set((state) => {
      // Re-prune every entry so stale (>window) activity is dropped on each use,
      // not just for the id being recorded.
      const next = new Map<string, UsageEntry>();
      for (const [entryId, entry] of state.actionUsageEntries) {
        const uses = pruneUses(entry.uses, nowMs);
        if (uses.length > 0) next.set(entryId, { uses });
      }
      const current = next.get(id)?.uses ?? [];
      next.set(id, { uses: pruneUses([...current, nowMs], nowMs) });
      return { actionUsageEntries: trimToCap(next) };
    });
  },

  hydrateActionMru: (list) => {
    const nowMs = Date.now();
    set(() => {
      const map = new Map<string, UsageEntry>();
      let index = 0;
      for (const raw of list) {
        const position = index++;
        if (typeof raw === "string") {
          // Pre-frecency persistence was a plain MRU list (most-recent first).
          // Seed each id with one synthetic use, staggered so list order
          // becomes recency order.
          if (raw.length === 0 || map.has(raw)) continue;
          const uses = pruneUses([nowMs - position * 60_000], nowMs);
          if (uses.length > 0) map.set(raw, { uses });
          continue;
        }
        if (raw == null || typeof raw.id !== "string" || map.has(raw.id)) continue;
        let uses: number[];
        if ("uses" in raw && Array.isArray(raw.uses)) {
          uses = pruneUses(raw.uses, nowMs);
        } else if ("score" in raw) {
          uses = synthesizeFromScore(raw.score, raw.lastAccessedAt, nowMs);
        } else {
          uses = [];
        }
        if (uses.length > 0) map.set(raw.id, { uses });
      }
      return { actionUsageEntries: trimToCap(map) };
    });
  },

  clearActionMru: () => {
    set({ actionUsageEntries: new Map() });
  },

  getSortedActionMruList: () => {
    const nowMs = Date.now();
    const { actionUsageEntries } = get();
    const rows: ActionFrecencyEntry[] = [];
    for (const [id, entry] of actionUsageEntries) {
      const uses = pruneUses(entry.uses, nowMs);
      if (uses.length === 0) continue;
      rows.push({ id, score: uses.length, lastAccessedAt: uses[uses.length - 1]! });
    }
    rows.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.lastAccessedAt !== a.lastAccessedAt) return b.lastAccessedAt - a.lastAccessedAt;
      return a.id.localeCompare(b.id);
    });
    return rows;
  },
});
