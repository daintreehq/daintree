import { describe, expect, it } from "vitest";
import { ClaudeLimitStopTracker, type ClaudeLimitLook } from "../ClaudeLimitStop.js";

const RULE = "─".repeat(60);
const BANNER = "  ⎿  You've hit your session limit · resets 3pm (UTC)";
const CANCELLED = "  ⎿  Automatic continue cancelled · /rate-limit-options to re-arm";
const COUNTDOWN = "  Usage limit reached · continuing automatically at 3pm · esc to cancel";
const screen = (between: string[] = [], footer = "  ? for shortcuts") => [
  "● Refactoring the parser.",
  BANNER,
  ...between,
  RULE,
  "❯ ",
  RULE,
  footer,
];
const COUNTING = screen([], COUNTDOWN);
const CANCELLED_SCREEN = screen([CANCELLED]);
const IDLE = ["● Done.", RULE, "❯ ", RULE, "  ? for shortcuts"];

// 2:59pm UTC.
const NOW = Date.UTC(2026, 10, 19, 14, 59);

function harness() {
  let seq = 0;
  let inputSeq = 0;
  const tracker = new ClaudeLimitStopTracker(() => ++seq);
  const look = (extra: Partial<ClaudeLimitLook> = {}): ClaudeLimitLook => ({
    now: NOW,
    cols: 80,
    inputSeq,
    incarnation: 0,
    observedSince: 1,
    shownAt: () => null,
    ...extra,
  });
  return {
    tracker,
    look,
    type(data: string, owner?: string) {
      inputSeq++;
      tracker.noteInput(data, owner);
    },
    observe(lines: string[], extra: Partial<ClaudeLimitLook> = {}, armLook = false) {
      tracker.observe(lines, look(extra), armLook);
      return tracker.held();
    },
  };
}

describe("ClaudeLimitStopTracker (#18192)", () => {
  it("holds no stop while the countdown shows", () => {
    const h = harness();
    expect(h.observe(COUNTING)).toBeNull();
  });

  it("leaves the stop Daintree's after an assistant's Escape or double Escape", () => {
    for (const keys of [["\x1b"], ["\x1b", "\x1b"], ["\x1b\x1b"]]) {
      const h = harness();
      h.observe(COUNTING);
      for (const key of keys) h.type(key, "assistant-1");
      expect(h.observe(CANCELLED_SCREEN)).toMatchObject({ skipAtStop: null, shown: true });
    }
  });

  it("records a person's Escape, a person's key beside an assistant's Escape, and anything more an assistant typed", () => {
    const person = harness();
    person.observe(COUNTING);
    person.type("\x1b");
    expect(person.observe(CANCELLED_SCREEN)).toMatchObject({ skipAtStop: "auto-continue-cancelled" });

    const mixed = harness();
    mixed.observe(COUNTING);
    mixed.type("\x1b", "assistant-1");
    mixed.type("q");
    expect(mixed.observe(CANCELLED_SCREEN)).toMatchObject({ skipAtStop: "auto-continue-cancelled" });

    const typing = harness();
    typing.observe(COUNTING);
    typing.type("\x1b", "assistant-1");
    typing.type("continue", "assistant-1");
    expect(typing.observe(CANCELLED_SCREEN)).toMatchObject({ skipAtStop: "input-since" });
  });

  it("counts a cancellation nothing explains as a person's, unless the arming itself saw it", () => {
    const h = harness();
    h.observe(COUNTING);
    expect(h.observe(CANCELLED_SCREEN)).toMatchObject({ skipAtStop: "auto-continue-cancelled" });

    const armed = harness();
    expect(armed.observe(CANCELLED_SCREEN, {}, true)).toMatchObject({ skipAtStop: null });
  });

  it("forgets input from before a look that couldn't be the cancel's own frame", () => {
    const h = harness();
    h.type("fix the parser\r");
    h.observe(IDLE);
    h.observe(COUNTING);
    h.type("\x1b", "assistant-1");
    expect(h.observe(CANCELLED_SCREEN)).toMatchObject({ skipAtStop: null });
  });

  it("keeps input across a frame with no composer drawn", () => {
    const h = harness();
    h.observe(COUNTING);
    h.type("\x1b");
    h.observe(["● Refactoring the parser.", BANNER]);
    expect(h.observe(CANCELLED_SCREEN)).toMatchObject({ skipAtStop: "auto-continue-cancelled" });
  });

  it("guards the stop from its first sighting, after the Escape that made it", () => {
    const h = harness();
    h.observe(COUNTING);
    h.type("\x1b", "assistant-1");
    expect(h.observe(CANCELLED_SCREEN)?.guard).toEqual({
      key: expect.any(String),
      inputSeq: 1,
      dialogSeen: false,
    });
  });

  it("is the same stop through a repaint, and keeps its verdict and guard when seen again after a gap", () => {
    const h = harness();
    h.observe(COUNTING);
    h.type("\x1b");
    const first = h.observe(CANCELLED_SCREEN)!;
    expect(h.observe(CANCELLED_SCREEN)).toBe(first);
    h.tracker.noteDialog();
    h.observe(IDLE);
    expect(first.shown).toBe(false);
    const again = h.observe(CANCELLED_SCREEN, { observedSince: 2 })!;
    expect(again.seq).toBe(first.seq + 1);
    expect(again).toMatchObject({
      skipAtStop: "auto-continue-cancelled",
      guard: first.guard,
      observedAt: first.observedAt,
    });
    expect(again.guard.dialogSeen).toBe(true);
  });

  it("makes a new stop when the wait is cancelled under a banner first seen without it", () => {
    const h = harness();
    // A frame drawn before the countdown reached it.
    const early = h.observe(screen())!;
    h.observe(COUNTING);
    expect(early).toMatchObject({ shown: false, ownWait: true });
    h.type("\x1b");
    const cancelled = h.observe(CANCELLED_SCREEN)!;
    expect(cancelled.seq).not.toBe(early.seq);
    expect(cancelled.skipAtStop).toBe("auto-continue-cancelled");
  });

  it("reads the reset against when the pane first showed it, as minute precision", () => {
    const h = harness();
    // Looked at again after 3pm, but first shown at 2:59pm: still today's.
    const later = Date.UTC(2026, 10, 19, 15, 5);
    const stop = h.observe(screen(), { now: later, shownAt: () => NOW });
    expect(stop?.reset).toEqual({ resetsAt: Date.UTC(2026, 10, 19, 15, 1) });
  });

  it("says why when the banner names no reset that reads", () => {
    const h = harness();
    const unstated = h.observe([
      "● Refactoring the parser.",
      "  ⎿  You've hit your usage limit",
      RULE,
      "❯ ",
      RULE,
    ]);
    expect(unstated?.reset).toEqual({ reason: "no-reset-stated" });
  });
});
