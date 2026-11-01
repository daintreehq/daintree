import { ScheduleSchema, type Schedule } from "../types/scheduledRuns.js";
import { parseCron, type CronField } from "./cron.js";

/** Why a schedule can't be stored, worded for the form field it names. */
export interface ScheduleIssue {
  /** The field at fault as a dotted path ("name", "cadence.cron", "launch.prompt"); empty for the record as a whole. */
  readonly path: string;
  /** For an issue with the cron expression, the cron field it names, when it names one. */
  readonly cronField: CronField | null;
  readonly message: string;
}

/**
 * Every reason `ScheduleSchema` refuses the record, or none. The messages are
 * the schema's own, which never quote the prompt or the precondition command.
 */
export function scheduleIssues(candidate: Schedule): ScheduleIssue[] {
  const result = ScheduleSchema.safeParse(candidate);
  if (result.success) return [];
  return result.error.issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    return {
      path,
      cronField: path === "cadence.cron" ? cronFieldOf(candidate) : null,
      message: issue.message,
    };
  });
}

function cronFieldOf(candidate: Schedule): CronField | null {
  const cron: unknown = candidate.cadence?.cron;
  if (typeof cron !== "string") return null;
  const parsed = parseCron(cron);
  return parsed.ok ? null : parsed.error.field;
}
