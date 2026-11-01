import { describe, expect, it } from "vitest";
import {
  isDueScheduleCheckRequested,
  startsWindowlessForDueSchedules,
} from "../dueScheduleLaunch.js";

describe("dueScheduleLaunch", () => {
  it("recognises only the bare switch", () => {
    expect(isDueScheduleCheckRequested(["daintree", "--run-due-schedules"])).toBe(true);
    expect(isDueScheduleCheckRequested(["daintree"])).toBe(false);
    expect(isDueScheduleCheckRequested(["daintree", "--run-due-schedules=1"])).toBe(false);
    expect(isDueScheduleCheckRequested(["daintree", "run-due-schedules"])).toBe(false);
  });

  it("starts windowless on macOS and Linux, and not on Windows", () => {
    const argv = ["daintree", "--run-due-schedules"];
    expect(startsWindowlessForDueSchedules({ platform: "darwin", argv })).toBe(true);
    expect(startsWindowlessForDueSchedules({ platform: "linux", argv })).toBe(true);
    expect(startsWindowlessForDueSchedules({ platform: "win32", argv })).toBe(false);
    expect(startsWindowlessForDueSchedules({ platform: "darwin", argv: ["daintree"] })).toBe(false);
  });
});
