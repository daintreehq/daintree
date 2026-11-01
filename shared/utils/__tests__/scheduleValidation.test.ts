import { describe, expect, it } from "vitest";
import { createSchedule } from "../scheduledRuns.js";
import { scheduleIssues } from "../scheduleValidation.js";
import { parseCron } from "../cron.js";
import type { Schedule } from "../../types/scheduledRuns.js";

const NOW = Date.UTC(2026, 10, 1, 12);

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    ...createSchedule(
      {
        id: "s1",
        projectId: "p".repeat(64),
        name: "Nightly triage",
        launch: { agentId: "claude", prompt: "Triage the open issues." },
        timeZone: "UTC",
      },
      NOW
    ),
    ...overrides,
  };
}

describe("scheduleIssues", () => {
  it("finds nothing wrong with a new schedule", () => {
    expect(scheduleIssues(schedule())).toEqual([]);
  });

  it("names the cron field a bad expression is wrong in, with the parser's reason", () => {
    const cron = "0 25 * * *";
    const parsed = parseCron(cron);
    if (parsed.ok) throw new Error("expected the fixture to be invalid");

    const issues = scheduleIssues(schedule({ cadence: { cron, timeZone: "UTC" } }));

    expect(issues).toEqual([
      { path: "cadence.cron", cronField: parsed.error.field, message: parsed.error.message },
    ]);
    expect(parsed.error.field).toBe("hour");
  });

  it("reports an expression wrong as a whole with no cron field", () => {
    const issues = scheduleIssues(schedule({ cadence: { cron: "@daily", timeZone: "UTC" } }));

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: "cadence.cron", cronField: null });
    expect(issues[0]!.message).not.toBe("");
  });

  it("reports a zone this system doesn't know against the zone", () => {
    const issues = scheduleIssues(
      schedule({ cadence: { cron: "0 9 * * *", timeZone: "Mars/Olympus" } })
    );

    expect(issues).toEqual([
      { path: "cadence.timeZone", cronField: null, message: expect.stringContaining("Mars") },
    ]);
  });

  it("reports every field at fault at once, never quoting the prompt", () => {
    const base = schedule();
    const issues = scheduleIssues({
      ...base,
      name: "   ",
      launch: { ...base.launch, prompt: "  " },
      policies: { ...base.policies, precondition: { command: "" } },
    });

    expect(issues.map((issue) => issue.path).sort()).toEqual([
      "launch.prompt",
      "name",
      "policies.precondition.command",
    ]);
    expect(issues.every((issue) => issue.cronField === null)).toBe(true);
  });

  it("refuses a key the schedule doesn't have", () => {
    const issues = scheduleIssues({ ...schedule(), extra: true } as unknown as Schedule);

    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toBe("");
  });
});
