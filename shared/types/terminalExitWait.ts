import { z } from "zod";
import { MAX_BATCH_SENDS } from "./mcpBatch.js";

/**
 * Waiting for a closed panel's process to exit (#15728). A close trashes the
 * panel and its process runs on through the trash grace, so a caller about to
 * delete the worktree under it has to know when it is gone. Answered in main,
 * from what the pty-host reported, so a deadline passing is never read as an
 * exit and a panel the trash has already let go still reports how it ended.
 */
export const DEFAULT_TERMINAL_EXIT_WAIT_MS = 30_000;
/** Above the trash grace plus a graceful shutdown and its kill escalation. */
export const MAX_TERMINAL_EXIT_WAIT_MS = 60_000;

export const TerminalWaitForExitArgsSchema = z.object({
  terminalIds: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_BATCH_SENDS)
    .describe("1-16 panels this session closed."),
  timeoutMs: z
    .number()
    .int()
    .min(0)
    .max(MAX_TERMINAL_EXIT_WAIT_MS)
    .optional()
    .describe("Shared deadline, 0 to 60000; default 30000. 0 reads once."),
  endGrace: z
    .boolean()
    .optional()
    .describe("Start shutting down those still in the trash now, not when the grace ends."),
});

export type TerminalWaitForExitArgs = z.infer<typeof TerminalWaitForExitArgsSchema>;

export const TERMINAL_EXIT_OUTCOMES = ["exited", "running", "unknown"] as const;
export type TerminalExitOutcome = (typeof TERMINAL_EXIT_OUTCOMES)[number];

export const TerminalExitObservationSchema = z.object({
  terminalId: z.string(),
  outcome: z
    .enum(TERMINAL_EXIT_OUTCOMES)
    .describe("exited: the host saw it exit; running: still alive at the deadline."),
  exitCode: z.number().optional(),
  signal: z.number().optional(),
  graceEnded: z
    .boolean()
    .optional()
    .describe("With endGrace: true when this call started its shutdown."),
});

export type TerminalExitObservation = z.infer<typeof TerminalExitObservationSchema>;

export const TerminalWaitForExitResultSchema = z.object({
  processes: z.array(TerminalExitObservationSchema),
});

export type TerminalWaitForExitResult = z.infer<typeof TerminalWaitForExitResultSchema>;
