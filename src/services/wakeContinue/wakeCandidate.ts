/**
 * One agent pane a restore started again from its snapshot (#17883), and what
 * its launch did with the conversation it had.
 *
 * - `resumed`: launched with its agent's resume command.
 * - `fresh`: launched without one, so the conversation it had is not there.
 * - `held`: not launched; the pane waits for the user (the resume setting, a
 *   plugin's hold, or a choice only the user can make).
 */
export interface WakeCandidate {
  terminalId: string;
  title: string;
  agentId: string;
  worktreeId: string | null;
  outcome: "resumed" | "fresh" | "held";
  /** Why a held pane is held, as restore recorded it. */
  holdReason?: string;
  /** When the restore pass that launched it began (epoch ms). */
  restoredAt: number;
}
