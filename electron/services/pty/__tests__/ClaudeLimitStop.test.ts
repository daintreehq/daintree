import { describe, expect, it } from "vitest";
import {
  ClaudeLimitStopTracker,
  ESCAPE_GRACE_MS,
  type ClaudeLimitLook,
} from "../ClaudeLimitStop.js";

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
const HALF_DRAWN = ["● Refactoring the parser.", BANNER];

// 2:59pm UTC.
const NOW = Date.UTC(2026, 10, 19, 14, 59);

function harness() {
  let seq = 0;
  let inputSeq = 0;
  let clock = NOW;
  const tracker = new ClaudeLimitStopTracker(() => ++seq);
  return {
    tracker,
    /** Move the clock on; every key and look happens at the clock's time. */
    wait(ms: number) {
      clock += ms;
    },
    type(data: string, owner?: string) {
      inputSeq++;
      tracker.noteInput(data, owner, clock);
    },
    arm() {
      tracker.arm(clock);
    },
    observe(lines: string[], extra: Partial<ClaudeLimitLook> = {}) {
      tracker.observe(lines, {
        now: clock,
        tick: clock,
        cols: 80,
        inputSeq,
        incarnation: 0,
        observedSince: 1,
        shownAt: () => null,
        ...extra,
      });
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
      h.wait(1_000);
      for (const key of keys) h.type(key, "assistant-1");
      h.wait(100);
      expect(h.observe(CANCELLED_SCREEN)).toMatchObject({ skipAtStop: null, shown: true });
    }
  });

  it("records a person's Escape, also beside an assistant's", () => {
    for (const owners of [[undefined], ["assistant-1", undefined], [undefined, "assistant-1"]]) {
      const h = harness();
      h.observe(COUNTING);
      h.wait(1_000);
      for (const owner of owners) h.type("\x1b", owner);
      expect(h.observe(CANCELLED_SCREEN)).toMatchObject({
        skipAtStop: "auto-continue-cancelled",
      });
    }
  });

  it.each([
    ["an Escape and text in one write", "\x1bq"],
    ["an arrow key", "\x1b[A"],
    ["text", "continue"],
  ])("counts only an Escape as an assistant's cancel, not %s", (_label, data) => {
    const h = harness();
    h.observe(COUNTING);
    h.type(data, "assistant-1");
    expect(h.observe(CANCELLED_SCREEN)).toMatchObject({ skipAtStop: "auto-continue-cancelled" });
  });

  it("leaves a person's keys that aren't an Escape to the checks after the stop", () => {
    // The prompt that ran into the limit, sent just before the banner showed.
    const h = harness();
    h.type("fix the parser\r");
    h.wait(300);
    h.observe(COUNTING);
    h.type("\x1b", "assistant-1");
    expect(h.observe(CANCELLED_SCREEN)).toMatchObject({ skipAtStop: null });
  });

  it("keeps a person's Escape through a stale look drawn before it", () => {
    for (const stale of [COUNTING, IDLE]) {
      const h = harness();
      h.observe(COUNTING);
      h.type("\x1b");
      // A sample of a frame drawn before the key, arriving after it.
      h.wait(200);
      h.observe(stale);
      h.wait(200);
      h.observe(COUNTING);
      h.type("\x1b", "assistant-1");
      expect(h.observe(CANCELLED_SCREEN)).toMatchObject({
        skipAtStop: "auto-continue-cancelled",
      });
    }
  });

  it("forgets an Escape from well before the banner showed", () => {
    const h = harness();
    h.type("\x1b");
    h.wait(ESCAPE_GRACE_MS + 1);
    h.observe(COUNTING);
    h.type("\x1b", "assistant-1");
    expect(h.observe(CANCELLED_SCREEN)).toMatchObject({ skipAtStop: null });
  });

  it("counts a cancellation nothing explains as a person's", () => {
    const h = harness();
    h.observe(COUNTING);
    h.wait(1_000);
    expect(h.observe(CANCELLED_SCREEN)).toMatchObject({ skipAtStop: "auto-continue-cancelled" });
  });

  it("lets an arming made while the banner showed explain a cancellation, past a stale countdown look", () => {
    // Armed once the person had already cancelled: the first look still drew the countdown.
    const h = harness();
    h.observe(IDLE);
    h.type("\x1b");
    h.wait(500);
    h.arm();
    h.observe(COUNTING);
    h.wait(200);
    expect(h.observe(CANCELLED_SCREEN)).toMatchObject({ skipAtStop: null });

    // A person's Escape after the arming still means leave it.
    const after = harness();
    after.arm();
    after.observe(COUNTING);
    after.type("\x1b");
    expect(after.observe(CANCELLED_SCREEN)).toMatchObject({
      skipAtStop: "auto-continue-cancelled",
    });
  });

  it("never lets an arming from before the banner explain a cancellation", () => {
    // A launch's preset arms the pane; later the agent draws an old,
    // cancelled banner again (a resumed conversation).
    const h = harness();
    h.arm();
    h.observe(IDLE);
    h.wait(60_000);
    expect(h.observe(CANCELLED_SCREEN)).toMatchObject({ skipAtStop: "auto-continue-cancelled" });
  });

  it("keeps an Escape across a frame with no composer drawn", () => {
    const h = harness();
    h.observe(COUNTING);
    h.type("\x1b", "assistant-1");
    h.observe(HALF_DRAWN);
    expect(h.observe(CANCELLED_SCREEN)).toMatchObject({ skipAtStop: null });
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

  it("is the same stop through a repaint, and keeps its sighting when seen again after a gap", () => {
    const h = harness();
    h.observe(COUNTING);
    h.type("\x1b", "assistant-1");
    const first = h.observe(CANCELLED_SCREEN)!;
    expect(h.observe(CANCELLED_SCREEN)).toBe(first);
    h.tracker.noteDialog();
    // Out of view a while (a transcript open over it), with a key typed.
    h.observe(IDLE);
    expect(first.shown).toBe(false);
    h.type("q");
    h.wait(10 * 60_000);
    const again = h.observe(CANCELLED_SCREEN, { observedSince: 2 })!;
    expect(again.seq).toBe(first.seq + 1);
    expect(again).toMatchObject({ skipAtStop: null, observedAt: NOW, reset: first.reset });
    expect(again.guard).toBe(first.guard);
    expect(again.guard).toEqual({ key: expect.any(String), inputSeq: 1, dialogSeen: true });
  });

  it("is the same stop in a pane cut shorter, which shows less of the history above it", () => {
    const h = harness();
    const tall = [
      "● Read the lexer and the parser, then traced the failing case to the tokenizer.",
      "● Refactoring the parser so empty input reaches the tokenizer as one token.",
      BANNER,
      RULE,
      "❯ ",
      RULE,
    ];
    const first = h.observe(tall)!;
    h.type("\x7f");
    expect(h.observe(tall.slice(1))).toBe(first);
    expect(h.observe(tall)).toBe(first);
    // Other history over the same words is another stop, guarded afresh.
    const other = h.observe(["● Fixed the lexer.", ...tall.slice(2)])!;
    expect(other).not.toBe(first);
    expect(other.guard.inputSeq).toBe(1);
  });

  it("brings the stop back as it was once Claude is on view again", () => {
    const h = harness();
    const first = h.observe(screen())!;
    h.type("\x7f");
    h.tracker.hide();
    expect(first.shown).toBe(false);
    expect(h.observe(screen())).toBe(first);
    expect(first).toMatchObject({ shown: true, guard: { inputSeq: 0 } });
  });

  it("keeps the guard through a row drawn for a moment under the banner", () => {
    const h = harness();
    const first = h.observe(screen())!;
    h.type("\x7f");
    h.observe(screen(["limit."]));
    const back = h.observe(screen())!;
    expect(back.seq).not.toBe(first.seq);
    expect(back.guard).toBe(first.guard);
    expect(back.guard.inputSeq).toBe(0);
  });

  it("starts the sighting afresh, keeping the guard, once a turn ran past the stop", () => {
    const h = harness();
    const first = h.observe(screen())!;
    h.observe(screen(["● Picking the parser back up."]));
    expect(first).toMatchObject({ shown: false, ended: true });
    h.wait(5 * 60 * 60_000);
    const next = h.observe(screen(), { shownAt: () => NOW + 5 * 60 * 60_000 })!;
    expect(next.seq).not.toBe(first.seq);
    expect(next.observedAt).toBe(NOW + 5 * 60 * 60_000);
    // 3pm has passed by 7:59pm, so it's tomorrow's.
    expect(next.reset).toEqual({ resetsAt: Date.UTC(2026, 10, 20, 15, 1) });
    expect(next.guard).toBe(first.guard);
  });

  it("guards a stop afresh under another run of the agent", () => {
    const h = harness();
    const first = h.observe(screen())!;
    h.type("/restart\r");
    const next = h.observe(screen(), { incarnation: 1 })!;
    expect(next.guard).not.toBe(first.guard);
    expect(next.guard.inputSeq).toBe(1);
  });

  it("keeps the stop and its guard across an arming again, lifting only a person's verdict", () => {
    const h = harness();
    h.arm();
    h.observe(COUNTING);
    h.type("\x1b");
    const left = h.observe(CANCELLED_SCREEN)!;
    expect(left.skipAtStop).toBe("auto-continue-cancelled");
    h.type("x");
    h.arm();
    expect(h.observe(CANCELLED_SCREEN)).toBe(left);
    expect(left).toMatchObject({ skipAtStop: null, guard: { inputSeq: 1, dialogSeen: false } });
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
    // Looked at after 3pm, but first shown at 2:59pm: still today's.
    h.wait(6 * 60_000);
    expect(h.observe(screen(), { shownAt: () => NOW })?.reset).toEqual({
      resetsAt: Date.UTC(2026, 10, 19, 15, 1),
    });
    const unseen = harness();
    unseen.wait(6 * 60_000);
    expect(unseen.observe(screen())?.reset).toEqual({ resetsAt: Date.UTC(2026, 10, 20, 15, 1) });
  });

  it.each([
    ["names none", "  ⎿  You've hit your usage limit", "no-reset-stated"],
    [
      "names a time no clock shows",
      "  ⎿  You've hit your session limit · resets 13pm",
      "unreadable-time",
    ],
  ])("says why when the banner %s", (_label, banner, reason) => {
    const h = harness();
    expect(h.observe(["● Refactoring the parser.", banner, RULE, "❯ ", RULE])?.reset).toEqual({
      reason,
    });
  });
});
