import type { TerminalInstance } from "@shared/types";
import { CLOSE_CONFIRM_AGENT_STATES, coerceAgentState } from "@shared/types/agent";
import { isAgentTerminal } from "@/utils/terminalType";

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
export function terminalHasRunningAgentSession(
  terminal: TerminalInstance | undefined | null
): boolean {
  if (!terminal) return false;
  if (!isAgentTerminal(terminal)) return false;
  const state = coerceAgentState(terminal.agentState);
  return state !== undefined && CLOSE_CONFIRM_AGENT_STATES.has(state);
}

/**
 * Filter a list of terminals down to those with a running agent session.
 * Used by bulk actions to decide whether to confirm before mutating.
 */
export function collectRunningAgentTerminals(
  terminals: ReadonlyArray<TerminalInstance>
): TerminalInstance[] {
  return terminals.filter((t) => terminalHasRunningAgentSession(t));
}
