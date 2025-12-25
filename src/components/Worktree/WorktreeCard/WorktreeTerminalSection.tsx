import { useMemo } from "react";
import type React from "react";
import { useDraggable } from "@dnd-kit/core";
import type { AgentState } from "@/types";
import type { TerminalInstance } from "@/store/terminalStore";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { cn } from "@/lib/utils";
import type { WorktreeTerminalCounts } from "@/hooks/useWorktreeTerminals";
import type { DragData } from "@/components/DragDrop/DndProvider";
import {
  STATE_COLORS,
  STATE_ICONS,
  STATE_LABELS,
  STATE_PRIORITY,
  STATE_SORT_PRIORITY,
} from "../terminalStateConfig";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "../../ui/tooltip";
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  GripVertical,
  LayoutGrid,
  Loader2,
  PanelBottom,
  Play,
  Terminal,
  XCircle,
} from "lucide-react";

interface StateIconProps {
  state: AgentState;
  count: number;
}

function StateIcon({ state, count }: StateIconProps) {
  const Icon = STATE_ICONS[state];
  const colorClass = STATE_COLORS[state];
  const label = STATE_LABELS[state];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn("flex items-center gap-1 text-[11px]", colorClass)}
          role="img"
          aria-label={`${count} ${label}`}
        >
          <Icon
            className={cn(
              "w-3 h-3",
              state === "working" && "animate-spin motion-reduce:animate-none"
            )}
            aria-hidden
          />
          <span className="font-mono">{count}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {count} {label}
      </TooltipContent>
    </Tooltip>
  );
}

function computeSourceIndexMaps(terminals: TerminalInstance[]) {
  const gridTerminals = terminals.filter((t) => t.location === "grid" || t.location === undefined);
  const dockTerminals = terminals.filter((t) => t.location === "dock");

  const gridIndexMap = new Map<string, number>();
  gridTerminals.forEach((term, idx) => gridIndexMap.set(term.id, idx));

  const dockIndexMap = new Map<string, number>();
  dockTerminals.forEach((term, idx) => dockIndexMap.set(term.id, idx));

  return { gridIndexMap, dockIndexMap };
}

interface DraggableTerminalRowProps {
  terminal: TerminalInstance;
  sourceIndex: number;
  onTerminalSelect: (terminal: TerminalInstance) => void;
}

function DraggableTerminalRow({
  terminal,
  sourceIndex,
  onTerminalSelect,
}: DraggableTerminalRowProps) {
  const sourceLocation: "grid" | "dock" = terminal.location === "dock" ? "dock" : "grid";

  const dragData: DragData = {
    terminal,
    sourceLocation,
    sourceIndex,
  };

  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
    id: `worktree-list:${terminal.id}`,
    data: dragData,
  });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex items-center justify-between gap-2.5 px-3 py-2 group transition-colors hover:bg-white/5",
        isDragging && "opacity-40"
      )}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onTerminalSelect(terminal);
        }}
        className="flex items-center gap-2 min-w-0 flex-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-[-2px] rounded"
      >
        <div className="shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
          <TerminalIcon
            type={terminal.type}
            kind={terminal.kind}
            agentId={terminal.agentId}
            className="w-3 h-3"
          />
        </div>
        <div className="flex flex-col min-w-0">
          <span className="text-xs font-medium truncate text-canopy-text/70 group-hover:text-canopy-text transition-colors">
            {terminal.title}
          </span>
          {terminal.type === "terminal" &&
            terminal.agentState === "running" &&
            terminal.lastCommand && (
              <span
                className="text-[11px] font-mono text-canopy-text/50 truncate"
                title={terminal.lastCommand}
              >
                {terminal.lastCommand}
              </span>
            )}
        </div>
      </button>

      <div className="flex items-center gap-2.5 shrink-0">
        {terminal.agentState === "working" && (
          <Loader2
            className="w-3 h-3 animate-spin motion-reduce:animate-none text-[var(--color-state-working)]"
            aria-label="Working"
          />
        )}

        {terminal.agentState === "running" && (
          <Play className="w-3 h-3 text-[var(--color-status-info)]" aria-label="Running" />
        )}

        {terminal.agentState === "waiting" && (
          <AlertCircle className="w-3 h-3 text-amber-400" aria-label="Waiting for input" />
        )}

        {terminal.agentState === "failed" && (
          <XCircle className="w-3 h-3 text-[var(--color-status-error)]" aria-label="Failed" />
        )}

        {terminal.agentState === "completed" && (
          <CheckCircle2
            className="w-3 h-3 text-[var(--color-status-success)]"
            aria-label="Completed"
          />
        )}

        <div
          className="text-muted-foreground/40 group-hover:text-muted-foreground/60 transition-colors"
          title={terminal.location === "dock" ? "Docked" : "On Grid"}
        >
          {terminal.location === "dock" ? (
            <PanelBottom className="w-3 h-3" />
          ) : (
            <LayoutGrid className="w-3 h-3" />
          )}
        </div>

        <button
          ref={setActivatorNodeRef}
          type="button"
          className="cursor-grab active:cursor-grabbing text-canopy-text/30 hover:text-canopy-text/60 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-1 rounded"
          aria-label="Drag to move terminal"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

