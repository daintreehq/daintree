import { z } from "zod";
import { ScheduleSchema, type Schedule } from "../../shared/types/scheduledRuns.js";

export const SCHEDULES_SCHEMA_VERSION = 1;

const SchedulesFileSchema = z.strictObject({
  _schemaVersion: z.literal(SCHEDULES_SCHEMA_VERSION),
  schedules: z.array(ScheduleSchema),
});

export type SchedulesDecodeResult =
  | { ok: true; schedules: Schedule[] }
  | { ok: false; reason: "corrupt" }
  | { ok: false; reason: "future-version"; onDiskVersion: number };

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

  const result = SchedulesFileSchema.safeParse(parsed);
  if (!result.success) return { ok: false, reason: "corrupt" };

  // A record filed under another project, or a repeated id, is not a file
  // this store wrote.
  const ids = new Set<string>();
  for (const schedule of result.data.schedules) {
    if (schedule.projectId !== projectId || ids.has(schedule.id)) {
      return { ok: false, reason: "corrupt" };
    }
    ids.add(schedule.id);
  }
  return { ok: true, schedules: result.data.schedules };
}

/** Builds the envelope field by field, so nothing riding on a record reaches the top level. */
export function encodeSchedulesFile(schedules: readonly Schedule[]): string {
  return JSON.stringify({ _schemaVersion: SCHEDULES_SCHEMA_VERSION, schedules }, null, 2);
}
