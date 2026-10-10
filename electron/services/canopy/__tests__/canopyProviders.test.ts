import { describe, expect, it } from "vitest";
import {
  CANOPY_NOTE_MAX_CHARS,
  combinePriority,
  reconcileScore,
  toDescriberResult,
  type CanopyScreenInput,
} from "../canopyProviders.js";

const INPUT: CanopyScreenInput = {
  agent: "claude",
  title: "Claude",
  screen: "Do you want to proceed?\n❯ 1. Yes\n  2. No",
  lines: ["Do you want to proceed?", "❯ 1. Yes", "  2. No"],
  observed: { agentState: "waiting", waitingReason: "approval", secondsInState: 30 },
};

describe("combinePriority", () => {
  it("ranks a described run by the describer's score alone", () => {
    expect(combinePriority(0.95, 30)).toBe(30);
    expect(combinePriority(0.95, 88)).toBe(88);
  });

  it("takes the classifier's word alone for a run that was never described", () => {
    expect(combinePriority(0.42, null)).toBe(42);
  });
});

describe("toDescriberResult", () => {
  const approval = (score: unknown) => ({
    category: "approval",
    headline: "Run the tests?",
    question: "Do you want to proceed?",
    options: ["Yes", "No"],
    summary: "Waiting to run npm test.",
    attention_score: score,
  });

  it("reads the attention score, clamped to 0-100", () => {
    expect(toDescriberResult(approval(88), INPUT).attentionScore).toBe(88);
    expect(toDescriberResult(approval(140), INPUT).attentionScore).toBe(100);
    expect(toDescriberResult(approval("high"), INPUT).attentionScore).toBe(0);
  });

  it("reads a spelt-out null as no task and no question", () => {
    const result = toDescriberResult(
      {
        category: "finished",
        headline: "Review it",
        summary: "Done.",
        attention_score: 40,
        task: "null",
        question: "None",
        options: [],
        progress: 100,
        tests: "passing",
        changes: "maybe",
      },
      INPUT
    );
    expect(result).toMatchObject({ task: null, question: null, progress: 100, tests: "passing" });
    // A value outside the schema claims nothing.
    expect(result.changes).toBe("unknown");
  });

  it("refuses a card with no category it knows", () => {
    expect(() => toDescriberResult({ category: "busy", headline: "x" }, INPUT)).toThrow(
      "unexpected category"
    );
    expect(() => toDescriberResult("not a card", INPUT)).toThrow("unexpected response shape");
  });
});

describe("the describer's note", () => {
  const noted = (note: unknown, extra: Record<string, unknown> = {}) => ({
    category: "working",
    headline: "Running the tests",
    summary: "Third run of the dates test.",
    attention_score: 5,
    note,
    ...extra,
  });

  it("reads the new note back, and a repeated failure as stuck", () => {
    const result = toDescriberResult(
      noted("Goal: fix dates.\nWatch: dates test failed 3 runs", { failure_repeats: 3 }),
      { ...INPUT, note: { text: "Goal: fix dates.", secondsAgo: 40 } }
    );
    expect(result.note).toBe("Goal: fix dates.\nWatch: dates test failed 3 runs");
    expect(result.failureRepeats).toBe(3);
    expect(result.attentionScore).toBe(70);
  });

  it("treats an approval for something the user ruled out as risky", () => {
    const result = toDescriberResult(
      {
        category: "approval",
        headline: "Refuse npm install — use pnpm",
        summary: "You said never run npm here.",
        attention_score: 94,
        risk: "none",
        risk_reason: "You said never run npm here",
        instruction: "asked",
        note: "",
        failure_repeats: 0,
      },
      INPUT
    );
    expect(result).toMatchObject({ risk: "caution", attentionScore: 98, instruction: "asked" });
    expect(result.riskReason).toBe("You said never run npm here");
  });

  it("never raises the failure count on a screen that has not changed", () => {
    const result = toDescriberResult(
      noted("Watch: build fails TS2742: 4 runs", { failure_repeats: 4 }),
      { ...INPUT, failureRepeatsCap: 2 }
    );
    expect(result.failureRepeats).toBe(2);
    expect(result.attentionScore).toBe(5);
  });

  it("cuts an overlong note at a whole line", () => {
    const line = "Done: " + "x".repeat(300);
    const { note } = toDescriberResult(noted([line, line, line].join("\n")), INPUT);
    expect(note!.length).toBeLessThanOrEqual(CANOPY_NOTE_MAX_CHARS);
    expect(note).toBe([line, line].join("\n"));
  });

  it("reads a blank note as none", () => {
    expect(toDescriberResult(noted("  "), INPUT).note).toBeNull();
  });
});

describe("reconcileScore", () => {
  it("lifts a busy agent going round in circles to the stuck band", () => {
    expect(reconcileScore(5, "working", "unknown", "unknown", "failing", 60, 2)).toBe(5);
    expect(reconcileScore(5, "working", "unknown", "unknown", "failing", 60, 3)).toBe(70);
  });

  it("ranks a broken instruction by whether harm is still being done, under the approvals", () => {
    const score = (instruction: "none" | "asked" | "ongoing" | "done" | "irreversible") =>
      reconcileScore(5, "working", "unknown", "uncommitted", "unknown", 50, 0, 30, instruction);
    expect(score("none")).toBe(5);
    expect(score("asked")).toBe(5);
    expect(score("ongoing")).toBe(75);
    expect(score("done")).toBe(65);
    expect(score("irreversible")).toBe(88);
  });

  it("never ranks a question below its anchor", () => {
    expect(reconcileScore(70, "question", "unknown", "uncommitted", "passing", 100)).toBe(86);
  });

  it("keeps a fresh finished turn at 40 until it has sat for half an hour", () => {
    expect(reconcileScore(20, "finished", "unknown", "committed", "passing", 100, 0, 18)).toBe(40);
    expect(reconcileScore(20, "finished", "unknown", "committed", "passing", 100, 0, 2400)).toBe(
      20
    );
    expect(reconcileScore(20, "finished", "unknown", "committed", "passing", 100)).toBe(20);
  });
});
