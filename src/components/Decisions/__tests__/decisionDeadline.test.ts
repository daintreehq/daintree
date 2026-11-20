import { describe, expect, it } from "vitest";
import type { DecisionQuestionStanding } from "@shared/types/decisionsQuestion";
import {
  EXPIRY_SOON_MS,
  clockText,
  contentDeadlineElapsed,
  deadlineElapsed,
  expiresSoon,
  nextAskDeadline,
  nextDeadlineChange,
  remainingText,
} from "../decisionDeadline";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse("2026-11-20T14:00:00.000Z");
const OPEN: DecisionQuestionStanding = { kind: "waiting", reason: "open" };
const REPLY: DecisionQuestionStanding = { kind: "waiting", reason: "reply" };

const at = (ms: number) => new Date(ms).toISOString();

describe("deadlineElapsed (#17943)", () => {
  it("passes only an ask's own deadline, at or after it", () => {
    expect(deadlineElapsed({ expiresAt: at(NOW), standing: OPEN }, NOW)).toBe(true);
    expect(deadlineElapsed({ expiresAt: at(NOW + 1), standing: OPEN }, NOW)).toBe(false);
    expect(deadlineElapsed({ expiresAt: at(NOW - 1), standing: { kind: "queued" } }, NOW)).toBe(
      true
    );
    // A reply asked for after an answer isn't bound by the question's deadline.
    expect(deadlineElapsed({ expiresAt: at(NOW - 1), standing: REPLY }, NOW)).toBe(false);
    // Never, and a deadline that can't be read, never pass.
    expect(deadlineElapsed({ expiresAt: null, standing: OPEN }, NOW)).toBe(false);
    expect(deadlineElapsed({ expiresAt: "soon", standing: OPEN }, NOW)).toBe(false);
  });

  it("reads a question in full by its status", () => {
    expect(contentDeadlineElapsed({ expiresAt: at(NOW - 1), status: "open" }, NOW)).toBe(true);
    expect(contentDeadlineElapsed({ expiresAt: at(NOW - 1), status: "expired" }, NOW)).toBe(false);
  });

  it("names a deadline within a day only while it is still ahead", () => {
    const soon = (ms: number) => expiresSoon({ expiresAt: at(ms), standing: OPEN }, NOW);
    expect(soon(NOW + EXPIRY_SOON_MS)).toBe(true);
    expect(soon(NOW + EXPIRY_SOON_MS + 1)).toBe(false);
    expect(soon(NOW)).toBe(false);
  });

  it("finds the soonest deadline still ahead among asks", () => {
    expect(
      nextAskDeadline(
        [
          { expiresAt: at(NOW + 5 * MINUTE), standing: OPEN },
          { expiresAt: at(NOW + MINUTE), standing: REPLY },
          { expiresAt: at(NOW - MINUTE), standing: OPEN },
          { expiresAt: at(NOW + 2 * MINUTE), standing: { kind: "queued" } },
        ],
        NOW
      )
    ).toBe(NOW + 2 * MINUTE);
    expect(nextAskDeadline([{ expiresAt: null, standing: OPEN }], NOW)).toBeNull();
  });
});

describe("remainingText (#17943)", () => {
  it("says the largest whole unit left, and the last minute as less than one", () => {
    expect(remainingText(NOW + 59_999, NOW)).toBe("Less than a minute left");
    expect(remainingText(NOW + 8 * MINUTE + 30_000, NOW)).toBe("8 minutes left");
    expect(remainingText(NOW + MINUTE, NOW)).toBe("1 minute left");
    expect(remainingText(NOW + 2 * HOUR + 5 * MINUTE, NOW)).toBe("2 hours left");
    expect(remainingText(NOW + 3 * 24 * HOUR, NOW)).toBe("3 days left");
  });
});

describe("clockText (#17943)", () => {
  it("names the day for a deadline on another day, and not for one today", () => {
    const local = new Date(NOW);
    const laterToday = new Date(local);
    laterToday.setMinutes(local.getMinutes() + 1);
    const tomorrow = new Date(local);
    tomorrow.setDate(local.getDate() + 1);
    const time = (date: Date) =>
      date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

    if (laterToday.getDate() === local.getDate()) {
      expect(clockText(laterToday.getTime(), NOW)).toBe(time(laterToday));
    }
    expect(clockText(tomorrow.getTime(), NOW)).not.toBe(time(tomorrow));
    expect(clockText(tomorrow.getTime(), NOW).endsWith(time(tomorrow))).toBe(true);
  });
});

describe("nextDeadlineChange (#17943)", () => {
  it("waits until just past the next whole minute while under an hour is left", () => {
    // 8m 30s left: "8 minutes" turns to "7 minutes" just after 30 seconds.
    expect(nextDeadlineChange([NOW + 8 * MINUTE + 30_000], NOW)).toBe(30_001);
  });

  it("waits for the row to come within a day, or the next whole hour, whichever is first", () => {
    const deadline = NOW + EXPIRY_SOON_MS + 10 * MINUTE;
    expect(nextDeadlineChange([deadline], NOW)).toBe(10 * MINUTE);
    expect(nextDeadlineChange([NOW + 5 * HOUR + 20 * MINUTE], NOW)).toBe(20 * MINUTE + 1);
  });

  it("schedules the deadline itself in the last minute, and nothing once all have passed", () => {
    expect(nextDeadlineChange([NOW + 20_000], NOW)).toBe(20_000);
    expect(nextDeadlineChange([NOW - 1, NOW], NOW)).toBeNull();
    expect(nextDeadlineChange([], NOW)).toBeNull();
  });

  it("takes the soonest change across several deadlines", () => {
    expect(nextDeadlineChange([NOW + 5 * HOUR + 20 * MINUTE, NOW + 2 * MINUTE + 5_000], NOW)).toBe(
      5_001
    );
  });
});
