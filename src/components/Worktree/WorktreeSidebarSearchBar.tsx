import { useCallback, useEffect, useState, useRef } from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { WorktreeFilterPopover } from "./WorktreeFilterPopover";
import type { ChipCounts } from "@/lib/worktreeFilters";

interface WorktreeSidebarSearchBarProps {
  inputRef?: React.Ref<HTMLInputElement>;
  chipCounts?: ChipCounts;
  /**
   * Where the bar is mounted. The sidebar variant carries the optional
   * `--worktree-filter-bar-bg` theme surface (a recessed strip at the top of
   * the rail); the modal variant stays transparent so the strip doesn't leak
   * onto the elevated overview dialog.
   */
  variant?: "sidebar" | "modal";
  /**
   * Controls rendered on the trailing edge of the field row, after the facet
   * button. For callers whose view-scope controls belong with the filters
   * rather than in their own band — the overview passes its main-worktree
   * switch here so the whole working toolbar stays one line.
   */
  trailing?: React.ReactNode;
  /**
   * Filter scope / sort status ("1 of 2 worktrees · Sorting disabled while
   * searching") rendered under the field, sharing a row with "Clear all".
   * Visual-only — screen readers are served by the caller's debounced
   * announcer effects, not a live region here (#9665).
   */
  statusText?: string | null;
}

// The visible filter updates instantly via `liveQuery`; only the persisted
// `query` write to localStorage is debounced, so typing never feels laggy.
const QUERY_PERSIST_DEBOUNCE_MS = 500;

function assignForwardedRef<T>(ref: React.Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") {
    ref(value);
  } else if (ref && typeof ref === "object") {
    (ref as React.MutableRefObject<T | null>).current = value;
  }
}

