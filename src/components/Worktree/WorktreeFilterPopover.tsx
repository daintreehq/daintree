import { useState } from "react";
import { Filter } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useKeepMounted } from "@/hooks/useKeepMounted";
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
 * The trigger and its count. The body — every section, chip and sort control —
 * is its own chunk, loaded on the trigger's first hover, focus or open, and
 * kept mounted from then on (#17034).
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
  const hasQuery = useWorktreeFilterStore((state) => state.query.trim().length > 0);
  // Beside an external search field the query is that field's filter, not this
  // popover's, so it stays out of the count.
  const filterCount = hideSearchInput ? facetFilterCount : facetFilterCount + (hasQuery ? 1 : 0);
  const showBadge = filterCount > 0;
  const isField = appearance === "field";

  // Latched rather than tied to `isOpen`: Radix keeps the content through its
  // exit animation, and the body holds the popover's own typed query.
  const bodyMounted = useKeepMounted(isOpen);

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
            // Active state is a neutral fill + count, never a saturated colour or a
            // floating notification dot. A dot reads as "something new"; what matters
            // here is "how many filters", so we surface the number instead.
            showBadge
              ? isField
                ? "bg-overlay-soft text-text-primary"
                : "bg-tint/[0.08] text-text-primary"
              : isField
                ? "bg-[var(--worktree-search-input-bg,var(--color-surface-canvas))] text-text-secondary hover:bg-overlay-soft hover:text-text-primary"
                : "text-text-secondary hover:bg-tint/[0.06] hover:text-text-primary"
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
      {bodyMounted && (
        <FilterContentLoader
          hideSearchInput={hideSearchInput}
          chipCounts={chipCounts}
          filterCount={filterCount}
        />
      )}
    </Popover>
  );
}

function FilterContentLoader(props: WorktreeFilterPopoverContentProps) {
  // Bumped by Retry: a fresh loader mounts and issues the import again.
  const [attempt, setAttempt] = useState(0);
  return <FilterContentAttempt key={attempt} {...props} onRetry={() => setAttempt((n) => n + 1)} />;
}

function FilterContentAttempt({
  onRetry,
  ...props
}: WorktreeFilterPopoverContentProps & { onRetry: () => void }) {
  const load = usePreloadedComponent(PreloadableFilterContent);
  if (load.status === "ready") return <PreloadableFilterContent {...props} />;
  // A local chunk read, well inside the 400ms gate: nothing opens until it
  // lands, and Radix focuses the content when it mounts.
  if (load.status === "loading") return null;
  return (
    <PopoverContent align="start" className="w-72 p-3" data-testid="worktree-filter-popover">
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
    </PopoverContent>
  );
}
