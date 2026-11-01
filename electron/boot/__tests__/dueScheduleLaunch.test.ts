import { describe, expect, it } from "vitest";
import { isDueScheduleCheckRequested } from "../dueScheduleLaunch.js";

describe("dueScheduleLaunch", () => {
  it("recognises only the bare switch", () => {
    expect(isDueScheduleCheckRequested(["daintree", "--run-due-schedules"])).toBe(true);
    expect(isDueScheduleCheckRequested(["daintree"])).toBe(false);
    expect(isDueScheduleCheckRequested(["daintree", "--run-due-schedules=1"])).toBe(false);
    expect(isDueScheduleCheckRequested(["daintree", "run-due-schedules"])).toBe(false);
  });
});
