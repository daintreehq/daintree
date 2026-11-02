import { describe, expect, it } from "vitest";
import {
  SCHEDULES_SCHEMA_VERSION,
  decodeSchedulesFile,
  encodeSchedulesFile,
} from "../schedulesCodec.js";
import { createSchedule } from "../../../shared/utils/scheduledRuns.js";
import {
  SCHEDULE_SWITCHES_OFF,
  type ProjectScheduleSwitches,
  type Schedule,
} from "../../../shared/types/scheduledRuns.js";

const PROJECT = "a".repeat(64);
const OTHER_PROJECT = "b".repeat(64);
const NOW = Date.UTC(2026, 10, 1, 12);

const ON: ProjectScheduleSwitches = {
  schedulesOn: true,
  startWhenClosed: true,
  schedulesOnSince: NOW,
};

function schedule(id: string, projectId = PROJECT, runWhenClosed = false): Schedule {
  return createSchedule(
    {
      id,
      projectId,
      name: `Schedule ${id}`,
      launch: { agentId: "claude", prompt: "  Keep this prompt exactly.\n" },
      timeZone: "Europe/London",
      policies: { runWhenClosed },
    },
    NOW
  );
}

function file(schedules: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    _schemaVersion: SCHEDULES_SCHEMA_VERSION,
    switches: SCHEDULE_SWITCHES_OFF,
    schedules,
    ...extra,
  });
}

function v1File(schedules: unknown[]): string {
  return JSON.stringify({ _schemaVersion: 1, schedules });
}

describe("schedules codec", () => {
  it("reads back exactly what it wrote, prompt whitespace included", () => {
    const schedules = [schedule("one"), schedule("two")];

    for (const switches of [
      ON,
      { schedulesOn: true, startWhenClosed: false, schedulesOnSince: null },
      { schedulesOn: false, startWhenClosed: true, schedulesOnSince: NOW - 1 },
    ]) {
      const decoded = decodeSchedulesFile(encodeSchedulesFile({ switches, schedules }), PROJECT);
      expect(decoded).toEqual({ ok: true, switches, schedules });
    }
  });

  it("reads an empty list", () => {
    expect(decodeSchedulesFile(file([]), PROJECT)).toEqual({
      ok: true,
      switches: SCHEDULE_SWITCHES_OFF,
      schedules: [],
    });
  });

  describe("a file from before the project's switches (#16166)", () => {
    it("keeps a project with schedules firing, and Daintree starting for them when one asked", () => {
      const schedules = [schedule("one"), schedule("two", PROJECT, true)];

      expect(decodeSchedulesFile(v1File(schedules), PROJECT)).toEqual({
        ok: true,
        switches: { schedulesOn: true, startWhenClosed: true, schedulesOnSince: null },
        schedules,
      });
    });

    it("keeps Daintree from starting when no schedule asked for it", () => {
      const schedules = [schedule("one")];

      expect(decodeSchedulesFile(v1File(schedules), PROJECT)).toEqual({
        ok: true,
        switches: { schedulesOn: true, startWhenClosed: false, schedulesOnSince: null },
        schedules,
      });
    });

    it("turns both off for a project with no schedules", () => {
      expect(decodeSchedulesFile(v1File([]), PROJECT)).toEqual({
        ok: true,
        switches: SCHEDULE_SWITCHES_OFF,
        schedules: [],
      });
    });

    it("is read whole or not at all, as today's file is", () => {
      const { enabled: _enabled, ...missing } = schedule("one");

      expect(decodeSchedulesFile(v1File([missing]), PROJECT)).toEqual({
        ok: false,
        reason: "corrupt",
      });
      expect(
        decodeSchedulesFile(
          JSON.stringify({ _schemaVersion: 1, switches: ON, schedules: [] }),
          PROJECT
        )
      ).toEqual({ ok: false, reason: "corrupt" });
    });
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
    [
      "no schedules array",
      JSON.stringify({ _schemaVersion: SCHEDULES_SCHEMA_VERSION, switches: SCHEDULE_SWITCHES_OFF }),
    ],
    ["no switches", JSON.stringify({ _schemaVersion: SCHEDULES_SCHEMA_VERSION, schedules: [] })],
    ["a switch that isn't a boolean", file([], { switches: { ...ON, schedulesOn: "yes" } })],
    ["an unknown switch", file([], { switches: { ...ON, wakeMachine: true } })],
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

  it("writes only the version, the switches and the list at the top level", () => {
    const forged = { ...schedule("one"), _schemaVersion: 99 } as unknown as Schedule;
    const switches = { ...ON, extra: true } as unknown as ProjectScheduleSwitches;

    const written = JSON.parse(encodeSchedulesFile({ switches, schedules: [forged] })) as Record<
      string,
      unknown
    >;

    expect(Object.keys(written).sort()).toEqual(["_schemaVersion", "schedules", "switches"]);
    expect(written._schemaVersion).toBe(SCHEDULES_SCHEMA_VERSION);
    expect(written.switches).toEqual(ON);
  });
});
