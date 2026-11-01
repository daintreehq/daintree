import { isHostThrowawayTerminalId } from "./hostThrowaway.js";

/**
 * Every guided Decisions relay deploy's terminal id starts with this (#16023).
 * The deploy prints the relay's claim secret, which Daintree never writes to
 * disk, so the pane's screen must never reach a session snapshot.
 */
export const DECISIONS_DEPLOY_TERMINAL_PREFIX = "daintree-decisions-deploy-";

/**
 * Whether a terminal's screen stays in memory only: never written to a session
 * snapshot, so a restart brings back none of it. The pty-host knows a terminal
 * only by its id, so the policy is carried by the id itself.
 */
export function isScreenNeverSaved(terminalId: string): boolean {
  return (
    isHostThrowawayTerminalId(terminalId) || terminalId.startsWith(DECISIONS_DEPLOY_TERMINAL_PREFIX)
  );
}
