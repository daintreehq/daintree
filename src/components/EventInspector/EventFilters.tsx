import { useState, useMemo, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { POPOVER_ROW_HOVER_CLASS } from "@/components/ui/popoverHeader";
import { SearchField, clearSearchBeforeDismiss } from "@/components/ui/SearchField";
import { FilterChip } from "@/components/ui/FilterChip";
import { Check, ListFilter } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { EventRecord, EventFilterOptions, EventCategory } from "@/store/eventStore";
import { EVENT_CATEGORY_STYLES } from "@/config/categoryColors";

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

type FilterSubset = Pick<EventFilterOptions, "types" | "categories" | "search" | "traceId">;

interface EventFiltersProps {
  events: EventRecord[];
  filters: FilterSubset;
  onFiltersChange: (filters: FilterSubset) => void;
  className?: string;
}

export function EventFilters({ events, filters, onFiltersChange, className }: EventFiltersProps) {
  const [searchInput, setSearchInput] = useState(filters.search || "");
  const [traceIdInput, setTraceIdInput] = useState(filters.traceId || "");
  const traceInputRef = useRef<HTMLInputElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);

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

  const { availableTypes, typeCounts } = useMemo(() => {
    const types = new Set<string>();
    const counts = new Map<string, number>();

    events.forEach((event) => {
      types.add(event.type);
      counts.set(event.type, (counts.get(event.type) || 0) + 1);
    });

    return {
      availableTypes: Array.from(types).sort(),
      typeCounts: counts,
    };
  }, [events]);

  const groupedTypes = useMemo(() => {
    const groups: Record<string, string[]> = {
      system: [],
      agent: [],
      devserver: [],
      watcher: [],
      file: [],
      ui: [],
      other: [],
    };

    availableTypes.forEach((type) => {
      if (type.startsWith("sys:")) groups.system!.push(type);
      else if (type.startsWith("agent:")) groups.agent!.push(type);
      else if (type.startsWith("server:")) groups.devserver!.push(type);
      else if (type.startsWith("watcher:")) groups.watcher!.push(type);
      else if (type.startsWith("file:")) groups.file!.push(type);
      else if (type.startsWith("ui:")) groups.ui!.push(type);
      else groups.other!.push(type);
    });

    Object.keys(groups).forEach((key) => {
      if (groups[key]!.length === 0) delete groups[key];
    });

    return groups;
  }, [availableTypes]);

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

  const clearTypeFilters = () => {
    onFiltersChange({ ...filters, types: undefined });
  };

  const moreFilterCount = (filters.types?.length || 0) + (filters.traceId ? 1 : 0);

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
        value={searchInput}
        onChange={(e) => handleSearchChange(e.target.value)}
        onClear={clearSearch}
        placeholder="Search events"
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
          className="flex max-h-[60vh] w-80 flex-col p-0"
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
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
            {Object.keys(groupedTypes).length === 0 ? (
              <EmptyState
                variant="zero-data"
                scale="popover"
                title="No events captured yet"
                className="py-6"
              />
            ) : null}
            {Object.entries(groupedTypes).map(([category, types]) => (
              <div key={category}>
                <div className="px-1 pb-0.5 text-2xs font-medium capitalize text-text-secondary">
                  {category}
                </div>
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
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
