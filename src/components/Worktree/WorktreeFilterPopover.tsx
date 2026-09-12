import { useCallback, useEffect, useId, useMemo, useState, useRef } from "react";
import { Filter, X, ChevronDown, Check } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import type { ChipCounts } from "@/lib/worktreeFilters";
import {
  ACTIVITY_OPTIONS,
  DEV_SERVER_OPTIONS,
  ORDER_OPTIONS,
  PR_ISSUE_OPTIONS,
  SESSION_OPTIONS,
  STATUS_OPTIONS,
  TYPE_OPTIONS,
} from "@/lib/worktreeFilterOptions";

interface FilterSectionProps {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  activeCount?: number;
  onClear?: () => void;
  /**
   * Shown in the header while the section is closed — what the section is
   * currently set to, so a collapsed section still answers its own question.
   */
  summary?: string;
  /**
   * Chip sections wrap their body in a `role="group"` labelled by the header,
   * so a chip announces the facet it belongs to. The sort section's body is a
   * radiogroup plus a checkbox, which carry their own semantics.
   */
  plainBody?: boolean;
}

function FilterSection({
  title,
  children,
  defaultOpen = false,
  activeCount = 0,
  onClear,
  summary,
  plainBody = false,
}: FilterSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const reactId = useId();
  const contentId = `filter-section-content-${reactId}`;
  const headerId = `filter-section-header-${reactId}`;
  const hasActive = activeCount > 0;
  const expandButtonRef = useRef<HTMLButtonElement>(null);

  // `defaultOpen` is only an initial value, so a section that gains its first
  // filter from outside the popover (the quick-state bar, a restored session)
  // would stay shut over a filter the user cannot see. Open on the 0 -> n edge
  // only, so this never fights a deliberate collapse.
  const hadActive = useRef(hasActive);
  useEffect(() => {
    if (hasActive && !hadActive.current) setIsOpen(true);
    hadActive.current = hasActive;
  }, [hasActive]);

  return (
    <div className="flex flex-col border-b border-border-default last:border-b-0">
      <div className="flex items-center">
        <button
          ref={expandButtonRef}
          id={headerId}
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          aria-expanded={isOpen}
          aria-controls={contentId}
          className="flex min-w-0 flex-1 items-center justify-between gap-2 px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-overlay-soft hover:text-text-primary"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0">{title}</span>
            {hasActive && (
              <span className="rounded-full bg-tint/10 px-1.5 py-0.5 text-3xs font-medium leading-none tabular-nums text-text-secondary">
                {activeCount}
              </span>
            )}
            {!isOpen && summary && (
              <span className="min-w-0 truncate text-2xs font-normal text-text-secondary">
                {summary}
              </span>
            )}
          </span>
          <ChevronDown
            data-animated-chevron
            className={cn(
              "w-3.5 h-3.5 shrink-0 transition-transform",
              isOpen ? "transform rotate-180" : ""
            )}
          />
        </button>
        {/* The slot is always the same width, whether or not there is anything
            in it: Clear is a sibling of the flex-1 header button, so rendering
            it only on active sections pushed their chevrons out of line with
            every other section's. `inert` keeps the placeholder — and a hidden
            Clear — out of the tab order. */}
        <span
          className={cn("shrink-0 px-2 py-1.5 text-2xs", !(onClear && hasActive) && "invisible")}
          inert={!(onClear && hasActive)}
          aria-hidden={!(onClear && hasActive)}
        >
          {onClear && hasActive ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                // The Clear button hides itself once activeCount hits 0, so move
                // focus to the adjacent expand toggle first to keep it off body.
                expandButtonRef.current?.focus();
                onClear();
              }}
              aria-label={`Clear ${title} filters`}
              // Underlined rather than a bare colour step: at rest this sat at
              // the same tone as the heading beside it, so nothing marked it as
              // a control rather than a second label.
              className="text-text-secondary underline decoration-border-strong underline-offset-2 transition-colors hover:text-text-primary hover:decoration-current"
            >
              Clear
            </button>
          ) : (
            "Clear"
          )}
        </span>
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
            {plainBody ? (
              children
            ) : (
              <div role="group" aria-labelledby={headerId} className="flex flex-wrap gap-1.5">
                {children}
              </div>
            )}
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

