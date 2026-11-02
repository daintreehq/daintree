import { describe, expect, it } from "vitest";
import { resolveResetsAt, scanClaudeUsageMessages } from "../ClaudeUsageWarnings.js";

const COLS = 160;
const scan = (...lines: string[]) => scanClaudeUsageMessages(lines, COLS);

/** A footer row as Claude draws it: hints on the left, the warning flush right. */
const footer = (left: string, message: string) =>
  `${left}${" ".repeat(COLS - 1 - left.length - message.length)}${message}`;

// Rows as Claude Code prints them. The banner under a tool result is #13127's
// capture; the footer warnings are Claude Code 2.1.316's message builder
// ("You've used ${n}% of your ${limit}", "Over ${n}% of your ${limit} used",
// "Approaching ${limit}", each joined to "resets ${when}" with " · "), which
// it draws flush right in the prompt footer, truncated with "…" when it doesn't
// fit, or on a row of its own; the window-first and session forms are older
// builds' banners.
describe("scanClaudeUsageMessages", () => {
  it.each([
    [
      "the hit-limit banner under a tool result",
      "  ⎿  You've hit your weekly limit · resets Oct 2 at 9pm (Europe/Lisbon)",
      { window: "weekly limit", statement: "reached", usedPercent: null },
      "Oct 2 at 9pm (Europe/Lisbon)",
    ],
    [
      "a used-percent warning on a row of its own",
      "  You've used 87% of your weekly limit · resets Nov 2 at 6pm (Australia/Sydney)",
      { window: "weekly limit", statement: "used", usedPercent: 87 },
      "Nov 2 at 6pm (Australia/Sydney)",
    ],
    [
      "a used-percent warning beside the footer's shortcuts hint",
      footer(
        "  ? for shortcuts",
        "You’ve used 91% of your 5-hour limit · resets 3:30pm (America/New_York)"
      ),
      { window: "5-hour limit", statement: "used", usedPercent: 91 },
      "3:30pm (America/New_York)",
    ],
    [
      "a threshold warning with an upgrade hint beside a mode",
      footer(
        "  ⏵⏵ accept edits on (shift+tab to cycle)",
        "Over 75% of your weekly limit used · resets Nov 4 at 9am (Europe/London) · /upgrade to keep using Claude Code"
      ),
      { window: "weekly limit", statement: "over", usedPercent: 75 },
      "Nov 4 at 9am (Europe/London)",
    ],
    [
      "a footer warning cut short",
      footer("  ? for shortcuts", "You've used 87% of your weekly limit · resets Nov 2 at 6…"),
      { window: "weekly limit", statement: "used", usedPercent: 87 },
      "Nov 2 at 6…",
    ],
    [
      "a warning with a border glyph after it",
      "──── You've used 100% of your Fable limit · resets 3pm (UTC) ▔",
      { window: "Fable limit", statement: "used", usedPercent: 100 },
      "3pm (UTC)",
    ],
    [
      "an approaching warning for a model's limit",
      "Approaching Opus limit · resets Nov 4 at 9am (Europe/London)",
      { window: "Opus limit", statement: "approaching", usedPercent: null },
      "Nov 4 at 9am (Europe/London)",
    ],
    [
      "an approaching warning with no reset",
      "Approaching 5-hour limit",
      { window: "5-hour limit", statement: "approaching", usedPercent: null },
      null,
    ],
    [
      "a model's hit limit",
      "You've hit your Sonnet limit · resets Oct 3 at 1am",
      { window: "Sonnet limit", statement: "reached", usedPercent: null },
      "Oct 3 at 1am",
    ],
    [
      "a hit limit with progress saved",
      "  ⎿  You've hit your 5-hour limit · resets 4pm (Europe/Lisbon) · progress saved",
      { window: "5-hour limit", statement: "reached", usedPercent: null },
      "4pm (Europe/Lisbon)",
    ],
    [
      "an older build's session limit",
      "You've hit your session limit · resets 6pm",
      { window: "session limit", statement: "reached", usedPercent: null },
      "6pm",
    ],
    [
      "an older build's window-first banner",
      "5-hour limit reached ∙ resets 3pm",
      { window: "5-hour limit", statement: "reached", usedPercent: null },
      "3pm",
    ],
    [
      "an unqualified limit with its reset",
      "You've hit your limit · resets 2pm (America/New_York)",
      { window: "limit", statement: "reached", usedPercent: null },
      "2pm (America/New_York)",
    ],
    [
      "an unqualified usage limit",
      "  ⎿  You've hit your usage limit",
      { window: "usage limit", statement: "reached", usedPercent: null },
      null,
    ],
  ])("reads %s", (_name, row, expected, resetText) => {
    expect(scan("some output", row, "")).toEqual([{ ...expected, resetText }]);
  });

  it.each([
    ["Codex's own warning", "⚠ Heads up, you have less than 10% of your weekly limit left."],
    ["prose about a limit", "The banner says you've hit your weekly limit · resets Oct 2"],
    ["a sentence that goes on", "You've used 87% of your weekly limit, so slow down."],
    ["a question", "Have you hit your weekly limit?"],
    ["a quoted fixture", `  "You've used 87% of your weekly limit · resets Nov 2 at 6pm",`],
    [
      "a quoted footer fixture reaching the edge",
      footer(`  "  ? for shortcuts`, `You've used 91% of your 5-hour limit · resets 3pm (UTC)",`),
    ],
    ["a template string", "  `Over 75% of your weekly limit used · resets ${when}`"],
    ["a retry budget", "  ⎿  You've hit your limit of 5 retries · resets Oct 2"],
    ["a bare limit with no reset", "You've hit your limit"],
    ["a window-first banner with no reset", "Session limit reached"],
    ["a credit limit", "Over 80% of your usage credit limit used · resets Nov 4"],
    ["a team budget", "You've hit your team's shared budget · resets Nov 4"],
    ["closeness to a credit limit", "You're close to your usage credit limit"],
    ["an impossible percent", "You've used 101% of your weekly limit"],
    ["a limit the row goes on about", "Approaching weekly limit of tokens"],
    ["prose after a single space", "Note: You've used 87% of your weekly limit · resets Nov 2"],
    ["prose after a gap", "The banner says:  You've hit your weekly limit · resets 3pm (UTC)"],
    ["a code comment", "//  You've used 87% of your weekly limit · resets 3pm (UTC)"],
    ["an added diff line", "+  Approaching Opus limit · resets 3pm (UTC)"],
    [
      "a table cell reaching the edge",
      footer("| Example |", "You've used 87% of your weekly limit · resets 3pm (UTC) |"),
    ],
    [
      "a code comment reaching the edge",
      footer("  //", "You've used 87% of your weekly limit · resets 3pm (Australia/Sydney)"),
    ],
    ["a quoted banner", `  ⎿  You've hit your weekly limit · resets 3pm (UTC)",`],
    [
      "a gap followed by something other than the message",
      footer("  ? for shortcuts", "- You've used 87% of your weekly limit · resets 3pm (UTC)"),
    ],
  ])("ignores %s", (_name, row) => {
    expect(scan(row)).toEqual([]);
  });

  it("reads a message after a gap only on a row that reaches the pane's edge", () => {
    const row = "  ? for shortcuts      You've used 87% of your weekly limit · resets 3pm (UTC)";
    expect(scanClaudeUsageMessages([row], row.length + 1)).toHaveLength(1);
    expect(scanClaudeUsageMessages([row], row.length + 20)).toEqual([]);
    expect(scanClaudeUsageMessages([row])).toEqual([]);
  });

  it("keeps the lowest message per window and one per window", () => {
    expect(
      scan(
        "You've used 80% of your weekly limit · resets Nov 2 at 6pm",
        "  ⎿  You've hit your 5-hour limit · resets 4pm",
        "You've used 87% of your weekly limit · resets Nov 2 at 6pm"
      )
    ).toEqual([
      { window: "weekly limit", statement: "used", usedPercent: 87, resetText: "Nov 2 at 6pm" },
      { window: "5-hour limit", statement: "reached", usedPercent: null, resetText: "4pm" },
    ]);
  });

  it("reads only the tail of the viewport", () => {
    const old = "You've used 80% of your weekly limit · resets Nov 2 at 6pm";
    expect(scan(old, ...Array.from({ length: 11 }, () => "output"))).toHaveLength(1);
    expect(scan(old, ...Array.from({ length: 12 }, () => "output"))).toEqual([]);
  });

  it("strips colour before matching", () => {
    expect(scan("\x1b[33mYou've used 87% of your weekly limit\x1b[39m")).toEqual([
      { window: "weekly limit", statement: "used", usedPercent: 87, resetText: null },
    ]);
  });

  describe("a reset a narrow pane wrapped", () => {
    const wrapped = (first: string, second: string) => scan(first, second)[0]?.resetText;

    it("carries the rest of the time from the next row", () => {
      expect(
        wrapped(
          "  ⎿  You've hit your weekly limit · resets Nov 2 at",
          "     6pm (Australia/Sydney)"
        )
      ).toBe("Nov 2 at 6pm (Australia/Sydney)");
    });

    it("carries a zone that wrapped after a whole time", () => {
      expect(
        wrapped("  ⎿  You've hit your weekly limit · resets 3pm", "     (America/New_York)")
      ).toBe("3pm (America/New_York)");
    });

    it("carries a zone that wrapped inside its name", () => {
      expect(
        wrapped("  ⎿  You've hit your weekly limit · resets 3pm (America/New_", "     York)")
      ).toBe("3pm (America/New_York)");
    });

    it("carries a reset that wrapped whole", () => {
      expect(wrapped("  ⎿  You've hit your weekly limit · resets", "     3pm (UTC)")).toBe(
        "3pm (UTC)"
      );
    });

    it("leaves a row that only looks like a zone out of it", () => {
      expect(wrapped("  ⎿  You've hit your weekly limit · resets 3pm", "  (main)")).toBe("3pm");
    });

    it("leaves an unrelated row out of it", () => {
      expect(
        wrapped("You've used 87% of your weekly limit · resets Nov 2 at", "  ✻ Thinking…")
      ).toBe("Nov 2 at");
      expect(wrapped("  ⎿  You've hit your weekly limit · resets 3pm", "  ✻ Thinking…")).toBe(
        "3pm"
      );
    });
  });
});

