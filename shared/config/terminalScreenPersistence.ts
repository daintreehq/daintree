import { isHostThrowawayTerminalId } from "./hostThrowaway.js";

/**
 * Every guided Decisions relay deploy's terminal id starts with this (#16023).
 * The deploy prints the relay's claim secret, which Daintree never writes to
 * disk, so the pane's screen must never reach a session snapshot.
 */
export const DECISIONS_DEPLOY_TERMINAL_PREFIX = "daintree-decisions-deploy-";

/**
 * Every guided Decisions relay update's terminal id starts with this (#16201).
 * Its command runs once and ends the PTY with its own exit status, which is
 * how Settings learns the update finished.
 */
export const DECISIONS_UPDATE_TERMINAL_PREFIX = "daintree-decisions-update-";

export function isDecisionsDeployTerminalId(terminalId: string): boolean {
  return terminalId.startsWith(DECISIONS_DEPLOY_TERMINAL_PREFIX);
}

export function isDecisionsUpdateTerminalId(terminalId: string): boolean {
  return terminalId.startsWith(DECISIONS_UPDATE_TERMINAL_PREFIX);
}

/**
 * A pane that runs a Decisions relay operation against the user's Cloudflare
 * account: a deploy or an update. Its command runs once, from the spawn, and
 * nothing that replays a pane (a restart, duplicate, restored layout, recipe
 * or pty-host crash) runs it again.
 */
export function isDecisionsRelayTerminalId(terminalId: string): boolean {
  return isDecisionsDeployTerminalId(terminalId) || isDecisionsUpdateTerminalId(terminalId);
}

/**
 * Whether a terminal's screen stays in memory only: never written to a session
 * snapshot, so a restart brings back none of it. The pty-host knows a terminal
 * only by its id, so the policy is carried by the id itself.
 */
export function isScreenNeverSaved(terminalId: string): boolean {
  return isHostThrowawayTerminalId(terminalId) || isDecisionsRelayTerminalId(terminalId);
}