/**
 * Three tiers, and they have to be told apart at a glance while the pointer is
 * somewhere in the grid:
 *
 *   unavailable — matches nothing right now. Shows its `(0)` and is disabled,
 *     because selecting it can only empty the list.
 *   available   — a subtle fill gives the pill a body; the border alone is far
 *     below a perceptible step on every dark theme.
 *   selected    — a check glyph, a stronger fill and a stronger border.
 *
 * The glyph is what actually carries selection. Hovering an available chip also
 * raises its fill and takes its text to `text-text-primary`, so fill and text
 * alone left hover and selected reading identically — you could not see what
 * was selected while the pointer was in the grid. A glyph is not a colour, so
 * it also survives `forced-colors: active`, where every author fill flattens.
 */
function FilterChip({ label, isActive, onClick, count }: FilterChipProps) {
  const isUnavailable = count === 0 && !isActive;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={isActive}
      disabled={isUnavailable}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs transition-colors",
        isActive
          ? "border-text-secondary bg-filter-selected-bg-strong text-text-primary"
          : isUnavailable
            ? "cursor-not-allowed border-border-default bg-transparent text-text-secondary"
            : "border-text-secondary bg-overlay-soft text-text-primary hover:bg-overlay-medium hover:border-text-primary"
      )}
    >
      {isActive && <Check className="-ml-0.5 w-3 h-3 shrink-0" aria-hidden="true" />}
      {count === undefined ? label : `${label} (${count})`}
    </button>
  );
}

interface ChipOption<T extends string> {
  value: T;
  label: string;
}

interface ChipGridProps<T extends string> {
  options: readonly ChipOption<T>[];
  isActive: (value: T) => boolean;
  onToggle: (value: T) => void;
  counts?: Record<T, number>;
  /**
   * Past this many options, values that match nothing are folded behind a
   * "more" toggle. Branch type carries fifteen values and a real repository
   * uses three or four of them, so the unfolded grid was four rows of mostly
   * dead options sitting between the user and every facet below it.
   */
  overflowAfter?: number;
}

function ChipGrid<T extends string>({
  options,
  isActive,
  onToggle,
  counts,
  overflowAfter,
}: ChipGridProps<T>) {
  const [showAll, setShowAll] = useState(false);

  const { shown, hiddenCount } = useMemo(() => {
    if (!counts || overflowAfter === undefined || options.length <= overflowAfter) {
      return { shown: options, hiddenCount: 0 };
    }
    const useful = options.filter((o) => counts[o.value] > 0 || isActive(o.value));
    // Nothing matches anything — fold nothing rather than render an empty facet.
    if (useful.length === 0) return { shown: options, hiddenCount: 0 };
    return { shown: useful, hiddenCount: options.length - useful.length };
  }, [options, counts, overflowAfter, isActive]);

  const visible = showAll || hiddenCount === 0 ? options : shown;

  return (
    <>
      {visible.map((option) => (
        <FilterChip
          key={option.value}
          label={option.label}
          isActive={isActive(option.value)}
          onClick={() => onToggle(option.value)}
          count={counts?.[option.value]}
        />
      ))}
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          aria-expanded={showAll}
          className="inline-flex items-center self-center py-0.5 text-2xs text-text-secondary underline decoration-border-strong underline-offset-2 transition-colors hover:text-text-primary hover:decoration-current"
        >
          {showAll ? "Show fewer" : `${hiddenCount} with no matches`}
        </button>
      )}
    </>
  );
}

/** Both orientations, because the group reads as a vertical list of choices. */
const SORT_ARROW_STEPS: Record<string, number | undefined> = {
  ArrowDown: 1,
  ArrowRight: 1,
  ArrowUp: -1,
  ArrowLeft: -1,
};

