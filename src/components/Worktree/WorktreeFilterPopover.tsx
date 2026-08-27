import { useCallback, useEffect, useState, useRef } from "react";
import { Filter, X, ChevronDown } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  useWorktreeFilterStore,
  type OrderBy,
  type StatusFilter,
  type TypeFilter,
  type PrIssueFilter,
  type SessionFilter,
  type ActivityFilter,
  type DevServerFilter,
} from "@/store/worktreeFilterStore";
import type { ChipCounts } from "@/lib/worktreeFilters";

interface FilterSectionProps {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  activeCount?: number;
  onClear?: () => void;
}

function FilterSection({
  title,
  children,
  defaultOpen = false,
  activeCount = 0,
  onClear,
}: FilterSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const contentId = `filter-section-${title.toLowerCase().replace(/\s+/g, "-")}`;
  const hasActive = activeCount > 0;
  const expandButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="flex flex-col border-b border-daintree-border last:border-b-0">
      <div className="flex items-center">
        <button
          ref={expandButtonRef}
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          aria-expanded={isOpen}
          aria-controls={contentId}
          className="flex flex-1 items-center justify-between px-3 py-1.5 text-xs font-medium text-daintree-text/70 transition-colors hover:bg-overlay-soft"
        >
          <span className="flex items-center gap-1.5">
            {title}
            {hasActive && (
              <span className="rounded-full bg-tint/10 px-1.5 py-0.5 text-[10px] font-medium leading-none tabular-nums text-daintree-text/60">
                {activeCount}
              </span>
            )}
          </span>
          <ChevronDown
            data-animated-chevron
            className={cn("w-3.5 h-3.5 transition-transform", isOpen ? "transform rotate-180" : "")}
          />
        </button>
        {onClear && hasActive && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              // The Clear button unmounts itself once activeCount hits 0, so move
              // focus to the adjacent expand toggle first to keep it off body.
              expandButtonRef.current?.focus();
              onClear();
            }}
            aria-label={`Clear ${title} filters`}
            className="shrink-0 px-2 py-1.5 text-[11px] text-text-secondary transition-colors hover:text-daintree-text"
          >
            Clear
          </button>
        )}
      </div>
      {/* Animated reveal so the body honors what the rotating chevron
       * promises — same grid-rows idiom as LocalCommitsDropdown. Content
       * stays mounted; `inert` keeps collapsed chips out of tab order. */}
      <div
        aria-hidden={!isOpen}
        inert={!isOpen}
        data-animated-reveal
        className={cn(
          "grid transition-[grid-template-rows] duration-150 ease-out motion-reduce:transition-none",
          isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="overflow-hidden">
          <div id={contentId} className="px-3 pb-2.5 pt-0.5">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

interface FilterChipProps {
  label: string;
  isActive: boolean;
  onClick: () => void;
  count?: number;
}

function FilterChip({ label, isActive, onClick, count }: FilterChipProps) {
  const showCount = count !== undefined && (count > 0 || isActive);
  const isDimmed = count === 0 && !isActive;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={isActive}
      className={cn(
        "inline-flex items-center px-2 py-0.5 text-[11px] rounded-full border transition-colors",
        isActive
          ? "bg-filter-selected-bg-soft border-daintree-border text-daintree-text"
          : isDimmed
            ? "bg-daintree-bg border-daintree-border text-daintree-text/45 hover:bg-overlay-soft hover:text-daintree-text/70"
            : "bg-daintree-bg border-daintree-border text-daintree-text/75 hover:bg-overlay-medium hover:text-daintree-text"
      )}
    >
      {showCount ? `${label} (${count})` : label}
    </button>
  );
}

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "dirty", label: "Dirty" },
  { value: "stale", label: "Stale" },
  { value: "idle", label: "Idle" },
];

const TYPE_OPTIONS: { value: TypeFilter; label: string }[] = [
  { value: "feature", label: "Feature" },
  { value: "bugfix", label: "Bugfix" },
  { value: "refactor", label: "Refactor" },
  { value: "chore", label: "Chore" },
  { value: "docs", label: "Docs" },
  { value: "test", label: "Test" },
  { value: "release", label: "Release" },
  { value: "ci", label: "CI" },
  { value: "deps", label: "Deps" },
  { value: "perf", label: "Perf" },
  { value: "style", label: "Style" },
  { value: "wip", label: "WIP" },
  { value: "main", label: "Main" },
  { value: "detached", label: "Detached" },
  { value: "other", label: "Other" },
];

