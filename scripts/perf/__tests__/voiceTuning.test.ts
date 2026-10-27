import { describe, expect, it } from "vitest";
import { OPENAI_TRANSCRIPTION_TUNING } from "../../../electron/services/voice/openaiTranscriptionTuning";
import type { ObservedEvent } from "../lib/voicePreviewFinalScore";
import {
  isExcluded,
  parseTuningArm,
  renderTuningTable,
  scoreTuningSession,
  summariseTuning,
  type ScoredTuningSession,
  type TuningSession,
} from "../lib/voiceTuningScore";

function session(
  arm: string,
  events: ObservedEvent[],
  overrides: Partial<TuningSession> = {}
): TuningSession {
  return {
    arm,
    clip: "clip",
    pass: 1,
    startResult: { ok: true },
    events,
    vad: {
      forks: 1,
      ready: 1,
      speechStarts: 1,
      speechEnds: 0,
      pauses: 0,
      errors: 0,
      unexpectedExits: 0,
    },
    reconnects: 0,
    droppedConnect: 0,
    droppedReplay: 0,
    audioMs: 3000,
    readyMs: 1200,
    maxChunkLateMs: 5,
    stopMs: 3000,
    drainMs: 700,
    ...overrides,
  };
}

const delta = (at: number, itemId: string, text: string): ObservedEvent => ({
  at,
  type: "delta",
  itemId,
  text,
});

const complete = (at: number, itemId: string, text: string): ObservedEvent => ({
  at,
  type: "complete",
  itemId,
  text,
  endOfSpeech: false,
  endsAtPause: false,
  incomplete: false,
});

function scored(
  arm: string,
  clip: string,
  pass: number,
  hypothesis: string,
  reference = "fix the leak now",
  { finalAt = 2000, terms = [] as string[] } = {}
): ScoredTuningSession {
  const result = scoreTuningSession(
    session(arm, [complete(finalAt, "a", hypothesis)], { clip, pass }),
    reference,
    terms
  );
  if (isExcluded(result)) throw new Error("expected a scored session");
  return result;
}

