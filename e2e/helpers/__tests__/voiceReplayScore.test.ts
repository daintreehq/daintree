import { describe, expect, it } from "vitest";
import {
  alignWords,
  compareRuns,
  normaliseWords,
  renderComparison,
  scoreClip,
  summariseConfig,
  termRecalled,
  VOICE_REPLAY_SCHEMA_VERSION,
  VOICE_REPLAY_SCORING_VERSION,
  type SessionResult,
  type SessionTiming,
  type VoiceReplayRun,
} from "../voiceReplayScore";

const timing = (overrides: Partial<SessionTiming> = {}): SessionTiming => ({
  micOpenMs: 100,
  recordingMs: 400,
  firstDeltaMs: 900,
  firstFinalMs: 1500,
  stopMs: 3000,
  stopLateMs: 2,
  stopToLastFinalMs: 600,
  stopToEndedMs: 800,
  audioMs: 2900,
  ...overrides,
});

function session(
  clip: string,
  config: string,
  reference: string,
  hypothesis: string,
  extra: Partial<SessionResult> = {}
): SessionResult {
  return {
    clip,
    config,
    repeat: 0,
    hypothesis,
    draft: null,
    score: scoreClip(reference, hypothesis, []),
    timing: timing(),
    statuses: ["connecting", "recording", "finishing"],
    endReason: "stopped",
    errors: [],
    ...extra,
  };
}

describe("normaliseWords", () => {
  it("scores formatted and spoken forms of the same prompt as the same words", () => {
    expect(normaliseWords("Run npm test --watch on src/index.ts")).toEqual(
      normaliseWords("run N P M test dash dash watch on src slash index dot TS")
    );
  });

  it("splits identifiers into the words a provider writes for them", () => {
    expect(normaliseWords("VoiceRecordingService")).toEqual(["voice", "recording", "service"]);
    expect(normaliseWords("OpenAITranscriptionProvider")).toEqual(
      normaliseWords("open A I transcription provider")
    );
    expect(normaliseWords("WebGL")).toEqual(normaliseWords("web G L"));
  });

  it("maps small number words to digits but keeps a run of numbers apart", () => {
    expect(normaliseWords("Nova three")).toEqual(["nova", "3"]);
    expect(normaliseWords("one two")).toEqual(["1", "2"]);
  });

  it("merges a spelled-out run only when it holds a letter", () => {
    expect(normaliseWords("T S two three four five")).toEqual(normaliseWords("TS2345"));
    expect(normaliseWords("A P I dot T S")).toEqual(normaliseWords("api.ts"));
    expect(normaliseWords("wrap it in a hook")).toEqual(["wrap", "it", "in", "a", "hook"]);
  });

  it("drops apostrophes inside words rather than splitting them", () => {
    expect(normaliseWords("Don’t touch the user's config")).toEqual([
      "dont",
      "touch",
      "the",
      "users",
      "config",
    ]);
  });
});

describe("alignWords and scoreClip", () => {
  it("counts substitutions, deletions and insertions", () => {
    const a = alignWords(["a1", "b1", "c1", "d1"], ["a1", "x1", "c1", "d1", "e1"]);
    expect([a.substitutions, a.deletions, a.insertions]).toEqual([1, 0, 1]);
    const b = alignWords(["a1", "b1", "c1"], ["a1", "c1"]);
    expect([b.substitutions, b.deletions, b.insertions]).toEqual([0, 1, 0]);
  });

  it("lets WER exceed one when the hypothesis is mostly noise", () => {
    const score = scoreClip("commit", "please now commit it all", []);
    expect(score.wer).toBe(4);
    expect(score.firstWordKept).toBe(true);
  });

  it("scores an empty hypothesis as every word lost", () => {
    const score = scoreClip("commit and push", "", ["push"]);
    expect(score.wer).toBe(1);
    expect(score.firstWordKept).toBe(false);
    expect(score.lastWordKept).toBe(false);
    expect(score.missedTerms).toEqual(["push"]);
  });

  it("judges the first and last words by alignment, not by a match elsewhere", () => {
    // "push" appears in the hypothesis, but the final one the speaker said was cut.
    const cut = scoreClip("push the branch then push", "push the branch then", []);
    expect(cut.firstWordKept).toBe(true);
    expect(cut.lastWordKept).toBe(false);

    const lostStart = scoreClip("rebase onto develop", "onto develop", []);
    expect(lostStart.firstWordKept).toBe(false);
    expect(lostStart.lastWordKept).toBe(true);
  });
});

describe("termRecalled", () => {
  const hyp = (text: string) => normaliseWords(text);

  it("forgives spacing but not spelling", () => {
    expect(termRecalled("useEffect", hyp("wrap the use effect"))).toBe(true);
    expect(termRecalled("Next.js", hyp("a nextjs app"))).toBe(true);
    expect(termRecalled("useEffect", hyp("wrap the use affect"))).toBe(false);
  });

  it("needs whole words: a term inside a longer word doesn't count", () => {
    expect(termRecalled("pty", hyp("the empty file"))).toBe(false);
    expect(termRecalled("node-pty", hyp("rebuild node pty"))).toBe(true);
  });
});

