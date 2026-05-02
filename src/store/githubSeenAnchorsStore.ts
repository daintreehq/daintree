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
  if (isOpen) return null;
  if (now - anchor.seenAt > SEEN_SUPPRESSION_TTL_MS) return null;
  if (currentCount == null) return null;
  const delta = currentCount - anchor.count;
  if (delta <= 0) return null;
  return delta > BADGE_CAP ? `+${BADGE_CAP}+` : `+${delta}`;
}

interface GitHubSeenAnchorsState {
  anchors: Record<string, PerCategoryAnchors>;
  recordOpen: (projectPath: string, category: GitHubSeenAnchorCategory, count: number) => void;
}

export const useGitHubSeenAnchorsStore = create<GitHubSeenAnchorsState>()(
  persist(
    (set) => ({
      anchors: {},

      recordOpen: (projectPath, category, count) =>
        set((state) => ({
          anchors: {
            ...state.anchors,
            [projectPath]: {
              ...(state.anchors[projectPath] ?? {}),
              [category]: { count, seenAt: Date.now() },
            },
          },
        })),
    }),
    {
      name: "daintree-github-seen-anchors",
      storage: createSafeJSONStorage(),
      version: 0,
      migrate: (persistedState) => persistedState as GitHubSeenAnchorsState,
      partialize: (state) => ({ anchors: state.anchors }),
    }
  )
);

registerPersistedStore({
  storeId: "githubSeenAnchorsStore",
  store: useGitHubSeenAnchorsStore,
  persistedStateType: "{ anchors: Record<string, PerCategoryAnchors> }",
});
