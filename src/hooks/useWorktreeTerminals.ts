import { useMemo, useState, useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel, type PtyPanelData } from "@shared/types/panel";
import type { AgentState } from "@/types";
import type { WaitingReason } from "@shared/types/agent";
import { getDominantAgentState } from "@/components/Worktree/terminalStateConfig";
import { deriveTerminalChrome, type TerminalChromeInput } from "@/utils/terminalChrome";
import { getTerminalAgentDisplayState } from "@/utils/terminalAgentDisplayState";
import { resolvePaneSessionPresentation } from "@/lib/paneSessionPresentation";
import type { FleetBand } from "@/lib/fleetAttention";
import { useRunFleetBands } from "./useRunSessionPresentation";

export interface WorktreeTerminalCounts {
  total: number;
  /** Sessions by the state their glyph draws, `unread` and `blocked` excepted. */
  byState: Record<AgentState, number>;
  /** Hand-backs the user has not read yet. */
  unread: number;
  /** Agents stopped on an error. */
  blocked: number;
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
  isRestarting?: boolean;
  runtimeStatus?: string;
};

const NO_BAND = (): FleetBand | undefined => undefined;

/**
 * Pure aggregator over a worktree's terminal list, exposed for unit tests.
 *
 * Counts each session as its glyph draws it: the compact indicators' display
 * state (active states credited during the identity boot window, a live
 * agent's idle, missing or completed state shown as waiting, exited and
 * plain-shell terminals idle) through the run's fleet band, as the pane does.
 * Only an unread Canopy ask counts as waiting; a hand-back is `unread` or
 * completed, an error wait `blocked`, and a prompt that asks nothing — or a
 * run the fleet hasn't reported — idle. `agentStates` stays on the display
 * state: reading a stop must not change the worktree's dominant state.
 */
export function aggregateAgentStates(
  terminals: AggregateInput[],
  bandOf: (terminalId: string) => FleetBand | undefined = NO_BAND
): {
  byState: Record<AgentState, number>;
  unread: number;
  blocked: number;
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
  let blocked = 0;
  const agentStates: (AgentState | undefined)[] = [];

  terminals.forEach((terminal) => {
    const rawState = terminal.agentState;
    const displayState = getTerminalAgentDisplayState(deriveTerminalChrome(terminal), rawState);
    const presented = resolvePaneSessionPresentation(displayState, bandOf(terminal.id), terminal);
    if (presented === "unread") {
      unread += 1;
    } else if (presented === "blocked") {
      blocked += 1;
    } else {
      const state = presented ?? "idle";
      byState[state] = (byState[state] || 0) + 1;
    }

    if (displayState) {
      agentStates.push(displayState);
    }
  });

  return { byState, unread, blocked, agentStates };
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
  const bands = useRunFleetBands(terminalIds);

  const result = useMemo(() => {
    const bandById = new Map(terminalIds.map((id, i) => [id, bands[i]]));
    const { byState, unread, blocked, agentStates } = aggregateAgentStates(terminals, (id) =>
      bandById.get(id)
    );
    const dominantAgentState = getDominantAgentState(agentStates);

    return {
      terminals,
      counts: {
        total: terminals.length,
        byState,
        unread,
        blocked,
      },
      dominantAgentState,
    };
  }, [terminals, terminalIds, bands]);

  // Debounce counts to prevent UI jitter during rapid state changes (e.g., app restart)
  const debouncedCounts = useDebouncedValue(result.counts, 250);

  return {
    terminals: result.terminals,
    counts: debouncedCounts,
    dominantAgentState: result.dominantAgentState,
  };
}
