import { describe, expect, it } from "vitest";
import { judgeCodexLimitScreen } from "../codexLimitContinueScreen.js";

// A Codex 0.170 screen in the serializer's shape: the stop banner as the last
// history cell, then the composer's tinted band and its footer.
const TINT = "\x1b[48;2;30;30;30m";
const PAD = " \x1b[99X";
const GLYPH = "\x1b[1m›\x1b[22m";
const PLACEHOLDER = "\x1b[2mAsk Codex to do anything\x1b[22m";
const BANNER = "■ You’ve hit your usage limit. Try again at 3:40 PM.";

function screen({
  above = "• Ran the tests.",
  banner = BANNER,
  between = [] as string[],
  box = PLACEHOLDER,
  footer = "  ? for shortcuts                                 100% context left",
} = {}): string {
  return [
    above,
    "",
    banner,
    "",
    ...between,
    `${TINT}${PAD}`,
    `${GLYPH} ${box}\x1b[50X`,
    `${PAD}`,
    `\x1b[0m${footer}`,
  ].join("\r\n");
}

describe("judgeCodexLimitScreen (#17909)", () => {
  it("continues a plain turn stopped at its limit", () => {
    expect(judgeCodexLimitScreen(screen(), 80)).toEqual({ line: "continue" });
  });

  it.each([
    ["alone", "  Goal hit usage limits (/goal resume)"],
    [
      "beside the IDE indicator",
      "  ? for shortcuts   Goal hit usage limits (/goal resume) · IDE context",
    ],
  ])("resumes a /goal run whose footer says it hit the limit, %s", (_, footer) => {
    expect(judgeCodexLimitScreen(screen({ footer }), 120)).toEqual({ line: "/goal resume" });
  });

  it.each([
    ["a paused goal", "  Goal paused (/goal resume)"],
    ["a goal still pursued", "  Pursuing goal (12k tokens)"],
    ["a goal status clipped at the edge", "  Goal hit usage li"],
    ["plan mode, which hides any goal status", "  Plan mode (shift+tab to cycle)"],
  ])("types nothing when the footer shows %s", (_, footer) => {
    expect(judgeCodexLimitScreen(screen({ footer }), 80)).toEqual({
      skip: "unrecognized-footer",
    });
  });

  it("types nothing once something was printed below the banner", () => {
    expect(judgeCodexLimitScreen(screen({ between: ["• Working on it", ""] }), 80)).toEqual({
      skip: "banner-not-last",
    });
  });

  it("types nothing over a draft in the composer", () => {
    expect(judgeCodexLimitScreen(screen({ box: "fix the flaky test" }), 80)).toEqual({
      skip: "draft",
    });
  });

  it("types nothing when the banner is gone", () => {
    expect(judgeCodexLimitScreen(screen({ banner: "• All done." }), 80)).toEqual({
      skip: "banner-gone",
    });
  });

  it("types nothing at a screen with no composer below the banner", () => {
    const dialog = [
      "• Ran the tests.",
      "",
      BANNER,
      "",
      "  Would you like to run the following command?",
      "› 1. Yes, proceed",
      "  2. No, and tell Codex what to do differently",
    ].join("\r\n");
    expect(judgeCodexLimitScreen(dialog, 80)).toEqual({ skip: "banner-not-last" });
    expect(judgeCodexLimitScreen(`• Ran the tests.\r\n\r\n${BANNER}\r\n`, 80)).toEqual({
      skip: "no-composer",
    });
  });

  it("reads a banner Codex word-wrapped at a narrow pane", () => {
    const wrapped = screen({
      banner: "■ You’ve hit your usage limit. Try again at\r\n3:40 PM.",
    });
    expect(judgeCodexLimitScreen(wrapped, 44)).toEqual({ line: "continue" });
  });
});
