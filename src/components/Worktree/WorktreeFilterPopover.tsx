import { useCallback, useEffect, useState, useRef } from "react";
import { Filter, X, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  useWorktreeFilterStore,
  type OrderBy,
  type StatusFilter,
  type TypeFilter,
  type GitHubFilter,
  type SessionFilter,
  type ActivityFilter,
} from "@/store/worktreeFilterStore";

interface FilterSectionProps {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

function FilterSection({ title, children, defaultOpen = false }: FilterSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const contentId = `filter-section-${title.toLowerCase().replace(/\s+/g, "-")}`;

  return (
    <div className="border-b border-canopy-border last:border-b-0">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-controls={contentId}
        className="flex items-center justify-between w-full px-3 py-2 text-xs font-medium text-canopy-text/70 hover:bg-white/[0.03]"
      >
        {title}
        <ChevronDown
          className={cn("w-3.5 h-3.5 transition-transform", isOpen ? "transform rotate-180" : "")}
        />
      </button>
      {isOpen && (
        <div id={contentId} className="px-3 pb-3 pt-1">
          {children}
        </div>
      )}
    </div>
  );
}

interface FilterChipProps {
  label: string;
  isActive: boolean;
  onClick: () => void;
}

function FilterChip({ label, isActive, onClick }: FilterChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={isActive}
      className={cn(
        "inline-flex items-center px-2 py-0.5 text-[11px] rounded-full border transition-colors",
        isActive
          ? "bg-canopy-accent/20 border-canopy-accent/40 text-canopy-accent"
          : "bg-canopy-bg border-canopy-border text-canopy-text/60 hover:bg-white/[0.04] hover:text-canopy-text/80"
      )}
    >
      {label}
    </button>
  );
}

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "dirty", label: "Dirty" },
  { value: "error", label: "Error" },
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

const GITHUB_OPTIONS: { value: GitHubFilter; label: string }[] = [
  { value: "hasIssue", label: "Has Issue" },
  { value: "hasPR", label: "Has PR" },
  { value: "prOpen", label: "PR Open" },
  { value: "prMerged", label: "PR Merged" },
  { value: "prClosed", label: "PR Closed" },
];

const SESSION_OPTIONS: { value: SessionFilter; label: string }[] = [
  { value: "hasTerminals", label: "Has Terminals" },
  { value: "working", label: "Working" },
  { value: "running", label: "Running" },
  { value: "waiting", label: "Waiting" },
  { value: "failed", label: "Failed" },
  { value: "completed", label: "Completed" },
];

const ACTIVITY_OPTIONS: { value: ActivityFilter; label: string }[] = [
  { value: "last15m", label: "15m" },
  { value: "last1h", label: "1h" },
  { value: "last24h", label: "24h" },
  { value: "last7d", label: "7d" },
];

const ORDER_OPTIONS: { value: OrderBy; label: string }[] = [
  { value: "created", label: "Date created" },
  { value: "recent", label: "Recently updated" },
  { value: "alpha", label: "Alphabetical" },
];