export function WorktreeSidebarSearchBar({
  inputRef,
  chipCounts,
  variant = "sidebar",
  statusText,
  trailing,
}: WorktreeSidebarSearchBarProps) {
  const query = useWorktreeFilterStore((state) => state.query);
  const liveQuery = useWorktreeFilterStore((state) => state.liveQuery);
  const setQuery = useWorktreeFilterStore((state) => state.setQuery);
  const setLiveQuery = useWorktreeFilterStore((state) => state.setLiveQuery);
  const clearAll = useWorktreeFilterStore((state) => state.clearAll);
  const quickStateFilter = useWorktreeFilterStore((state) => state.quickStateFilter);
  const hasFacetFilters = useWorktreeFilterStore((state) => state.hasFacetFilters());
  const hasActiveFiltersValue = useWorktreeFilterStore((state) => state.hasActiveFilters());

  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const internalRef = useRef<HTMLInputElement | null>(null);
  const prevHasActiveFiltersRef = useRef(hasActiveFiltersValue);

  // Sync the instant `liveQuery` and cancel any pending persistence write when
  // the persisted `query` changes from outside this input (hydration,
  // programmatic resets, another window). During normal typing `query` only
  // changes when the debounce commits, at which point `liveQuery` already
  // matches, so this is a no-op.
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setLiveQuery(query);
  }, [query, setLiveQuery]);

  // Cancel any pending debounce when ANY filter is cleared externally
  // (popover footer "Clear all filters", sidebar empty-state CTA, etc.).
  // The `[query]` effect above only catches transitions of `query` itself;
  // when the typed-but-uncommitted query coincides with an external clearAll,
  // the store's `query` stays "" and the debounce would silently resurrect
  // the typed value after the persist delay.
  useEffect(() => {
    if (prevHasActiveFiltersRef.current && !hasActiveFiltersValue) {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      setLiveQuery("");
    }
    prevHasActiveFiltersRef.current = hasActiveFiltersValue;
  }, [hasActiveFiltersValue, setLiveQuery]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  const handleQueryChange = useCallback(
    (value: string) => {
      // Instant: drives the visible filter and input on every keystroke.
      setLiveQuery(value);
      // Debounced: only the localStorage persistence write is throttled.
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        // Commit whatever `liveQuery` is when the timer fires, not the value
        // captured at schedule time. If the query was cleared externally (e.g.
        // "Show all worktrees" → clearAll with no other active filters, so the
        // hasActiveFilters guard never trips), this commits "" instead of
        // resurrecting the stale typed value.
        setQuery(useWorktreeFilterStore.getState().liveQuery);
      }, QUERY_PERSIST_DEBOUNCE_MS);
    },
    [setQuery, setLiveQuery]
  );

  const handleClearSearch = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setLiveQuery("");
    setQuery("");
    // Keep focus on input after clearing, per ARIA APG combobox guidance —
    // the X button unmounts when the query clears, so focus would otherwise fall to body.
    internalRef.current?.focus();
  }, [setQuery, setLiveQuery]);

  const handleClearAll = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    // The "Clear all" button unmounts once fewer than two filter axes remain,
    // so keep focus on the search input — matching the X button's behaviour
    // above — rather than letting it fall to body (issue #10315).
    internalRef.current?.focus();
    // `clearAll` resets both `query` and `liveQuery` in the store.
    clearAll();
  }, [clearAll]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // ARIA APG combobox sequence: close popup → clear text → blur.
      if (isPopoverOpen) {
        e.stopPropagation();
        setIsPopoverOpen(false);
        return;
      }
      if (liveQuery) {
        e.stopPropagation();
        handleClearSearch();
        return;
      }
      internalRef.current?.blur();
    },
    [isPopoverOpen, liveQuery, handleClearSearch]
  );

  const setRefs = useCallback(
    (el: HTMLInputElement | null) => {
      internalRef.current = el;
      assignForwardedRef(inputRef, el);
    },
    [inputRef]
  );

  const showClear = !!liveQuery;
  const activeAxisCount =
    (liveQuery.trim() ? 1 : 0) + (quickStateFilter !== "all" ? 1 : 0) + (hasFacetFilters ? 1 : 0);
  const showClearAll = activeAxisCount >= 2;

  return (
    <div
      className={cn(
        // px-3 matches the header above and the status line below, so the whole
        // control zone sits on one 12px inset instead of three (#11991).
        // No top padding in the sidebar: the header's py-3 already sets the
        // 12px above the field. pb-3 matches it below, so the rule under the
        // rail lands on the same rhythm the title sits on. The modal's header
        // has no such trailing padding — it ends on its own border — so that
        // variant supplies the inset itself rather than sitting flush against
        // the rule above it.
        "px-3 pb-3 border-b border-divider shrink-0",
        // In the dialog the horizontal neighbours are different too: the header,
        // the footer and the rows below all sit on AppDialog's chrome inset
        // (24px plus the 11px scrollbar gutter `AppDialog.Body` reserves), so
        // the bar carries that one instead of the rail's 12px.
        variant === "modal" && "pt-3 px-[calc(1.5rem+11px)]",
        variant === "sidebar" && "worktree-filter-bar"
      )}
    >
      <div className="flex items-stretch gap-1.5">
        <div
          role="search"
          className={cn(
            // h-7: 28px is the app's compact control height and the desktop-IDE
            // norm; the field used to be 34px, which gave the rail more visual
            // mass than the title above it.
            "flex h-7 flex-1 min-w-0 items-center gap-1.5 px-2 rounded-[var(--radius-md)]",
            // Fallback keeps themes without --worktree-search-input-bg byte-identical.
            "bg-[var(--worktree-search-input-bg,var(--color-daintree-bg))] border border-daintree-border",
            "focus-within:border-daintree-accent/40 focus-within:ring-1 focus-within:ring-daintree-accent/20"
          )}
        >
          <Search
            className="w-3.5 h-3.5 shrink-0 text-daintree-text/40 pointer-events-none"
            aria-hidden="true"
          />
          <input
            ref={setRefs}
            type="text"
            value={liveQuery}
            onChange={(e) => handleQueryChange(e.target.value)}
            onKeyDown={handleKeyDown}
            // Short on purpose: at the 200px minimum "Search worktrees..." clips
            // to "Search worktree", which reads as a typo rather than as
            // truncation. The noun is already the heading directly above, and
            // the full phrase stays the accessible name.
            placeholder="Search…"
            aria-label="Search worktrees"
            className="flex-1 min-w-0 text-xs bg-transparent text-daintree-text placeholder-daintree-text/40 focus:outline-hidden"
          />
          {showClear && (
            <button
              type="button"
              onClick={handleClearSearch}
              className="flex shrink-0 items-center justify-center w-5 h-5 rounded text-daintree-text/40 transition-colors hover:text-daintree-text focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-daintree-accent"
              aria-label="Clear search"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
        {/* Filter/sort lives as its own adjacent control, not buried inside the
            field — matching the app's other search rails (Logs, Keyboard
            Shortcuts, Command Overrides). */}
        <WorktreeFilterPopover
          appearance="field"
          hideSearchInput
          chipCounts={chipCounts}
          open={isPopoverOpen}
          onOpenChange={setIsPopoverOpen}
        />
        {trailing}
      </div>
      {(statusText || showClearAll) && (
        // pt-2, not pt-1: the rail's own bottom padding is 12px, so a 4px gap
        // above this line left it crowding the field it describes while
        // floating clear of the rule below.
        <div className="flex items-center gap-2 pt-2">
          {statusText && (
            <span className="min-w-0 flex-1 truncate text-[11px] text-text-secondary">
              {statusText}
            </span>
          )}
          {showClearAll && (
            <button
              type="button"
              onClick={handleClearAll}
              className="ml-auto shrink-0 rounded text-[11px] text-text-secondary hover:text-daintree-text transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-daintree-accent"
            >
              Clear all
            </button>
          )}
        </div>
      )}
    </div>
  );
}
