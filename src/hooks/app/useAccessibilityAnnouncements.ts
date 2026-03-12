import { useEffect, useRef } from "react";
import { useTerminalStore } from "@/store";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import type { AgentState } from "@shared/types/domain";

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
    case "failed":
      return { msg: `${title} encountered an error`, priority: "assertive" };
    default:
      return null;
  }
}

export function useAccessibilityAnnouncements() {
  const isFirstMount = useRef(true);
  const previousStatesRef = useRef<Map<string, TerminalStateSnapshot>>(new Map());
  const debounceTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const focusedId = useTerminalStore((s) => s.focusedId);
  const terminals = useTerminalStore((s) => s.terminals);

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

      newStates.set(terminal.id, {
        agentState: terminal.agentState,
        stateChangeConfidence: terminal.stateChangeConfidence,
      });

      const prev = prevStates.get(terminal.id);
      if (!prev || prev.agentState === terminal.agentState) continue;

      // Skip low-confidence heuristic transitions
      if (terminal.stateChangeConfidence !== undefined && terminal.stateChangeConfidence < 0.7) {
        continue;
      }

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
    return () => {
      for (const timer of debounceTimersRef.current.values()) {
        clearTimeout(timer);
      }
      debounceTimersRef.current.clear();
    };
  }, []);
}
