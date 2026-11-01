import { describe, expect, it } from "vitest";
import {
  SCHEDULES_SCHEMA_VERSION,
  decodeSchedulesFile,
  encodeSchedulesFile,
} from "../schedulesCodec.js";
import { createSchedule } from "../../../shared/utils/scheduledRuns.js";
import type { Schedule } from "../../../shared/types/scheduledRuns.js";

const PROJECT = "a".repeat(64);
const OTHER_PROJECT = "b".repeat(64);
const NOW = Date.UTC(2026, 10, 1, 12);

function schedule(id: string, projectId = PROJECT): Schedule {
  return createSchedule(
    {
      id,
      projectId,
      name: `Schedule ${id}`,
      launch: { agentId: "claude", prompt: "  Keep this prompt exactly.\n" },
      timeZone: "Europe/London",
    },
    NOW
  );
}

function file(schedules: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ _schemaVersion: SCHEDULES_SCHEMA_VERSION, schedules, ...extra });
}

describe("schedules codec", () => {
  it("reads back exactly what it wrote, prompt whitespace included", () => {
    const schedules = [schedule("one"), schedule("two")];

    const decoded = decodeSchedulesFile(encodeSchedulesFile(schedules), PROJECT);

    expect(decoded).toEqual({ ok: true, schedules });
  });

  it("reads an empty list", () => {
    expect(decodeSchedulesFile(file([]), PROJECT)).toEqual({ ok: true, schedules: [] });
  });

  it("keeps a newer app's file apart from damage, whatever its shape", () => {
    const raw = JSON.stringify({ _schemaVersion: SCHEDULES_SCHEMA_VERSION + 1, jobs: "anything" });

    expect(decodeSchedulesFile(raw, PROJECT)).toEqual({
      ok: false,
      reason: "future-version",
      onDiskVersion: SCHEDULES_SCHEMA_VERSION + 1,
    });
  });

  it.each([
    ["not JSON", "{"],
    ["an array", "[]"],
    ["no version", JSON.stringify({ schedules: [] })],
    ["an older version", JSON.stringify({ _schemaVersion: 0, schedules: [] })],
    ["a fractional version", JSON.stringify({ _schemaVersion: 1.5, schedules: [] })],
    ["no schedules array", JSON.stringify({ _schemaVersion: SCHEDULES_SCHEMA_VERSION })],
    ["an unknown top-level key", file([], { extra: 1 })],
  ])("treats %s as damage", (_label, raw) => {
    expect(decodeSchedulesFile(raw, PROJECT)).toEqual({ ok: false, reason: "corrupt" });
  });

  it("reads none of a file with one record today's schema refuses", () => {
    const broken = { ...schedule("two"), cadence: { cron: "0 0 30 2 *", timeZone: "UTC" } };

    expect(decodeSchedulesFile(file([schedule("one"), broken]), PROJECT)).toEqual({
      ok: false,
      reason: "corrupt",
    });
  });

  it("never fills in a field a record is missing", () => {
    const { enabled: _enabled, ...missing } = schedule("one");

    expect(decodeSchedulesFile(file([missing]), PROJECT)).toEqual({ ok: false, reason: "corrupt" });
  });

  it("refuses a record filed under another project", () => {
    expect(decodeSchedulesFile(file([schedule("one", OTHER_PROJECT)]), PROJECT)).toEqual({
      ok: false,
      reason: "corrupt",
    });
  });

  it("refuses a repeated id", () => {
    expect(decodeSchedulesFile(file([schedule("one"), schedule("one")]), PROJECT)).toEqual({
      ok: false,
      reason: "corrupt",
    });
  });

  it("writes only the version and the list at the top level", () => {
    const forged = { ...schedule("one"), _schemaVersion: 99 } as unknown as Schedule;

    const written = JSON.parse(encodeSchedulesFile([forged])) as Record<string, unknown>;

    expect(Object.keys(written).sort()).toEqual(["_schemaVersion", "schedules"]);
    expect(written._schemaVersion).toBe(SCHEDULES_SCHEMA_VERSION);
  });
});
