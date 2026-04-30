import { useEffect, useRef, useState } from "react";
import type { AgentState } from "shared/types/agent";
import type { TerminalRuntimeIdentity } from "@shared/types/panel";
import { isAgentTerminal } from "@/utils/terminalType";

type BlockedState = "waiting" | null;

const DEBOUNCE_MS = 800;

function toBlockedState(agentState: AgentState | undefined): BlockedState {
  if (agentState === "waiting") return "waiting";
  return null;
}

type AgentStateSource = {
  agentState?: AgentState;
  activityStatus?: "working" | "waiting" | "success" | "failure";
  waitingReason?: unknown;
  detectedAgentId?: string;
  runtimeIdentity?: TerminalRuntimeIdentity;
  launchAgentId?: string;
  runtimeStatus?: string;
  exitCode?: number | null;
};

function hasRuntimeAgentIdentity(panel: AgentStateSource): boolean {
  if ("runtimeIdentity" in panel || "detectedAgentId" in panel) {
    return isAgentTerminal(panel);
  }
  // Backward-compatible for unit tests and pure callers that pass only state.
  return true;
}

export function getDockDisplayAgentState(panel: AgentStateSource): AgentState | undefined {
  const hasIdentityFields =
    "runtimeIdentity" in panel ||
    "detectedAgentId" in panel ||
    "launchAgentId" in panel ||
    "runtimeStatus" in panel ||
    "exitCode" in panel;
  if (!hasIdentityFields && panel.agentState === undefined) return undefined;
  if (!hasRuntimeAgentIdentity(panel)) return undefined;

  if (
    panel.agentState === "completed" ||
    panel.agentState === "exited" ||
    panel.agentState === "directing"
  ) {
    return panel.agentState;
  }

  if (panel.activityStatus === "waiting" || panel.agentState === "waiting") {
    return "waiting";
  }

  if (panel.activityStatus === "working" || panel.agentState === "working") {
    return "working";
  }

  return panel.agentState;
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
  panels: ReadonlyArray<AgentStateSource>
): AgentState | undefined {
  for (const panel of panels) {
    if (getDockDisplayAgentState(panel) === "waiting") return "waiting";
  }
  return undefined;
}

export function getGroupAmbientAgentState(
  panels: ReadonlyArray<AgentStateSource>
): AgentState | undefined {
  let hasWaiting = false;
  let hasWorking = false;

  for (const panel of panels) {
    const state = getDockDisplayAgentState(panel);
    if (state === "waiting") hasWaiting = true;
    else if (state === "working") hasWorking = true;
  }

  if (hasWaiting) return "waiting";
  if (hasWorking) return "working";
  return undefined;
}

export function isGroupDeprioritized(panels: ReadonlyArray<AgentStateSource>): boolean {
  if (panels.length === 0) return false;
  return panels.every((p) => {
    const state = getDockDisplayAgentState(p);
    if (!state) return true;
    return state === "idle" || state === "completed" || state === "exited";
  });
}
