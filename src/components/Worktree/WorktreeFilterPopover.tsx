import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Filter } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { clearSearchBeforeDismiss } from "@/components/ui/SearchField";
import { lazyWithPreload, usePreloadedComponent } from "@/lib/lazyWithPreload";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import type { ChipCounts } from "@/lib/worktreeFilters";
import type { WorktreeFilterPopoverContentProps } from "./WorktreeFilterPopoverContent";

const PreloadableFilterContent = lazyWithPreload(
  () => import("./WorktreeFilterPopoverContent"),
  (m) => m.WorktreeFilterPopoverContent
);

/** Loads the popover's body ahead of an open; a failure is left to the open to report. */
export function preloadWorktreeFilterContent(): Promise<void> {
  return PreloadableFilterContent.preload().then(
    () => {},
    () => {}
  );
}

function warmFilterContent(): void {
  void preloadWorktreeFilterContent();
}

interface WorktreeFilterPopoverProps {
  hideSearchInput?: boolean;
  chipCounts?: ChipCounts;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * `field` frames the trigger as a sibling of an adjacent search input
   * (matched border + surface, stretches to the input height) — the sidebar
   * rail. `ghost` (default) is the borderless icon button used standalone in
   * toolbars like the overview-modal header.
   */
  appearance?: "ghost" | "field";
}

/**
 * The trigger, its count and the popover's content shell. The sections inside
 * — every chip and sort control — are their own chunk, loaded on the trigger's
 * first hover, focus or open (#17034). The content is one element across the
 * load, so a dismissal while it loads works, and nothing swaps it out from
 * under Radix's focus handling.
 */
export function WorktreeFilterPopover({
  hideSearchInput = false,
  chipCounts,
  open,
  onOpenChange,
  appearance = "ghost",
}: WorktreeFilterPopoverProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open ?? internalOpen;
  const setIsOpen = onOpenChange ?? setInternalOpen;

  // A number per selector, so the trigger re-renders only when a count moves.
  const facetFilterCount = useWorktreeFilterStore(
    (state) =>
      state.statusFilters.size +
      state.typeFilters.size +
      state.prIssueFilters.size +
      state.sessionFilters.size +
      (state.hasAgentFilter ? 1 : 0) +
      state.activityFilters.size +
      state.devServerFilters.size
  );
  const query = useWorktreeFilterStore((state) => state.query);
  const setQuery = useWorktreeFilterStore((state) => state.setQuery);
  const clearFacetFilters = useWorktreeFilterStore((state) => state.clearFacetFilters);
  const clearAll = useWorktreeFilterStore((state) => state.clearAll);
  const hasQuery = query.trim().length > 0;
  // Beside an external search field the query is that field's filter, not this
  // popover's, so it stays out of the count.
  const filterCount = hideSearchInput ? facetFilterCount : facetFilterCount + (hasQuery ? 1 : 0);
  const showBadge = filterCount > 0;
  const isField = appearance === "field";

  const [localQuery, setLocalQuery] = useState("");
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLocalQuery(query);
  }, [query]);

  const handleQueryChange = useCallback(
    (value: string) => {
      setLocalQuery(value);
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      debounceRef.current = setTimeout(() => {
        setQuery(value);
      }, 200);
    },
    [setQuery]
  );

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const clearQuery = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    setLocalQuery("");
    setQuery("");
  }, [setQuery]);

  const handleClearAll = useCallback(() => {
    // The footer (and this button) unmount the moment the last filter clears,
    // so move focus onto the still-mounted popover content first — else
    // it drops to document.body inside the open popover (issue #10315).
    contentRef.current?.focus();
    if (hideSearchInput) {
      // The text belongs to the field beside the trigger, which has its own X
      // and its own pending commit. Wiping it here, or cancelling that commit,
      // would reach into a field this popover does not own.
      clearFacetFilters();
      return;
    }
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    setLocalQuery("");
    clearAll();
  }, [hideSearchInput, clearFacetFilters, clearAll]);

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "flex shrink-0 items-center justify-center gap-1 rounded-[var(--radius-md)] transition-colors",
            // Every other control in this rail carries the accent focus ring;
            // without one here the browser painted its own blue outline.
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary",
            isField
              ? // Square while idle, the field's height and the skeleton's w-7;
                // a count widens it.
                cn(
                  "self-stretch border border-border-default",
                  filterCount > 0 ? "min-w-7 px-1.5" : "w-7 px-0"
                )
              : "h-6 min-w-6 px-1.5",
            // A disclosure, not a toggle: active filters show as the count and
            // primary ink, never a latched fill. Hover and open both lift one
            // step up the neutral overlay ladder, whatever the count.
            "hover:bg-overlay-hover hover:text-text-primary aria-expanded:bg-overlay-hover aria-expanded:text-text-primary",
            showBadge ? "text-text-primary" : "text-text-secondary",
            isField && "bg-[var(--worktree-search-input-bg,var(--color-surface-canvas))]"
          )}
          // The count is rendered as text inside the button, and `aria-label`
          // overrides contents when the accessible name is computed — so the
          // number was visible and unspoken. It belongs in the name itself.
          aria-label={
            showBadge
              ? `Filter and sort worktrees, ${filterCount} active`
              : "Filter and sort worktrees"
          }
          aria-haspopup="dialog"
          onPointerEnter={warmFilterContent}
          onFocus={warmFilterContent}
        >
          <Filter className="w-3.5 h-3.5 shrink-0" />
          {showBadge && (
            <span className="text-3xs font-medium leading-none tabular-nums">{filterCount}</span>
          )}
        </button>
      </PopoverTrigger>
      {/* The footer is a sibling of the scroll container, not the last thing
          inside it: with several sections open the only bulk escape from a
          filtered list used to scroll out of sight. */}
      <PopoverContent
        ref={contentRef}
        align="start"
        className="flex w-72 max-h-[70vh] flex-col p-0"
        data-testid="worktree-filter-popover"
        onEscapeKeyDown={(e) => clearSearchBeforeDismiss(e, searchInputRef.current, clearQuery)}
      >
        <FilterContentLoader
          contentRef={contentRef}
          hideSearchInput={hideSearchInput}
          chipCounts={chipCounts}
          filterCount={filterCount}
          localQuery={localQuery}
          onQueryChange={handleQueryChange}
          onClearQuery={clearQuery}
          searchInputRef={searchInputRef}
          onClearAll={handleClearAll}
        />
      </PopoverContent>
    </Popover>
  );
}

