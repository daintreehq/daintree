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
const HALF_DRAWN = ["● Refactoring the parser.", BANNER];

// 2:59pm UTC.
const NOW = Date.UTC(2026, 10, 19, 14, 59);

function harness() {
  let seq = 0;
  let inputSeq = 0;
  const tracker = new ClaudeLimitStopTracker(() => ++seq);
  return {
    tracker,
    type(data: string, owner?: string) {
      inputSeq++;
      tracker.noteInput(data, owner);
    },
    observe(lines: string[], extra: Partial<ClaudeLimitLook> = {}) {
      tracker.observe(lines, {
        now: NOW,
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
      for (const key of keys) h.type(key, "assistant-1");
      expect(h.observe(CANCELLED_SCREEN)).toMatchObject({ skipAtStop: null, shown: true });
    }
  });

  it("records a person's Escape, and a person's key beside an assistant's Escape, as the person's", () => {
    const person = harness();
    person.observe(COUNTING);
    person.type("\x1b");
    expect(person.observe(CANCELLED_SCREEN)).toMatchObject({
      skipAtStop: "auto-continue-cancelled",
    });

    const mixed = harness();
    mixed.observe(COUNTING);
    mixed.type("\x1b", "assistant-1");
    mixed.type("q");
    expect(mixed.observe(CANCELLED_SCREEN)).toMatchObject({
      skipAtStop: "auto-continue-cancelled",
    });
  });

  it.each([
    ["more keys after the Escape", ["\x1b", "continue"]],
    ["an Escape and text in one write", ["\x1bq"]],
    ["an arrow key", ["\x1b[A"]],
  ])("records an assistant's %s as input, not a cancel", (_label, writes) => {
    const h = harness();
    h.observe(COUNTING);
    for (const data of writes) h.type(data, "assistant-1");
    expect(h.observe(CANCELLED_SCREEN)).toMatchObject({ skipAtStop: "input-since" });
  });

  it("keeps a person's Escape through a look that still showed the countdown", () => {
    // A sample drawn before the key arrives after it: the person's Escape
    // must not be swallowed and leave only an assistant's after it.
    const h = harness();
    h.observe(COUNTING);
    h.type("\x1b");
    h.observe(COUNTING);
    h.type("\x1b", "assistant-1");
    expect(h.observe(CANCELLED_SCREEN)).toMatchObject({ skipAtStop: "auto-continue-cancelled" });
  });

  it("keeps an assistant's Escape through a look that still showed the countdown", () => {
    const h = harness();
    h.observe(COUNTING);
    h.type("\x1b", "assistant-1");
    h.observe(COUNTING);
    expect(h.observe(CANCELLED_SCREEN)).toMatchObject({ skipAtStop: null });
  });

  it("counts a cancellation nothing explains as a person's", () => {
    const h = harness();
    h.observe(COUNTING);
    expect(h.observe(CANCELLED_SCREEN)).toMatchObject({ skipAtStop: "auto-continue-cancelled" });
  });

  it("lets an arming explain a cancellation, through a stale countdown look but not past input", () => {
    const armed = harness();
    armed.tracker.arm();
    armed.observe(COUNTING);
    expect(armed.observe(CANCELLED_SCREEN)).toMatchObject({ skipAtStop: null });

    const typedSince = harness();
    typedSince.tracker.arm();
    typedSince.type("\x1b");
    expect(typedSince.observe(CANCELLED_SCREEN)).toMatchObject({
      skipAtStop: "auto-continue-cancelled",
    });

    // An arming at launch, before the agent drew anything, explains nothing later.
    const atLaunch = harness();
    atLaunch.tracker.arm();
    atLaunch.observe(IDLE);
    expect(atLaunch.observe(CANCELLED_SCREEN)).toMatchObject({
      skipAtStop: "auto-continue-cancelled",
    });
  });

  it("forgets input from before a look with no banner", () => {
    const h = harness();
    h.observe(COUNTING);
    h.type("fix the parser\r");
    h.observe(IDLE);
    h.type("\x1b", "assistant-1");
    expect(h.observe(CANCELLED_SCREEN)).toMatchObject({ skipAtStop: null });
  });

  it("keeps input across a frame with no composer drawn", () => {
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
    const later = NOW + 10 * 60_000;
    const again = h.observe(CANCELLED_SCREEN, { observedSince: 2, now: later })!;
    expect(again.seq).toBe(first.seq + 1);
    expect(again).toMatchObject({ skipAtStop: null, observedAt: NOW, reset: first.reset });
    expect(again.guard).toBe(first.guard);
    expect(again.guard).toEqual({ key: expect.any(String), inputSeq: 1, dialogSeen: true });
  });

  it("ends a stop once a new turn is printed after it", () => {
    const h = harness();
    const first = h.observe(screen())!;
    h.observe(screen(["● Picking the parser back up."]));
    expect(h.tracker.held()).toBeNull();
    // The same words again later are a new stop, guarded afresh.
    h.type("next\r");
    const next = h.observe(screen())!;
    expect(next.seq).not.toBe(first.seq);
    expect(next.guard.inputSeq).toBe(1);
  });

  it("keeps the stop and its guard across an arming again, lifting only a person's verdict", () => {
    const h = harness();
    h.tracker.arm();
    h.observe(COUNTING);
    h.type("\x1b");
    const left = h.observe(CANCELLED_SCREEN)!;
    expect(left.skipAtStop).toBe("auto-continue-cancelled");
    h.type("x");
    h.tracker.arm();
    expect(h.observe(CANCELLED_SCREEN)).toBe(left);
    expect(left).toMatchObject({ skipAtStop: null, guard: { inputSeq: 1 } });
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
    const later = Date.UTC(2026, 10, 19, 15, 5);
    expect(h.observe(screen(), { now: later, shownAt: () => NOW })?.reset).toEqual({
      resetsAt: Date.UTC(2026, 10, 19, 15, 1),
    });
    const unseen = harness();
    expect(unseen.observe(screen(), { now: later })?.reset).toEqual({
      resetsAt: Date.UTC(2026, 10, 20, 15, 1),
    });
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
