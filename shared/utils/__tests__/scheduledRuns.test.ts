import { describe, expect, it } from "vitest";
import { ScheduleSchema, type ScheduledRunEvidence } from "../../types/scheduledRuns.js";
import { machineTimeZone, nextCronOccurrence } from "../cron.js";
import {
  createSchedule,
  occurrenceKeyFor,
  outcomeForEvidence,
  validateCadence,
  type NewScheduleInput,
} from "../scheduledRuns.js";

const NOW = Date.parse("2026-06-01T12:00:00Z");

const minimal: NewScheduleInput = {
  id: "schedule-1",
  projectId: "project-1",
  name: "Nightly triage",
  launch: { agentId: "claude", prompt: "Triage new issues" },
};

describe("createSchedule", () => {
  it("gives a new schedule the issue's default policies", () => {
    expect(createSchedule(minimal, NOW).policies).toEqual({
      missedRuns: "run-once-late",
      overlap: "skip",
      precondition: null,
      onDone: "keep",
      runWhenClosed: false,
    });
  });

  it("builds a complete schedule the persisted schema accepts", () => {
    const schedule = createSchedule(minimal, NOW);
    expect(ScheduleSchema.safeParse(schedule).success).toBe(true);
    expect(schedule.enabled).toBe(true);
    expect(schedule.createdAt).toBe(NOW);
    expect(schedule.updatedAt).toBe(NOW);
    expect(schedule.launch).toEqual({
      agentId: "claude",
      presetId: null,
      prompt: "Triage new issues",
      worktreeId: null,
    });
  });

  it("fixes the machine's zone at creation unless one is given", () => {
    expect(createSchedule(minimal, NOW).cadence.timeZone).toBe(machineTimeZone());
    expect(createSchedule({ ...minimal, timeZone: "Asia/Tokyo" }, NOW).cadence.timeZone).toBe(
      "Asia/Tokyo"
    );
    const spelled = createSchedule({ ...minimal, timeZone: " europe/london " }, NOW);
    expect(spelled.cadence.timeZone).toBe("Europe/London");
    expect(ScheduleSchema.safeParse(spelled).success).toBe(true);
  });

  it("starts with a cadence that parses and fires", () => {
    const validation = validateCadence(createSchedule(minimal, NOW).cadence);
    expect(validation.ok).toBe(true);
    if (validation.ok) {
      expect(nextCronOccurrence(validation.cron, validation.timeZone, NOW)).toBeGreaterThan(NOW);
    }
  });

  it("keeps supplied values and fills only what is missing", () => {
    const schedule = createSchedule(
      {
        ...minimal,
        name: "  Weekly deps  ",
        cron: " 0 3 * * SUN ",
        enabled: false,
        launch: { ...minimal.launch, presetId: "fast", worktreeId: "/repo/wt" },
        policies: { overlap: "replace", precondition: { command: "test -f .ready" } },
      },
      NOW
    );
    expect(schedule.name).toBe("Weekly deps");
    expect(schedule.cadence.cron).toBe("0 3 * * SUN");
    expect(schedule.enabled).toBe(false);
    expect(schedule.launch).toMatchObject({ presetId: "fast", worktreeId: "/repo/wt" });
    expect(schedule.policies).toMatchObject({
      overlap: "replace",
      precondition: { command: "test -f .ready" },
      missedRuns: "run-once-late",
      onDone: "keep",
    });
  });

  it("doesn't let an explicit undefined policy erase a default", () => {
    const schedule = createSchedule(
      { ...minimal, policies: { missedRuns: undefined, runWhenClosed: undefined } },
      NOW
    );
    expect(ScheduleSchema.safeParse(schedule).success).toBe(true);
  });

  it("shares no nested object with its input or another schedule", () => {
    const precondition = { command: "true" };
    const first = createSchedule({ ...minimal, policies: { precondition } }, NOW);
    const second = createSchedule(minimal, NOW);
    expect(first.policies.precondition).not.toBe(precondition);
    expect(first.policies).not.toBe(second.policies);
    expect(first.launch).not.toBe(minimal.launch);
  });
});

describe("occurrenceKeyFor", () => {
  it("is the same for the same instant and differs across instants", () => {
    const dueAt = Date.parse("2026-11-01T05:30:00Z");
    expect(occurrenceKeyFor(dueAt)).toBe(occurrenceKeyFor(new Date(dueAt).getTime()));
    // The two showings of 01:30 in New York on fall-back day are distinct keys.
    expect(occurrenceKeyFor(dueAt)).not.toBe(occurrenceKeyFor(dueAt + 3_600_000));
    expect(Date.parse(occurrenceKeyFor(dueAt))).toBe(dueAt);
  });
});

describe("outcomeForEvidence", () => {
  const cases: [ScheduledRunEvidence, string][] = [
    [{ kind: "handback", report: "done" }, "done"],
    [{ kind: "handback", report: "needs-you" }, "needs-you"],
    [{ kind: "exit", process: "agent", exitCode: 0, signal: null }, "done"],
    [{ kind: "exit", process: "pty", exitCode: 2, signal: null }, "failed"],
    [{ kind: "exit", process: "pty", exitCode: 0, signal: 15 }, "failed"],
    [{ kind: "exit", process: "pty", exitCode: 0, signal: 0 }, "done"],
    [{ kind: "exit", process: "agent", exitCode: null, signal: null }, "exited"],
    [{ kind: "skip", reason: { kind: "missed" } }, "skipped"],
    [{ kind: "launch-error", message: "spawn ENOENT" }, "failed"],
    [{ kind: "cancel" }, "cancelled"],
    [{ kind: "replace", replacedByRunId: "run-2" }, "replaced"],
    [{ kind: "lost" }, "lost"],
  ];

  it.each(cases)("reads %j as %s", (evidence, outcome) => {
    expect(outcomeForEvidence(evidence)).toBe(outcome);
  });
});

describe("validateCadence", () => {
  it("points a form at the field that's wrong", () => {
    const badCron = validateCadence({ cron: "0 25 * * *", timeZone: "UTC" });
    expect(badCron).toMatchObject({ ok: false, error: { field: "cron", cronField: "hour" } });
    const badZone = validateCadence({ cron: "0 9 * * *", timeZone: "Nowhere/Special" });
    expect(badZone).toMatchObject({ ok: false, error: { field: "timeZone", cronField: null } });
  });

  it("returns the resolved zone name", () => {
    expect(validateCadence({ cron: "0 9 * * *", timeZone: "europe/london" })).toMatchObject({
      ok: true,
      timeZone: "Europe/London",
    });
  });
});
