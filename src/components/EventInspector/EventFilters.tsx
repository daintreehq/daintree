import { useState, useMemo, useEffect } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Search, X, Filter, Tag } from "lucide-react";
import type { EventRecord, EventFilterOptions, EventCategory } from "@/store/eventStore";

const ALL_CATEGORIES: EventCategory[] = [
  "system",
  "agent",
  "task",
  "server",
  "file",
  "ui",
  "watcher",
  "artifact",
];

const CATEGORY_CONFIG: Record<EventCategory, { label: string; color: string }> = {
  system: { label: "System", color: "bg-blue-500/20 text-blue-400 border-blue-500/30" },
  agent: { label: "Agent", color: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" },
  task: { label: "Task", color: "bg-green-500/20 text-green-400 border-green-500/30" },
  server: { label: "Server", color: "bg-orange-500/20 text-orange-400 border-orange-500/30" },
  file: { label: "File", color: "bg-pink-500/20 text-pink-400 border-pink-500/30" },
  ui: { label: "UI", color: "bg-indigo-500/20 text-indigo-400 border-indigo-500/30" },
  watcher: { label: "Watcher", color: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30" },
  artifact: { label: "Artifact", color: "bg-rose-500/20 text-rose-400 border-rose-500/30" },
};

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
  const [showTypeFilters, setShowTypeFilters] = useState(false);

  useEffect(() => {
    setSearchInput(filters.search || "");
  }, [filters.search]);

  useEffect(() => {
    setTraceIdInput(filters.traceId || "");
  }, [filters.traceId]);

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
      task: [],
      devserver: [],
      watcher: [],
      file: [],
      ui: [],
      other: [],
    };

    availableTypes.forEach((type) => {
      if (type.startsWith("sys:")) groups.system.push(type);
      else if (type.startsWith("agent:")) groups.agent.push(type);
      else if (type.startsWith("task:")) groups.task.push(type);
      else if (type.startsWith("server:")) groups.devserver.push(type);
      else if (type.startsWith("watcher:")) groups.watcher.push(type);
      else if (type.startsWith("file:")) groups.file.push(type);
      else if (type.startsWith("ui:")) groups.ui.push(type);
      else groups.other.push(type);
    });

    Object.keys(groups).forEach((key) => {
      if (groups[key].length === 0) delete groups[key];
    });

    return groups;
  }, [availableTypes]);

  const handleSearchChange = (value: string) => {
    setSearchInput(value);
    onFiltersChange({ ...filters, search: value || undefined });
  };

  const clearSearch = () => {
    setSearchInput("");
    onFiltersChange({ ...filters, search: undefined });
  };

  const handleTraceIdChange = (value: string) => {
    setTraceIdInput(value);
    // Normalize: trim whitespace and lowercase for more forgiving matching
    const normalized = value.trim().toLowerCase();
    onFiltersChange({ ...filters, traceId: normalized || undefined });
  };

  const clearTraceId = () => {
    setTraceIdInput("");
    onFiltersChange({ ...filters, traceId: undefined });
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

  const clearCategoryFilters = () => {
    onFiltersChange({ ...filters, categories: undefined });
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

  const activeFilterCount =
    (filters.categories?.length || 0) +
    (filters.types?.length || 0) +
    (filters.search ? 1 : 0) +
    (filters.traceId ? 1 : 0);

  return (
    <div className={cn("flex-shrink-0 border-b bg-background", className)}>
      <div className="p-3 space-y-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search events..."
            className={cn(
              "w-full pl-9 pr-9 py-2 text-sm rounded-[var(--radius-md)]",
              "bg-muted/50 border border-transparent",
              "focus:bg-background focus:border-primary focus:outline-none",
              "placeholder:text-muted-foreground"
            )}
          />
          {searchInput && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={clearSearch}
              className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6"
            >
              <X className="w-4 h-4" />
            </Button>
          )}
        </div>

        <div className="space-y-1">
          <label className="text-xs text-muted-foreground px-1">
            Trace ID (correlates related events)
          </label>
          <div className="relative">
            <input
              type="text"
              value={traceIdInput}
              onChange={(e) => handleTraceIdChange(e.target.value)}
              placeholder="Filter by trace ID..."
              className={cn(
                "w-full pl-3 pr-9 py-2 text-sm rounded-[var(--radius-md)] font-mono",
                "bg-muted/50 border border-transparent",
                "focus:bg-background focus:border-primary focus:outline-none",
                "placeholder:text-muted-foreground placeholder:font-sans"
              )}
            />
            {traceIdInput && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={clearTraceId}
                className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6"
              >
                <X className="w-4 h-4" />
              </Button>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
              <Tag className="w-3 h-3" />
              <span>Categories</span>
            </div>
            {filters.categories && filters.categories.length > 0 && (
              <Button
                variant="ghost"
                size="xs"
                onClick={clearCategoryFilters}
                className="h-auto p-0"
              >
                Clear
              </Button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {ALL_CATEGORIES.map((category) => {
              const isActive = filters.categories?.includes(category) || false;
              const count = categoryCounts.get(category) || 0;
              const config = CATEGORY_CONFIG[category];

              return (
                <Button
                  key={category}
                  variant="outline"
                  size="xs"
                  onClick={() => toggleCategoryFilter(category)}
                  className={cn(
                    isActive
                      ? config.color
                      : "bg-muted/30 text-muted-foreground border-transparent hover:bg-muted/50"
                  )}
                >
                  <span>{config.label}</span>
                  {count > 0 && (
                    <span className={cn("text-[10px]", isActive ? "opacity-80" : "opacity-60")}>
                      {count}
                    </span>
                  )}
                </Button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowTypeFilters(!showTypeFilters)}
            className={cn(showTypeFilters && "bg-muted")}
          >
            <Filter className="w-3.5 h-3.5" />
            <span>Event Types</span>
            {activeFilterCount > 0 && (
              <span className="px-1.5 py-0.5 text-xs bg-primary text-primary-foreground rounded">
                {activeFilterCount}
              </span>
            )}
          </Button>
          {filters.types && filters.types.length > 0 && (
            <Button variant="ghost" size="xs" onClick={clearTypeFilters} className="h-auto p-0">
              Clear filters
            </Button>
          )}
        </div>
      </div>

      {showTypeFilters && (
        <div className="px-3 pb-3 space-y-3 max-h-64 overflow-y-auto">
          {Object.entries(groupedTypes).map(([category, types]) => (
            <div key={category} className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                {category}
              </div>
              <div className="space-y-0.5">
                {types.map((type) => {
                  const isChecked = filters.types?.includes(type) || false;
                  return (
                    <label
                      key={type}
                      className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/50 cursor-pointer group"
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleTypeFilter(type)}
                        className="w-3.5 h-3.5 rounded border-muted-foreground/50"
                      />
                      <span className="text-sm font-mono truncate flex-1">{type}</span>
                      <span className="text-xs text-muted-foreground opacity-0 group-hover:opacity-100">
                        {typeCounts.get(type) || 0}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
