import { buildResumeCommand, buildResumeLatestCommand } from "@shared/types/agentSettings";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import type { ScheduledRun, ScheduledRunTrigger } from "@shared/types/scheduledRuns";
import { machineTimeZone } from "@shared/utils/cron";
import { localDayNumber } from "./scheduleWords";

export const TRIGGER_WORDS: Record<ScheduledRunTrigger, string> = {
  scheduled: "Scheduled",
  "catch-up": "Catch-up",
  "run-now": "Run now",
  "os-launch": "OS launch",
};

/** When the run's terminal was seen to start, or null when no start was seen. */
export function runStartedAt(run: ScheduledRun): number | null {
  const { pty } = run.process;
  return pty.state === "not-started" ? null : pty.startedAt;
}

/** The instant a run is filed under: when it started, else when it was due, else when it was registered. */
export function runReferenceAt(run: ScheduledRun): number {
  return runStartedAt(run) ?? run.origin.dueAt ?? run.createdAt;
}

/**
 * How long the run took to settle, or has run so far while it's open. Null when
 * it never started, and for an interrupted run, which was settled at the next
 * startup and so says nothing about when it stopped.
 */
export function runDuration(
  run: ScheduledRun,
  now: number
): { ms: number; ongoing: boolean } | null {
  const started = runStartedAt(run);
  if (started === null) return null;
  const { settlement } = run;
  if (settlement.state === "open") return { ms: Math.max(0, now - started), ongoing: true };
  if (settlement.outcome === "interrupted") return null;
  return { ms: Math.max(0, settlement.settledAt - started), ongoing: false };
}

/** The agent's own words, or the recorded reason a run went the way it did. */
export interface RunDetail {
  kind: "summary" | "reason";
  text: string;
}

export function runDetail(run: ScheduledRun): RunDetail | null {
  const { settlement } = run;
  if (settlement.state !== "settled") return null;
  const { evidence } = settlement;
  const reason = (text: string): RunDetail => ({ kind: "reason", text });
  switch (evidence.kind) {
    case "handback": {
      const summary = evidence.summary?.trim();
      if (!summary) return null;
      // A summary cut at the capture's cap says so, rather than reading as the whole claim.
      return { kind: "summary", text: evidence.truncated ? `${summary}…` : summary };
    }
    case "skip": {
      const skip = evidence.reason;
      if (skip.kind === "missed") {
        return reason("Missed while the computer slept or Daintree was closed");
      }
      if (skip.kind === "overlap") return reason("The last run was still going");
      if (skip.error !== null) return reason(`The check command couldn't run: ${skip.error}`);
      if (skip.signal !== null) {
        return reason(`The check command was stopped by signal ${skip.signal}`);
      }
      if (skip.exitCode !== null) return reason(`The check command exited with ${skip.exitCode}`);
      return reason("The check command didn't pass");
    }
    case "launch-error": {
      // Main's refusals are sentences; a single-clause one drops its full stop, as every line here does.
      const message = evidence.message.trim();
      return reason(/[.!?]\s/.test(message) ? message : message.replace(/\.$/, ""));
    }
    case "cancel":
      return reason("You stopped it");
    case "replace":
      return reason("A newer run took its place");
    case "lost":
      return reason("Its terminal ended with no exit seen");
    case "interrupted":
      return reason("Daintree quit or crashed while it ran");
    case "exit":
      return null;
  }
}

export type RunAction =
  | { kind: "open" }
  | { kind: "resume"; sessionId: string }
  /**
   * No action: `label` stands where the button would and `explanation` says why.
   * A null label leaves the place empty, for a run whose row already says it never started.
   */
  | { kind: "none"; label: string | null; explanation: string };

/**
 * What a run offers: Open while its terminal is still in this view, Resume once
 * it's gone and the conversation can be reopened, and otherwise why neither.
 */
export function runAction(
  run: ScheduledRun,
  context: { terminalExists: boolean; worktreeIds: ReadonlySet<string> }
): RunAction {
  // A pane whose terminal was never seen to start holds only its launch error,
  // which the row already says; Open would show nothing more.
  const seenStarting = runStartedAt(run) !== null || run.settlement.state === "open";
  if (context.terminalExists && seenStarting) return { kind: "open" };
  const neverStarted =
    run.process.pty.state === "not-started" &&
    run.settlement.state === "settled" &&
    (run.settlement.evidence.kind === "skip" || run.settlement.evidence.kind === "launch-error");
  if (neverStarted || run.resume === null) {
    return {
      kind: "none",
      label: null,
      explanation: "This run never started, so there's no conversation to reopen",
    };
  }
  const { resume } = run;
  const agentName = getEffectiveAgentConfig(resume.agentId)?.name ?? resume.agentId;
  if (resume.agentSessionId === null) {
    return run.settlement.state === "open"
      ? {
          kind: "none",
          label: "No session yet",
          explanation: `${agentName} hasn't reported a session for this run yet`,
        }
      : {
          kind: "none",
          label: "No session saved",
          explanation: `${agentName} didn't report a session for this run, so there's no conversation to reopen`,
        };
  }
  if (resume.worktreeId !== null && !context.worktreeIds.has(resume.worktreeId)) {
    return {
      kind: "none",
      label: "Worktree removed",
      explanation:
        "The worktree this run worked in has been removed, so its conversation can't be reopened there",
    };
  }
  const resumable =
    buildResumeCommand(resume.agentId, resume.agentSessionId, resume.agentLaunchFlags) ??
    buildResumeLatestCommand(resume.agentId, resume.agentLaunchFlags);
  if (!resumable) {
    return {
      kind: "none",
      label: "Can't resume",
      explanation: `${agentName} doesn't support resuming a conversation`,
    };
  }
  return { kind: "resume", sessionId: resume.agentSessionId };
}

/** "Today", "Yesterday", or the date, in the schedule's zone. */
export function runDayLabel(epochMs: number, now: number, timeZone: string): string {
  const days = localDayNumber(now, timeZone) - localDayNumber(epochMs, timeZone);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const year = (at: number) =>
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(at);
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(year(epochMs) === year(now) ? {} : { year: "numeric" }),
    timeZone,
  }).format(epochMs);
}

/** Keeps "3:15 AM" on one line wherever it wraps. */
function unbroken(text: string): string {
  return text.replace(/\s/g, "\u00a0");
}

/** A time of day in the schedule's zone ("2:00 AM"). */
export function formatRunTime(epochMs: number, timeZone: string): string {
  return unbroken(
    new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone }).format(
      epochMs
    )
  );
}

/**
 * The full instant, to the second, for a hover: the row's short times hide a
 * few seconds' lateness and the date. The zone is named when it isn't this machine's.
 */
export function formatRunExact(epochMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZone,
    ...(timeZone !== machineTimeZone() ? { timeZoneName: "short" } : {}),
  }).format(epochMs);
}

/** The time a run was due, with its weekday when that isn't the day it's filed under. */
export function formatDueTime(dueAt: number, referenceAt: number, timeZone: string): string {
  if (localDayNumber(dueAt, timeZone) === localDayNumber(referenceAt, timeZone)) {
    return formatRunTime(dueAt, timeZone);
  }
  return unbroken(
    new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
      timeZone,
    }).format(dueAt)
  );
}