/** What a warm open focuses first: the search box, or the first chip without it. */
const FIRST_CONTROL = 'input:not([disabled]), button:not([disabled]), [tabindex="0"]';

interface FilterContentLoaderProps extends WorktreeFilterPopoverContentProps {
  contentRef: React.RefObject<HTMLDivElement | null>;
}

function FilterContentLoader({ contentRef, ...props }: FilterContentLoaderProps) {
  // Bumped by Retry: a fresh attempt mounts and issues the import again.
  const [attempt, setAttempt] = useState(0);
  return (
    <FilterContentAttempt
      key={attempt}
      contentRef={contentRef}
      {...props}
      onRetry={() => {
        // Retry unmounts with the failure it answers; park focus on the content
        // rather than let it drop to the document.
        contentRef.current?.focus();
        setAttempt((n) => n + 1);
      }}
    />
  );
}

function FilterContentAttempt({
  contentRef,
  onRetry,
  ...props
}: FilterContentLoaderProps & { onRetry: () => void }) {
  // Decided as this attempt mounts: sections that land after the content opened
  // find Radix's open focus parked on the content itself.
  const [arrivedLate] = useState(() => !PreloadableFilterContent.isLoaded());
  const load = usePreloadedComponent(PreloadableFilterContent);
  const ready = load.status === "ready";
  useLayoutEffect(() => {
    if (!ready || !arrivedLate) return;
    const content = contentRef.current;
    if (!content || document.activeElement !== content) return;
    content.querySelector<HTMLElement>(FIRST_CONTROL)?.focus({ preventScroll: true });
  }, [ready, arrivedLate, contentRef]);

  if (ready) return <PreloadableFilterContent {...props} />;
  // A local chunk read, well inside the 400ms gate: the content's box, empty.
  if (load.status === "loading") return <div aria-busy="true" className="h-24" />;
  return (
    <div className="p-3">
      <Callout
        severity="error"
        size="compact"
        title="Couldn't load filters"
        action={
          <Button variant="subtle" size="xs" onClick={onRetry}>
            Retry
          </Button>
        }
      />
    </div>
  );
}
