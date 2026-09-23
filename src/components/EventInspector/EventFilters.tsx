import { useState, useMemo, useEffect } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { PRESSED_TOGGLE } from "@/components/Diagnostics/toggleStyles";
import { Check, ListFilter, Search, X } from "lucide-react";
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
      <div className="relative min-w-[150px] max-w-[260px] flex-1">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-text-secondary"
        />
        <input
          type="search"
          value={searchInput}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder="Search events"
          aria-label="Search events"
          className={cn(
            "h-6 w-full rounded-[var(--radius-md)] pl-6 pr-7 text-xs",
            "border border-border-default bg-surface-canvas text-text-primary",
            "placeholder:text-text-placeholder",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary",
            "[&::-webkit-search-cancel-button]:hidden"
          )}
        />
        {searchInput && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={clearSearch}
            className="absolute right-0.5 top-1/2 h-5 w-5 -translate-y-1/2"
            aria-label="Clear search"
          >
            <X />
          </Button>
        )}
      </div>

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
            <Button
              key={category}
              variant="subtle"
              size="xs"
              onClick={() => toggleCategoryFilter(category)}
              className={cn("gap-1.5", isActive && PRESSED_TOGGLE)}
              aria-pressed={isActive}
            >
              <span
                aria-hidden="true"
                className={cn("h-1.5 w-1.5 rounded-full", CATEGORY_DOT[category])}
              />
              <span>{config.label}</span>
              <span className="tabular-nums text-text-secondary">{count}</span>
            </Button>
          );
        })}
      </div>

      <Popover open={moreOpen} onOpenChange={setMoreOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="subtle"
            size="xs"
            className={cn(moreFilterCount > 0 && PRESSED_TOGGLE)}
            aria-label={
              moreFilterCount > 0 ? `More filters, ${moreFilterCount} active` : "More filters"
            }
          >
            <ListFilter />
            Filters
            {moreFilterCount > 0 ? <span className="tabular-nums">{moreFilterCount}</span> : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={6} className="flex max-h-[60vh] w-80 flex-col p-0">
          <div className="shrink-0 space-y-1 border-b border-divider p-3">
            <label
              htmlFor="event-trace-filter"
              className="block text-xs font-medium text-text-primary"
            >
              Trace ID
            </label>
            <p className="text-2xs text-text-secondary">Shows every event from one operation</p>
            <div className="relative">
              <input
                id="event-trace-filter"
                type="text"
                value={traceIdInput}
                onChange={(e) => handleTraceIdChange(e.target.value)}
                placeholder="Filter by trace ID..."
                className={cn(
                  "h-7 w-full rounded-[var(--radius-md)] pl-2 pr-7 font-mono text-xs",
                  "border border-border-default bg-surface-canvas text-text-primary",
                  "placeholder:font-sans placeholder:text-text-placeholder",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
                )}
              />
              {traceIdInput && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={clearTraceId}
                  className="absolute right-0.5 top-1/2 h-5 w-5 -translate-y-1/2"
                  aria-label="Clear trace ID filter"
                >
                  <X />
                </Button>
              )}
            </div>
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
              <p className="px-1 pb-1 text-xs text-text-secondary">No events captured yet</p>
            ) : null}
            {Object.entries(groupedTypes).map(([category, types]) => (
              <div key={category}>
                <div className="px-1 pb-0.5 text-2xs font-medium capitalize text-text-secondary">
                  {category}
                </div>
                {types.map((type) => {
                  const isChecked = filters.types?.includes(type) || false;
                  return (
                    <button
                      key={type}
                      type="button"
                      aria-pressed={isChecked}
                      onClick={() => toggleTypeFilter(type)}
                      className="flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-1 py-1 text-left hover:bg-overlay-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
                    >
                      <Check
                        aria-hidden="true"
                        className={cn(
                          "h-3 w-3 shrink-0 text-text-primary",
                          !isChecked && "invisible"
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-primary">
                        {type}
                      </span>
                      <span className="text-2xs tabular-nums text-text-secondary">
                        {typeCounts.get(type) || 0}
                      </span>
                    </button>
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