/** Branch type is the only facet long enough to need folding. */
const BRANCH_TYPE_OVERFLOW_AFTER = 8;

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
  const groupByTypeId = useId();

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

  // Sort options are a real radio group, so they take one tab stop and the
  // arrows move (and select) within it — ARIA APG. Exposing `role="radio"`
  // without this promised keyboard behaviour the component did not have.
  // "Custom order" drops out while grouping is on, so the roving index has to
  // track the VISIBLE list, not ORDER_OPTIONS.
  const sortOptions = useMemo(
    () => ORDER_OPTIONS.filter((option) => !(option.value === "manual" && groupByType)),
    [groupByType]
  );
  const sortRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const checkedSortIndex = sortOptions.findIndex((option) => option.value === orderBy);
  // Defence, not a live path: `setGroupByType` already moves the selection off
  // "manual" when grouping turns on, so nothing reachable through the store
  // leaves the group with no checked option. If that guard ever slips, this
  // keeps the group tabbable instead of stranding it.
  const tabbableSortIndex = checkedSortIndex >= 0 ? checkedSortIndex : 0;

  const handleSortKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      // Home/End as well as the arrows, matching SegmentedRadioGroup — the
      // app's other radio-group keyboard model.
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? sortOptions.length - 1
            : SORT_ARROW_STEPS[event.key] !== undefined
              ? (index + SORT_ARROW_STEPS[event.key]! + sortOptions.length) % sortOptions.length
              : -1;
      if (next < 0) return;
      event.preventDefault();
      const option = sortOptions[next];
      if (!option) return;
      setOrderBy(option.value);
      sortRefs.current[next]?.focus();
    },
    [sortOptions, setOrderBy]
  );

  const isField = appearance === "field";
  const filtersActive = showBadge;
  const hasAnyFilter = fullFilterCount > 0;

  const sortSummary = useMemo(() => {
    const label = ORDER_OPTIONS.find((option) => option.value === orderBy)?.label ?? "";
    return groupByType ? `${label} · grouped` : label;
  }, [orderBy, groupByType]);

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "flex shrink-0 items-center justify-center gap-1 rounded-[var(--radius-md)] transition-colors",
            // Every other control in this rail carries the accent focus ring;
            // without one here the browser painted its own blue outline.
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary",
            isField ? "self-stretch border border-border-default px-2" : "h-6 min-w-6 px-1.5",
            // Active state is a neutral fill + count, never a saturated colour or a
            // floating notification dot. A dot reads as "something new"; what matters
            // here is "how many filters", so we surface the number instead.
            filtersActive
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
        sideOffset={8}
        className="flex w-72 max-h-[70vh] flex-col p-0"
        data-testid="worktree-filter-popover"
      >
        {/* Search */}
        {!hideSearchInput && (
          <div className="shrink-0 border-b border-border-default p-3">
            <div className="relative">
              <input
                type="text"
                value={localQuery}
                onChange={(e) => handleQueryChange(e.target.value)}
                placeholder="Search worktrees..."
                aria-label="Search worktrees"
                className={cn(
                  "w-full rounded-[var(--radius-md)] px-2.5 py-1.5 text-xs",
                  "border border-border-default bg-surface-canvas",
                  "text-text-primary placeholder:text-text-secondary",
                  "focus:outline-hidden focus:border-border-strong"
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
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-text-secondary hover:text-text-primary"
                  aria-label="Clear search"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Sort and grouping are one block, and they read as a peer of the
              facets rather than a differently-styled preamble: same heading
              treatment, same chevron column, same disclosure. Collapsed by
              default with the current order in the header, so it answers its
              own question without spending a quarter of the panel on four
              radios the user set once. */}
          <FilterSection title="Sort by" summary={sortSummary} plainBody>
            <div role="radiogroup" aria-label="Sort worktrees by" className="flex flex-col">
              {sortOptions.map((option, index) => (
                <button
                  key={option.value}
                  type="button"
                  ref={(el) => {
                    sortRefs.current[index] = el;
                  }}
                  onClick={() => setOrderBy(option.value)}
                  onKeyDown={(event) => handleSortKeyDown(event, index)}
                  role="radio"
                  aria-checked={orderBy === option.value}
                  // One tab stop for the whole group, arrows move within it.
                  tabIndex={index === tabbableSortIndex ? 0 : -1}
                  className={cn(
                    "flex items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1 text-xs",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary",
                    orderBy === option.value
                      ? "bg-overlay-raised text-text-primary"
                      : "text-text-secondary hover:bg-overlay-medium"
                  )}
                >
                  <span
                    className={cn(
                      "flex h-3 w-3 shrink-0 items-center justify-center rounded-full border",
                      orderBy === option.value
                        ? "border-text-primary bg-text-primary"
                        : "border-border-strong"
                    )}
                  >
                    {orderBy === option.value && (
                      <span className="status-mark h-1.5 w-1.5 rounded-full bg-text-inverse" />
                    )}
                  </span>
                  {option.label}
                </button>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2 border-t border-border-default pt-2">
              <Checkbox
                id={groupByTypeId}
                size="sm"
                checked={groupByType}
                onCheckedChange={(checked) => setGroupByType(checked === true)}
              />
              <label htmlFor={groupByTypeId} className="cursor-pointer text-xs text-text-secondary">
                Group by type
              </label>
            </div>
          </FilterSection>

          <FilterSection
            title="Status"
            defaultOpen
            activeCount={statusFilters.size}
            onClear={clearStatusFilters}
          >
            <ChipGrid
              options={STATUS_OPTIONS}
              isActive={(value) => statusFilters.has(value)}
              onToggle={toggleStatusFilter}
              counts={chipCounts?.status}
            />
          </FilterSection>

          <FilterSection
            title="Branch type"
            defaultOpen
            activeCount={typeFilters.size}
            onClear={clearTypeFilters}
          >
            <ChipGrid
              options={TYPE_OPTIONS}
              isActive={(value) => typeFilters.has(value)}
              onToggle={toggleTypeFilter}
              counts={chipCounts?.branchType}
              overflowAfter={BRANCH_TYPE_OVERFLOW_AFTER}
            />
          </FilterSection>

          <FilterSection
            title="Issues & PRs"
            defaultOpen={prIssueFilters.size > 0}
            activeCount={prIssueFilters.size}
            onClear={clearPrIssueFilters}
          >
            <ChipGrid
              options={PR_ISSUE_OPTIONS}
              isActive={(value) => prIssueFilters.has(value)}
              onToggle={togglePrIssueFilter}
              counts={chipCounts?.prIssue}
            />
          </FilterSection>

          <FilterSection
            title="Sessions"
            defaultOpen={sessionFilters.size > 0}
            activeCount={sessionFilters.size}
            onClear={clearSessionFilters}
          >
            <ChipGrid
              options={SESSION_OPTIONS}
              isActive={(value) => sessionFilters.has(value)}
              onToggle={toggleSessionFilter}
              counts={chipCounts?.sessions}
            />
          </FilterSection>

          <FilterSection
            title="Activity"
            defaultOpen={activityFilters.size > 0}
            activeCount={activityFilters.size}
            onClear={clearActivityFilters}
          >
            <ChipGrid
              options={ACTIVITY_OPTIONS}
              isActive={(value) => activityFilters.has(value)}
              onToggle={toggleActivityFilter}
              counts={chipCounts?.activity}
            />
          </FilterSection>

          <FilterSection
            title="Dev server"
            defaultOpen={devServerFilters.size > 0}
            activeCount={devServerFilters.size}
            onClear={clearDevServerFilters}
          >
            <ChipGrid
              options={DEV_SERVER_OPTIONS}
              isActive={(value) => devServerFilters.has(value)}
              onToggle={toggleDevServerFilter}
              counts={chipCounts?.devServer}
            />
          </FilterSection>
        </div>

        {/* Clear All */}
        {hasAnyFilter && (
          <div className="shrink-0 border-t border-border-default p-3">
            <Button variant="subtle" size="xs" onClick={handleClearAll} className="w-full">
              Clear all filters
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
