import { useState, useMemo, useEffect, useRef, type MouseEvent, type RefObject } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { POPOVER_ROW_HOVER_CLASS } from "@/components/ui/popoverHeader";
import { SearchField, clearSearchBeforeDismiss } from "@/components/ui/SearchField";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { FilterChip } from "@/components/ui/FilterChip";
import { TailKeepingText } from "@/components/ui/TailKeepingText";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Check, ListFilter, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { EventRecord, EventFilterOptions, EventCategory } from "@/store/eventStore";
import { EVENT_CATEGORY_STYLES } from "@/config/categoryColors";
import { useTruncationDetection } from "@/hooks/useTruncationDetection";
import {
  activeContextFilters,
  formatContextValue,
  hasActiveEventFilters,
  type ContextFilterKey,
} from "./contextFilters";

// Dot per category as a recognition aid beside the label, from the same hue
// family as the timeline's category chips. Never the only signal.
const CATEGORY_DOT: Record<EventCategory, string> = {
  system: "bg-cat-blue",
  agent: "bg-cat-green",
  server: "bg-cat-orange",
  file: "bg-cat-pink",
  ui: "bg-cat-indigo",
  watcher: "bg-cat-cyan",
  artifact: "bg-cat-rose",
};

const ALL_CATEGORIES: EventCategory[] = [
  "system",
  "agent",
  "server",
  "file",
  "ui",
  "watcher",
  "artifact",
];

interface EventFiltersProps {
  events: EventRecord[];
  filters: EventFilterOptions;
  onFiltersChange: (filters: EventFilterOptions) => void;
  /** Clears every filter. The bar drops its own drafts and keeps focus first. */
  onClear: () => void;
  /** Changes whenever filters are cleared from anywhere, so pending drafts are dropped too. */
  resetSignal?: number;
  /** The search field, so a clear from outside the bar can hand focus to it. */
  searchInputRef?: RefObject<HTMLInputElement | null>;
  className?: string;
}

/** A worktree id is its path; the folder name is the part that tells two apart. */
function worktreeName(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1) || value;
}

/** Pointer clicks hand focus over without a ring; keyboard activation keeps it. */
function focusAfter(event: MouseEvent, target: HTMLElement | null | undefined) {
  target?.focus({ preventScroll: true, focusVisible: event.detail === 0 });
}

interface AppliedContextTokenProps {
  filterKey: ContextFilterKey;
  label: string;
  noun: string;
  value: string | number;
  onClear: (event: MouseEvent<HTMLButtonElement>, key: ContextFilterKey) => void;
}

/**
 * A value set from an event's Context, shown in the bar as the selected chip
 * it is in Context; pressing it clears that one value. A worktree shows its
 * folder name, and the full id is disclosed whenever the label doesn't carry it.
 */
function AppliedContextToken({ filterKey, label, noun, value, onClear }: AppliedContextTokenProps) {
  const full = formatContextValue(filterKey, value);
  const display = filterKey === "worktreeId" ? worktreeName(full) : full;
  const { ref: headRef, isTruncated } = useTruncationDetection();
  const showFull = display !== full || isTruncated;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <FilterChip
          selected
          data-applied-filter=""
          aria-label={`${label}: ${display}`}
          aria-description={display !== full ? full : undefined}
          onClick={(event) => onClear(event, filterKey)}
          className="max-w-72"
        >
          <span className="shrink-0 font-normal">{label}:</span>
          <TailKeepingText text={display} headRef={headRef} />
          <X aria-hidden="true" className="h-3 w-3 shrink-0" />
        </FilterChip>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {showFull ? <div className="font-mono break-all">{full}</div> : null}
        <div className={showFull ? "text-text-secondary" : undefined}>Clear {noun} filter</div>
      </TooltipContent>
    </Tooltip>
  );
}

