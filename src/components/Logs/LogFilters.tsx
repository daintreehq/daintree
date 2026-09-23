import { useCallback, useEffect, useState, useRef } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { PRESSED_TOGGLE } from "@/components/Diagnostics/toggleStyles";
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

// The dot is a recognition aid beside the word, never the only signal.
const LOG_LEVELS: { level: LogLevel; label: string; dot: string }[] = [
  { level: "debug", label: "Debug", dot: "bg-text-secondary" },
  { level: "info", label: "Info", dot: "bg-status-info" },
  { level: "warn", label: "Warn", dot: "bg-status-warning" },
  { level: "error", label: "Error", dot: "bg-status-error" },
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
  // would resurrect the cleared search 200ms later. It reacts only to the
  // committed search going from set to empty — reacting to "empty while the
  // box has text" would also fire on every first keystroke, before the
  // debounce commits it, and erase what was typed.
  const committedSearchRef = useRef(filters.search);
  useEffect(() => {
    const previous = committedSearchRef.current;
    committedSearchRef.current = filters.search;
    if (previous && !filters.search) setSearchValue("");
  }, [filters.search]);

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

  const activeSourceCount = filters.sources?.length ?? 0;

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-divider px-3 py-1.5">
      <div className="relative min-w-[150px] max-w-[260px] flex-1">
        <input
          type="search"
          value={searchValue}
          onChange={(e) => setSearchValue(e.target.value)}
          placeholder="Search logs"
          aria-label="Search logs"
          className={cn(
            "h-6 w-full rounded-[var(--radius-md)] px-2 pr-7 text-xs",
            "border border-border-default bg-surface-canvas",
            "text-text-primary placeholder:text-text-placeholder",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary",
            "[&::-webkit-search-cancel-button]:hidden"
          )}
        />
        {searchValue && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setSearchValue("")}
            className="absolute right-0.5 top-1/2 h-5 w-5 -translate-y-1/2"
            aria-label="Clear search"
          >
            <X />
          </Button>
        )}
      </div>

      <div className="flex items-center gap-1" role="group" aria-label="Filter by level">
        {LOG_LEVELS.map(({ level, label, dot }) => {
          const isActive = filters.levels?.includes(level) ?? false;
          const count = levelCounts?.[level] ?? 0;
          return (
            <Button
              key={level}
              variant="subtle"
              size="xs"
              onClick={() => handleLevelToggle(level)}
              className={cn("gap-1.5", isActive && PRESSED_TOGGLE)}
              aria-pressed={isActive}
              aria-label={`${label}${count > 0 ? ` (${count})` : ""}`}
            >
              <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", dot)} />
              {label}
              {count > 0 && <span className="tabular-nums text-text-secondary">{count}</span>}
            </Button>
          );
        })}
      </div>

      {availableSources.length > 0 && (
        <div ref={sourcesRef} className="relative">
          <Button
            variant="subtle"
            size="xs"
            onClick={() => setIsSourcesOpen(!isSourcesOpen)}
            aria-expanded={isSourcesOpen}
            aria-haspopup="true"
            className={cn(activeSourceCount > 0 && PRESSED_TOGGLE)}
          >
            Sources{activeSourceCount > 0 ? ` (${activeSourceCount})` : ""}
            <ChevronDown />
          </Button>
          {isSourcesOpen && (
            <div
              className={cn(
                "absolute left-0 top-full z-50 mt-1 p-1",
                "rounded-[var(--radius-md)] border border-border-default bg-surface-panel-elevated shadow-[var(--theme-shadow-floating)]",
                "max-h-[200px] min-w-[180px] overflow-y-auto"
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
                      "w-full justify-start gap-1.5 font-mono focus-visible:-outline-offset-2",
                      isActive ? "text-text-primary" : "text-text-secondary"
                    )}
                    aria-pressed={isActive}
                  >
                    <Check aria-hidden="true" className={cn(!isActive && "invisible")} />
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
        <Button variant="ghost" size="xs" onClick={handleClearAll}>
          Clear filters
        </Button>
      )}
    </div>
  );
}
