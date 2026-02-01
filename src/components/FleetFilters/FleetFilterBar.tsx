import { useMemo, useEffect } from "react";
import { X, ChevronDown, Check, GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useFleetFilterStore, type FleetStateFilter } from "@/store/fleetFilterStore";
import { useWorktrees } from "@/hooks/useWorktrees";
import type { TerminalInstance } from "@/store";

interface StateFilterOption {
  value: FleetStateFilter;
  label: string;
  color: string;
}

const STATE_FILTER_OPTIONS: StateFilterOption[] = [
  { value: "working", label: "Working", color: "var(--color-status-info)" },
  { value: "running", label: "Running", color: "var(--color-status-info)" },
  { value: "waiting", label: "Waiting", color: "var(--color-status-warning)" },
  { value: "completed", label: "Completed", color: "var(--color-status-success)" },
  { value: "failed", label: "Failed", color: "var(--color-status-error)" },
];

interface StateChipProps {
  option: StateFilterOption;
  count: number;
  isActive: boolean;
  onClick: () => void;
}

function StateChip({ option, count, isActive, onClick }: StateChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={isActive}
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] rounded-full border transition-colors",
        isActive
          ? "border-current"
          : "bg-canopy-bg border-canopy-border text-canopy-text/60 hover:bg-white/[0.04] hover:text-canopy-text/80"
      )}
      style={isActive ? { color: option.color, borderColor: option.color } : undefined}
    >
      <span
        className={cn("w-1.5 h-1.5 rounded-full", !isActive && "bg-current opacity-60")}
        style={isActive ? { backgroundColor: option.color } : undefined}
      />
      {option.label}
      {count > 0 && <span className={cn("opacity-70", isActive && "opacity-100")}>({count})</span>}
    </button>
  );
}

interface FleetFilterBarProps {
  terminals: TerminalInstance[];
  visibleCount?: number;
  className?: string;
}

export function FleetFilterBar({ terminals, visibleCount, className }: FleetFilterBarProps) {
  const { worktrees } = useWorktrees();

  const { stateFilters, worktreeFilter, toggleStateFilter, setWorktreeFilter, clearAll } =
    useFleetFilterStore();

  // Reset worktree filter if selected worktree no longer exists
  const selectedWorktree = useMemo(() => {
    if (worktreeFilter === "all") return null;
    return worktrees.find((w) => w.id === worktreeFilter);
  }, [worktrees, worktreeFilter]);

  // Auto-clear invalid worktree filter
  useEffect(() => {
    if (worktreeFilter !== "all" && !selectedWorktree) {
      setWorktreeFilter("all");
    }
  }, [worktreeFilter, selectedWorktree, setWorktreeFilter]);

  // Compute state counts scoped to current worktree filter
  const stateCounts = useMemo(() => {
    const counts: Record<FleetStateFilter, number> = {
      working: 0,
      running: 0,
      waiting: 0,
      completed: 0,
      failed: 0,
    };

    // Filter terminals by current worktree filter before counting
    const scopedTerminals =
      worktreeFilter === "all"
        ? terminals
        : terminals.filter((t) => t.worktreeId === worktreeFilter);

    for (const terminal of scopedTerminals) {
      if (terminal.kind === "agent" && terminal.agentState) {
        const state = terminal.agentState as FleetStateFilter;
        if (state in counts) {
          counts[state]++;
        }
      }
    }
    return counts;
  }, [terminals, worktreeFilter]);

  // Total agents scoped to current worktree filter
  const totalAgents = useMemo(() => {
    const scopedTerminals =
      worktreeFilter === "all"
        ? terminals
        : terminals.filter((t) => t.worktreeId === worktreeFilter);
    return scopedTerminals.filter((t) => t.kind === "agent").length;
  }, [terminals, worktreeFilter]);

  // Use derived state instead of calling store methods to ensure reactivity
  const hasFilters = stateFilters.size > 0 || worktreeFilter !== "all";

  if (totalAgents === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "flex items-center gap-2 px-2 py-1.5 bg-canopy-bg/50 border-b border-canopy-border",
        className
      )}
    >
      <div className="flex items-center gap-1.5 flex-wrap">
        {STATE_FILTER_OPTIONS.map((option) => (
          <StateChip
            key={option.value}
            option={option}
            count={stateCounts[option.value]}
            isActive={stateFilters.has(option.value)}
            onClick={() => toggleStateFilter(option.value)}
          />
        ))}
      </div>

      <div className="h-4 w-px bg-canopy-border mx-1" />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] rounded-md transition-colors",
              "hover:bg-white/[0.04]",
              worktreeFilter !== "all"
                ? "text-canopy-accent"
                : "text-canopy-text/60 hover:text-canopy-text/80"
            )}
          >
            <GitBranch className="w-3 h-3" />
            <span className="max-w-[120px] truncate">
              {selectedWorktree?.branch ?? selectedWorktree?.name ?? "All worktrees"}
            </span>
            <ChevronDown className="w-3 h-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          <DropdownMenuItem
            onClick={() => setWorktreeFilter("all")}
            className="flex items-center gap-2"
          >
            {worktreeFilter === "all" && <Check className="w-3 h-3" />}
            <span className={worktreeFilter === "all" ? "" : "pl-5"}>All worktrees</span>
          </DropdownMenuItem>
          {worktrees.length > 0 && <DropdownMenuSeparator />}
          {worktrees.map((worktree) => (
            <DropdownMenuItem
              key={worktree.id}
              onClick={() => setWorktreeFilter(worktree.id)}
              className="flex items-center gap-2"
            >
              {worktreeFilter === worktree.id && <Check className="w-3 h-3" />}
              <span className={cn("truncate", worktreeFilter === worktree.id ? "" : "pl-5")}>
                {worktree.branch ?? worktree.name}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {hasFilters && (
        <>
          <div className="h-4 w-px bg-canopy-border mx-1" />
          <Button
            variant="ghost"
            size="xs"
            onClick={clearAll}
            className="text-canopy-text/50 hover:text-canopy-text gap-1"
          >
            <X className="w-3 h-3" />
            Clear
          </Button>
        </>
      )}

      <div className="flex-1" />

      <div className="flex items-center gap-2 text-[10px] text-canopy-text/40">
        {hasFilters && visibleCount !== undefined && visibleCount < totalAgents && (
          <span className="text-canopy-text/50">({totalAgents - visibleCount} hidden)</span>
        )}
        <span>
          {totalAgents} agent{totalAgents !== 1 ? "s" : ""}
        </span>
      </div>
    </div>
  );
}

export default FleetFilterBar;
