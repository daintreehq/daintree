import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSafeJSONStorage } from "./persistence/safeStorage";
import { registerPersistedStore } from "./persistence/persistedStoreRegistry";

export type GitHubSeenAnchorCategory = "issues" | "prs" | "commits";

export interface GitHubSeenAnchor {
  count: number;
  seenAt: number;
}

export type PerCategoryAnchors = Partial<Record<GitHubSeenAnchorCategory, GitHubSeenAnchor>>;

// Suppress the "+N" badge when the anchor is older than 72 hours so a Monday
// return to a long-ignored project doesn't flash "+847" — at that age the
// number is no longer a useful "what's new since I last looked" signal.
export const SEEN_SUPPRESSION_TTL_MS = 72 * 60 * 60 * 1000;

const BADGE_CAP = 99;

export function deriveBadgeLabel(
  anchor: GitHubSeenAnchor | undefined,
  currentCount: number | null,
  isOpen: boolean,
  now: number
): string | null {
  if (!anchor) return null;
  // Defensive: corrupted persisted state (manual localStorage edit, partial
  // write, or a future schema change) could surface a non-numeric `count` or
  // `seenAt` that would otherwise produce `+NaN`.
  if (!Number.isFinite(anchor.count) || !Number.isFinite(anchor.seenAt)) return null;
  if (isOpen) return null;
  if (now - anchor.seenAt > SEEN_SUPPRESSION_TTL_MS) return null;
  if (currentCount == null) return null;
  const delta = currentCount - anchor.count;
  if (delta <= 0) return null;
  return delta > BADGE_CAP ? `+${BADGE_CAP}+` : `+${delta}`;
}

interface GitHubSeenAnchorsState {
  anchors: Record<string, PerCategoryAnchors>;
  /**
   * Records an anchor for the given project + category. Pass `null` for
   * `count` when the user opens the dropdown while stats haven't loaded yet —
   * any existing anchor for that category is cleared so a stale value can't
   * over-report once stats arrive (the user attended to the category but had
   * nothing concrete to anchor against). On the next open with a known count
   * a fresh anchor is captured.
   */
  recordOpen: (
    projectPath: string,
    category: GitHubSeenAnchorCategory,
    count: number | null
  ) => void;
}

export const useGitHubSeenAnchorsStore = create<GitHubSeenAnchorsState>()(
  persist(
    (set) => ({
      anchors: {},

      recordOpen: (projectPath, category, count) =>
        set((state) => {
          const projectAnchors = state.anchors[projectPath] ?? {};
          if (count == null) {
            if (!(category in projectAnchors)) return state;
            const { [category]: _omit, ...rest } = projectAnchors;
            return {
              anchors: {
                ...state.anchors,
                [projectPath]: rest,
              },
            };
          }
          return {
            anchors: {
              ...state.anchors,
              [projectPath]: {
                ...projectAnchors,
                [category]: { count, seenAt: Date.now() },
              },
            },
          };
        }),
    }),
    {
      name: "daintree-github-seen-anchors",
      storage: createSafeJSONStorage(),
      version: 0,
      migrate: (persistedState) =>
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        persistedState as GitHubSeenAnchorsState,
      partialize: (state) => ({ anchors: state.anchors }),
    }
  )
);

registerPersistedStore({
  storeId: "githubSeenAnchorsStore",
  store: useGitHubSeenAnchorsStore,
  persistedStateType: "{ anchors: Record<string, PerCategoryAnchors> }",
});
