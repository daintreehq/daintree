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
  terminalIds: string[];
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
 * Only a run in Needs you counts as waiting; a hand-back is `unread` or
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

/** A value key for counts: equal counts give equal keys. Exposed for tests. */
export function countsKey({ total, byState: s, unread, blocked }: WorktreeTerminalCounts): string {
  return [
    total,
    s.idle,
    s.working,
    s.waiting,
    s.directing,
    s.completed,
    s.exited,
    unread,
    blocked,
  ].join(",");
}

/** The inverse of `countsKey`, field for field in the same order. */
export function countsFromKey(key: string): WorktreeTerminalCounts {
  const [
    total = 0,
    idle = 0,
    working = 0,
    waiting = 0,
    directing = 0,
    completed = 0,
    exited = 0,
    unread = 0,
    blocked = 0,
  ] = key.split(",").map(Number);
  return {
    total,
    byState: { idle, working, waiting, directing, completed, exited },
    unread,
    blocked,
  };
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

type PanelStoreState = ReturnType<typeof usePanelStore.getState>;

/**
 * A worktree's terminals, in bucket order: PTY panels that are neither trashed
 * nor excluded from persistence. Reads only this worktree's bucket
 * (`panelIdsByWorktreeId`), so the cost is bounded by its own panel count, not
 * by total `panelIds` (#7451).
 */
export function selectWorktreeTerminals(
  state: PanelStoreState,
  worktreeId: string
): PtyPanelData[] {
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
}

/** The live PTY panels behind `ids`, in that order; missing or non-PTY ids drop out. */
export function selectPtyPanels(state: PanelStoreState, ids: readonly string[]): PtyPanelData[] {
  const out: PtyPanelData[] = [];
  for (const id of ids) {
    const raw = state.panelsById[id];
    if (raw && isPtyPanel(raw)) out.push(raw);
  }
  return out;
}

export interface WorktreeTerminalSummary {
  /** Same array for as long as the membership and its order hold. */
  terminalIds: string[];
  counts: WorktreeTerminalCounts;
  dominantAgentState: AgentState | null;
}

/**
 * Everything a worktree card shows about its terminals without holding the
 * panels themselves. A panel object is replaced on every activity, flow-status
 * and held-duration write, so a caller holding `terminals` re-renders on each
 * of them; this hook selects only ids and value keys, and re-renders only when
 * the membership, the counts or the dominant state actually change (#17051).
 */
export function useWorktreeTerminalSummary(worktreeId: string): WorktreeTerminalSummary {
  const terminalIds = usePanelStore(
    useShallow((state) => selectWorktreeTerminals(state, worktreeId).map((t) => t.id))
  );
  const bands = useRunFleetBands(terminalIds);
  const bandById = useMemo(
    () => new Map(terminalIds.map((id, i) => [id, bands[i]])),
    [terminalIds, bands]
  );

  const result = usePanelStore(
    useShallow((state) => {
      const terminals = selectWorktreeTerminals(state, worktreeId);
      const { byState, unread, blocked, agentStates } = aggregateAgentStates(terminals, (id) =>
        bandById.get(id)
      );
      return {
        countsKey: countsKey({ total: terminals.length, byState, unread, blocked }),
        dominantAgentState: getDominantAgentState(agentStates),
      };
    })
  );

  // Debounce counts to prevent UI jitter during rapid state changes (e.g., app
  // restart). It runs on a value key, not the counts object: any patch to a
  // panel in this worktree rebuilds the counts, and a fresh but equal object
  // restarted the timer each time, so a streaming sibling kept a real count
  // change from landing until its output settled (#16800). The key also keeps
  // `counts` the same object for as long as no count changes.
  const debouncedCountsKey = useDebouncedValue(result.countsKey, 250);
  const counts = useMemo(() => countsFromKey(debouncedCountsKey), [debouncedCountsKey]);

  return { terminalIds, counts, dominantAgentState: result.dominantAgentState };
}

/**
 * The summary plus the panels themselves, for callers that render panel fields.
 * `terminals` is a fresh array whenever any panel in the worktree is patched,
 * so a caller that re-renders often should take the summary instead.
 */
export function useWorktreeTerminals(worktreeId: string): UseWorktreeTerminalsResult {
  const summary = useWorktreeTerminalSummary(worktreeId);
  const terminals = usePanelStore(
    useShallow((state) => selectWorktreeTerminals(state, worktreeId))
  );
  return { ...summary, terminals };
}