describe("parseTuningArm", () => {
  it("runs production's segmentation at a bare tier", () => {
    expect(parseTuningArm("high").tuning).toEqual({
      ...OPENAI_TRANSCRIPTION_TUNING,
      delay: "high",
    });
  });

  it("reads a cap and a gap rule in seconds", () => {
    expect(parseTuningArm("low:cap15").tuning).toMatchObject({
      minSegmentMs: null,
      maxSegmentMs: 15_000,
    });
    expect(parseTuningArm("medium:gap8-15").tuning).toEqual({
      delay: "medium",
      minSegmentMs: 8_000,
      maxSegmentMs: 15_000,
    });
    expect(parseTuningArm("low:gap6.5-12").tuning.minSegmentMs).toBe(6_500);
  });

  it("refuses an arm the provider couldn't run", () => {
    expect(() => parseTuningArm("loud")).toThrow(/delay tier/);
    expect(() => parseTuningArm("low:gap15-8")).toThrow(/minSegmentMs/);
    expect(() => parseTuningArm("low:cap0")).toThrow(/maxSegmentMs/);
    expect(() => parseTuningArm("low:fast")).toThrow(/can't read/);
  });
});

describe("scoreTuningSession", () => {
  it("scores the finals with words, in completion order, and times them from the stop", () => {
    const result = scoreTuningSession(
      session("low", [
        delta(600, "z", " "),
        complete(700, "z", ""),
        delta(900, "a", "fix the"),
        complete(1500, "a", "Fix the"),
        complete(2600, "b", ""),
        delta(2900, "c", "leak"),
        complete(3400, "c", "leak now."),
        complete(3500, "d", " "),
      ]),
      "Fix the leak now.",
      ["leak"]
    );
    if (isExcluded(result)) throw new Error("expected a scored session");
    expect(result.hypothesis).toBe("Fix the leak now.");
    expect(result.score.wer).toBe(0);
    expect(result.timing).toEqual({
      readyMs: 1200,
      firstDeltaMs: 900,
      firstFinalMs: 1500,
      stopToLastFinalMs: 400,
      drainMs: 700,
    });
    expect(result.segments).toBe(5);
    expect(result.emptyFinals).toBe(3);
  });

  it("times a last final that landed before the stop as negative", () => {
    const result = scoreTuningSession(session("low", [complete(2400, "a", "fix")]), "fix", []);
    expect(!isExcluded(result) && result.timing.stopToLastFinalMs).toBe(-600);
  });

  it("leaves out a session with anything that would make its score lie", () => {
    const result = scoreTuningSession(
      session("low", [complete(1500, "a", "fix")], { reconnects: 1 }),
      "fix",
      []
    );
    expect(isExcluded(result) && result.reasons).toEqual(["reconnected"]);
  });

  it("has no stop timing for a run that predates it", () => {
    const result = scoreTuningSession(
      session("low", [complete(1500, "a", "fix")], { stopMs: undefined }),
      "fix",
      []
    );
    expect(!isExcluded(result) && result.timing.stopToLastFinalMs).toBeNull();
  });
});

describe("summariseTuning", () => {
  it("summarises only the clip and pass pairs every arm scored", () => {
    const lost = scoreTuningSession(
      session("high", [complete(1, "a", "fix")], { clip: "hard", reconnects: 1 }),
      "fix",
      []
    );
    const summary = summariseTuning(
      ["low", "high", "medium"],
      [
        scored("low", "easy", 1, "fix the leak now"),
        scored("high", "easy", 1, "fix the leak now"),
        scored("medium", "easy", 1, "fix the leak now"),
        scored("low", "easy", 2, "fixed a leek"),
        scored("high", "easy", 2, "fixed a leek"),
        scored("low", "hard", 1, "fixed a leek"),
        lost,
      ]
    );
    // Only easy pass 1 is in every arm: the pass is part of the pair.
    expect(summary.cohort).toBe(1);
    expect(summary.excluded).toHaveLength(1);
    expect(summary.armSummaries.map((arm) => [arm.arm, arm.sessions, arm.pooledWer])).toEqual([
      ["low", 1, 0],
      ["high", 1, 0],
      ["medium", 1, 0],
    ]);
  });

  it("pools edits over reference words, so a long clip weighs more", () => {
    const summary = summariseTuning(
      ["low"],
      [
        scored("low", "short", 1, "fix", "fix it"),
        scored(
          "low",
          "long",
          1,
          "one two three four five six seven eight",
          "one two three four five six seven eight"
        ),
      ]
    );
    const [arm] = summary.armSummaries;
    expect(arm!.pooledWer).toBeCloseTo(1 / 10);
    expect(arm!.meanWer).toBeCloseTo(0.25);
  });

  it("reports recall, kept ends and timing spreads per arm", () => {
    const finals = [2100, 2500, 2900, 3300, 4100];
    const summary = summariseTuning(
      ["low"],
      finals.map((finalAt, i) =>
        scored("low", `clip-${i}`, 1, i === 0 ? "the leak now" : "fix the leak now", undefined, {
          finalAt,
          terms: i < 2 ? ["leak", "bug"] : [],
        })
      )
    );
    const [arm] = summary.armSummaries;
    expect(arm!.termRecall).toBe(0.5);
    expect(arm!.firstWordKeptRate).toBe(0.8);
    expect(arm!.lastWordKeptRate).toBe(1);
    // From a stop at 3000: -900, -500, -100, 300, 1100.
    expect(arm!.timing.stopToLastFinalMs).toEqual({ median: -100, p95: 1100, count: 5 });
    expect(arm!.timing.firstFinalMs).toEqual({ median: 2900, p95: 4100, count: 5 });

    const table = renderTuningTable(summary).join("\n");
    expect(table).toContain("| low | 5.0% | 5.0% | 50.0% | 80.0% | 100.0% |");
    expect(table).toContain("| -100 / 1100 |");
  });

  it("compares every arm with the first, session by session", () => {
    const at = (finalAt: number) => ({ finalAt });
    const summary = summariseTuning(
      ["low", "high"],
      [
        scored("low", "a", 1, "fix a leek now", undefined, at(3200)),
        scored("high", "a", 1, "fix the leak now", undefined, at(3500)),
        scored("low", "b", 1, "fix the leak now", undefined, at(3200)),
        scored("high", "b", 1, "fix the leak now", undefined, at(3300)),
        scored("low", "c", 1, "fix the leak now", undefined, at(3200)),
        scored("high", "c", 1, "fix the leak", undefined, at(3100)),
      ]
    );
    expect(summary.paired).toEqual([
      {
        arm: "high",
        against: "low",
        pairs: 3,
        meanEditDelta: -1 / 3,
        fewerEdits: 1,
        moreEdits: 1,
        sameEdits: 1,
        medianStopToLastFinalDeltaMs: 100,
      },
    ]);
    expect(renderTuningTable(summary).join("\n")).not.toMatch(/leek/);
  });
});
