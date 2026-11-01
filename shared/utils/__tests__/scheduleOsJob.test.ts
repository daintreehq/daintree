import { describe, expect, it } from "vitest";
import { createSchedule } from "../scheduledRuns.js";
import {
  RUN_WHEN_CLOSED_PATH,
  fitRunWhenClosed,
  runWhenClosedIssue,
  runWhenClosedIssues,
  type ScheduleOsJobContext,
} from "../scheduleOsJob.js";

const MAC: ScheduleOsJobContext = {
  kind: "launch-agent",
  systemTimeZone: "Europe/London",
  unavailable: null,
};
const LINUX: ScheduleOsJobContext = {
  kind: "systemd-timer",
  systemTimeZone: "Europe/London",
  unavailable: null,
};

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
        { kind: "systemd-timer", systemTimeZone: null, unavailable: null }
      )
    ).toBe("Couldn't read this computer's time zone");
  });

  it("refuses everything on a platform with no job yet", () => {
    expect(
      runWhenClosedIssue(
        { cron: "0 9 * * *", timeZone: "Europe/London" },
        { kind: null, systemTimeZone: null, unavailable: null }
      )
    ).toMatch(/isn't available on this platform/);
  });

  it("refuses everything while the Mac's zone can't be read", () => {
    expect(
      runWhenClosedIssue(
        { cron: "0 9 * * *", timeZone: "Europe/London" },
        { kind: "launch-agent", systemTimeZone: null, unavailable: null }
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

describe("runWhenClosedIssue on Windows (#15993)", () => {
  const PC: ScheduleOsJobContext = {
    kind: "task-scheduler",
    systemTimeZone: "Europe/London",
    unavailable: null,
  };

  it("accepts a cadence Windows' task can hold", () => {
    expect(runWhenClosedIssue({ cron: "*/15 9-17 * * 1-5", timeZone: "Europe/London" }, PC)).toBe(
      null
    );
  });

  it("names why Windows' task can't hold a cadence, in Windows' words", () => {
    expect(runWhenClosedIssue({ cron: "0 9 * * *", timeZone: "Asia/Tokyo" }, PC)).toMatch(
      /^Windows can only start Daintree on this PC's time/
    );
  });

  it("says a build that can't register the task can't, before anything else", () => {
    expect(
      runWhenClosedIssue(
        { cron: "0 9 * * *", timeZone: "Europe/London" },
        { ...PC, systemTimeZone: null, unavailable: "Not from the Store" }
      )
    ).toBe("Not from the Store");
  });

  it("names the PC when its zone can't be read", () => {
    expect(
      runWhenClosedIssue(
        { cron: "0 9 * * *", timeZone: "Europe/London" },
        { ...PC, systemTimeZone: null }
      )
    ).toBe("Couldn't read this PC's time zone");
  });
});

describe("fitRunWhenClosed", () => {
  const PC: ScheduleOsJobContext = {
    kind: "task-scheduler",
    systemTimeZone: "Europe/London",
    unavailable: null,
  };
  /** Twelve start times no run can share, so twelve triggers. */
  const twelve = (minute: number) => `${minute} 0,1,3,7,8,10,13,15,16,20,22,23 * * *`;

  function make(
    id: string,
    projectId: string,
    cron: string,
    createdAt: number,
    options: { enabled?: boolean; timeZone?: string } = {}
  ) {
    return createSchedule(
      {
        id,
        projectId,
        name: id,
        launch: { agentId: "claude", prompt: "Go." },
        cron,
        timeZone: options.timeZone ?? "Europe/London",
        enabled: options.enabled ?? true,
        policies: { runWhenClosed: true },
      },
      createdAt
    );
  }

  it("takes every opted-in schedule a Mac's job can hold, with no limit across them", () => {
    const schedules = Array.from({ length: 6 }, (_, i) => make(`s${i}`, "p", twelve(i), i));
    const fit = fitRunWhenClosed([{ projectId: "p", schedules }], MAC);
    expect(fit.included).toHaveLength(6);
    expect(fit.excluded).toEqual([]);
  });

  it("fits Windows' task oldest first, across projects, ignoring schedules that are off", () => {
    const fit = fitRunWhenClosed(
      [
        {
          projectId: "b",
          schedules: [
            make("b1", "b", twelve(2), 2),
            make("b2", "b", twelve(9), 0, { enabled: false }),
          ],
        },
        {
          projectId: "a",
          schedules: [
            make("a1", "a", twelve(1), 1),
            make("a2", "a", twelve(4), 4),
            make("a3", "a", "0 9 * * *", 5),
          ],
        },
        { projectId: "c", schedules: [make("c1", "c", twelve(3), 3)] },
      ],
      PC
    );
    expect(fit.included.map((cadence) => cadence.cron)).toEqual([
      twelve(1),
      twelve(2),
      twelve(3),
      twelve(4),
    ]);
    expect(fit.excluded).toEqual([
      { projectId: "a", scheduleId: "a3", reason: expect.stringMatching(/already use 48/) },
    ]);
  });

  it("breaks a tie in age by project, then schedule", () => {
    // Five schedules of twelve triggers, all as old, for a task that holds four.
    const fit = fitRunWhenClosed(
      [
        {
          projectId: "b",
          schedules: [make("a1", "b", twelve(1), 1), make("a0", "b", twelve(2), 1)],
        },
        {
          projectId: "a",
          schedules: [
            make("z3", "a", twelve(3), 1),
            make("z1", "a", twelve(4), 1),
            make("z2", "a", twelve(5), 1),
          ],
        },
      ],
      PC
    );
    // By project then id: a/z1, a/z2, a/z3, b/a0 fit, and b/a1 is left out.
    expect(fit.excluded.map((entry) => `${entry.projectId}/${entry.scheduleId}`)).toEqual(["b/a1"]);
  });

  it("lets in a schedule whose triggers the task already holds", () => {
    const fit = fitRunWhenClosed(
      [
        {
          projectId: "p",
          schedules: [
            make("s1", "p", twelve(1), 1),
            make("s2", "p", twelve(2), 2),
            make("s3", "p", twelve(3), 3),
            make("s4", "p", twelve(4), 4),
            make("s5", "p", twelve(2), 5),
          ],
        },
      ],
      PC
    );
    expect(fit.excluded).toEqual([]);
    expect(fit.included).toHaveLength(5);
  });

  it("leaves out a cadence the task can't hold, with its own reason", () => {
    const fit = fitRunWhenClosed(
      [
        {
          projectId: "p",
          schedules: [make("s1", "p", "0 9 * * *", 1, { timeZone: "Asia/Tokyo" })],
        },
      ],
      PC
    );
    expect(fit.included).toEqual([]);
    expect(fit.excluded).toEqual([
      { projectId: "p", scheduleId: "s1", reason: expect.stringMatching(/this PC's time/) },
    ]);
  });
});
