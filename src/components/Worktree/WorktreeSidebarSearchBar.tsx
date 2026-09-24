import { useCallback, useEffect, useState, useRef } from "react";
import { cn } from "@/lib/utils";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { WorktreeFilterPopover } from "./WorktreeFilterPopover";
import { SearchField } from "@/components/ui/SearchField";
import type { ChipCounts } from "@/lib/worktreeFilters";

interface WorktreeSidebarSearchBarProps {
  inputRef?: React.Ref<HTMLInputElement>;
  /**
   * ArrowDown from the field hands keyboard control to the results this bar
   * filters. Callers that have no navigable results below the field omit it
   * and ArrowDown does nothing, as before.
   */
  onArrowIntoResults?: () => void;
  chipCounts?: ChipCounts;
  /**
   * Where the bar is mounted. The sidebar variant carries the optional
   * `--worktree-filter-bar-bg` theme surface (a recessed strip at the top of
   * the rail). The palette variant is the overview's: it sits inside
   * `AppPaletteDialog.Header`, which owns the padding and the rule, so it
   * paints no strip of its own and uses the palette family's field.
   */
  variant?: "sidebar" | "palette";
  /**
   * Controls rendered on the trailing edge of the field row, after the facet
   * button. For callers whose view-scope controls belong with the filters
   * rather than in their own band — the overview passes its main-worktree
   * switch here so the whole working toolbar stays one line.
   */
  trailing?: React.ReactNode;
  /**
   * Offered Escape before the field spends it on clearing the query. Return
   * true to claim the key — the overview uses this so an active selection is
   * dismissed first, the same precedence Escape has everywhere else on it.
   */
  onEscape?: () => boolean;
  /**
   * Enter in the field. The overview is a quick switcher as much as a table:
   * type, Enter, and you are there — the field acts on the results it filters.
   */
  onSubmit?: () => void;
  /**
   * Filter scope / reorder status ("1 of 2 worktrees · Drag to reorder is off while
   * searching") rendered under the field, sharing a row with "Clear all".
   * Visual-only — screen readers are served by the caller's debounced
   * announcer effects, not a live region here (#9665).
   */
  statusText?: string | null;
  /**
   * The active filters by name, e.g. `Status: Dirty · Branch type: Feature`.
   * Separate from `statusText` rather than concatenated into it: on one line
   * beside a non-shrinking "Clear all" the count ate the width and the filter
   * names truncated away first — and the names are the part the count cannot
   * substitute for. Given its own row it wraps instead.
   */
  filterSummaryText?: string | null;
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
  onArrowIntoResults,
  chipCounts,
  variant = "sidebar",
  statusText,
  filterSummaryText,
  trailing,
  onEscape,
  onSubmit,
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
      if (e.key === "Enter" && onSubmit && !isPopoverOpen && !e.nativeEvent.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        onSubmit();
        return;
      }
      // ArrowDown hands off to the results below. The field takes initial
      // focus on this surface, so "type a query, arrow to the match" is the
      // first thing anyone does — and without this it did nothing, because
      // the arrow keys belong to the grid and the grid did not have focus.
      //
      // Focus MOVES rather than the field keeping it and driving the grid by
      // `aria-activedescendant`. That is the combobox architecture, and it is
      // wrong here twice over: this grid is permanently visible and
      // multi-selectable, which is not what a combobox popup is, and Space
      // would have to be either a space character or the selection toggle and
      // cannot be both. GitHub, Gmail, Linear, VS Code's search view and
      // Finder all move focus for exactly that reason.
      if (e.key === "ArrowDown" && onArrowIntoResults && !isPopoverOpen) {
        e.preventDefault();
        e.stopPropagation();
        onArrowIntoResults();
        return;
      }
      if (e.key !== "Escape") return;
      // ARIA APG combobox sequence: close popup → clear text → blur.
      if (isPopoverOpen) {
        e.stopPropagation();
        setIsPopoverOpen(false);
        return;
      }
      if (onEscape?.()) {
        e.stopPropagation();
        return;
      }
      if (liveQuery) {
        e.stopPropagation();
        handleClearSearch();
        return;
      }
      internalRef.current?.blur();
    },
    [isPopoverOpen, liveQuery, handleClearSearch, onArrowIntoResults, onEscape, onSubmit]
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
  // Facet filters are the ones with no other affordance out here: the query has
  // its own X in the field and quick-state has its own bar, but a Status or
  // Branch type chip is invisible once the popover closes. So any facet filter
  // earns the bulk clear on its own; everything else still needs two axes
  // before this line is worth the row it costs.
  const showClearAll = hasFacetFilters || activeAxisCount >= 2;

  return (
    <div
      className={cn(
        // px-3 matches the header above and the status line below, so the whole
        // control zone sits on one 12px inset instead of three (#11991).
        // No top padding in the sidebar: the header's py-3 already sets the
        // 12px above the field. pb-3 matches it below, so the rule under the
        // rail lands on the same rhythm the title sits on.
        "px-3 pb-3 border-b border-divider shrink-0",
        variant === "sidebar" && "worktree-filter-bar",
        // The palette header it sits in owns the inset and the rule.
        variant === "palette" && "px-0 pb-0 border-b-0"
      )}
    >
      <div className={cn("flex gap-1.5", variant === "palette" ? "items-center" : "items-stretch")}>
        <SearchField
          size={variant === "palette" ? "palette" : "compact"}
          fieldProps={{ role: "search" }}
          // h-7 via the compact size: 28px is the app's compact control height
          // and the desktop-IDE norm; the field used to be 34px, which gave the
          // rail more visual mass than the title above it. The theme's raised
          // field colour, where it sets one, stays the resting well.
          fieldClassName={cn(
            "flex-1",
            variant === "sidebar" &&
              "[--search-field-bg:var(--worktree-search-input-bg,var(--theme-surface-canvas))]"
          )}
          inputRef={setRefs}
          value={liveQuery}
          onChange={(e) => handleQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onClear={showClear ? handleClearSearch : undefined}
          // Short on purpose: at the 200px minimum "Search worktrees..." clips
          // to "Search worktree", which reads as a typo rather than as
          // truncation. The noun is already the heading directly above, and
          // the full phrase stays the accessible name.
          placeholder={variant === "palette" ? "Search worktrees…" : "Search…"}
          aria-label="Search worktrees"
        />
        {/* Filter/sort lives as its own adjacent control, not buried inside the
            field — matching the app's other search rails (Logs, Keyboard
            Shortcuts, Command Overrides). */}
        <WorktreeFilterPopover
          appearance={variant === "palette" ? "ghost" : "field"}
          hideSearchInput
          chipCounts={chipCounts}
          open={isPopoverOpen}
          onOpenChange={setIsPopoverOpen}
        />
        {trailing}
      </div>
      {(statusText || filterSummaryText || showClearAll) && (
        // pt-2, not pt-1: the rail's own bottom padding is 12px, so a 4px gap
        // above this line left it crowding the field it describes while
        // floating clear of the rule below.
        <div className="pt-2">
          <div className="flex items-center gap-2">
            {statusText && (
              <span className="min-w-0 flex-1 truncate text-2xs text-text-secondary">
                {statusText}
              </span>
            )}
            {showClearAll && (
              <button
                type="button"
                onClick={handleClearAll}
                className="ml-auto shrink-0 rounded-[var(--radius-sm)] text-2xs text-text-secondary hover:text-text-primary transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary"
              >
                Clear all
              </button>
            )}
          </div>
          {filterSummaryText && (
            // Its own row, and wrapping: at the 200px minimum width there is no
            // room to share a line with the count and "Clear all", and a
            // truncated "Status: Di…" answers nothing.
            <div className="mt-0.5 text-2xs leading-snug text-text-secondary [overflow-wrap:anywhere]">
              {filterSummaryText}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
