import { useMemo, useState, useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePanelStore, type TerminalInstance } from "@/store/panelStore";
import type { AgentState } from "@/types";
import { getDominantAgentState } from "@/components/Worktree/AgentStatusIndicator";
import { deriveTerminalChrome } from "@/utils/terminalChrome";

export interface WorktreeTerminalCounts {
  total: number;
  byState: Record<AgentState, number>;
}

export interface UseWorktreeTerminalsResult {
  terminals: TerminalInstance[];
  counts: WorktreeTerminalCounts;
  dominantAgentState: AgentState | null;
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
  // Use useShallow to prevent infinite loops.
  // Without this, .filter() returns a new reference every render,
  // breaking React's useSyncExternalStore contract.
  const terminals = usePanelStore(
    useShallow((state) =>
      state.panelIds
        .map((id) => state.panelsById[id])
        .filter(
          (t): t is TerminalInstance =>
            t !== undefined && t.worktreeId === worktreeId && t.location !== "trash"
        )
    )
  );

  const result = useMemo(() => {
    const byState: Record<AgentState, number> = {
      idle: 0,
      working: 0,
      waiting: 0,
      directing: 0,
      completed: 0,
      exited: 0,
    };

    const agentStates: (AgentState | undefined)[] = [];
    terminals.forEach((terminal) => {
      const isLiveAgent = deriveTerminalChrome(terminal).isAgent;
      // Plain terminals and demoted ex-agents are counted as sessions, but
      // they must not contribute stale agent states to sidebar badges.
      const state = isLiveAgent ? (terminal.agentState ?? "idle") : "idle";
      byState[state] = (byState[state] || 0) + 1;

      if (isLiveAgent && terminal.agentState) {
        agentStates.push(terminal.agentState);
      }
    });

    const dominantAgentState = getDominantAgentState(agentStates);

    return {
      terminals,
      counts: {
        total: terminals.length,
        byState,
      },
      dominantAgentState,
    };
  }, [terminals]);

  // Debounce counts to prevent UI jitter during rapid state changes (e.g., app restart)
  const debouncedCounts = useDebouncedValue(result.counts, 250);

  return {
    terminals: result.terminals,
    counts: debouncedCounts,
    dominantAgentState: result.dominantAgentState,
  };
}
