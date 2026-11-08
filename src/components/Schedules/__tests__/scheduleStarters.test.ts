import { describe, expect, it } from "vitest";
import { createSchedule, validateCadence } from "@shared/utils/scheduledRuns";
import { machineTimeZone } from "@shared/utils/cron";
import { SCHEDULE_STARTERS } from "../scheduleStarters";

describe("SCHEDULE_STARTERS (#16394)", () => {
  it("has unique ids and names", () => {
    expect(new Set(SCHEDULE_STARTERS.map((s) => s.id)).size).toBe(SCHEDULE_STARTERS.length);
    expect(new Set(SCHEDULE_STARTERS.map((s) => s.name)).size).toBe(SCHEDULE_STARTERS.length);
  });

  it.each(SCHEDULE_STARTERS)("$id has a cadence and prompt that make a valid schedule", (s) => {
    expect(validateCadence({ cron: s.cron, timeZone: machineTimeZone() }).ok).toBe(true);
    const made = createSchedule({
      id: "x",
      projectId: "p",
      name: s.name,
      launch: { agentId: "claude", prompt: s.prompt },
      cron: s.cron,
      timeZone: machineTimeZone(),
    });
    expect(made.launch.prompt).toBe(s.prompt);
  });

  it.each(SCHEDULE_STARTERS)(
    "$id suits an unwatched run: reports a quiet run, never publishes or removes, no handback",
    (s) => {
      expect(s.prompt).toMatch(/say so in one line/);
      expect(s.prompt).toMatch(/Do not [^.]*push, merge or delete/);
      expect(s.prompt.toLowerCase()).not.toContain("handback");
    }
  );
});
