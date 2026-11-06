import { describe, expect, it } from "vitest";
import {
  launchSpawnProvenance,
  readScheduledRunRef,
  readSpawnProvenance,
  scheduledRunForRecord,
} from "../scheduledRunProvenance.js";

const REF = { scheduleId: "schedule-1", runId: "run-1" };
const OTHER = { scheduleId: "schedule-2", runId: "run-9" };

describe("readScheduledRunRef", () => {
  it("reads both ids and drops anything else", () => {
    expect(readScheduledRunRef({ ...REF, extra: "x" })).toEqual(REF);
    expect(readScheduledRunRef(OTHER)).toEqual(OTHER);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "run-1"],
    ["an array", [REF]],
    ["a missing run id", { scheduleId: "schedule-1" }],
    ["an empty schedule id", { scheduleId: "", runId: "run-1" }],
    ["a numeric run id", { scheduleId: "schedule-1", runId: 7 }],
  ])("reads %s as no reference", (_label, value) => {
    expect(readScheduledRunRef(value)).toBeUndefined();
  });
});

describe("readSpawnProvenance", () => {
  it("keeps a schedule source with its reference", () => {
    expect(readSpawnProvenance("schedule", REF)).toEqual({
      spawnedBy: "schedule",
      scheduledRun: REF,
    });
    expect(readSpawnProvenance("schedule", OTHER).scheduledRun).toEqual(OTHER);
  });

  it("drops a schedule source whose reference doesn't read", () => {
    expect(readSpawnProvenance("schedule", { scheduleId: "schedule-1" })).toEqual({});
    expect(readSpawnProvenance("schedule", undefined)).toEqual({});
  });

  it("drops a reference on any other source", () => {
    expect(readSpawnProvenance("mcp", REF)).toEqual({ spawnedBy: "mcp" });
    expect(readSpawnProvenance(undefined, REF)).toEqual({});
  });

  it("reads an unknown source as none", () => {
    expect(readSpawnProvenance("cron", REF)).toEqual({});
  });

  it("leaves an ordinary source as it was", () => {
    expect(readSpawnProvenance("palette", undefined)).toEqual({ spawnedBy: "palette" });
  });
});

describe("launchSpawnProvenance", () => {
  it("makes a launch with a reference a schedule launch, whatever source it named", () => {
    expect(launchSpawnProvenance("mcp", REF)).toEqual({ spawnedBy: "schedule", scheduledRun: REF });
    expect(launchSpawnProvenance("palette", OTHER).scheduledRun).toEqual(OTHER);
    expect(launchSpawnProvenance(undefined, REF)).toEqual({
      spawnedBy: "schedule",
      scheduledRun: REF,
    });
  });

  it("refuses a schedule source that came without a reference", () => {
    expect(launchSpawnProvenance("schedule", undefined)).toEqual({});
  });

  it("keeps the caller's own source otherwise", () => {
    expect(launchSpawnProvenance("assistant", undefined)).toEqual({ spawnedBy: "assistant" });
    expect(launchSpawnProvenance(undefined, undefined)).toEqual({});
  });
});

describe("scheduledRunForRecord", () => {
  it("names the terminal's run", () => {
    expect(scheduledRunForRecord({ scheduledRun: REF })).toEqual({ scheduledRun: REF });
    expect(scheduledRunForRecord({ scheduledRun: OTHER, agentIncarnation: 0 })).toEqual({
      scheduledRun: OTHER,
    });
  });

  it("adds nothing for a later agent the detector saw take over the same PTY", () => {
    expect(scheduledRunForRecord({ scheduledRun: REF, agentIncarnation: 1 })).toEqual({});
  });

  it("adds nothing for a terminal no schedule launched", () => {
    expect(scheduledRunForRecord({})).toEqual({});
    expect(scheduledRunForRecord({ scheduledRun: { runId: "run-1" } })).toEqual({});
  });
});
