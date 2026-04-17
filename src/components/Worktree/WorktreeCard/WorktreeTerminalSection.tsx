import { useCallback, useMemo, useRef, useState } from "react";
import type React from "react";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { AgentState } from "@/types";
import type { TerminalInstance } from "@/store/panelStore";
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
import { ChevronRight, GripVertical, PanelBottom, SquareTerminal } from "lucide-react";
import { MoveToGridIcon } from "@/components/icons";
import {
  SortableWorktreeTerminal,
  getAccordionDragId,
} from "@/components/DragDrop/SortableWorktreeTerminal";
import { useFleetArmingStore, isFleetArmEligible } from "@/store/fleetArmingStore";

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

interface MarqueeBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface TerminalRowProps {
  term: TerminalInstance;
  listeners: React.HTMLAttributes<HTMLElement> | undefined;
  onClick: (term: TerminalInstance, e: React.MouseEvent) => void;
}

function TerminalRow({ term, listeners, onClick }: TerminalRowProps) {
  const isArmed = useFleetArmingStore((s) => s.armedIds.has(term.id));
  const armBadge = useFleetArmingStore((s) => s.armOrderById[term.id]);

  return (
    <div
      data-terminal-id={term.id}
      className={cn(
        "rounded-[var(--radius-md)]",
        isArmed &&
          "bg-daintree-accent/5 outline outline-2 outline-daintree-accent/70 outline-offset-[-2px]"
      )}
    >
      <div className="worktree-section-button group/termrow flex items-center justify-between gap-2.5 px-3 py-2 transition-colors">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClick(term, e);
          }}
          aria-selected={isArmed}
          className="flex items-center gap-2 min-w-0 flex-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-[-2px] rounded"
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
            <span className="truncate text-xs font-medium text-text-secondary transition-colors group-hover/termrow:text-daintree-text">
              {term.title}
            </span>
            {term.type === "terminal" && term.agentState === "running" && term.lastCommand && (
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
          {isArmed && armBadge !== undefined && (
            <span
              className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-daintree-accent px-1 text-[9px] font-mono font-semibold text-[var(--color-daintree-bg)] tabular-nums"
              aria-label={`Armed position ${armBadge}`}
            >
              {armBadge}
            </span>
          )}

          {term.agentState &&
            term.agentState !== "idle" &&
            (() => {
              const Icon = getEffectiveStateIcon(term.agentState, term.waitingReason);
              return (
                <Icon
                  className={cn(
                    "w-3 h-3",
                    getEffectiveStateColor(term.agentState, term.waitingReason),
                    term.agentState === "working" && "animate-spin-slow motion-reduce:animate-none"
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
                  <MoveToGridIcon className="w-3 h-3" />
                )}
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {term.location === "dock" ? "Docked" : "On Grid"}
            </TooltipContent>
          </Tooltip>

          <button
            type="button"
            data-drag-handle
            className="cursor-grab rounded text-text-muted transition-colors hover:text-text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-1 active:cursor-grabbing"
            aria-label="Drag to move terminal"
            {...(listeners as React.HTMLAttributes<HTMLElement>)}
          >
            <GripVertical className="w-3.5 h-3.5" />
          </button>
        </div>
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
  const eligibleTerminalsRef = useRef<TerminalInstance[]>([]);
  eligibleTerminalsRef.current = orderedWorktreeTerminals.filter(isFleetArmEligible);

  const handleTerminalClick = useCallback(
    (term: TerminalInstance, e: React.MouseEvent) => {
      if (!isFleetArmEligible(term)) {
        onTerminalSelect(term);
        return;
      }
      const store = useFleetArmingStore.getState();
      if (e.shiftKey) {
        const orderedEligibleIds = eligibleTerminalsRef.current.map((t) => t.id);
        store.extendTo(term.id, orderedEligibleIds);
      } else {
        store.toggleId(term.id);
      }
    },
    [onTerminalSelect]
  );

  // Marquee starts potential on pointerdown (no capture yet). We only upgrade
  // to an active marquee — and take pointer capture — after the pointer has
  // moved past a small threshold. This way a plain click on a tile still
  // fires its onClick handler, while drag-to-select activates cleanly.
  const MARQUEE_THRESHOLD_PX = 4;
  const marqueeStartRef = useRef<{
    x: number;
    y: number;
    pointerId: number;
    active: boolean;
  } | null>(null);
  const tileRectsRef = useRef<Map<string, DOMRect>>(new Map());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [marqueeBox, setMarqueeBox] = useState<MarqueeBox | null>(null);

  const snapshotRects = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const nodes = container.querySelectorAll<HTMLElement>("[data-terminal-id]");
    const rects = new Map<string, DOMRect>();
    nodes.forEach((el) => {
      const id = el.dataset.terminalId;
      if (id) rects.set(id, el.getBoundingClientRect());
    });
    tileRectsRef.current = rects;
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const target = e.target as Element;
      // dnd-kit owns the drag handle — don't shadow its pointer events.
      if (target.closest("[data-drag-handle]")) return;
      marqueeStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        pointerId: e.pointerId,
        active: false,
      };
      snapshotRects();
    },
    [snapshotRects]
  );

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const start = marqueeStartRef.current;
    if (!start) return;
    const dx = Math.abs(e.clientX - start.x);
    const dy = Math.abs(e.clientY - start.y);
    if (!start.active) {
      if (dx < MARQUEE_THRESHOLD_PX && dy < MARQUEE_THRESHOLD_PX) return;
      start.active = true;
      try {
        e.currentTarget.setPointerCapture(start.pointerId);
      } catch {
        // capture may fail if pointer already released
      }
    }
    const container = scrollRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const x = Math.min(start.x, e.clientX) - rect.left + container.scrollLeft;
    const y = Math.min(start.y, e.clientY) - rect.top + container.scrollTop;
    setMarqueeBox({ x, y, w: dx, h: dy });
  }, []);

  const commitMarquee = useCallback(
    (endX: number, endY: number) => {
      const start = marqueeStartRef.current;
      if (!start) return;
      const left = Math.min(start.x, endX);
      const right = Math.max(start.x, endX);
      const top = Math.min(start.y, endY);
      const bottom = Math.max(start.y, endY);
      const hits: string[] = [];
      for (const [id, r] of tileRectsRef.current) {
        if (r.right < left || r.left > right || r.bottom < top || r.top > bottom) continue;
        hits.push(id);
      }
      if (hits.length > 0) {
        const eligible = new Set(eligibleTerminalsRef.current.map((t) => t.id));
        const orderedHits = orderedWorktreeTerminals
          .map((t) => t.id)
          .filter((id) => hits.includes(id) && eligible.has(id));
        if (orderedHits.length > 0) {
          useFleetArmingStore.getState().armIds(orderedHits);
        }
      }
    },
    [orderedWorktreeTerminals]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const start = marqueeStartRef.current;
      if (!start) return;
      if (start.active) {
        try {
          e.currentTarget.releasePointerCapture(start.pointerId);
        } catch {
          // capture may already be released
        }
        commitMarquee(e.clientX, e.clientY);
      }
      marqueeStartRef.current = null;
      setMarqueeBox(null);
    },
    [commitMarquee]
  );

  const handlePointerCancel = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const start = marqueeStartRef.current;
    if (!start) return;
    if (start.active) {
      try {
        e.currentTarget.releasePointerCapture(start.pointerId);
      } catch {
        // ignore
      }
    }
    marqueeStartRef.current = null;
    setMarqueeBox(null);
  }, []);

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
            className="worktree-section-button flex w-full items-center justify-between rounded-t-[var(--radius-lg)] border-b border-border-default bg-surface-inset px-3 py-1.5 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-[-2px]"
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
              ref={scrollRef}
              role="list"
              aria-labelledby={`${terminalsId}-button`}
              aria-multiselectable="true"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
              className="relative max-h-[300px] overflow-y-auto bg-surface-inset"
            >
              {orderedWorktreeTerminals.map((term, index) => (
                <SortableWorktreeTerminal
                  key={term.id}
                  terminal={term}
                  worktreeId={worktreeId}
                  sourceIndex={index}
                >
                  {({ listeners }) => (
                    <TerminalRow
                      term={term}
                      listeners={listeners as React.HTMLAttributes<HTMLElement> | undefined}
                      onClick={handleTerminalClick}
                    />
                  )}
                </SortableWorktreeTerminal>
              ))}
              {marqueeBox && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute z-10 rounded border border-daintree-accent/60 bg-daintree-accent/10"
                  style={{
                    left: marqueeBox.x,
                    top: marqueeBox.y,
                    width: marqueeBox.w,
                    height: marqueeBox.h,
                  }}
                />
              )}
            </div>
          </SortableContext>
        </>
      ) : (
        <button
          onClick={onToggle}
          aria-expanded={false}
          aria-controls={terminalsPanelId}
          className="worktree-section-button flex w-full items-center justify-between rounded-[var(--radius-lg)] px-3 py-1.5 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-[-2px]"
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