export function WorktreeFilterPopover() {
  const [isOpen, setIsOpen] = useState(false);
  const [localQuery, setLocalQuery] = useState("");
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  const {
    query,
    orderBy,
    groupByType,
    statusFilters,
    typeFilters,
    githubFilters,
    sessionFilters,
    activityFilters,
    setQuery,
    setOrderBy,
    setGroupByType,
    toggleStatusFilter,
    toggleTypeFilter,
    toggleGitHubFilter,
    toggleSessionFilter,
    toggleActivityFilter,
    clearAll,
    getActiveFilterCount,
    hasActiveFilters,
  } = useWorktreeFilterStore();

  const filterCount = getActiveFilterCount();
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
    setLocalQuery("");
    clearAll();
  }, [clearAll]);

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "relative flex items-center justify-center w-7 h-7 rounded",
            "text-canopy-text/60 hover:text-canopy-text hover:bg-white/[0.06]",
            "transition-colors",
            hasActiveFilters() && "text-canopy-accent"
          )}
          aria-label="Filter and sort worktrees"
        >
          <Filter className="w-3.5 h-3.5" />
          {showBadge && (
            <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center min-w-[14px] h-[14px] px-1 text-[9px] font-medium bg-canopy-accent text-white rounded-full">
              {filterCount}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        className="w-72 p-0 max-h-[70vh] overflow-y-auto"
      >
        <div className="flex flex-col">
          {/* Search */}
          <div className="p-3 border-b border-canopy-border">
            <div className="relative">
              <input
                type="text"
                value={localQuery}
                onChange={(e) => handleQueryChange(e.target.value)}
                placeholder="Search worktrees..."
                aria-label="Search worktrees"
                className={cn(
                  "w-full px-2.5 py-1.5 text-xs rounded",
                  "bg-canopy-bg border border-canopy-border",
                  "text-canopy-text placeholder-canopy-text/40",
                  "focus:outline-none focus:border-canopy-accent/50"
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
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-canopy-text/40 hover:text-canopy-text"
                  aria-label="Clear search"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>

          {/* Sort Order */}
          <div className="p-3 border-b border-canopy-border">
            <div className="text-[10px] font-medium text-canopy-text/50 uppercase tracking-wide mb-2">
              Sort by
            </div>
            <div className="flex flex-col gap-1">
              {ORDER_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setOrderBy(option.value)}
                  role="radio"
                  aria-checked={orderBy === option.value}
                  className={cn(
                    "flex items-center gap-2 px-2 py-1 text-xs rounded",
                    orderBy === option.value
                      ? "bg-canopy-accent/10 text-canopy-accent"
                      : "text-canopy-text/70 hover:bg-white/[0.04]"
                  )}
                >
                  <div
                    className={cn(
                      "w-3 h-3 rounded-full border",
                      orderBy === option.value
                        ? "border-canopy-accent bg-canopy-accent"
                        : "border-canopy-border"
                    )}
                  >
                    {orderBy === option.value && (
                      <div className="w-full h-full flex items-center justify-center">
                        <div className="w-1.5 h-1.5 bg-white rounded-full" />
                      </div>
                    )}
                  </div>
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {/* Group by Type Toggle */}
          <div className="px-3 py-2 border-b border-canopy-border">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={groupByType}
                onChange={(e) => setGroupByType(e.target.checked)}
                className="w-3.5 h-3.5 rounded border-canopy-border text-canopy-accent focus:ring-canopy-accent focus:ring-offset-0 bg-canopy-bg"
              />
              <span className="text-xs text-canopy-text/70">Group by type</span>
            </label>
          </div>

          {/* Filter Sections */}
          <FilterSection title="Status" defaultOpen={statusFilters.size > 0}>
            <div className="flex flex-wrap gap-1.5">
              {STATUS_OPTIONS.map((option) => (
                <FilterChip
                  key={option.value}
                  label={option.label}
                  isActive={statusFilters.has(option.value)}
                  onClick={() => toggleStatusFilter(option.value)}
                />
              ))}
            </div>
          </FilterSection>

          <FilterSection title="Branch Type" defaultOpen={typeFilters.size > 0}>
            <div className="flex flex-wrap gap-1.5">
              {TYPE_OPTIONS.map((option) => (
                <FilterChip
                  key={option.value}
                  label={option.label}
                  isActive={typeFilters.has(option.value)}
                  onClick={() => toggleTypeFilter(option.value)}
                />
              ))}
            </div>
          </FilterSection>

          <FilterSection title="GitHub" defaultOpen={githubFilters.size > 0}>
            <div className="flex flex-wrap gap-1.5">
              {GITHUB_OPTIONS.map((option) => (
                <FilterChip
                  key={option.value}
                  label={option.label}
                  isActive={githubFilters.has(option.value)}
                  onClick={() => toggleGitHubFilter(option.value)}
                />
              ))}
            </div>
          </FilterSection>

          <FilterSection title="Sessions" defaultOpen={sessionFilters.size > 0}>
            <div className="flex flex-wrap gap-1.5">
              {SESSION_OPTIONS.map((option) => (
                <FilterChip
                  key={option.value}
                  label={option.label}
                  isActive={sessionFilters.has(option.value)}
                  onClick={() => toggleSessionFilter(option.value)}
                />
              ))}
            </div>
          </FilterSection>

          <FilterSection title="Activity" defaultOpen={activityFilters.size > 0}>
            <div className="flex flex-wrap gap-1.5">
              {ACTIVITY_OPTIONS.map((option) => (
                <FilterChip
                  key={option.value}
                  label={option.label}
                  isActive={activityFilters.has(option.value)}
                  onClick={() => toggleActivityFilter(option.value)}
                />
              ))}
            </div>
          </FilterSection>

          {/* Clear All */}
          {hasActiveFilters() && (
            <div className="p-3 border-t border-canopy-border">
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
