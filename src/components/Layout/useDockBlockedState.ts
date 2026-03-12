import { useEffect, useRef, useState } from "react";
import type { AgentState } from "shared/types/domain";

type BlockedState = "waiting" | "failed" | null;

const DEBOUNCE_MS = 800;

function toBlockedState(agentState: AgentState | undefined): BlockedState {
  if (agentState === "waiting") return "waiting";
  if (agentState === "failed") return "failed";
  return null;
}

export function useDockBlockedState(agentState: AgentState | undefined): BlockedState {
  const rawState = toBlockedState(agentState);
  const [debouncedState, setDebouncedState] = useState<BlockedState>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (rawState !== null) {
      // Entering or switching between blocked states
      if (debouncedState !== null) {
        // Already in a blocked state — swap immediately
        setDebouncedState(rawState);
      } else {
        // Entering blocked from non-blocked — delay
        timerRef.current = setTimeout(() => {
          setDebouncedState(rawState);
        }, DEBOUNCE_MS);
      }
    } else {
      // Leaving blocked state — clear immediately
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setDebouncedState(null);
    }

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [rawState]); // eslint-disable-line react-hooks/exhaustive-deps

  return debouncedState;
}

export function getGroupBlockedAgentState(
  panels: ReadonlyArray<{ agentState?: AgentState }>
): AgentState | undefined {
  let hasWaiting = false;
  let hasFailed = false;

  for (const panel of panels) {
    if (panel.agentState === "waiting") hasWaiting = true;
    if (panel.agentState === "failed") hasFailed = true;
  }

  if (hasWaiting) return "waiting";
  if (hasFailed) return "failed";
  return undefined;
}
