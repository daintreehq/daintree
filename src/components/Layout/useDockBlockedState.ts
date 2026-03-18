import { useEffect, useRef, useState } from "react";
import type { AgentState } from "shared/types/agent";

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

export function getGroupAmbientAgentState(
  panels: ReadonlyArray<{ agentState?: AgentState }>
): AgentState | undefined {
  let hasWaiting = false;
  let hasFailed = false;
  let hasWorking = false;

  for (const panel of panels) {
    if (panel.agentState === "waiting") hasWaiting = true;
    else if (panel.agentState === "failed") hasFailed = true;
    else if (panel.agentState === "working" || panel.agentState === "running") hasWorking = true;
  }

  if (hasWaiting) return "waiting";
  if (hasFailed) return "failed";
  if (hasWorking) return "working";
  return undefined;
}

export function isGroupDeprioritized(panels: ReadonlyArray<{ agentState?: AgentState }>): boolean {
  if (panels.length === 0) return false;
  return panels.every(
    (p) => !p.agentState || p.agentState === "idle" || p.agentState === "completed"
  );
}