describe("resolveResetsAt", () => {
  // 2026-11-02 10:00 in Sydney (UTC+11) is 2026-11-01T23:00Z.
  const sydneyMorning = Date.UTC(2026, 10, 1, 23, 0);

  it("reads a dated reset in the zone Claude printed", () => {
    expect(resolveResetsAt("Nov 2 at 6pm (Australia/Sydney)", sydneyMorning)).toBe(
      Date.UTC(2026, 10, 2, 7, 0)
    );
  });

  it("reads the comma form and minutes", () => {
    expect(resolveResetsAt("Nov 4, 9:30am (Europe/London)", sydneyMorning)).toBe(
      Date.UTC(2026, 10, 4, 9, 30)
    );
  });

  it("takes a printed year over the observation's", () => {
    expect(resolveResetsAt("Jan 3, 2027 at 9pm (UTC)", sydneyMorning)).toBe(
      Date.UTC(2027, 0, 3, 21, 0)
    );
  });

  it("reads noon and midnight", () => {
    expect(resolveResetsAt("Nov 3 at 12pm (UTC)", sydneyMorning)).toBe(
      Date.UTC(2026, 10, 3, 12, 0)
    );
    expect(resolveResetsAt("Nov 3 at 12am (UTC)", sydneyMorning)).toBe(Date.UTC(2026, 10, 3, 0, 0));
  });

  it("reads a bare time as its next showing", () => {
    // 3pm Sydney is later the same day.
    expect(resolveResetsAt("3pm (Australia/Sydney)", sydneyMorning)).toBe(
      Date.UTC(2026, 10, 2, 4, 0)
    );
    // 9am Sydney has passed, so it is tomorrow's.
    expect(resolveResetsAt("9am (Australia/Sydney)", sydneyMorning)).toBe(
      Date.UTC(2026, 10, 2, 22, 0)
    );
  });

  it("keeps a bare time printed moments before it passed as today's", () => {
    const justAfter = Date.UTC(2026, 10, 2, 4, 0, 50);
    expect(resolveResetsAt("3pm (Australia/Sydney)", justAfter)).toBe(Date.UTC(2026, 10, 2, 4, 0));
  });

  it("reads a bare time minutes past as tomorrow's", () => {
    // Printed at 15:03 for a reset within the day, 3pm can only be tomorrow's.
    expect(resolveResetsAt("3pm (UTC)", Date.UTC(2026, 10, 2, 15, 3))).toBe(
      Date.UTC(2026, 10, 3, 15, 0)
    );
  });

  it("settles across a daylight-saving change", () => {
    // New York leaves daylight time on 2026-11-01; 9am on Nov 2 is UTC-5.
    expect(resolveResetsAt("Nov 2 at 9am (America/New_York)", sydneyMorning)).toBe(
      Date.UTC(2026, 10, 2, 14, 0)
    );
    // Oct 30 is still daylight time, UTC-4.
    expect(resolveResetsAt("Oct 30 at 9am (America/New_York)", sydneyMorning)).toBe(
      Date.UTC(2026, 9, 30, 13, 0)
    );
  });

  it("takes tomorrow's showing of a bare time the clock skips today", () => {
    // New York skips 2:00-3:00am on 2026-03-08; seen at 3:10am EDT.
    expect(resolveResetsAt("2:30am (America/New_York)", Date.UTC(2026, 2, 8, 7, 10))).toBe(
      Date.UTC(2026, 2, 9, 6, 30)
    );
  });

  it("takes the showing still to come of a bare time the clock repeats", () => {
    // 1:00-2:00am repeats on 2026-11-01; seen at the second 1:00am (EST).
    expect(resolveResetsAt("1:30am (America/New_York)", Date.UTC(2026, 10, 1, 6, 0))).toBe(
      Date.UTC(2026, 10, 1, 6, 30)
    );
  });

  it("takes the showing still to come of a dated time the clock repeats", () => {
    // 1:00-2:00am repeats in New York on 2026-11-01: EDT 05:30Z, then EST 06:30Z.
    const reset = "Nov 1 at 1:30am (America/New_York)";
    expect(resolveResetsAt(reset, Date.UTC(2026, 10, 1, 5, 0))).toBe(Date.UTC(2026, 10, 1, 5, 30));
    expect(resolveResetsAt(reset, Date.UTC(2026, 10, 1, 6, 0))).toBe(Date.UTC(2026, 10, 1, 6, 30));
    expect(resolveResetsAt(reset, Date.UTC(2026, 10, 1, 9, 0))).toBe(Date.UTC(2026, 10, 1, 6, 30));
  });

  it.each([
    ["no reset", null],
    ["a cut-off reset", "Nov 2 at"],
    ["a truncated reset", "Nov 2 at 6…"],
    ["an unknown zone", "6pm (Mars/Olympus_Mons)"],
    ["a day the month doesn't have", "Feb 30 at 6pm (UTC)"],
    ["a dated time the clock skips", "Mar 8 at 2:30am (America/New_York)"],
    ["an hour past twelve", "13pm (UTC)"],
    ["a relative reset", "in 2 hours"],
  ])("answers null for %s", (_name, text) => {
    expect(resolveResetsAt(text, sydneyMorning)).toBeNull();
  });
});
