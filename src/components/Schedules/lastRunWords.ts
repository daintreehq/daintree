import type { ScheduledRun } from "@shared/types/scheduledRuns";
import type { StatusSeverity } from "@/lib/statusSeverity";

export interface LastRunWords {
  /** What the run recorded: "Done", "Exited with 1", "Skipped". */
  label: string;
  /** The glyph and tone, for the outcomes that carry one; neutral outcomes carry none. */
  severity: StatusSeverity | null;
  /** The instant the time beside it is read from. */
  at: number;
  /** Words before the relative time, when the time isn't when the run ended. */
  timePrefix: string | null;
  /** A fact beside the time, such as why a run was skipped. */
  detail: string | null;
}

// Each says only what the skip record holds: a missed run can follow sleep as
// well as a closed app, and an overlap means an earlier run hadn't settled.
const SKIP_DETAIL = {
  missed: "missed",
  overlap: "earlier run unsettled",
  precondition: "check didn't pass",
} as const;

function settled(
  label: string,
  severity: StatusSeverity | null,
  at: number,
  detail: string | null = null
): LastRunWords {
  return { label, severity, at, timePrefix: null, detail };
}

/**
 * A run in the list's words, read only from what the history recorded. An open
 * run is described by what was seen of its terminal, since registration comes
 * before the spawn; a settled run is its recorded outcome and the evidence behind it.
 */
export function lastRunWords(run: ScheduledRun): LastRunWords {
  const { settlement } = run;
  if (settlement.state === "open") {
    const pty = run.process.pty;
    if (pty.state === "running") {
      return {
        label: "Running",
        severity: null,
        at: pty.startedAt,
        timePrefix: "Started",
        detail: null,
      };
    }
    if (pty.state === "not-started") {
      return {
        label: "Starting",
        severity: null,
        at: run.createdAt,
        timePrefix: null,
        detail: null,
      };
    }
    return {
      label: "In progress",
      severity: null,
      at: run.createdAt,
      timePrefix: null,
      detail: null,
    };
  }
  const at = settlement.settledAt;
  const { evidence } = settlement;
  switch (settlement.outcome) {
    case "done":
      return settled("Done", "success", at);
    case "needs-you":
      return settled("Needs you", "warning", at);
    case "failed":
      if (evidence.kind === "launch-error") return settled("Failed to launch", "error", at);
      // A signal ends a process whatever code it reports, as `outcomeForEvidence` reads it.
      if (evidence.kind === "exit" && evidence.signal !== null) {
        return settled(`Signal ${evidence.signal}`, "error", at);
      }
      if (evidence.kind === "exit" && evidence.exitCode !== null) {
        return settled(`Exited with ${evidence.exitCode}`, "error", at);
      }
      return settled("Failed", "error", at);
    case "exited":
      return settled("Exited", null, at);
    case "skipped":
      return settled(
        "Skipped",
        null,
        at,
        evidence.kind === "skip" ? SKIP_DETAIL[evidence.reason.kind] : null
      );
    case "cancelled":
      return settled("Cancelled", null, at);
    case "replaced":
      return settled("Replaced", null, at);
    case "lost":
      return settled("Lost", "error", at, "no exit seen");
    case "interrupted":
      return settled("Interrupted", null, at, "Daintree stopped");
  }
}
