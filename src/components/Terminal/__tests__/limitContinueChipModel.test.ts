import { describe, expect, it } from "vitest";
import {
  LIMIT_CONTINUE_OUTCOME_TTL_MS,
  canShowLimitContinue,
  describeLimitContinue,
  describeSkipReason,
  formatLimitClock,
} from "../limitContinueChipModel";

// Local wall-clock instants, so the expectations hold in any time zone.
const at = (day: number, hour: number, minute: number) =>
  new Date(2026, 10, day, hour, minute).getTime();
// Thursday, Nov 19 2026, 9:00 AM.
const NOW = at(19, 9, 0);

describe("formatLimitClock (#17911)", () => {
  it("names the time alone later today, in the viewer's clock", () => {
    expect(formatLimitClock(at(19, 15, 40), NOW)).toMatch(/^3:40\sPM$/u);
    expect(formatLimitClock(at(19, 15, 40), NOW, "en-GB")).toBe("15:40");
  });

  it("puts the weekday first for a reset later in the week", () => {
    expect(formatLimitClock(at(23, 10, 0), NOW)).toMatch(/^Mon 10:00\sAM$/u);
    expect(formatLimitClock(at(23, 10, 0), NOW, "en-GB")).toBe("Mon 10:00");
  });

  it("counts a reset just past midnight as tomorrow", () => {
    const lateNight = at(19, 23, 50);
    expect(formatLimitClock(at(20, 0, 5), lateNight)).toMatch(/^Fri 12:05\sAM$/u);
  });

  it("names the date once a weekday alone could mean two days", () => {
    expect(formatLimitClock(at(26, 10, 0), NOW)).toMatch(/^Nov 26, 10:00\sAM$/u);
  });

  it("names yesterday by its weekday", () => {
    expect(formatLimitClock(at(18, 23, 5), NOW)).toMatch(/^Wed 11:05\sPM$/u);
  });
});

describe("describeLimitContinue (#17911)", () => {
  it("says nothing for a pane armed with no stop yet", () => {
    expect(describeLimitContinue(undefined, NOW)).toBeNull();
    expect(describeLimitContinue({ status: "armed" }, NOW)).toBeNull();
    expect(canShowLimitContinue({ status: "armed" })).toBe(false);
  });

  it("names when a wait continues, for a reset days away too", () => {
    const resetsAt = at(23, 9, 59);
    const chip = describeLimitContinue(
      { status: "waiting", resetsAt, continueAt: resetsAt + 60_000 },
      NOW
    );
    expect(chip?.kind).toBe("waiting");
    expect(chip?.label).toMatch(/^Resumes Mon 10:00\sAM$/u);
    expect(chip?.lines.join("\n")).toMatch(/still where the limit left it/);
  });

  it("says the resume is due once its time passed with no result yet", () => {
    const chip = describeLimitContinue(
      { status: "waiting", resetsAt: NOW - 120_000, continueAt: NOW - 60_000 },
      NOW
    );
    expect(chip?.label).toMatch(/^Resume due 8:59\sAM$/u);
  });

  it("says when the pane continued, then lets it go after a day", () => {
    const state = { status: "continued", at: at(19, 3, 41), line: "continue" } as const;
    expect(describeLimitContinue(state, NOW)?.label).toMatch(/^Resumed 3:41\sAM$/u);
    expect(describeLimitContinue(state, NOW)?.lines.join("\n")).toMatch(/"continue"/);
    expect(
      describeLimitContinue(state, state.at + LIMIT_CONTINUE_OUTCOME_TTL_MS - 1)
    ).not.toBeNull();
    expect(describeLimitContinue(state, state.at + LIMIT_CONTINUE_OUTCOME_TTL_MS)).toBeNull();
  });

  it("keeps an overnight skip on the pane in the morning, with its reason", () => {
    const chip = describeLimitContinue(
      { status: "skipped", at: at(19, 3, 41), reason: "draft" },
      at(19, 8, 0)
    );
    expect(chip?.kind).toBe("skipped");
    expect(chip?.label).toBe("Resume skipped");
    expect(chip?.lines).toContain("The prompt wasn't empty");
  });

  it("says a restart, exit or move is why a resume was skipped", () => {
    const chip = describeLimitContinue(
      { status: "skipped", at: NOW, reason: "process-changed" },
      NOW
    );
    expect(chip?.lines).toContain(describeSkipReason("process-changed"));
    expect(describeSkipReason("process-changed")).toMatch(/restarted/);
  });

  it("says there's no reset time, rather than a time, when the reset couldn't be read", () => {
    for (const reason of ["no-reset", "unreadable-time", "quota-incomplete"] as const) {
      const chip = describeLimitContinue({ status: "skipped", at: NOW, reason }, NOW);
      expect(chip?.kind).toBe("no-reset");
      expect(chip?.label).toBe("No reset time");
      expect(chip?.lines).toContain(describeSkipReason(reason));
    }
  });

  it("words a reason that can come at the stop or at the reset as a skip", () => {
    for (const reason of ["not-observed", "banner-changed", "host-unanswered"] as const) {
      expect(describeLimitContinue({ status: "skipped", at: NOW, reason }, NOW)?.kind).toBe(
        "skipped"
      );
    }
  });

  it("leaves a stop the pane's own fallback takes to the fallback", () => {
    const state = { status: "skipped", at: NOW, reason: "falls-back" } as const;
    expect(canShowLimitContinue(state)).toBe(false);
    expect(describeLimitContinue(state, NOW)).toBeNull();
  });
});
