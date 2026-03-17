import { useMemo } from "react";
import type React from "react";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { AgentState } from "@/types";
import type { TerminalInstance } from "@/store/terminalStore";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { cn } from "@/lib/utils";
import type { WorktreeTerminalCounts } from "@/hooks/useWorktreeTerminals";
import { STATE_COLORS, STATE_ICONS, STATE_LABELS, STATE_PRIORITY } from "../terminalStateConfig";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "../../ui/tooltip";
import { ChevronRight, GripVertical, LayoutGrid, PanelBottom, Terminal } from "lucide-react";
import {
  SortableWorktreeTerminal,
  getAccordionDragId,
} from "@/components/DragDrop/SortableWorktreeTerminal";

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
              state === "working" && "animate-spin-slow motion-reduce:animate-none"
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

  const orderedWorktreeTerminals = terminals;

  if (!showMetaFooter) {
    return null;
  }

  return (
    <div
      id={terminalsId}
      className="mt-3 rounded-[var(--radius-lg)] border border-border-subtle bg-overlay-subtle"
    >
      {isExpanded ? (
        <>
          <button
            onClick={onToggle}
            aria-expanded={true}
            aria-controls={terminalsPanelId}
            className="flex w-full items-center justify-between rounded-t-[var(--radius-lg)] border-b border-border-subtle bg-overlay-soft px-3 py-1.5 text-left transition-colors hover:bg-overlay-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-[-2px]"
            id={`${terminalsId}-button`}
          >
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-text-muted">
              <Terminal className="w-3 h-3" />
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
              className="max-h-[300px] overflow-y-auto"
            >
              {orderedWorktreeTerminals.map((term, index) => (
                <SortableWorktreeTerminal
                  key={term.id}
                  terminal={term}
                  worktreeId={worktreeId}
                  sourceIndex={index}
                >
                  {({ listeners }) => (
                    <div className="group flex items-center justify-between gap-2.5 px-3 py-2 transition-colors hover:bg-overlay-soft">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onTerminalSelect(term);
                        }}
                        className="flex items-center gap-2 min-w-0 flex-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-[-2px] rounded"
                      >
                        <div className="shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                          <TerminalIcon
                            type={term.type}
                            kind={term.kind}
                            agentId={term.agentId}
                            detectedProcessId={term.detectedProcessId}
                            className="w-3 h-3"
                          />
                        </div>
                        <div className="flex flex-col min-w-0">
                          <span className="truncate text-xs font-medium text-text-secondary transition-colors group-hover:text-canopy-text">
                            {term.title}
                          </span>
                          {term.type === "terminal" &&
                            term.agentState === "running" &&
                            term.lastCommand && (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span className="truncate text-[11px] font-mono text-text-muted">
                                      {term.lastCommand}
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent side="bottom">{term.lastCommand}</TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            )}
                        </div>
                      </button>

                      <div className="flex items-center gap-2.5 shrink-0">
                        {term.agentState &&
                          term.agentState !== "idle" &&
                          (() => {
                            const Icon = STATE_ICONS[term.agentState];
                            return (
                              <Icon
                                className={cn(
                                  "w-3 h-3",
                                  STATE_COLORS[term.agentState],
                                  term.agentState === "working" &&
                                    "animate-spin-slow motion-reduce:animate-none"
                                )}
                                aria-label={STATE_LABELS[term.agentState]}
                              />
                            );
                          })()}

                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="text-text-muted transition-colors group-hover:text-text-secondary">
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
                        </TooltipProvider>

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
          className="flex w-full items-center justify-between rounded-[var(--radius-lg)] px-3 py-1.5 text-left transition-colors hover:bg-overlay-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-[-2px]"
          id={`${terminalsId}-button`}
        >
          <div className="flex items-center gap-1.5 text-[11px] text-text-secondary">
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
