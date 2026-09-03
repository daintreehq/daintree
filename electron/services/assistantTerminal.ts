import { getAgentAvailabilityStore } from "./AgentAvailabilityStore.js";

/**
 * The subset of a backend terminal record this predicate needs. Every generic
 * path already holds something of this shape — the pty-host record, a
 * `getAllTerminalsAsync` snapshot, or a `get-terminal` response.
 */
export interface AssistantTerminalCandidate {
  id: string;
  isAssistantTerminal?: boolean;
}

/**
 * Whether a terminal record belongs to the Daintree Assistant overlay rather
 * than the grid.
 *
 * The single predicate every generic terminal path consults, so the assistant
 * cannot fall into a filter's default "treat as an ordinary pane" bucket the
 * way it did in #12183 — where a project sleep journaled it into the resume
 * picker and hydration adopted its live PTY as a grid pane.
 *
 * Two sources, deliberately OR'd:
 *
 * - `isAssistantTerminal` — sealed onto the record at spawn from the spawn
 *   handler's validated help token. Authoritative and durable: it is readable
 *   from a snapshot taken before a kill, which is the only thing the teardown
 *   paths have once the PTY is gone.
 * - `AgentAvailabilityStore.isHelpTerminal` — the pre-existing renderer mark
 *   (`help.markTerminal`). Kept as a fallback because it also covers records
 *   that predate the stamp, such as a terminal adopted across a pty-host
 *   restart. On its own it is race-prone: the renderer sends it only after the
 *   spawn IPC has returned, so there is a window where the PTY is live and the
 *   mark has not landed — which is what let hydration adopt the assistant.
 *
 * Neither `HelpSessionService.isHelpTerminal` nor `launchAgentId` works here.
 * The former is a *live binding* that goes false on revoke/displace/unbind, so
 * it is already gone by the time a teardown path journals. The latter is just
 * a launch hint: the assistant can be backed by `claude`/`codex`/`copilot`, so
 * its `launchAgentId` is indistinguishable from a user-launched agent's.
 *
 * Fails open, and never throws. This runs inside the shutdown and project-
 * teardown journal loops, whose surrounding best-effort catches would turn one
 * throw here into "no resume records for anything" — far worse than the single
 * stray assistant record a false answer costs. The record stamp is consulted
 * first, so a stamped assistant is still skipped even if the store is
 * unavailable.
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