describe("summariseConfig", () => {
  it("pools WER over words and averages it over clips, and keeps null timings out", () => {
    const rows = [
      session(
        "long",
        "openai",
        "one two three four five six seven eight nine ten",
        "one two three four five six seven eight nine ten"
      ),
      session("short", "openai", "commit", "", { timing: timing({ firstFinalMs: null }) }),
      session("other", "deepgram", "commit", "commit"),
    ];
    const summary = summariseConfig("openai", rows);
    expect(summary.sessions).toBe(2);
    expect(summary.pooledWer).toBeCloseTo(1 / 11);
    expect(summary.meanWer).toBeCloseTo(0.5);
    expect(summary.timing.firstFinalMs).toEqual({ median: 1500, p95: 1500, count: 1 });
  });

  it("counts a session that errored or never ended as errored", () => {
    const rows = [
      session("a", "c", "x1", "x1"),
      session("b", "c", "x1", "x1", { errors: ["socket closed"] }),
      session("d", "c", "x1", "x1", { endReason: null }),
    ];
    expect(summariseConfig("c", rows).erroredSessions).toBe(2);
  });
});

function makeRun(overrides: Partial<VoiceReplayRun>): VoiceReplayRun {
  return {
    schemaVersion: VOICE_REPLAY_SCHEMA_VERSION,
    scoringVersion: VOICE_REPLAY_SCORING_VERSION,
    label: "run",
    createdAt: "2026-10-26T00:00:00.000Z",
    complete: true,
    gitSha: null,
    platform: "darwin-arm64",
    repeats: 1,
    stopTailMs: 0,
    configs: [{ id: "openai", provider: "openai", settings: {}, dictionary: [] }],
    skippedConfigs: [],
    clips: [
      {
        id: "a",
        source: "synthesised",
        audioMs: 1,
        longestUtteranceMs: 1,
        audioHash: "w1",
        referenceHash: "r1",
      },
      {
        id: "b",
        source: "synthesised",
        audioMs: 1,
        longestUtteranceMs: 1,
        audioHash: "w2",
        referenceHash: "r2",
      },
    ],
    sessions: [],
    failures: [],
    summaries: [],
    ...overrides,
  };
}

describe("compareRuns", () => {
  it("compares each config only over the sessions both sides ran", () => {
    const baseline = makeRun({
      sessions: [session("a", "openai", "x1 y1", "x1 y1"), session("b", "openai", "x1 y1", "")],
    });
    // The run lost clip b to a harness failure: comparing it whole would read as a WER drop.
    const run = makeRun({ sessions: [session("a", "openai", "x1 y1", "x1 y1")] });
    const [config] = compareRuns(baseline, run).configs;
    expect(config!.sharedSessions).toBe(1);
    expect(config!.unmatchedSessions).toBe(1);
    expect(config!.metrics.find((m) => m.metric === "pooled WER")!.delta).toBe(0);
  });

  it("leaves out a clip whose reference or audio changed", () => {
    const baseline = makeRun({
      sessions: [session("a", "openai", "x1", "x1"), session("b", "openai", "x1", "x1")],
    });
    const run = makeRun({
      clips: [
        {
          id: "a",
          source: "synthesised",
          audioMs: 1,
          longestUtteranceMs: 1,
          audioHash: "w1",
          referenceHash: "r1",
        },
        {
          id: "b",
          source: "recorded",
          audioMs: 1,
          longestUtteranceMs: 1,
          audioHash: "w9",
          referenceHash: "r2",
        },
      ],
      sessions: [session("a", "openai", "x1", "x1"), session("b", "openai", "x1", "")],
    });
    const comparison = compareRuns(baseline, run);
    expect(comparison.changedClips).toEqual(["b"]);
    expect(comparison.configs[0]!.sharedSessions).toBe(1);
  });

  it("reports configs on one side only and flags a config whose settings moved", () => {
    const baseline = makeRun({
      configs: [
        { id: "openai", provider: "openai", settings: {}, dictionary: [] },
        { id: "deepgram", provider: "deepgram", settings: {}, dictionary: [] },
      ],
    });
    const run = makeRun({
      configs: [
        { id: "openai", provider: "openai", settings: {}, dictionary: ["Zustand"] },
        { id: "custom", provider: "openai", settings: { language: "en" }, dictionary: [] },
      ],
    });
    const comparison = compareRuns(baseline, run);
    expect(comparison.onlyInBaseline).toEqual(["deepgram"]);
    expect(comparison.onlyInRun).toEqual(["custom"]);
    expect(comparison.configs[0]!.settingsDiffer).toBe(true);
  });

  it("refuses to compare scores from different normalisation rules", () => {
    expect(() =>
      compareRuns(makeRun({}), makeRun({ scoringVersion: VOICE_REPLAY_SCORING_VERSION + 1 }))
    ).toThrow(/scoring version/);
  });

  it("renders every exclusion beside the table", () => {
    const baseline = makeRun({ sessions: [session("a", "openai", "x1", "x1")] });
    const run = makeRun({
      sessions: [session("a", "openai", "x1", "z1")],
      failures: [{ clip: "b", config: "openai", repeat: 0, message: "launch timed out" }],
    });
    const text = renderComparison(baseline, run, compareRuns(baseline, run));
    expect(text).toMatch(/\| pooled WER \| 0\.0% \| 100\.0% \| \+100\.0 pt \| worse \|/);
    expect(text).toContain("Harness failures in this run: 1");
  });
});
