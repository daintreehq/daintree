import { useCallback, useEffect, useState, useRef } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useEscapeStack } from "@/hooks/useEscapeStack";
import type { LogLevel, LogFilterOptions } from "@/types";

interface LogFiltersProps {
  filters: LogFilterOptions;
  onFiltersChange: (filters: Partial<LogFilterOptions>) => void;
  onClear: () => void;
  availableSources: string[];
  levelCounts?: Partial<Record<LogLevel, number>>;
  sourceCounts?: Partial<Record<string, number>>;
}

const LOG_LEVELS: { level: LogLevel; label: string; color: string }[] = [
  { level: "debug", label: "Debug", color: "text-daintree-text/60 hover:bg-border-default" },
  { level: "info", label: "Info", color: "text-status-info hover:bg-status-info/15" },
  {
    level: "warn",
    label: "Warn",
    color: "text-status-warning hover:bg-status-warning/15",
  },
  { level: "error", label: "Error", color: "text-status-error hover:bg-status-error/15" },
];

export function LogFilters({
  filters,
  onFiltersChange,
  onClear,
  availableSources,
  levelCounts,
  sourceCounts,
}: LogFiltersProps) {
  const [searchValue, setSearchValue] = useState(filters.search || "");
  const [isSourcesOpen, setIsSourcesOpen] = useState(false);
  const sourcesRef = useRef<HTMLDivElement>(null);

  useEscapeStack(isSourcesOpen, () => setIsSourcesOpen(false));

  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchValue !== filters.search) {
        onFiltersChange({ search: searchValue || undefined });
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [searchValue, filters.search, onFiltersChange]);

  // External resets (e.g. clearFilters) zero filters.search but cannot reach
  // this component's local searchValue. Without this sync the debounce above
  // would resurrect the cleared search 200ms later.
  useEffect(() => {
    if (!filters.search && searchValue) {
      setSearchValue("");
    }
  }, [filters.search, searchValue]);

  const handleLevelToggle = useCallback(
    (level: LogLevel) => {
      const currentLevels = filters.levels || [];
      const newLevels = currentLevels.includes(level)
        ? currentLevels.filter((l) => l !== level)
        : [...currentLevels, level];
      onFiltersChange({ levels: newLevels.length > 0 ? newLevels : undefined });
    },
    [filters.levels, onFiltersChange]
  );

  const handleSourceToggle = useCallback(
    (source: string) => {
      const currentSources = filters.sources || [];
      const newSources = currentSources.includes(source)
        ? currentSources.filter((s) => s !== source)
        : [...currentSources, source];
      onFiltersChange({ sources: newSources.length > 0 ? newSources : undefined });
    },
    [filters.sources, onFiltersChange]
  );

  const handleClearAll = useCallback(() => {
    setSearchValue("");
    onClear();
  }, [onClear]);

  useEffect(() => {
    if (!isSourcesOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (sourcesRef.current && !sourcesRef.current.contains(event.target as Node)) {
        setIsSourcesOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isSourcesOpen]);

  const hasActiveFilters =
    (filters.levels && filters.levels.length > 0) ||
    (filters.sources && filters.sources.length > 0) ||
    filters.search;

  return (
    <div className="flex flex-wrap items-center gap-2 p-2 border-b border-border-default bg-daintree-sidebar/50">
      <div className="relative flex-1 min-w-[150px] max-w-[250px]">
        <input
          type="search"
          value={searchValue}
          onChange={(e) => setSearchValue(e.target.value)}
          placeholder="Search logs..."
          className={cn(
            "w-full px-2 py-1 text-xs rounded",
            "bg-surface-canvas border border-border-default",
            "text-text-primary placeholder-daintree-text/40",
            "focus:outline-hidden focus:border-status-info",
            "[&::-webkit-search-cancel-button]:hidden"
          )}
        />
        {searchValue && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setSearchValue("")}
            className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6"
            aria-label="Clear search"
          >
            <X className="w-3 h-3" />
          </Button>
        )}
      </div>

      <div className="flex items-center gap-1">
        <span className="text-daintree-text/60 text-xs mr-1">Level:</span>
        {LOG_LEVELS.map(({ level, label, color }) => {
          const isActive = filters.levels?.includes(level) ?? false;
          const count = levelCounts?.[level] ?? 0;
          return (
            <Button
              key={level}
              variant="subtle"
              size="xs"
              onClick={() => handleLevelToggle(level)}
              className={cn(isActive ? "bg-border-default font-medium" : "bg-daintree-bg/50", color)}
              aria-pressed={isActive}
              aria-label={`${label}${count > 0 ? ` (${count})` : ""}`}
            >
              {label}
              {count > 0 && <span className="ml-1 tabular-nums opacity-70">{count}</span>}
            </Button>
          );
        })}
      </div>

      {availableSources.length > 0 && (
        <div ref={sourcesRef} className="relative">
          <Button
            variant="outline"
            size="xs"
            onClick={() => setIsSourcesOpen(!isSourcesOpen)}
            aria-expanded={isSourcesOpen}
            aria-haspopup="true"
          >
            Sources {filters.sources?.length ? <span className="tabular-nums">({filters.sources.length})</span> : ""}
          </Button>
          {isSourcesOpen && (
            <div
              className={cn(
                "absolute left-0 top-full mt-1 z-50",
                "bg-surface-canvas border border-border-default rounded shadow-[var(--theme-shadow-floating)]",
                "min-w-[150px] max-h-[200px] overflow-y-auto"
              )}
            >
              {availableSources.map((source) => {
                const isActive = filters.sources?.includes(source) ?? false;
                const count = sourceCounts?.[source] ?? 0;
                return (
                  <Button
                    key={source}
                    variant="ghost"
                    size="xs"
                    onClick={() => handleSourceToggle(source)}
                    className={cn(
                      "w-full justify-start rounded-none",
                      isActive ? "text-status-info bg-status-info/10" : "text-text-primary",
                      count === 0 && !isActive && "opacity-50"
                    )}
                    aria-pressed={isActive}
                  >
                    {isActive && "* "}
                    {source}
                    <span className="ml-auto tabular-nums opacity-70">{count}</span>
                  </Button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {hasActiveFilters && (
        <Button variant="subtle" size="xs" onClick={handleClearAll}>
          Clear
        </Button>
      )}
    </div>
  );
}
