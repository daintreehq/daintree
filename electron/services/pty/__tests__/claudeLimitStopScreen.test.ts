import { describe, expect, it } from "vitest";
import { judgeClaudeLimitScreen, readClaudeLimitScreen } from "../claudeLimitStopScreen.js";

const RULE = "─".repeat(60);
const BANNER = "  ⎿  You've hit your weekly limit · resets Oct 2 at 9pm (Europe/Lisbon)";
const HINT = "     /upgrade to increase your usage limit.";
const CANCELLED = "  ⎿  Automatic continue cancelled · /rate-limit-options to re-arm";
const COUNTDOWN = "  Usage limit reached · continuing automatically at 10am · esc to cancel";
const FOOTER = "  ⏵⏵ accept edits on (shift+tab to cycle)";

function rows({
  above = ["● Refactoring the parser."],
  between = [] as string[],
  input = "❯ ",
  footer = FOOTER,
} = {}): string[] {
  return [...above, BANNER, HINT, "", ...between, RULE, input, RULE, footer];
}

const cancelled = () => rows({ between: [CANCELLED, ""] });
const bannerKeyOf = (lines: string[]) => {
  const screen = readClaudeLimitScreen(lines, 80);
  if (screen === null || screen === "no-composer") throw new Error("expected a stop");
  return screen.bannerKey;
};

describe("readClaudeLimitScreen (#18192)", () => {
  it("reads Claude's countdown as its own wait, and the same banner once cancelled as a stop", () => {
    const counting = readClaudeLimitScreen(rows({ footer: COUNTDOWN }), 80);
    const stopped = readClaudeLimitScreen(cancelled(), 80);
    expect(counting).toMatchObject({
      window: "weekly limit",
      resetText: "Oct 2 at 9pm (Europe/Lisbon)",
      countdown: true,
      cancelled: false,
      last: true,
    });
    expect(stopped).toMatchObject({ countdown: false, cancelled: true, last: true });
    // Cancelling makes it another stop, under the same banner.
    expect((stopped as { key: string }).key).not.toBe((counting as { key: string }).key);
  });

  it("reads the countdown when a narrow pane wraps it", () => {
    const wrapped = rows({ footer: "  Usage limit reached · continuing" }).concat(
      "  automatically at 10am"
    );
    expect(readClaudeLimitScreen(wrapped, 40)).toMatchObject({ countdown: true });
  });

  it("names the same stop through a repaint with blank rows, and another under other history", () => {
    const first = readClaudeLimitScreen(cancelled(), 80) as { key: string };
    const repainted = readClaudeLimitScreen(["", ...cancelled(), "", ""], 80) as { key: string };
    const later = readClaudeLimitScreen(
      rows({ above: ["● Fixed the lexer."], between: [CANCELLED] }),
      80
    ) as {
      key: string;
    };
    expect(repainted.key).toBe(first.key);
    expect(later.key).not.toBe(first.key);
  });

  it("says when something was printed after the banner", () => {
    expect(readClaudeLimitScreen(rows({ between: ["● Retrying the request."] }), 80)).toMatchObject(
      {
        last: false,
      }
    );
  });

  it("says nothing either way of a banner with no composer under it, and nothing at all with no banner", () => {
    expect(readClaudeLimitScreen(["● Refactoring the parser.", BANNER, HINT], 80)).toBe(
      "no-composer"
    );
    expect(readClaudeLimitScreen(["● Done.", "", RULE, "❯ ", RULE, FOOTER], 80)).toBeNull();
  });

  it("leaves a usage warning in the footer, which isn't a stop", () => {
    const warning = [
      "● Done.",
      "",
      RULE,
      "❯ ",
      RULE,
      "  You've used 90% of your weekly limit · resets 9pm",
    ];
    expect(readClaudeLimitScreen(warning, 80)).toBeNull();
  });
});

describe("judgeClaudeLimitScreen (#18192)", () => {
  const serialized = (lines: string[]) => lines.join("\r\n");
  const key = bannerKeyOf(cancelled());

  it("continues a cancelled stop above an empty composer", () => {
    expect(judgeClaudeLimitScreen(serialized(cancelled()), 80, key)).toEqual({ line: "continue" });
  });

  it("types nothing while Claude's own countdown is back on screen", () => {
    expect(
      judgeClaudeLimitScreen(serialized(rows({ between: [CANCELLED], footer: COUNTDOWN })), 80, key)
    ).toEqual({ skip: "own-wait" });
  });

  it.each([
    ["a draft in the composer", rows({ between: [CANCELLED], input: "❯ fix the lexer" }), "draft"],
    [
      "a new turn after the banner",
      rows({ between: [CANCELLED, "● Retrying."] }),
      "banner-not-last",
    ],
    ["another banner", rows({ between: [] }), "banner-changed"],
    ["no banner", ["● Done.", RULE, "❯ ", RULE, FOOTER], "banner-gone"],
    [
      "a dialog in the composer's place",
      ["● Refactoring the parser.", BANNER, HINT, CANCELLED, "  1. Yes"],
      "no-composer",
    ],
  ])("types nothing with %s", (_label, lines, skip) => {
    expect(judgeClaudeLimitScreen(serialized(lines), 80, key)).toEqual({ skip });
  });
});
