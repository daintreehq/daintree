import { describe, expect, it } from "vitest";
import { createSchedule } from "../scheduledRuns.js";
import {
  RUN_WHEN_CLOSED_PATH,
  runWhenClosedIssue,
  runWhenClosedIssues,
  type ScheduleOsJobContext,
} from "../scheduleOsJob.js";

const MAC: ScheduleOsJobContext = { kind: "launch-agent", systemTimeZone: "Europe/London" };
const LINUX: ScheduleOsJobContext = { kind: "systemd-timer", systemTimeZone: "Europe/London" };

function schedule(cron: string, runWhenClosed: boolean, timeZone = "Europe/London") {
  return createSchedule(
    {
      id: "s1",
      projectId: "p1",
      name: "Nightly",
      launch: { agentId: "claude", prompt: "Go." },
      cron,
      timeZone,
      policies: { runWhenClosed },
    },
    1
  );
}

describe("runWhenClosedIssue", () => {
  it("accepts a cadence the Mac's job can hold", () => {
    expect(runWhenClosedIssue({ cron: "0 9 * * 1-5", timeZone: "Europe/London" }, MAC)).toBeNull();
  });

  it("names why launchd can't hold a cadence", () => {
    expect(runWhenClosedIssue({ cron: "0 0 */2 * MON", timeZone: "Europe/London" }, MAC)).toMatch(
      /both the day of the month and the weekday/
    );
  });

  it("judges a Linux cadence by what a systemd timer can hold", () => {
    // Days that match both fields, which launchd can't hold, are one OnCalendar line.
    expect(
      runWhenClosedIssue({ cron: "0 0 */2 * MON", timeZone: "Europe/London" }, LINUX)
    ).toBeNull();
    expect(
      runWhenClosedIssue({ cron: "*/5 9-17 * * 1-5", timeZone: "Europe/London" }, LINUX)
    ).toBeNull();
    expect(runWhenClosedIssue({ cron: "0 9 * * *", timeZone: "Asia/Tokyo" }, LINUX)).toMatch(
      /^systemd can only start Daintree on this computer's time \(Europe\/London\)/
    );
    expect(
      runWhenClosedIssue(
        { cron: "0 9 * * *", timeZone: "Europe/London" },
        { kind: "systemd-timer", systemTimeZone: null }
      )
    ).toBe("Couldn't read this computer's time zone");
  });

  it("refuses everything on a platform with no job yet", () => {
    expect(
      runWhenClosedIssue(
        { cron: "0 9 * * *", timeZone: "Europe/London" },
        { kind: null, systemTimeZone: null }
      )
    ).toMatch(/isn't available on this platform/);
  });

  it("refuses everything while the Mac's zone can't be read", () => {
    expect(
      runWhenClosedIssue(
        { cron: "0 9 * * *", timeZone: "Europe/London" },
        { kind: "launch-agent", systemTimeZone: null }
      )
    ).toMatch(/time zone/);
  });
});

describe("runWhenClosedIssues", () => {
  it("asks nothing of a schedule with the option off, whatever its cadence", () => {
    expect(runWhenClosedIssues(schedule("0 0 */2 * MON", false, "Asia/Tokyo"), MAC)).toEqual([]);
  });

  it("passes a schedule with the option on that the job can start", () => {
    expect(runWhenClosedIssues(schedule("0 9 * * 1-5", true), MAC)).toEqual([]);
  });

  it("names the option's field for a schedule the job can't start", () => {
    expect(runWhenClosedIssues(schedule("0 9 * * *", true, "Asia/Tokyo"), MAC)).toEqual([
      { path: RUN_WHEN_CLOSED_PATH, cronField: null, message: expect.stringMatching(/Tokyo/) },
    ]);
  });
});