const PR_ISSUE_OPTIONS: { value: PrIssueFilter; label: string }[] = [
  { value: "hasIssue", label: "Has issue" },
  { value: "hasPR", label: "Has PR" },
  { value: "prOpen", label: "PR open" },
  { value: "prMerged", label: "PR merged" },
  { value: "prClosed", label: "PR closed" },
];

const SESSION_OPTIONS: { value: SessionFilter; label: string }[] = [
  { value: "hasTerminals", label: "Has terminals" },
  { value: "working", label: "Working" },
  { value: "waiting", label: "Waiting" },
  { value: "completed", label: "Completed" },
  { value: "exited", label: "Exited" },
];

const ACTIVITY_OPTIONS: { value: ActivityFilter; label: string }[] = [
  { value: "last15m", label: "15m" },
  { value: "last1h", label: "1h" },
  { value: "last24h", label: "24h" },
  { value: "last7d", label: "7d" },
];

const DEV_SERVER_OPTIONS: { value: DevServerFilter; label: string }[] = [
  { value: "hasDevServer", label: "Has server" },
  { value: "running", label: "Running" },
  { value: "starting", label: "Starting" },
  { value: "error", label: "Error" },
];

const ORDER_OPTIONS: { value: OrderBy; label: string }[] = [
  { value: "created", label: "Date created" },
  { value: "recent", label: "Recently updated" },
  { value: "alpha", label: "Alphabetical" },
  { value: "manual", label: "Custom order" },
];

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
  const [localQuery, setLocalQuery] = useState("");
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const {
    query,
    orderBy,
    groupByType,
    statusFilters,
    typeFilters,
    prIssueFilters,
    sessionFilters,
    activityFilters,
    devServerFilters,
    quickStateFilter,
    setQuery,
    setOrderBy,
    setGroupByType,
    toggleStatusFilter,
    toggleTypeFilter,
    togglePrIssueFilter,
    toggleSessionFilter,
    toggleActivityFilter,
    toggleDevServerFilter,
    clearStatusFilters,
    clearTypeFilters,
    clearPrIssueFilters,
    clearSessionFilters,
    clearActivityFilters,
    clearDevServerFilters,
    clearAll,
  } = useWorktreeFilterStore(
    useShallow((state) => ({
      query: state.query,
      orderBy: state.orderBy,
      groupByType: state.groupByType,
      statusFilters: state.statusFilters,
      typeFilters: state.typeFilters,
      prIssueFilters: state.prIssueFilters,
      sessionFilters: state.sessionFilters,
      activityFilters: state.activityFilters,
      devServerFilters: state.devServerFilters,
      quickStateFilter: state.quickStateFilter,
      setQuery: state.setQuery,
      setOrderBy: state.setOrderBy,
      setGroupByType: state.setGroupByType,
      toggleStatusFilter: state.toggleStatusFilter,
      toggleTypeFilter: state.toggleTypeFilter,
      togglePrIssueFilter: state.togglePrIssueFilter,
      toggleSessionFilter: state.toggleSessionFilter,
      toggleActivityFilter: state.toggleActivityFilter,
      toggleDevServerFilter: state.toggleDevServerFilter,
      clearStatusFilters: state.clearStatusFilters,
      clearTypeFilters: state.clearTypeFilters,
      clearPrIssueFilters: state.clearPrIssueFilters,
      clearSessionFilters: state.clearSessionFilters,
      clearActivityFilters: state.clearActivityFilters,
      clearDevServerFilters: state.clearDevServerFilters,
      clearAll: state.clearAll,
    }))
  );

  // Derived from the SUBSCRIBED snapshot, not from the store's imperative
  // `getActiveFilterCount()` / `hasActiveFilters()` helpers. Those reread
  // `_projectStore` live at call time, so the badge and the footer were reading
  // the store at two different instants within one render and could disagree —
  // which is how the "Clear all filters" footer went missing while the trigger
  // was showing a count of 3. One snapshot, one number, three consumers.
  const hasQuery = query.trim().length > 0;
  const facetFilterCount =
    statusFilters.size +
    typeFilters.size +
    prIssueFilters.size +
    sessionFilters.size +
    activityFilters.size +
    devServerFilters.size +
    (quickStateFilter !== "all" ? 1 : 0);
  const fullFilterCount = facetFilterCount + (hasQuery ? 1 : 0);
  const filterCount = hideSearchInput ? facetFilterCount : fullFilterCount;
  const showBadge = filterCount > 0;

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

  const handleClearAll = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    // The footer (and this button) unmount the moment the last filter clears,
    // so move focus onto the still-mounted popover content first — else
    // it drops to document.body inside the open popover (issue #10315).
    contentRef.current?.focus();
    setLocalQuery("");
    clearAll();
  }, [clearAll]);

  const isField = appearance === "field";
  const filtersActive = showBadge;
  const hasAnyFilter = fullFilterCount > 0;

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "flex shrink-0 items-center justify-center gap-1 rounded-[var(--radius-md)] transition-colors",
            // Every other control in this rail carries the accent focus ring;
            // without one here the browser painted its own blue outline.
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent",
            isField ? "self-stretch border border-daintree-border px-2" : "h-6 min-w-6 px-1.5",
            // Active state is a neutral fill + count, never a saturated colour or a
            // floating notification dot. A dot reads as "something new"; what matters
            // here is "how many filters", so we surface the number instead.
            filtersActive
              ? isField
                ? "bg-overlay-soft text-daintree-text"
                : "bg-tint/[0.08] text-daintree-text"
              : isField
                ? "bg-[var(--worktree-search-input-bg,var(--color-daintree-bg))] text-daintree-text/60 hover:bg-overlay-soft hover:text-daintree-text"
                : "text-daintree-text/60 hover:bg-tint/[0.06] hover:text-daintree-text"
          )}
          aria-label="Filter and sort worktrees"
          aria-haspopup="dialog"
        >
          <Filter className="w-3.5 h-3.5 shrink-0" />
          {showBadge && (
            <span className="text-[10px] font-medium leading-none tabular-nums">{filterCount}</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        align="start"
        sideOffset={8}
        className="w-72 p-0 max-h-[70vh] overflow-y-auto"
        data-testid="worktree-filter-popover"
      >
        <div className="flex flex-col">
          {/* Search */}
          {!hideSearchInput && (
            <div className="p-3 border-b border-daintree-border">
              <div className="relative">
                <input
                  type="text"
                  value={localQuery}
                  onChange={(e) => handleQueryChange(e.target.value)}
                  placeholder="Search worktrees..."
                  aria-label="Search worktrees"
                  className={cn(
                    "w-full px-2.5 py-1.5 text-xs rounded",
                    "bg-daintree-bg border border-daintree-border",
                    "text-daintree-text placeholder-daintree-text/40",
                    "focus:outline-hidden focus:border-daintree-accent/50"
                  )}
                />
                {localQuery && (
                  <button
                    type="button"
                    onClick={() => {
                      if (debounceRef.current) {
                        clearTimeout(debounceRef.current);
                      }
                      setLocalQuery("");
                      setQuery("");
                    }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-daintree-text/40 hover:text-daintree-text"
                    aria-label="Clear search"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Sort Order */}
          <div className="px-3 pt-2.5 pb-2 border-b border-daintree-border">
            <div
              id="worktree-sort-by-label"
              className="text-[10px] font-medium text-text-secondary uppercase tracking-wide mb-1.5"
            >
              Sort by
            </div>
            <div
              role="radiogroup"
              aria-labelledby="worktree-sort-by-label"
              className="flex flex-col"
            >
              {ORDER_OPTIONS.filter((option) => !(option.value === "manual" && groupByType)).map(
                (option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setOrderBy(option.value)}
                    role="radio"
                    aria-checked={orderBy === option.value}
                    className={cn(
                      "flex items-center gap-2 px-2 py-1 text-xs rounded",
                      "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-daintree-accent",
                      orderBy === option.value
                        ? "bg-overlay-raised text-daintree-text"
                        : "text-daintree-text/70 hover:bg-overlay-medium"
                    )}
                  >
                    <div
                      className={cn(
                        "w-3 h-3 rounded-full border",
                        orderBy === option.value
                          ? "border-daintree-text bg-daintree-text"
                          : "border-daintree-border"
                      )}
                    >
                      {orderBy === option.value && (
                        <div className="w-full h-full flex items-center justify-center">
                          <div className="w-1.5 h-1.5 bg-text-inverse rounded-full" />
                        </div>
                      )}
                    </div>
                    {option.label}
                  </button>
                )
              )}
            </div>
          </div>

          {/* Group by Type Toggle */}
          <div className="px-3 py-2 border-b border-daintree-border">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={groupByType}
                onChange={(e) => setGroupByType(e.target.checked)}
                className="w-3.5 h-3.5 rounded border-daintree-border text-daintree-accent focus:ring-daintree-accent/30 focus:ring-offset-0 bg-daintree-bg"
              />
              <span className="text-xs text-daintree-text/70">Group by type</span>
            </label>
          </div>

          {/* Filter Sections */}
          <FilterSection
            title="Status"
            defaultOpen={statusFilters.size > 0}
            activeCount={statusFilters.size}
            onClear={clearStatusFilters}
          >
            <div className="flex flex-wrap gap-1.5">
              {STATUS_OPTIONS.map((option) => (
                <FilterChip
                  key={option.value}
                  label={option.label}
                  isActive={statusFilters.has(option.value)}
                  onClick={() => toggleStatusFilter(option.value)}
                  count={chipCounts?.status[option.value]}
                />
              ))}
            </div>
          </FilterSection>

          <FilterSection
            title="Branch type"
            defaultOpen={typeFilters.size > 0}
            activeCount={typeFilters.size}
            onClear={clearTypeFilters}
          >
            <div className="flex flex-wrap gap-1.5">
              {TYPE_OPTIONS.map((option) => (
                <FilterChip
                  key={option.value}
                  label={option.label}
                  isActive={typeFilters.has(option.value)}
                  onClick={() => toggleTypeFilter(option.value)}
                  count={chipCounts?.branchType[option.value]}
                />
              ))}
            </div>
          </FilterSection>

          <FilterSection
            title="Issues & PRs"
            defaultOpen={prIssueFilters.size > 0}
            activeCount={prIssueFilters.size}
            onClear={clearPrIssueFilters}
          >
            <div className="flex flex-wrap gap-1.5">
              {PR_ISSUE_OPTIONS.map((option) => (
                <FilterChip
                  key={option.value}
                  label={option.label}
                  isActive={prIssueFilters.has(option.value)}
                  onClick={() => togglePrIssueFilter(option.value)}
                  count={chipCounts?.prIssue[option.value]}
                />
              ))}
            </div>
          </FilterSection>

          <FilterSection
            title="Sessions"
            defaultOpen={sessionFilters.size > 0}
            activeCount={sessionFilters.size}
            onClear={clearSessionFilters}
          >
            <div className="flex flex-wrap gap-1.5">
              {SESSION_OPTIONS.map((option) => (
                <FilterChip
                  key={option.value}
                  label={option.label}
                  isActive={sessionFilters.has(option.value)}
                  onClick={() => toggleSessionFilter(option.value)}
                  count={chipCounts?.sessions[option.value]}
                />
              ))}
            </div>
          </FilterSection>

          <FilterSection
            title="Activity"
            defaultOpen={activityFilters.size > 0}
            activeCount={activityFilters.size}
            onClear={clearActivityFilters}
          >
            <div className="flex flex-wrap gap-1.5">
              {ACTIVITY_OPTIONS.map((option) => (
                <FilterChip
                  key={option.value}
                  label={option.label}
                  isActive={activityFilters.has(option.value)}
                  onClick={() => toggleActivityFilter(option.value)}
                  count={chipCounts?.activity[option.value]}
                />
              ))}
            </div>
          </FilterSection>

          <FilterSection
            title="Dev server"
            defaultOpen={devServerFilters.size > 0}
            activeCount={devServerFilters.size}
            onClear={clearDevServerFilters}
          >
            <div className="flex flex-wrap gap-1.5">
              {DEV_SERVER_OPTIONS.map((option) => (
                <FilterChip
                  key={option.value}
                  label={option.label}
                  isActive={devServerFilters.has(option.value)}
                  onClick={() => toggleDevServerFilter(option.value)}
                  count={chipCounts?.devServer[option.value]}
                />
              ))}
            </div>
          </FilterSection>

          {/* Clear All */}
          {hasAnyFilter && (
            <div className="p-3 border-t border-daintree-border">
              <Button variant="subtle" size="xs" onClick={handleClearAll} className="w-full">
                Clear all filters
              </Button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
