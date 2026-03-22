import { useCallback, useEffect, useState, useRef } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { LogLevel, LogFilterOptions } from "@/types";

interface LogFiltersProps {
  filters: LogFilterOptions;
  onFiltersChange: (filters: Partial<LogFilterOptions>) => void;
  onClear: () => void;
  availableSources: string[];
}

const LOG_LEVELS: { level: LogLevel; label: string; color: string }[] = [
  { level: "debug", label: "Debug", color: "text-canopy-text/60 hover:bg-canopy-border" },
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
}: LogFiltersProps) {
  const [searchValue, setSearchValue] = useState(filters.search || "");
  const [isSourcesOpen, setIsSourcesOpen] = useState(false);
  const sourcesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchValue !== filters.search) {
        onFiltersChange({ search: searchValue || undefined });
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [searchValue, filters.search, onFiltersChange]);

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
    <div className="flex flex-wrap items-center gap-2 p-2 border-b border-canopy-border bg-canopy-sidebar/50">
      <div className="relative flex-1 min-w-[150px] max-w-[250px]">
        <input
          type="text"
          value={searchValue}
          onChange={(e) => setSearchValue(e.target.value)}
          placeholder="Search logs..."
          className={cn(
            "w-full px-2 py-1 text-xs rounded",
            "bg-canopy-bg border border-canopy-border",
            "text-canopy-text placeholder-canopy-text/40",
            "focus:outline-none focus:border-status-info"
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
            ×
          </Button>
        )}
      </div>

      <div className="flex items-center gap-1">
        <span className="text-canopy-text/60 text-xs mr-1">Level:</span>
        {LOG_LEVELS.map(({ level, label, color }) => {
          const isActive = filters.levels?.includes(level);
          return (
            <Button
              key={level}
              variant="subtle"
              size="xs"
              onClick={() => handleLevelToggle(level)}
              className={cn(isActive ? "bg-canopy-border font-medium" : "bg-canopy-bg/50", color)}
            >
              {label}
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
          >
            Sources {filters.sources?.length ? <span className="tabular-nums">({filters.sources.length})</span> : ""}
          </Button>
          {isSourcesOpen && (
            <div
              className={cn(
                "absolute left-0 top-full mt-1 z-50",
                "bg-canopy-bg border border-canopy-border rounded shadow-[var(--theme-shadow-floating)]",
                "min-w-[150px] max-h-[200px] overflow-y-auto"
              )}
            >
              {availableSources.map((source) => {
                const isActive = filters.sources?.includes(source);
                return (
                  <Button
                    key={source}
                    variant="ghost"
                    size="xs"
                    onClick={() => handleSourceToggle(source)}
                    className={cn(
                      "w-full justify-start rounded-none",
                      isActive ? "text-status-info bg-status-info/10" : "text-canopy-text"
                    )}
                  >
                    {isActive && "* "}
                    {source}
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
