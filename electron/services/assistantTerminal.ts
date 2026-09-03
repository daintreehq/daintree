import { getAgentAvailabilityStore } from "./AgentAvailabilityStore.js";

export interface AssistantTerminalCandidate {
  id: string;
  isAssistantTerminal?: boolean;
}

/**
 * Whether a terminal record belongs to the Daintree Assistant overlay rather
 * than the grid. ("Assistant" here is what older main-process code calls
 * "help".)
 *
 * The single predicate every generic terminal path consults, so the assistant
 * cannot fall into a filter's default "treat as an ordinary pane" bucket the
 * way it did in #12183 — where a project sleep journaled it into the resume
 * picker and hydration adopted its live PTY as a grid pane.
 *
 * Two sources, deliberately OR'd:
 *
 * - `isAssistantTerminal` — sealed onto the record at spawn. Authoritative:
 *   it is readable from a snapshot taken before a kill, which is all a
 *   teardown path has once the PTY is gone.
 * - `AgentAvailabilityStore.isHelpTerminal` — the renderer's
 *   `help.markTerminal`, kept as a same-window fallback for unstamped
 *   records. Not sufficient alone: it lands only after the spawn IPC returns,
 *   and a second window re-initialises the store and drops it.
 *
 * Neither `HelpSessionService.isHelpTerminal` nor `launchAgentId` can stand in
 * here. The former is a live binding that goes false on revoke/displace, so it
 * is already gone by the time a teardown path journals. The latter is a launch
 * hint: the assistant can be backed by `claude`/`codex`/`copilot`, making it
 * indistinguishable from a user-launched agent.
 *
 * Fails open. This runs inside best-effort journal loops whose surrounding
 * catches would turn a throw here into "no resume records for anything" — far
 * worse than the one stray record a false answer costs. The stamp is checked
 * first, so a stamped assistant is skipped regardless.
 */
export function isAssistantTerminalRecord(
  terminal: AssistantTerminalCandidate | null | undefined
): boolean {
  if (!terminal) return false;
  if (terminal.isAssistantTerminal === true) return true;
  try {
    return getAgentAvailabilityStore().isHelpTerminal(terminal.id) === true;
  } catch {
    return false;
  }
}
