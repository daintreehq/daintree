import { useMemo, useState, useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel, type PtyPanelData } from "@shared/types/panel";
import type { AgentState } from "@/types";
import type { WaitingReason } from "@shared/types/agent";
import { getDominantAgentState } from "@/components/Worktree/terminalStateConfig";
import { deriveTerminalChrome, type TerminalChromeInput } from "@/utils/terminalChrome";
import { getTerminalAgentDisplayState } from "@/utils/terminalAgentDisplayState";
import { resolveSessionPresentation, type HandBackSeenState } from "@/lib/handBackPresentation";
import { useRunHandBackStates } from "./useRunHandBackState";

export interface WorktreeTerminalCounts {
  total: number;
  /** Sessions by the state their glyph draws, `unread` hand-backs excepted. */
  byState: Record<AgentState, number>;
  /** Hand-backs the user has not read yet. */
  unread: number;
}

export interface UseWorktreeTerminalsResult {
  terminals: PtyPanelData[];
  counts: WorktreeTerminalCounts;
  dominantAgentState: AgentState | null;
}

/** Minimum shape consumed by `aggregateAgentStates`; satisfied by both
 *  `PtyPanelData` (production) and legacy `TerminalInstance` fixtures (tests). */
type AggregateInput = TerminalChromeInput & {
  id: string;
  agentState?: AgentState;
  waitingReason?: WaitingReason;
};

const NO_HAND_BACK = (): HandBackSeenState => "none";

/**
 * Pure aggregator over a worktree's terminal list, exposed for unit tests.
 *
 * Uses the same display-state coercion as compact terminal indicators: active
 * states are credited during the identity boot window, live-agent idle/missing/
 * completed states count as waiting, and exited or plain-shell terminals count
 * as idle so stale states don't bleed into badges.
 *
 * A hand-back the user has read counts as completed and an unread one as
 * `unread`, so neither inflates the waiting count. `agentStates` stays on the
 * display state: reading a stop must not change the worktree's dominant state.
 */
export function aggregateAgentStates(
  terminals: AggregateInput[],
  handBackOf: (terminalId: string) => HandBackSeenState = NO_HAND_BACK
): {
  byState: Record<AgentState, number>;
  unread: number;
  agentStates: (AgentState | undefined)[];
} {
  const byState: Record<AgentState, number> = {
    idle: 0,
    working: 0,
    waiting: 0,
    directing: 0,
    completed: 0,
    exited: 0,
  };
  let unread = 0;
  const agentStates: (AgentState | undefined)[] = [];

  terminals.forEach((terminal) => {
    const rawState = terminal.agentState;
    const displayState = getTerminalAgentDisplayState(deriveTerminalChrome(terminal), rawState);
    const presented = resolveSessionPresentation(
      displayState,
      rawState,
      terminal.waitingReason,
      handBackOf(terminal.id)
    );
    if (presented === "unread") {
      unread += 1;
    } else {
      const state = presented ?? "idle";
      byState[state] = (byState[state] || 0) + 1;
    }

    if (displayState) {
      agentStates.push(displayState);
    }
  });

  return { byState, unread, agentStates };
}

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);
  const isFirstRender = useRef(true);

  useEffect(() => {
    // On first render, use the value immediately (no delay)
    if (isFirstRender.current) {
      isFirstRender.current = false;
      setDebouncedValue(value);
      return;
    }

    const timer = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}

export function useWorktreeTerminals(worktreeId: string): UseWorktreeTerminalsResult {
  // Reads only from this worktree's pre-computed bucket (`panelIdsByWorktreeId`)
  // so the selector body cost is bounded by the worktree's own panel count, not
  // by total `panelIds`. The bucket reference is reference-stable when other
  // worktrees mutate (issue #7451) — useShallow then skips re-renders unless a
  // panel object inside this worktree actually changed.
  const terminals = usePanelStore(
    useShallow((state) => {
      const ids = state.panelIdsByWorktreeId[worktreeId];
      if (!ids || ids.length === 0) return [];
      const out: PtyPanelData[] = [];
      for (const id of ids) {
        const raw = state.panelsById[id];
        if (!raw) continue;
        if (raw.location === "trash") continue;
        if (!isPtyPanel(raw)) continue;
        if (raw.excludeFromPersistence === true) continue;
        out.push(raw);
      }
      return out;
    })
  );

  const terminalIds = useMemo(() => terminals.map((t) => t.id), [terminals]);
  const handBackStates = useRunHandBackStates(terminalIds);

  const result = useMemo(() => {
    const handBackById = new Map(terminalIds.map((id, i) => [id, handBackStates[i] ?? "none"]));
    const { byState, unread, agentStates } = aggregateAgentStates(
      terminals,
      (id) => handBackById.get(id) ?? "none"
    );
    const dominantAgentState = getDominantAgentState(agentStates);

    return {
      terminals,
      counts: {
        total: terminals.length,
        byState,
        unread,
      },
      dominantAgentState,
    };
  }, [terminals, terminalIds, handBackStates]);

  // Debounce counts to prevent UI jitter during rapid state changes (e.g., app restart)
  const debouncedCounts = useDebouncedValue(result.counts, 250);

  return {
    terminals: result.terminals,
    counts: debouncedCounts,
    dominantAgentState: result.dominantAgentState,
  };
}
