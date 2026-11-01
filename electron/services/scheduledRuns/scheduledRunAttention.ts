import type { ScheduledRun } from "../../../shared/types/scheduledRuns.js";

/**
 * Why a settled run needs a person (#15988). Nothing else does: a run that
 * finished, was skipped by its policy, was replaced, cancelled, lost or
 * interrupted is in its history and pages nobody.
 */
export type ScheduledRunAttention =
  | { kind: "launch-failed" }
  | { kind: "exited"; process: "agent" | "pty"; exitCode: number }
  | { kind: "needs-you" };

/**
 * Read from the settled record's evidence, the fact it settled on. An exit
 * counts only with a non-zero code: one ended by a signal alone is how
 * Daintree's own kills end a terminal (the trash's expiry, a kill), so it
 * says nothing about the agent's work.
 */
export function scheduledRunAttention(run: ScheduledRun): ScheduledRunAttention | null {
  const { settlement } = run;
  if (settlement.state !== "settled") return null;
  const { evidence } = settlement;
  switch (evidence.kind) {
    case "launch-error":
      return { kind: "launch-failed" };
    case "exit":
      return evidence.exitCode !== null && evidence.exitCode !== 0
        ? { kind: "exited", process: evidence.process, exitCode: evidence.exitCode }
        : null;
    case "handback":
      return evidence.report === "needs-you" ? { kind: "needs-you" } : null;
    default:
      return null;
  }
}

export interface ScheduledRunAttentionNames {
  /** The schedule's name, or null when it couldn't be read. */
  scheduleName: string | null;
  /** The run's agent as people know it. */
  agentName: string;
}

/**
 * A banner's words. Names and codes only: the agent's summary and a launch
 * error's reason stay in the history the click opens, so nothing the agent
 * wrote is put on the lock screen.
 */
export function describeScheduledRunAttention(
  attention: ScheduledRunAttention,
  { scheduleName, agentName }: ScheduledRunAttentionNames
): { title: string; body: string } {
  const schedule = scheduleName === null ? "a scheduled run" : `"${scheduleName}"`;
  switch (attention.kind) {
    case "launch-failed":
      return {
        title: "Scheduled run couldn't start",
        body: `${agentName} didn't launch for ${schedule}. Its history says why.`,
      };
    case "exited": {
      const who = attention.process === "agent" ? agentName : `${agentName}'s terminal`;
      return {
        title: "Scheduled run failed",
        body: `${who} exited with code ${attention.exitCode} during ${schedule}.`,
      };
    }
    case "needs-you":
      return {
        title: "Scheduled run needs you",
        body: `${agentName} handed back ${schedule} for you to look at.`,
      };
  }
}
