import type { AgentState } from "@shared/types/agent";
import type { TerminalChromeDescriptor } from "./terminalChrome";

/**
 * Resolves the display state for an agent terminal's compact activity indicator.
 *
 * Three coupled rules:
 *
 * 1. Explicit exit suppresses everything. `chrome.hasExited` flips true the
 *    moment any exit signal arrives (`exitCode`, `runtimeStatus` exited/error,
 *    `agentState` exited). This wins over a stale `agentState` because the IPC
 *    `terminal:exit` event lands before the `agent:state-changed` "exited"
 *    event — without this gate, a brief stale spinner can appear post-exit.
 *
 * 2. Active states (`working`, `waiting`, `directing`) pass through regardless
 *    of `chrome.isAgent`. This preserves the #6650 boot-window behavior where
 *    `agent:state-changed` can fire before the runtime identity commits — the
 *    indicator surfaces immediately and the icon catches up.
 *
 * 3. Once the agent chrome is live, the indicator stays visible for the agent's
 *    lifetime. `idle`, `completed`, and missing state coerce to `waiting`;
 *    monitor-derived states therefore render as working while output changes
 *    and waiting after it goes quiet. `directing` remains distinct because it
 *    is a renderer-side user-intervention state, not an activity signal.
 */
export function getTerminalAgentDisplayState(
  chrome: Pick<TerminalChromeDescriptor, "isAgent" | "hasExited">,
  agentState: AgentState | undefined
): AgentState | undefined {
  if (chrome.hasExited || agentState === "exited") return undefined;

  if (agentState === "working" || agentState === "waiting" || agentState === "directing") {
    return agentState;
  }

  if (!chrome.isAgent) return undefined;

  return "waiting";
}