export interface WorktreeTerminalSectionProps {
  worktreeId: string;
  isExpanded: boolean;
  counts: WorktreeTerminalCounts;
  terminals: TerminalInstance[];
  onToggle: (e: React.MouseEvent) => void;
  onTerminalSelect: (terminal: TerminalInstance) => void;
}

export function WorktreeTerminalSection({
  worktreeId,
  isExpanded,
  counts,
  terminals,
  onToggle,
  onTerminalSelect,
}: WorktreeTerminalSectionProps) {
  const showMetaFooter = counts.total > 0;

  const terminalsId = useMemo(() => `worktree-${worktreeId}-terminals`, [worktreeId]);
  const terminalsPanelId = useMemo(() => `worktree-${worktreeId}-terminals-panel`, [worktreeId]);

  const topTerminalState = useMemo((): { state: AgentState; count: number } | null => {
    for (const state of STATE_PRIORITY) {
      const count = counts.byState[state];
      if (count > 0) {
        return { state, count };
      }
    }
    return null;
  }, [counts.byState]);

  const orderedWorktreeTerminals = useMemo(() => {
    if (terminals.length === 0) return terminals;

    const isAgentTerminal = (terminal: TerminalInstance) =>
      terminal.type === "claude" || terminal.type === "gemini" || terminal.type === "codex";

    return [...terminals].sort((a, b) => {
      const aIsAgent = isAgentTerminal(a);
      const bIsAgent = isAgentTerminal(b);

      if (aIsAgent !== bIsAgent) {
        return aIsAgent ? -1 : 1;
      }

      const aState = a.agentState ?? "idle";
      const bState = b.agentState ?? "idle";
      const aPriority = STATE_SORT_PRIORITY[aState];
      const bPriority = STATE_SORT_PRIORITY[bState];

      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }

      return (a.title || "").localeCompare(b.title || "");
    });
  }, [terminals]);

  const { gridIndexMap, dockIndexMap } = useMemo(
    () => computeSourceIndexMaps(terminals),
    [terminals]
  );

  if (!showMetaFooter) {
    return null;
  }

  return (
    <div
      id={terminalsId}
      className="mt-3 bg-white/[0.01] rounded-[var(--radius-lg)] border border-white/5"
    >
      {isExpanded ? (
        <>
          <button
            onClick={onToggle}
            aria-expanded={true}
            aria-controls={terminalsPanelId}
            className="w-full px-3 py-1.5 flex items-center justify-between text-left border-b border-white/5 transition-colors bg-white/[0.03] hover:bg-white/[0.05] focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-[-2px] rounded-t-[var(--radius-lg)]"
            id={`${terminalsId}-button`}
          >
            <span className="flex items-center gap-1.5 text-[11px] text-canopy-text/50 font-medium">
              <Terminal className="w-3 h-3" />
              <span>Active Sessions ({counts.total})</span>
            </span>
            <ChevronRight className="w-3 h-3 text-canopy-text/40 rotate-90" />
          </button>
          <div
            id={terminalsPanelId}
            role="region"
            aria-labelledby={`${terminalsId}-button`}
            className="max-h-[300px] overflow-y-auto"
          >
            {orderedWorktreeTerminals.map((term) => {
              const sourceIndex =
                term.location === "dock"
                  ? (dockIndexMap.get(term.id) ?? 0)
                  : (gridIndexMap.get(term.id) ?? 0);

              return (
                <DraggableTerminalRow
                  key={term.id}
                  terminal={term}
                  sourceIndex={sourceIndex}
                  onTerminalSelect={onTerminalSelect}
                />
              );
            })}
          </div>
        </>
      ) : (
        <button
          onClick={onToggle}
          aria-expanded={false}
          aria-controls={terminalsPanelId}
          className="w-full px-3 py-1.5 flex items-center justify-between text-left rounded-[var(--radius-lg)] transition-colors hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-[-2px]"
          id={`${terminalsId}-button`}
        >
          <div className="flex items-center gap-1.5 text-[11px] text-canopy-text/60">
            <Terminal className="w-3 h-3" />
            <span className="inline-flex items-center gap-1">
              <span className="font-mono tabular-nums">{counts.total}</span>
              <span className="font-sans">active</span>
            </span>
          </div>

          {topTerminalState && (
            <TooltipProvider>
              <StateIcon state={topTerminalState.state} count={topTerminalState.count} />
            </TooltipProvider>
          )}
        </button>
      )}
    </div>
  );
}
