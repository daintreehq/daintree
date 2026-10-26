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
  type VoiceReplayClipRecord,
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
  extra: Partial<SessionResult> & { terms?: string[] } = {}
): SessionResult {
  const { terms = [], ...rest } = extra;
  return {
    clip,
    config,
    repeat: 0,
    hypothesis,
    draft: null,
    score: scoreClip(reference, hypothesis, terms),
    timing: timing(),
    statuses: ["connecting", "recording", "finishing"],
    endReason: "stopped",
    errors: [],
    ...rest,
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

  it("keeps an acronym with digits whole, however it was written", () => {
    expect(normaliseWords("E2E")).toEqual(["e2e"]);
    expect(normaliseWords("e2e")).toEqual(["e2e"]);
    expect(normaliseWords("E 2 E")).toEqual(["e2e"]);
    expect(normaliseWords("T S two three four five")).toEqual(normaliseWords("TS2345"));
  });

  it("maps small number words to digits but keeps a run of numbers apart", () => {
    expect(normaliseWords("Nova three")).toEqual(["nova", "3"]);
    expect(normaliseWords("one two")).toEqual(["1", "2"]);
  });

  it("ends a spelled-out run at a symbol, written or spoken", () => {
    expect(normaliseWords("A P I dot T S")).toEqual(["api", "ts"]);
    expect(normaliseWords("api.ts")).toEqual(["api", "ts"]);
    expect(normaliseWords("a/b")).toEqual(normaliseWords("a slash b"));
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
  it("records the op for every reference word", () => {
    const a = alignWords(["a1", "b1", "c1", "d1"], ["a1", "x1", "c1", "d1", "e1"]);
    expect([a.substitutions, a.deletions, a.insertions]).toEqual([1, 0, 1]);
    expect(a.referenceOps).toEqual(["match", "sub", "match", "match"]);
    const b = alignWords(["a1", "b1", "c1"], ["a1", "c1"]);
    expect(b.referenceOps).toEqual(["match", "del", "match"]);
  });

  it("prefers the equally cheap path that keeps more words matched", () => {
    const tie = alignWords(["commit", "and", "push"], ["commit", "push", "now"]);
    expect([tie.substitutions, tie.deletions, tie.insertions]).toEqual([0, 1, 1]);
    expect(tie.referenceOps).toEqual(["match", "del", "match"]);
    expect(scoreClip("Commit and push", "Commit push now", []).lastWordKept).toBe(true);
  });

  it("marks a substituted first or last word as lost", () => {
    const score = scoreClip("rebase onto develop", "debase onto devel", []);
    expect(score.firstWordKept).toBe(false);
    expect(score.lastWordKept).toBe(false);
    expect(score.substitutions).toBe(2);
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
  it("pools WER over words and averages it over clips", () => {
    const rows = [
      session(
        "long",
        "openai",
        "one two three four five six seven eight nine ten",
        "one two three four five six seven eight nine ten"
      ),
      session("short", "openai", "commit", ""),
      session("other", "deepgram", "commit", "commit"),
    ];
    const summary = summariseConfig("openai", rows);
    expect(summary.sessions).toBe(2);
    expect(summary.pooledWer).toBeCloseTo(1 / 11);
    expect(summary.meanWer).toBeCloseTo(0.5);
    expect(summary.firstWordKeptRate).toBe(0.5);
    expect(summary.lastWordKeptRate).toBe(0.5);
  });

  it("pools term recall over every term opportunity", () => {
    const rows = [
      session("a", "c", "use Zustand and Vitest", "use Zustand and vitest", {
        terms: ["Zustand", "Vitest"],
      }),
      session("b", "c", "open WebGL", "open web jail", { terms: ["WebGL"] }),
    ];
    expect(summariseConfig("c", rows).termRecall).toBeCloseTo(2 / 3);
  });

  it("takes median and nearest-rank p95 over the sessions that reached each point", () => {
    // 100, 200 … 2000 in a scrambled order, plus one session that never got a final.
    const values = Array.from({ length: 20 }, (_, i) => ((i * 7) % 20) * 100 + 100);
    const rows = values.map((v, i) =>
      session(`clip${i}`, "c", "x1", "x1", { timing: timing({ firstFinalMs: v }) })
    );
    rows.push(session("silent", "c", "x1", "", { timing: timing({ firstFinalMs: null }) }));
    expect(summariseConfig("c", rows).timing.firstFinalMs).toEqual({
      median: 1050,
      p95: 1900,
      count: 20,
    });
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

const clip = (
  id: string,
  overrides: Partial<VoiceReplayClipRecord> = {}
): VoiceReplayClipRecord => ({
  id,
  source: "synthesised",
  audioMs: 1,
  longestUtteranceMs: 1,
  audioHash: `w-${id}`,
  referenceHash: `r-${id}`,
  ...overrides,
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
    configs: [
      { id: "openai", provider: "openai", settings: {}, dictionary: [] },
      { id: "deepgram", provider: "deepgram", settings: {}, dictionary: [] },
    ],
    skippedConfigs: [],
    clips: [clip("a"), clip("b")],
    sessions: [],
    failures: [],
    summaries: [],
    ...overrides,
  };
}

const metric = (comparison: ReturnType<typeof compareRuns>, config: string, name: string) =>
  comparison.configs.find((c) => c.config === config)!.metrics.find((m) => m.metric === name)!;

describe("compareRuns", () => {
  it("compares each config only over the sessions, by clip and repeat, both sides ran", () => {
    const baseline = makeRun({
      sessions: [
        session("a", "openai", "x1 y1", "x1 y1"),
        session("a", "openai", "x1 y1", "x1", { repeat: 1 }),
        session("b", "openai", "x1 y1", ""),
        session("a", "deepgram", "x1 y1", ""),
      ],
    });
    // The run lost openai's clip b to a harness failure, and has a repeat the
    // baseline never ran: compared whole, either would move the numbers.
    const run = makeRun({
      sessions: [
        session("a", "openai", "x1 y1", "x1 y1"),
        session("a", "openai", "x1 y1", "x1", { repeat: 1 }),
        session("a", "openai", "x1 y1", "", { repeat: 2 }),
        session("a", "deepgram", "x1 y1", "x1 y1"),
      ],
    });
    const comparison = compareRuns(baseline, run);
    const openai = comparison.configs.find((c) => c.config === "openai")!;
    expect(openai.sharedSessions).toBe(2);
    expect(openai.unmatchedSessions).toBe(2);
    expect(metric(comparison, "openai", "pooled WER")).toMatchObject({
      baseline: 0.25,
      run: 0.25,
      delta: 0,
    });
    expect(metric(comparison, "deepgram", "pooled WER")).toMatchObject({
      baseline: 1,
      run: 0,
      delta: -1,
    });
  });

  it("leaves out a clip whose reference, terms or audio changed", () => {
    const sessions = [
      session("a", "openai", "x1", "x1"),
      session("b", "openai", "x1", "x1"),
      session("c", "openai", "x1", "x1"),
    ];
    const baseline = makeRun({ clips: [clip("a"), clip("b"), clip("c")], sessions });
    const run = makeRun({
      clips: [clip("a"), clip("b", { referenceHash: "r-b2" }), clip("c", { audioHash: "w-c2" })],
      sessions: [
        session("a", "openai", "x1", "x1"),
        session("b", "openai", "x1", ""),
        session("c", "openai", "x1", ""),
      ],
    });
    const comparison = compareRuns(baseline, run);
    expect(comparison.changedClips).toEqual(["b", "c"]);
    expect(metric(comparison, "openai", "pooled WER").run).toBe(0);
  });

  it("flags a config whose provider, settings or dictionary moved, and only then", () => {
    const base = { id: "x", provider: "openai", settings: { language: "en" }, dictionary: ["A1"] };
    const differs = (change: Partial<typeof base>) =>
      compareRuns(makeRun({ configs: [base] }), makeRun({ configs: [{ ...base, ...change }] }))
        .configs[0]!.settingsDiffer;
    expect(differs({})).toBe(false);
    expect(differs({ provider: "deepgram" })).toBe(true);
    expect(differs({ settings: { language: "de" } })).toBe(true);
    expect(differs({ dictionary: ["A1", "B1"] })).toBe(true);
  });

  it("reports configs on one side only", () => {
    const comparison = compareRuns(
      makeRun({}),
      makeRun({ configs: [{ id: "openai", provider: "openai", settings: {}, dictionary: [] }] })
    );
    expect(comparison.onlyInBaseline).toEqual(["deepgram"]);
    expect(comparison.onlyInRun).toEqual([]);
  });

  it("notes a stop-tail change, which moves every config", () => {
    expect(compareRuns(makeRun({}), makeRun({})).harnessNotes).toEqual([]);
    expect(compareRuns(makeRun({}), makeRun({ stopTailMs: 500 })).harnessNotes[0]).toMatch(
      /0 ms to 500 ms/
    );
  });

  it("refuses to compare scores from different normalisation rules", () => {
    expect(() =>
      compareRuns(makeRun({}), makeRun({ scoringVersion: VOICE_REPLAY_SCORING_VERSION + 1 }))
    ).toThrow(/scoring version/);
  });
});

describe("renderComparison", () => {
  it("reads deltas the right way round for each metric and shows every exclusion", () => {
    const baseline = makeRun({
      sessions: [
        session("a", "openai", "x1 y1", "x1", {
          terms: ["y1"],
          timing: timing({ firstFinalMs: 1000, stopToEndedMs: null }),
        }),
      ],
    });
    const run = makeRun({
      stopTailMs: 200,
      clips: [clip("a"), clip("b", { referenceHash: "r-b2" })],
      configs: [{ id: "openai", provider: "openai", settings: {}, dictionary: ["y1"] }],
      sessions: [
        session("a", "openai", "x1 y1", "x1 y1", {
          terms: ["y1"],
          timing: timing({ firstFinalMs: 1200, stopToEndedMs: null }),
        }),
      ],
      failures: [{ clip: "b", config: "openai", repeat: 0, message: "launch timed out" }],
    });
    const text = renderComparison(baseline, run, compareRuns(baseline, run));
    expect(text).toContain("| pooled WER | 50.0% | 0.0% | -50.0 pt | better |");
    expect(text).toContain("| term recall | 0.0% | 100.0% | +100.0 pt | better |");
    expect(text).toContain("| firstFinalMs median | 1000 ms | 1200 ms | +200 ms | worse |");
    expect(text).toContain("| stopToEndedMs median | — | — | — |  |");
    expect(text).toContain("| errored sessions | 0 | 0 | 0 |  |");
    expect(text).toContain("Settings or dictionary differ");
    expect(text).toContain("Changed clips, left out: b");
    expect(text).toContain("Only in the baseline: deepgram");
    expect(text).toContain("The stop tail moved from 0 ms to 200 ms");
    expect(text).toContain("Harness failures in this run: 1");
  });
});
