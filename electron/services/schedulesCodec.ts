import { z } from "zod";
import {
  ProjectScheduleSwitchesSchema,
  ScheduleSchema,
  type ProjectScheduleSwitches,
  type Schedule,
} from "../../shared/types/scheduledRuns.js";

export const SCHEDULES_SCHEMA_VERSION = 2;

/** Before the project's switches (#16166): every schedule fired, and each asked for the OS job itself. */
const SchedulesFileV1Schema = z.strictObject({
  _schemaVersion: z.literal(1),
  schedules: z.array(ScheduleSchema),
});

const SchedulesFileSchema = z.strictObject({
  _schemaVersion: z.literal(SCHEDULES_SCHEMA_VERSION),
  switches: ProjectScheduleSwitchesSchema,
  schedules: z.array(ScheduleSchema),
});

/** A project's schedules and its switches, as one file holds them. */
export interface SchedulesFile {
  switches: ProjectScheduleSwitches;
  schedules: Schedule[];
}

export type SchedulesDecodeResult =
  | ({ ok: true } & SchedulesFile)
  | { ok: false; reason: "corrupt" }
  | { ok: false; reason: "future-version"; onDiskVersion: number };

/**
 * The switches a project from before them behaves as: its schedules on when
 * it has any, and Daintree started for them when one of them asked for that.
 * A project with none starts with both off.
 */
export function switchesBefore(schedules: readonly Schedule[]): ProjectScheduleSwitches {
  return {
    schedulesOn: schedules.length > 0,
    startWhenClosed: schedules.some((schedule) => schedule.policies.runWhenClosed),
    schedulesOnSince: null,
  };
}

/**
 * Total: never throws. A file is read whole or not at all. One record that
 * fails today's schema makes the file unreadable rather than being dropped,
 * because every schedule in it runs an agent unattended: losing one silently
 * is as wrong as running one this build can't represent.
 */
export function decodeSchedulesFile(raw: string, projectId: string): SchedulesDecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "corrupt" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "corrupt" };
  }

  // Version before shape: a newer app's file may legitimately fail today's
  // schema, and it is kept under a name that says it is a downgrade.
  const rawVersion = (parsed as Record<string, unknown>)._schemaVersion;
  if (typeof rawVersion !== "number" || !Number.isInteger(rawVersion) || rawVersion < 0) {
    return { ok: false, reason: "corrupt" };
  }
  if (rawVersion > SCHEDULES_SCHEMA_VERSION) {
    return { ok: false, reason: "future-version", onDiskVersion: rawVersion };
  }

  let file: SchedulesFile;
  if (rawVersion === 1) {
    const result = SchedulesFileV1Schema.safeParse(parsed);
    if (!result.success) return { ok: false, reason: "corrupt" };
    file = { switches: switchesBefore(result.data.schedules), schedules: result.data.schedules };
  } else {
    const result = SchedulesFileSchema.safeParse(parsed);
    if (!result.success) return { ok: false, reason: "corrupt" };
    file = { switches: result.data.switches, schedules: result.data.schedules };
  }

  // A record filed under another project, or a repeated id, is not a file
  // this store wrote.
  const ids = new Set<string>();
  for (const schedule of file.schedules) {
    if (schedule.projectId !== projectId || ids.has(schedule.id)) {
      return { ok: false, reason: "corrupt" };
    }
    ids.add(schedule.id);
  }
  return { ok: true, ...file };
}

/** Builds the envelope field by field, so nothing riding on a record reaches the top level. */
export function encodeSchedulesFile({ switches, schedules }: SchedulesFile): string {
  return JSON.stringify(
    {
      _schemaVersion: SCHEDULES_SCHEMA_VERSION,
      switches: {
        schedulesOn: switches.schedulesOn,
        startWhenClosed: switches.startWhenClosed,
        schedulesOnSince: switches.schedulesOnSince,
      },
      schedules,
    },
    null,
    2
  );
}
