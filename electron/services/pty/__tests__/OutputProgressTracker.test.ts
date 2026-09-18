import { describe, it, expect } from "vitest";
import {
  OUTPUT_PROGRESS_RESIZE_QUIET_MS,
  OutputProgressTracker,
  normalizeProgressLines,
} from "../OutputProgressTracker.js";

const answer = ["● The fix is in src/app.ts.", "", "  ⎿  Updated 2 files"];

function claudeFrame(spinner: string, elapsed: string): string[] {
  return [
    ...answer,
    `${spinner} Thinking… (${elapsed} · ↓ 1.${elapsed.length}k tokens · esc to interrupt)`,
  ];
}

describe("OutputProgressTracker", () => {
  it("counts the first rendered content as a change from the blank screen", () => {
    const tracker = new OutputProgressTracker();
    expect(tracker.observe([], 0)).toBe(false);
    expect(tracker.observe(answer, 100)).toBe(true);
  });

  it("reports nothing for a frame identical to the last", () => {
    const tracker = new OutputProgressTracker();
    tracker.observe(answer, 0);
    expect(tracker.observe([...answer], 100)).toBe(false);
  });

  it("ignores a frozen turn whose only motion is its working footer (the #12428 case)", () => {
    const tracker = new OutputProgressTracker();
    expect(tracker.observe(claudeFrame("✻", "2m 38s"), 0)).toBe(true);
    expect(tracker.observe(claudeFrame("✽", "2m 39s"), 1_000)).toBe(false);
    expect(tracker.observe(claudeFrame("✶", "2m 40s"), 2_000)).toBe(false);
  });

  it.each([
    ["Codex", "• Working (12s • esc to interrupt)", "• Working (13s • esc to interrupt)"],
    [
      "Gemini",
      "⠼ Pondering the question (esc to cancel, 14s)",
      "⠴ Reticulating splines (esc to cancel, 15s)",
    ],
    ["Copilot", "∙ Thinking (Esc to cancel)", "○ Thinking (Esc to cancel)"],
    ["a bare spinner", "⠋ thinking", "⠙ thinking"],
  ])("ignores %s's footer animating", (_agent, before, after) => {
    const tracker = new OutputProgressTracker();
    tracker.observe([...answer, before], 0);
    expect(tracker.observe([...answer, after], 1_000)).toBe(false);
  });

  it("ignores a tool row's elapsed timer ticking", () => {
    const tracker = new OutputProgressTracker();
    tracker.observe(["● Bash(npm test)", "  ⎿  Running… (12s)"], 0);
    expect(tracker.observe(["● Bash(npm test)", "  ⎿  Running… (13s)"], 1_000)).toBe(false);
  });

  it("sees new content arriving beside a spinner that is also ticking", () => {
    // The whole-viewport activity classifier calls this frame indicator
    // activity; the tracker must still count the new line.
    const tracker = new OutputProgressTracker();
    tracker.observe(claudeFrame("✻", "12s"), 0);
    const next = [...answer, "● Now running the tests.", "✽ Thinking… (13s · esc to interrupt)"];
    expect(tracker.observe(next, 1_000)).toBe(true);
  });

  it("sees output that scrolls the viewport", () => {
    const tracker = new OutputProgressTracker();
    tracker.observe(["line 1", "line 2", "line 3"], 0);
    expect(tracker.observe(["line 2", "line 3", "line 4"], 200)).toBe(true);
  });

  it("keeps ordinary numbers that are not timers or token counts", () => {
    const tracker = new OutputProgressTracker();
    tracker.observe(["Tests: 41 passed, 100 total"], 0);
    expect(tracker.observe(["Tests: 42 passed, 100 total"], 200)).toBe(true);
  });

  it("treats a change inside the resize window as reflow, then re-baselines on it", () => {
    const tracker = new OutputProgressTracker();
    tracker.observe(["a long line that wraps"], 0);
    tracker.noteResize(1_000);
    expect(tracker.observe(["a long line", "that wraps"], 1_200)).toBe(false);
    // The reflowed frame is the new baseline, so seeing it again is not a change.
    expect(
      tracker.observe(["a long line", "that wraps"], 1_000 + OUTPUT_PROGRESS_RESIZE_QUIET_MS)
    ).toBe(false);
    expect(
      tracker.observe(["a long line", "that wraps", "new"], 1_000 + OUTPUT_PROGRESS_RESIZE_QUIET_MS)
    ).toBe(true);
  });

  it("sees a tool row change that a spinner-and-verb pattern would have swallowed", () => {
    const tracker = new OutputProgressTracker();
    tracker.observe([...answer, "● Running tests in a.ts"], 0);
    expect(tracker.observe([...answer, "● Running tests in b.ts"], 1_000)).toBe(true);
  });

  it("reads every frame of a hintless star spinner the same", () => {
    // Claude's cycle passes through `·` and `*`; dropping some frames and
    // keeping others would stamp on every lap.
    const tracker = new OutputProgressTracker();
    tracker.observe([...answer, "· Cogitating…"], 0);
    expect(tracker.observe([...answer, "✻ Cogitating…"], 1_000)).toBe(false);
    expect(tracker.observe([...answer, "* Cogitating…"], 2_000)).toBe(false);
  });

  it("reads a timer rolling over into minutes as unchanged", () => {
    const tracker = new OutputProgressTracker();
    tracker.observe(["● Bash(npm test)", "  ⎿  Running… (59s)"], 0);
    expect(tracker.observe(["● Bash(npm test)", "  ⎿  Running… (1m 0s)"], 1_000)).toBe(false);
    expect(tracker.observe(["● Bash(npm test)", "  ⎿  Running… (1:01)"], 2_000)).toBe(false);
  });

  it("keeps durations and token counts in ordinary output", () => {
    const tracker = new OutputProgressTracker();
    tracker.observe(["p95: 3.5s, budget 100 tokens"], 0);
    expect(tracker.observe(["p95: 10ms, budget 100 tokens"], 200)).toBe(true);
    expect(tracker.observe(["p95: 10ms, budget 200 tokens"], 400)).toBe(true);
  });

  it("ignores aider's waiting bar sweeping", () => {
    const tracker = new OutputProgressTracker();
    tracker.observe([...answer, "░░░░░░░░░█ Waiting for claude-sonnet"], 0);
    expect(tracker.observe([...answer, "░░░░██░░░░ Waiting for claude-sonnet"], 1_000)).toBe(false);
  });

  it("sees an indentation-only change", () => {
    const tracker = new OutputProgressTracker();
    tracker.observe(["def f():", "return 1"], 0);
    expect(tracker.observe(["def f():", "    return 1"], 200)).toBe(true);
  });
});

describe("normalizeProgressLines", () => {
  it("drops hinted status rows, masks tickers inside parentheses, and collapses interior spacing", () => {
    expect(
      normalizeProgressLines([
        "✻ Thinking… (2m 39s · esc to interrupt)",
        "  ⎿  Running…   (1h2m3s · ↓ 12.5k tokens)  ",
        "Used 12.5k tokens in v1.2m",
        "   ",
      ])
    ).toEqual(["  ⎿ Running… (# ~ ↓ #)", "Used 12.5k tokens in v1.2m"]);
  });
});
