import type {
  Schedule,
  ScheduleCadence,
  SchedulePolicies,
  ScheduledRunEvidence,
  ScheduledRunOutcome,
} from "../types/scheduledRuns.js";
import {
  machineTimeZone,
  parseCron,
  validateTimeZone,
  type CronField,
  type ParsedCron,
} from "./cron.js";

export const DEFAULT_SCHEDULE_CRON = "0 9 * * *";

export interface NewScheduleInput {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly launch: {
    readonly agentId: string;
    readonly prompt: string;
    readonly presetId?: string | null;
    readonly worktreeId?: string | null;
  };
  readonly cron?: string;
  readonly timeZone?: string;
  readonly enabled?: boolean;
  readonly policies?: Partial<SchedulePolicies>;
}

/**
 * A new schedule with every policy at its default: a missed run runs once,
 * late; an overlapping run is skipped; no precondition; the terminal is kept
 * when the agent reports done; and it runs only while Daintree is running.
 *
 * The zone is fixed here, to the machine's unless given, so a later change to
 * the machine's zone doesn't move a job nobody is watching. Creating a schedule
 * is the opt-in, so it starts enabled.
 */
export function createSchedule(input: NewScheduleInput, now: number = Date.now()): Schedule {
  const { policies } = input;
  return {
    id: input.id,
    projectId: input.projectId,
    name: input.name.trim(),
    enabled: input.enabled ?? true,
    cadence: {
      cron: (input.cron ?? DEFAULT_SCHEDULE_CRON).trim(),
      timeZone: input.timeZone ?? machineTimeZone(),
    },
    launch: {
      agentId: input.launch.agentId,
      presetId: input.launch.presetId ?? null,
      prompt: input.launch.prompt,
      worktreeId: input.launch.worktreeId ?? null,
    },
    policies: {
      missedRuns: policies?.missedRuns ?? "run-once-late",
      overlap: policies?.overlap ?? "skip",
      precondition: policies?.precondition ? { command: policies.precondition.command } : null,
      onDone: policies?.onDone ?? "keep",
      runWhenClosed: policies?.runWhenClosed ?? false,
    },
    createdAt: now,
    updatedAt: now,
  };
}

/** The key that makes an occurrence run at most once: its due instant in UTC ISO form. */
export function occurrenceKeyFor(dueAt: number): string {
  return new Date(dueAt).toISOString();
}

/** The outcome each piece of settlement evidence stands for. */
export function outcomeForEvidence(evidence: ScheduledRunEvidence): ScheduledRunOutcome {
  switch (evidence.kind) {
    case "handback":
      return evidence.report;
    case "exit":
      if (evidence.signal !== null) return "failed";
      if (evidence.exitCode === null) return "exited";
      return evidence.exitCode === 0 ? "done" : "failed";
    case "skip":
      return "skipped";
    case "launch-error":
      return "failed";
    case "cancel":
      return "cancelled";
    case "replace":
      return "replaced";
    case "lost":
      return "lost";
  }
}

export interface CadenceError {
  readonly field: "cron" | "timeZone";
  /** The cron field at fault, when the message is about one. */
  readonly cronField: CronField | null;
  readonly message: string;
}

export type CadenceValidation =
  | { readonly ok: true; readonly cron: ParsedCron; readonly timeZone: string }
  | { readonly ok: false; readonly error: CadenceError };

/** Parses a cadence once, for a form's messages or for the next-occurrence calls in `cron.ts`. */
export function validateCadence(cadence: ScheduleCadence): CadenceValidation {
  const parsed = parseCron(cadence.cron);
  if (!parsed.ok) {
    return {
      ok: false,
      error: { field: "cron", cronField: parsed.error.field, message: parsed.error.message },
    };
  }
  const zone = validateTimeZone(cadence.timeZone);
  if (!zone.ok) {
    return { ok: false, error: { field: "timeZone", cronField: null, message: zone.message } };
  }
  return { ok: true, cron: parsed.cron, timeZone: zone.timeZone };
}
