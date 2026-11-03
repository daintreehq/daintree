import { isHostThrowawayTerminalId } from "./hostThrowaway.js";

/**
 * Every guided Decisions relay deploy's terminal id starts with this (#16023).
 * The person types API keys at its prompts, and the CLI before 0.3.0 printed
 * the relay's claim secret (#16199 has it hand the secret to main instead),
 * so the pane's screen must never reach a session snapshot.
 */
export const DECISIONS_DEPLOY_TERMINAL_PREFIX = "daintree-decisions-deploy-";

/**
 * Every guided Decisions relay update's terminal id starts with this (#16201).
 * Its command runs once and ends the PTY with its own exit status, which is
 * how Settings learns the update finished.
 */
export const DECISIONS_UPDATE_TERMINAL_PREFIX = "daintree-decisions-update-";

/**
 * Every guided Decisions relay removal's terminal id starts with this (#16202).
 * Main runs its CLI as the PTY's own process, so the PTY ends with the CLI's
 * status, which is what tells Daintree the removal finished.
 */
export const DECISIONS_REMOVE_TERMINAL_PREFIX = "daintree-decisions-remove-";

export function isDecisionsDeployTerminalId(terminalId: string): boolean {
  return terminalId.startsWith(DECISIONS_DEPLOY_TERMINAL_PREFIX);
}

export function isDecisionsUpdateTerminalId(terminalId: string): boolean {
  return terminalId.startsWith(DECISIONS_UPDATE_TERMINAL_PREFIX);
}

export function isDecisionsRemoveTerminalId(terminalId: string): boolean {
  return terminalId.startsWith(DECISIONS_REMOVE_TERMINAL_PREFIX);
}

/**
 * A pane that runs a Decisions relay operation against the user's Cloudflare
 * account: a deploy, an update or a removal. Its command runs once, from the
 * spawn, and nothing that replays a pane (a restart, duplicate, restored
 * layout, recipe or pty-host crash) runs it again.
 */
export function isDecisionsRelayTerminalId(terminalId: string): boolean {
  return (
    isDecisionsDeployTerminalId(terminalId) ||
    isDecisionsUpdateTerminalId(terminalId) ||
    isDecisionsRemoveTerminalId(terminalId)
  );
}

/**
 * Whether a terminal's screen stays in memory only: never written to a session
 * snapshot, so a restart brings back none of it. The pty-host knows a terminal
 * only by its id, so the policy is carried by the id itself. A removal's screen
 * is kept off disk too, so a restored pane never shows a "Removed." that
 * Daintree didn't act on.
 */
export function isScreenNeverSaved(terminalId: string): boolean {
  return isHostThrowawayTerminalId(terminalId) || isDecisionsRelayTerminalId(terminalId);
}
