import { useEffect, useRef } from "react";
import { useTerminalStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import type { AgentState } from "@shared/types/agent";

interface TerminalStateSnapshot {
  agentState?: AgentState;
  stateChangeConfidence?: number;
}

function getAgentStateMessage(
  title: string,
  newState: AgentState
): { msg: string; priority: "polite" | "assertive" } | null {
  switch (newState) {
    case "working":
    case "running":
      return { msg: `${title} is working`, priority: "polite" };
    case "waiting":
      return { msg: `${title} is waiting for input`, priority: "polite" };
    case "completed":
      return { msg: `${title} finished`, priority: "polite" };
    default:
      return null;
  }
}

export function useAccessibilityAnnouncements() {
  const isFirstMount = useRef(true);
  const previousStatesRef = useRef<Map<string, TerminalStateSnapshot>>(new Map());
  const debounceTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const focusedId = useTerminalStore((s) => s.focusedId);
  const terminals = useTerminalStore(useShallow((s) => s.terminals));

  // Panel focus announcements
  useEffect(() => {
    if (isFirstMount.current) {
      isFirstMount.current = false;
      return;
    }

    if (!focusedId) return;

    const terminal = terminals.find((t) => t.id === focusedId);
    if (!terminal) return;

    useAnnouncerStore.getState().announce(`${terminal.title} panel focused`);
  }, [focusedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Agent state change announcements
  useEffect(() => {
    const prevStates = previousStatesRef.current;
    const newStates = new Map<string, TerminalStateSnapshot>();

    for (const terminal of terminals) {
      if (!terminal.agentState) continue;

      const prev = prevStates.get(terminal.id);

      // No previous state or same state — just track it
      if (!prev || prev.agentState === terminal.agentState) {
        newStates.set(terminal.id, {
          agentState: terminal.agentState,
          stateChangeConfidence: terminal.stateChangeConfidence,
        });
        continue;
      }

      // Skip low-confidence heuristic transitions — keep the previous state
      // so a later high-confidence confirmation of this state will still trigger
      if (terminal.stateChangeConfidence !== undefined && terminal.stateChangeConfidence < 0.7) {
        newStates.set(terminal.id, prev);
        continue;
      }

      // State changed with sufficient confidence — record and announce
      newStates.set(terminal.id, {
        agentState: terminal.agentState,
        stateChangeConfidence: terminal.stateChangeConfidence,
      });

      const announcement = getAgentStateMessage(terminal.title, terminal.agentState);
      if (!announcement) continue;

      // Debounce per terminal
      const existingTimer = debounceTimersRef.current.get(terminal.id);
      if (existingTimer) clearTimeout(existingTimer);

      const { msg, priority } = announcement;
      const timer = setTimeout(() => {
        useAnnouncerStore.getState().announce(msg, priority);
        debounceTimersRef.current.delete(terminal.id);
      }, 300);
      debounceTimersRef.current.set(terminal.id, timer);
    }

    previousStatesRef.current = newStates;
  }, [terminals]);

  // Cleanup debounce timers on unmount
  useEffect(() => {
    const timers = debounceTimersRef.current;
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);
}