export function EventFilters({
  events,
  filters,
  onFiltersChange,
  onClear,
  resetSignal,
  searchInputRef,
  className,
}: EventFiltersProps) {
  const [searchInput, setSearchInput] = useState(filters.search || "");
  const [traceIdInput, setTraceIdInput] = useState(filters.traceId || "");
  const traceInputRef = useRef<HTMLInputElement>(null);
  const ownSearchRef = useRef<HTMLInputElement>(null);
  const searchRef = searchInputRef ?? ownSearchRef;
  const [moreOpen, setMoreOpen] = useState(false);

  // A clear from outside the bar (the filtered-empty state's Clear filters)
  // empties the store but can't reach these drafts; without this a draft
  // typed just before the clear would commit itself after the debounce.
  const lastResetRef = useRef(resetSignal);
  useEffect(() => {
    if (lastResetRef.current === resetSignal) return;
    lastResetRef.current = resetSignal;
    setSearchInput("");
    setTraceIdInput("");
  }, [resetSignal]);

  useEffect(() => {
    setSearchInput(filters.search || "");
  }, [filters.search]);

  useEffect(() => {
    setTraceIdInput(filters.traceId || "");
  }, [filters.traceId]);

  useEffect(() => {
    const next = searchInput || undefined;
    if (next === filters.search) return;
    const timer = setTimeout(() => {
      onFiltersChange({ ...filters, search: next });
    }, 200);
    return () => clearTimeout(timer);
  }, [searchInput, filters, onFiltersChange]);

  useEffect(() => {
    const next = traceIdInput.trim().toLowerCase() || undefined;
    if (next === filters.traceId) return;
    const timer = setTimeout(() => {
      onFiltersChange({ ...filters, traceId: next });
    }, 200);
    return () => clearTimeout(timer);
  }, [traceIdInput, filters, onFiltersChange]);

  const categoryCounts = useMemo(() => {
    const counts = new Map<EventCategory, number>();
    events.forEach((event) => {
      if (event.category) {
        counts.set(event.category, (counts.get(event.category) || 0) + 1);
      }
    });
    return counts;
  }, [events]);

  // Grouped by the same categories, labels and order as the chips. A selected
  // type stays listed after its events are cleared, so it can still be unticked.
  const { groupedTypes, typeCounts } = useMemo(() => {
    const counts = new Map<string, number>();
    const categoryOf = new Map<string, EventCategory>();
    events.forEach((event) => {
      counts.set(event.type, (counts.get(event.type) || 0) + 1);
      if (event.category) categoryOf.set(event.type, event.category);
    });
    filters.types?.forEach((type) => {
      if (!counts.has(type)) counts.set(type, 0);
    });

    const byCategory = new Map<EventCategory | "other", string[]>();
    Array.from(counts.keys())
      .sort()
      .forEach((type) => {
        const category = categoryOf.get(type) ?? "other";
        byCategory.set(category, [...(byCategory.get(category) ?? []), type]);
      });

    const groups: Array<{ label: string; types: string[] }> = [];
    for (const category of ALL_CATEGORIES) {
      const types = byCategory.get(category);
      if (types) groups.push({ label: EVENT_CATEGORY_STYLES[category].label, types });
    }
    const other = byCategory.get("other");
    if (other) groups.push({ label: "Other", types: other });
    return { groupedTypes: groups, typeCounts: counts };
  }, [events, filters.types]);

  const handleSearchChange = (value: string) => {
    setSearchInput(value);
  };

  const clearSearch = () => {
    setSearchInput("");
  };

  const handleTraceIdChange = (value: string) => {
    setTraceIdInput(value);
  };

  const clearTraceId = () => {
    setTraceIdInput("");
  };

  const toggleCategoryFilter = (category: EventCategory) => {
    const currentCategories = filters.categories || [];
    const newCategories = currentCategories.includes(category)
      ? currentCategories.filter((c) => c !== category)
      : [...currentCategories, category];
    onFiltersChange({
      ...filters,
      categories: newCategories.length > 0 ? newCategories : undefined,
    });
  };

  const toggleTypeFilter = (type: string) => {
    const currentTypes = filters.types || [];
    const newTypes = currentTypes.includes(type)
      ? currentTypes.filter((t) => t !== type)
      : [...currentTypes, type];
    onFiltersChange({ ...filters, types: newTypes.length > 0 ? newTypes : undefined });
  };

  // The button unmounts with the selection it clears; the trace field above
  // it is the nearest control that stays.
  const clearTypeFilters = (event: MouseEvent<HTMLButtonElement>) => {
    if (document.activeElement === event.currentTarget) focusAfter(event, traceInputRef.current);
    onFiltersChange({ ...filters, types: undefined });
  };

  // The token unmounts with its filter, so focus moves on first: to the next
  // token, else the previous one, else the search field.
  const clearContextFilter = (event: MouseEvent<HTMLButtonElement>, key: ContextFilterKey) => {
    const token = event.currentTarget;
    if (document.activeElement === token) {
      const tokens = Array.from(
        token.parentElement?.querySelectorAll<HTMLElement>("[data-applied-filter]") ?? []
      );
      const index = tokens.indexOf(token);
      focusAfter(event, tokens[index + 1] ?? tokens[index - 1] ?? searchRef.current);
    }
    onFiltersChange({ ...filters, [key]: undefined });
  };

  // "Clear filters" unmounts once nothing is left to clear, so focus lands in
  // the search field rather than falling to the body.
  const handleClearAll = (event: MouseEvent<HTMLButtonElement>) => {
    setSearchInput("");
    setTraceIdInput("");
    focusAfter(event, searchRef.current);
    onClear();
  };

  const moreFilterCount = (filters.types?.length || 0) + (filters.traceId ? 1 : 0);
  const appliedContext = activeContextFilters(filters);
  const showClearAll = hasActiveEventFilters(filters);

  return (
    <div
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-2 border-b border-divider px-3 py-1.5",
        className
      )}
    >
      <SearchField
        size="dense"
        fieldClassName="min-w-[150px] max-w-[260px] flex-1"
        type="search"
        inputRef={searchRef}
        value={searchInput}
        onChange={(e) => handleSearchChange(e.target.value)}
        onClear={clearSearch}
        placeholder="Search events…"
        aria-label="Search events"
      />

      <div
        className="flex flex-wrap items-center gap-1"
        role="group"
        aria-label="Filter by category"
      >
        {ALL_CATEGORIES.map((category) => {
          const isActive = filters.categories?.includes(category) || false;
          const count = categoryCounts.get(category) || 0;
          const config = EVENT_CATEGORY_STYLES[category];
          return (
            <FilterChip
              key={category}
              selected={isActive}
              count={count}
              onClick={() => toggleCategoryFilter(category)}
            >
              <span
                aria-hidden="true"
                className={cn("h-1.5 w-1.5 rounded-full", CATEGORY_DOT[category])}
              />
              {config.label}
            </FilterChip>
          );
        })}
      </div>

      <Popover open={moreOpen} onOpenChange={setMoreOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="subtle"
            size="xs"
            // Opens a popover, so it is not a toggle and never looks pressed.
            // Primary ink and the count say more filters are narrowing the
            // list, as on the other filter triggers.
            className={cn(moreFilterCount > 0 && "text-text-primary")}
            aria-label={
              moreFilterCount > 0 ? `More filters, ${moreFilterCount} active` : "More filters"
            }
          >
            <ListFilter />
            Filters
            {moreFilterCount > 0 ? <span className="tabular-nums">{moreFilterCount}</span> : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          // Bounded by the room Radix measured as well, or a tall list opening
          // upward from the dock runs its header off the top of the window.
          className="flex max-h-[min(60vh,var(--radix-popover-content-available-height))] w-80 flex-col p-0"
          onEscapeKeyDown={(e) => clearSearchBeforeDismiss(e, traceInputRef.current, clearTraceId)}
        >
          <div className="shrink-0 space-y-1 border-b border-divider p-3">
            <label
              htmlFor="event-trace-filter"
              className="block text-xs font-medium text-text-primary"
            >
              Trace ID
            </label>
            <p className="text-2xs text-text-secondary">Shows every event from one operation</p>
            <SearchField
              size="compact"
              id="event-trace-filter"
              inputRef={traceInputRef}
              value={traceIdInput}
              onChange={(e) => handleTraceIdChange(e.target.value)}
              onClear={clearTraceId}
              clearLabel="Clear trace ID filter"
              placeholder="Filter by trace ID…"
              className="font-mono placeholder:font-sans"
            />
          </div>
          <div className="flex shrink-0 items-center justify-between px-3 pb-1 pt-2">
            <span className="text-xs font-medium text-text-primary">Event types</span>
            {filters.types && filters.types.length > 0 && (
              <Button variant="ghost" size="xs" onClick={clearTypeFilters}>
                Clear types
              </Button>
            )}
          </div>
          {/* A short list of short rows that routinely runs past the bottom: the
              compact fade says it continues without washing out a live row. */}
          <ScrollShadow compact className="flex-1" scrollClassName="space-y-2 px-2 pb-2">
            {groupedTypes.length === 0 ? (
              <EmptyState
                variant="zero-data"
                scale="popover"
                title="No events captured yet"
                className="py-6"
              />
            ) : null}
            {groupedTypes.map(({ label, types }) => (
              <div key={label}>
                <div className="px-1 pb-0.5 text-2xs font-medium text-text-secondary">{label}</div>
                {types.map((type) => {
                  const isChecked = filters.types?.includes(type) || false;
                  return (
                    <Button
                      key={type}
                      variant="ghost"
                      size="xs"
                      aria-pressed={isChecked}
                      onClick={() => toggleTypeFilter(type)}
                      className={cn(
                        "w-full justify-start gap-1.5 font-mono text-text-primary focus-visible:-outline-offset-2",
                        POPOVER_ROW_HOVER_CLASS
                      )}
                    >
                      <Check aria-hidden="true" className={cn(!isChecked && "invisible")} />
                      <span className="min-w-0 flex-1 truncate text-left">{type}</span>
                      <span className="tabular-nums text-text-secondary">
                        {typeCounts.get(type) || 0}
                      </span>
                    </Button>
                  );
                })}
              </div>
            ))}
          </ScrollShadow>
        </PopoverContent>
      </Popover>

      {/* Values set from an event's Context have no control of their own up
          here, so each one is shown and cleared from the bar. */}
      {appliedContext.length > 0 ? (
        <div
          className="flex min-w-0 flex-wrap items-center gap-1"
          role="group"
          aria-label="Context filters"
        >
          {appliedContext.map(({ key, label, noun, value }) => (
            <AppliedContextToken
              key={key}
              filterKey={key}
              label={label}
              noun={noun}
              value={value}
              onClear={clearContextFilter}
            />
          ))}
        </div>
      ) : null}

      {showClearAll ? (
        <Button variant="ghost" size="xs" onClick={handleClearAll}>
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}
