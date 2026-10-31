import { z } from "zod";
import { MAX_TERMINAL_EXIT_WAIT_MS, TerminalExitObservationSchema } from "./terminalExitWait.js";

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
    .describe("How long closed panes' processes get to exit, 0 to 60000; default 30000."),
});

export type WorktreeRetireOwnedArgs = z.infer<typeof WorktreeRetireOwnedArgsSchema>;

export const WorktreeRetireOwnedResultSchema = z.object({
  worktreeId: z.string(),
  closedTerminalIds: z.array(z.string()).describe("This session's panes the call closed."),
  processes: z
    .array(TerminalExitObservationSchema)
    .describe("Each awaited process, as the host saw it exit."),
  headOid: z.string().describe("The commit the worktree was on, found on a remote-tracking ref."),
  branch: z.string().nullable().describe("Its branch, kept; null when detached."),
});

export type WorktreeRetireOwnedResult = z.infer<typeof WorktreeRetireOwnedResultSchema>;
