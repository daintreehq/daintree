import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IFuseOptions } from "fuse.js";
import { useSearchablePalette } from "@/hooks/useSearchablePalette";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { usePaletteStore, type PaletteId } from "@/store/paletteStore";
import { useAgentSessionRecords } from "@/hooks/useAgentSessionRecords";
import { buildResumeSessionItems, type ResumeSessionItem } from "@/services/resumeSessionItems";
import type { WorktreeSnapshot } from "@shared/types";

const RESUME_PALETTE_ID: PaletteId = "resume-sessions";

/**
 * Browse-mode page size. Nobody scrolls fifty sessions deep to resume one —
 * the recent few plus search cover real usage — so browsing shows the newest
 * page and lazily reveals more (button click or arrowing past the end) instead
 * of dumping the whole 30-day journal into the DOM.
 */
export const RESUME_PAGE_SIZE = 20;

const RESUME_FUSE_OPTIONS: IFuseOptions<ResumeSessionItem> = {
  keys: [
    { name: "name", weight: 2 },
    { name: "searchAliases", weight: 1.5 },
    { name: "description", weight: 1 },
  ],
  threshold: 0.4,
  includeScore: true,
};

/**
 * Data + search state for the resume-sessions launcher (`Cmd+K Cmd+R` / toolbar).
 * Fetches the journal unscoped while open (gated so closing doesn't re-read the
 * whole file; refreshed live when a close path journals a new record), scopes
 * it to the current project across all worktrees, and feeds the rich items
 * through the shared searchable-palette machinery.
 *
 * Browsing is a flat, newest-first list paged by {@link RESUME_PAGE_SIZE};
 * searching is flat and relevance-ordered over the full journal.
 */
const EMPTY_WORKTREES: Map<string, WorktreeSnapshot> = new Map();

export function useResumeSessionsPalette() {
  // Open state read straight from the shared palette store — the same source
  // useSearchablePalette derives its isOpen from — so the journal fetch (and
  // the worktree-map subscription below) can be gated on it without a
  // circular items → palette → isOpen dependency. The map subscription is
  // open-gated because this hook is always mounted in App: a live selector
  // re-rendered the whole App on every worktree-map identity change.
  const isOpen = usePaletteStore((state) => state.activePaletteId === RESUME_PALETTE_ID);
  const worktrees = useWorktreeStore((state) => (isOpen ? state.worktrees : EMPTY_WORKTREES));
  const currentProjectId = useProjectStore((state) => state.currentProject?.id ?? null);
  const { sessions, isLoading } = useAgentSessionRecords(isOpen);

  const items = useMemo(
    () => buildResumeSessionItems(sessions, { currentProjectId, worktrees }),
    [sessions, currentProjectId, worktrees]
  );

  const palette = useSearchablePalette<ResumeSessionItem>({
    items,
    fuseOptions: RESUME_FUSE_OPTIONS,
    includeMatches: true,
    maxResults: 100,
    canNavigate: (item) => !item.isStale,
    paletteId: RESUME_PALETTE_ID,
    getItemId: (item) => item.id,
  });

  const { query, results, selectedIndex, setQuery } = palette;
  const isSearching = query.trim().length > 0;

  const [visibleCount, setVisibleCount] = useState(RESUME_PAGE_SIZE);

  // Reset the query and paging on open. The palette is opened via
  // `paletteStore.openPalette` from the action, which bypasses
  // `useSearchablePalette.open()` — so reset here too, mirroring ThemePalette.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      wasOpenRef.current = true;
      setQuery("");
      setVisibleCount(RESUME_PAGE_SIZE);
    }
    if (!isOpen) {
      wasOpenRef.current = false;
    }
  }, [isOpen, setQuery]);

  // Keyboard lazy-load: arrowing past the visible end reveals the next page.
  // The grown count is derived synchronously (not via an effect) so the row
  // `aria-activedescendant` points at exists in the same commit the selection
  // moves — selection walks the full results and must never target an
  // unrendered row, even transiently. The effect below only commits the growth
  // to state so the list never shrinks when selection moves back up.
  const grownCount =
    !isSearching && selectedIndex >= visibleCount
      ? Math.ceil((selectedIndex + 1) / RESUME_PAGE_SIZE) * RESUME_PAGE_SIZE
      : visibleCount;
  useEffect(() => {
    if (grownCount > visibleCount) setVisibleCount(grownCount);
  }, [grownCount, visibleCount]);

  const visibleResults = isSearching ? results : results.slice(0, grownCount);
  const hiddenCount = results.length - visibleResults.length;

  const showMore = useCallback(() => {
    setVisibleCount((count) => count + RESUME_PAGE_SIZE);
  }, []);

  return {
    ...palette,
    isLoading,
    isSearching,
    visibleResults,
    hiddenCount,
    showMore,
    hasSessions: items.length > 0,
  };
}
