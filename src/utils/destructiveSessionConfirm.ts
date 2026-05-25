import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";
import { CLOSE_CONFIRM_AGENT_STATES, coerceAgentState } from "@shared/types/agent";
import { isAgentTerminal } from "@/utils/terminalType";
import { isPtyPanel } from "@shared/types/panel";

// Carrier element from the legacy `panelsById` shape, sourced through
// `getNarrowPanel`'s parameter so this file doesn't import the deprecated
// `TerminalInstance` alias by name. Lets external callers that still hand
// out raw carrier entries pass through until the rest of the renderer
// migrates to `getNarrowPanel` (#8957).
type CarrierPanel = Parameters<typeof getNarrowPanel>[0][string];

/**
 * True when a terminal is an agent terminal AND is currently in an
 * agent-state that represents in-flight work that would be lost on
 * kill/restart. Mirrors the gate at `shared/types/agent.CLOSE_CONFIRM_AGENT_STATES`
 * ("working" only — "waiting"/"directing" are agent-paused states where
 * stopping is non-disruptive).
 *
 * Used to gate the confirm dialogs for `terminal.kill`, `terminal.restart`,
 * and their bulk siblings: bare PTY terminals stay D0 (no confirm), agent
 * terminals only confirm while truly mid-work.
 */
export function terminalHasRunningAgentSession(terminal: CarrierPanel | undefined | null): boolean {
  if (!terminal) return false;
  if (!isAgentTerminal(terminal)) return false;
  const state = coerceAgentState(isPtyPanel(terminal) ? terminal.agentState : undefined);
  return state !== undefined && CLOSE_CONFIRM_AGENT_STATES.has(state);
}

/**
 * Filter a list of terminals down to those with a running agent session.
 * Used by bulk actions to decide whether to confirm before mutating.
 */
export function collectRunningAgentTerminals(
  terminals: ReadonlyArray<CarrierPanel>
): CarrierPanel[] {
  return terminals.filter((t) => terminalHasRunningAgentSession(t));
}
