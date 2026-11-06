import { z } from "zod";
import { MAX_TERMINAL_EXIT_WAIT_MS, type TerminalExitObservation } from "./terminalExitWait.js";

/**
 * Retiring a worktree the calling session created, in one call (#15737): its
 * tree clean and its commits on a remote, no one else's process in it, the
 * session's own panes there closed and their processes gone, then the same
 * confirmed delete `worktree.deleteOwned` runs. Answered in main, which holds
 * the ownership ledger, the pty-host's census and the exits it kept.
 */
export const WorktreeRetireOwnedArgsSchema = z.object({
  worktreeId: z
    .string()
    .min(1)
    .describe("The `worktreeId` this session got when creating the worktree."),
  timeoutMs: z
    .number()
    .int()
    .min(0)
    .max(MAX_TERMINAL_EXIT_WAIT_MS)
    .optional()
    .describe("Wait for closed panes to exit, 0 to 60000; default 30000."),
});

export type WorktreeRetireOwnedArgs = z.infer<typeof WorktreeRetireOwnedArgsSchema>;

export interface WorktreeRetireOwnedResult {
  worktreeId: string;
  /** This session's panes the call closed. */
  closedTerminalIds: string[];
  /** Each process it waited for, as the host saw it exit. */
  processes: TerminalExitObservation[];
  /** The commit the worktree was on, found on a remote-tracking ref. */
  headOid: string;
  /** Its branch, which is kept; null when HEAD was detached. */
  branch: string | null;
}
