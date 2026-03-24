import { useMemo } from "react";
import type React from "react";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { AgentState } from "@/types";
import type { TerminalInstance } from "@/store/terminalStore";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { cn } from "@/lib/utils";
import type { WorktreeTerminalCounts } from "@/hooks/useWorktreeTerminals";
import { getAgentConfig, isRegisteredAgent } from "@/config/agents";
import {
  STATE_LABELS,
  STATE_PRIORITY,
  getEffectiveStateIcon,
  getEffectiveStateColor,
} from "../terminalStateConfig";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { ChevronRight, GripVertical, LayoutGrid, PanelBottom, SquareTerminal } from "lucide-react";
import {
  SortableWorktreeTerminal,
  getAccordionDragId,
} from "@/components/DragDrop/SortableWorktreeTerminal";

interface StateIconProps {
  state: AgentState;
  count: number;
}

function StateIcon({ state, count }: StateIconProps) {
  const Icon = getEffectiveStateIcon(state);
  const colorClass = getEffectiveStateColor(state);
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
              state === "working" && "animate-spin-slow motion-reduce:animate-none"
            )}
            aria-hidden
          />
          <span className="font-mono tabular-nums">{count}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {count} {label}
      </TooltipContent>
    </Tooltip>
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

  const terminalsId = `worktree-${worktreeId}-terminals`;
  const terminalsPanelId = `worktree-${worktreeId}-terminals-panel`;

  const topTerminalState = useMemo((): { state: AgentState; count: number } | null => {
    for (const state of STATE_PRIORITY) {
      const count = counts.byState[state];
      if (count > 0) {
        return { state, count };
      }
    }
    return null;
  }, [counts.byState]);

  const SummaryIcon = useMemo(() => {
    if (terminals.length === 0) return null;
    let commonId: string | null = null;
    for (const t of terminals) {
      const effectiveId = t.agentId ?? (t.type && isRegisteredAgent(t.type) ? t.type : undefined);
      if (!effectiveId) return null;
      if (commonId === null) commonId = effectiveId;
      else if (effectiveId !== commonId) return null;
    }
    if (!commonId) return null;
    return getAgentConfig(commonId)?.icon ?? null;
  }, [terminals]);

  const orderedWorktreeTerminals = terminals;

  if (!showMetaFooter) {
    return null;
  }

  return (
    <div
      id={terminalsId}
      className="mt-3 rounded-[var(--radius-lg)] border border-border-default bg-surface-inset"
    >
      {isExpanded ? (
        <>
          <button
            onClick={onToggle}
            aria-expanded={true}
            aria-controls={terminalsPanelId}
            className="worktree-section-button flex w-full items-center justify-between rounded-t-[var(--radius-lg)] border-b border-border-default bg-surface-inset px-3 py-1.5 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-[-2px]"
            id={`${terminalsId}-button`}
          >
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-text-muted">
              {SummaryIcon ? (
                <SummaryIcon className="w-3 h-3" />
              ) : (
                <SquareTerminal className="w-3 h-3" />
              )}
              <span>Active Sessions ({counts.total})</span>
            </span>
            <ChevronRight className="h-3 w-3 rotate-90 text-text-muted" />
          </button>
          <SortableContext
            id={`worktree-${worktreeId}-accordion`}
            items={orderedWorktreeTerminals.map((t) => getAccordionDragId(t.id))}
            strategy={verticalListSortingStrategy}
          >
            <div
              id={terminalsPanelId}
              role="list"
              aria-labelledby={`${terminalsId}-button`}
              className="max-h-[300px] overflow-y-auto bg-surface-inset"
            >
              {orderedWorktreeTerminals.map((term, index) => (
                <SortableWorktreeTerminal
                  key={term.id}
                  terminal={term}
                  worktreeId={worktreeId}
                  sourceIndex={index}
                >
                  {({ listeners }) => (
                    <div className="worktree-section-button group/termrow flex items-center justify-between gap-2.5 px-3 py-2 transition-colors">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onTerminalSelect(term);
                        }}
                        className="flex items-center gap-2 min-w-0 flex-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-[-2px] rounded"
                      >
                        <div className="shrink-0 opacity-60 group-hover/termrow:opacity-100 transition-opacity">
                          <TerminalIcon
                            type={term.type}
                            kind={term.kind}
                            agentId={term.agentId}
                            detectedProcessId={term.detectedProcessId}
                            className="w-3 h-3"
                          />
                        </div>
                        <div className="flex flex-col min-w-0">
                          <span className="truncate text-xs font-medium text-text-secondary transition-colors group-hover/termrow:text-canopy-text">
                            {term.title}
                          </span>
                          {term.type === "terminal" &&
                            term.agentState === "running" &&
                            term.lastCommand && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="truncate text-[11px] font-mono text-text-muted">
                                    {term.lastCommand}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="bottom">{term.lastCommand}</TooltipContent>
                              </Tooltip>
                            )}
                        </div>
                      </button>

                      <div className="flex items-center gap-2.5 shrink-0">
                        {term.agentState &&
                          term.agentState !== "idle" &&
                          (() => {
                            const Icon = getEffectiveStateIcon(term.agentState, term.waitingReason);
                            return (
                              <Icon
                                className={cn(
                                  "w-3 h-3",
                                  getEffectiveStateColor(term.agentState, term.waitingReason),
                                  term.agentState === "working" &&
                                    "animate-spin-slow motion-reduce:animate-none"
                                )}
                                aria-label={STATE_LABELS[term.agentState]}
                              />
                            );
                          })()}

                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="text-text-muted transition-colors group-hover/termrow:text-text-secondary">
                              {term.location === "dock" ? (
                                <PanelBottom className="w-3 h-3" />
                              ) : (
                                <LayoutGrid className="w-3 h-3" />
                              )}
                            </div>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">
                            {term.location === "dock" ? "Docked" : "On Grid"}
                          </TooltipContent>
                        </Tooltip>

                        <button
                          type="button"
                          className="cursor-grab rounded text-text-muted transition-colors hover:text-text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-1 active:cursor-grabbing"
                          aria-label="Drag to move terminal"
                          {...listeners}
                        >
                          <GripVertical className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  )}
                </SortableWorktreeTerminal>
              ))}
            </div>
          </SortableContext>
        </>
      ) : (
        <button
          onClick={onToggle}
          aria-expanded={false}
          aria-controls={terminalsPanelId}
          className="worktree-section-button flex w-full items-center justify-between rounded-[var(--radius-lg)] px-3 py-1.5 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-[-2px]"
          id={`${terminalsId}-button`}
        >
          <div className="flex items-center gap-1.5 text-[11px] text-text-secondary">
            {SummaryIcon ? (
              <SummaryIcon className="w-3 h-3" />
            ) : (
              <SquareTerminal className="w-3 h-3" />
            )}
            <span className="inline-flex items-center gap-1">
              <span className="font-mono tabular-nums">{counts.total}</span>
              <span className="font-sans">active</span>
            </span>
          </div>

          {topTerminalState && (
            <StateIcon state={topTerminalState.state} count={topTerminalState.count} />
          )}
        </button>
      )}
    </div>
  );
}
