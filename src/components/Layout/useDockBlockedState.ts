import { useEffect, useRef, useState } from "react";
import type { AgentState, WaitingReason } from "@shared/types/agent";
import type { TerminalRuntimeIdentity } from "@shared/types/panel";
import { isAgentTerminal } from "@/utils/terminalType";
import { isNeedsYouPane } from "@/lib/paneSessionPresentation";

type BlockedState = "waiting" | null;

const DEBOUNCE_MS = 800;

function toBlockedState(agentState: AgentState | undefined): BlockedState {
  if (agentState === "waiting") return "waiting";
  return null;
}

type AgentStateSource = {
  id?: string;
  agentState?: AgentState;
  waitingReason?: WaitingReason;
  activityStatus?: "working" | "waiting" | "success" | "failure";
  detectedAgentId?: string;
  runtimeIdentity?: TerminalRuntimeIdentity;
  launchAgentId?: string;
  runtimeStatus?: string;
  exitCode?: number | null;
  isRestarting?: boolean;
};

function hasRuntimeAgentIdentity(panel: AgentStateSource): boolean {
  const hasIdentityFields =
    "runtimeIdentity" in panel ||
    "detectedAgentId" in panel ||
    "launchAgentId" in panel ||
    "runtimeStatus" in panel ||
    "exitCode" in panel;

  // If identity fields are present, check them definitively.
  if (hasIdentityFields) {
    return isAgentTerminal(panel);
  }

  // No identity fields present: An active agentState ("working" | "waiting" |
  // "directing") signals an in-flight agent run during the identity-boot
  // window — the backend only emits these states from agent-sourced events,
  // so trust the signal until identity fields arrive.
  if (
    panel.agentState === "working" ||
    panel.agentState === "waiting" ||
    panel.agentState === "directing"
  ) {
    return true;
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

/**
 * The state a docked group's chip edge takes from its members: waiting when
 * any agent tab is one the fleet places in `needs-you` and its pane still
 * shows stopped. A prompt that asks nothing, a hand-back, an error wait and a
 * terminal demoted from its agent don't edge it.
 */
export function getGroupBlockedAgentState(
  panels: ReadonlyArray<AgentStateSource>,
  needsYouRunIds: ReadonlySet<string>
): AgentState | undefined {
  for (const panel of panels) {
    if (panel.id === undefined || !hasRuntimeAgentIdentity(panel)) continue;
    if (isNeedsYouPane(needsYouRunIds, { ...panel, id: panel.id })) return "waiting";
  }
  return undefined;
}

/**
 * The state a grid tab group's edge takes from its members. Waiting is a hidden
 * tab the fleet places in `needs-you` — the shown tab draws its own — and
 * working is any member at work.
 */
export function getGroupAmbientAgentState(
  panels: ReadonlyArray<AgentStateSource>,
  needsYouRunIds: ReadonlySet<string>,
  shownPanelId?: string
): AgentState | undefined {
  let hasWaiting = false;
  let hasWorking = false;

  for (const panel of panels) {
    if (
      panel.id !== undefined &&
      panel.id !== shownPanelId &&
      isNeedsYouPane(needsYouRunIds, { ...panel, id: panel.id })
    ) {
      hasWaiting = true;
    } else if (getDockDisplayAgentState(panel) === "working") {
      hasWorking = true;
    }
  }

  if (hasWaiting) return "waiting";
  if (hasWorking) return "working";
  return undefined;
}

// Shared recede predicate so single pills (DockedTerminalItem) and group pills
// (DockedTabGroup) dim under identical conditions and cannot drift apart.
export function isDockAgentStateDeprioritized(agentState: AgentState | undefined): boolean {
  if (!agentState) return true;
  return agentState === "idle" || agentState === "completed" || agentState === "exited";
}

export function isGroupDeprioritized(panels: ReadonlyArray<AgentStateSource>): boolean {
  if (panels.length === 0) return false;
  return panels.every((p) => isDockAgentStateDeprioritized(getDockDisplayAgentState(p)));
}
