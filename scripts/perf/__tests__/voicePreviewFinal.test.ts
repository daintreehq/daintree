import { describe, expect, it } from "vitest";
import {
  collectSegments,
  disagreementSpans,
  literalWords,
  renderHeadline,
  renderReport,
  scorePolicy,
  scoreRun,
  scoreSession,
  type ObservedEvent,
  type Segment,
  type SessionObservation,
} from "../lib/voicePreviewFinalScore";

function observation(
  events: ObservedEvent[],
  overrides: Partial<SessionObservation> = {}
): SessionObservation {
  return {
    clip: "clip",
    pass: 1,
    startResult: { ok: true },
    events,
    vad: { forks: 1, ready: 1, speechStarts: 1, speechEnds: 0, errors: 0, unexpectedExits: 0 },
    reconnects: 0,
    droppedConnect: 0,
    droppedReplay: 0,
    audioMs: 3000,
    readyMs: 1200,
    maxChunkLateMs: 5,
    drainMs: 700,
    ...overrides,
  };
}

const delta = (itemId: string | null, text: string): ObservedEvent => ({
  at: 0,
  type: "delta",
  itemId,
  text,
});

const complete = (
  itemId: string | null,
  text: string,
  flags: Partial<{ endOfSpeech: boolean; endsAtPause: boolean; incomplete: boolean }> = {}
): ObservedEvent => ({
  at: 0,
  type: "complete",
  itemId,
  text,
  endOfSpeech: false,
  endsAtPause: false,
  incomplete: false,
  ...flags,
});

const segment = (preview: string, final: string, itemId = "item"): Segment => ({
  itemId,
  preview,
  deltas: 1,
  final,
  endsAtPause: false,
  endOfSpeech: false,
});

describe("collectSegments", () => {
  it("joins each item's deltas into its preview, in completion order", () => {
    const { segments, anomalies } = collectSegments(
      observation([
        // b's preview starts first, but a completes first.
        delta("b", " Then"),
        delta("a", " Commit"),
        delta("a", " and push."),
        complete("a", "Commit and push.", { endsAtPause: true }),
        delta("b", " stop."),
        complete("b", "Then stop.", { endOfSpeech: true }),
      ])
    );
    expect(anomalies).toEqual([]);
    expect(segments.map((s) => [s.itemId, s.preview, s.final, s.deltas])).toEqual([
      ["a", " Commit and push.", "Commit and push.", 2],
      ["b", " Then stop.", "Then stop.", 2],
    ]);
    expect(segments[0]!.endsAtPause).toBe(true);
    expect(segments[1]!.endOfSpeech).toBe(true);
  });

  it("keeps a segment whose preview never showed, with an empty preview", () => {
    const { segments, anomalies } = collectSegments(observation([complete("a", "Commit.")]));
    expect(anomalies).toEqual([]);
    expect(segments[0]).toMatchObject({ preview: "", deltas: 0, final: "Commit." });
  });

  it("names every reason a session can't be scored whole", () => {
    const { anomalies, segments } = collectSegments(
      observation(
        [
          delta(null, " lost"),
          delta("a", " half"),
          complete("b", "settled", { incomplete: true }),
          complete(null, "orphan"),
          complete("b", "again"),
          delta("b", " late"),
          { at: 0, type: "error", code: "transcription_item_failed" },
        ],
        {
          startResult: { ok: false, error: "nope" },
          reconnects: 1,
          droppedReplay: 2,
          vad: {
            forks: 1,
            ready: 0,
            speechStarts: 0,
            speechEnds: 0,
            errors: 1,
            unexpectedExits: 0,
          },
        }
      )
    );
    expect(anomalies.sort()).toEqual(
      [
        "start failed",
        "reconnected",
        "audio dropped",
        "VAD never ready",
        "VAD failed",
        "delta without an item",
        "segment settled without a final",
        "completion without an item",
        "item completed twice",
        "delta after its completion",
        "error transcription_item_failed",
        "preview never finalised",
      ].sort()
    );
    // A second completion of an item never becomes a second segment.
    expect(segments.map((s) => [s.itemId, s.final])).toEqual([["b", "settled"]]);
  });

  it("excludes on each provider and VAD condition alone", () => {
    const words = [delta("a", " Commit."), complete("a", "Commit.")];
    const vad = (overrides: Partial<SessionObservation["vad"]>) => ({
      forks: 1,
      ready: 1,
      speechStarts: 1,
      speechEnds: 0,
      errors: 0,
      unexpectedExits: 0,
      ...overrides,
    });
    const reasons = (overrides: Partial<SessionObservation>) =>
      collectSegments(observation(words, overrides)).anomalies;
    expect(reasons({})).toEqual([]);
    expect(reasons({ droppedConnect: 1 })).toEqual(["audio dropped"]);
    expect(reasons({ droppedReplay: 1 })).toEqual(["audio dropped"]);
    expect(reasons({ vad: vad({ forks: 0 }) })).toEqual(["VAD never ready"]);
    expect(reasons({ vad: vad({ ready: 0 }) })).toEqual(["VAD never ready"]);
    expect(reasons({ vad: vad({ errors: 1 }) })).toEqual(["VAD failed"]);
    expect(reasons({ vad: vad({ unexpectedExits: 1 }) })).toEqual(["VAD failed"]);
    expect(reasons({ vad: vad({ leftRunning: 0 }) })).toEqual([]);
    expect(reasons({ vad: vad({ leftRunning: 1 }) })).toEqual(["VAD outlived the session"]);
  });

  it("flags a session that produced no segment", () => {
    expect(collectSegments(observation([])).anomalies).toEqual(["no segment"]);
  });
});

describe("disagreementSpans", () => {
  const spans = (preview: string, final: string) =>
    disagreementSpans(preview.split(" ").filter(Boolean), final.split(" ").filter(Boolean)).map(
      (span) => [span.kind, span.previewWords.join(" "), span.finalWords.join(" "), span.finalStart]
    );

  it("finds nothing when the words agree", () => {
    expect(spans("commit and push", "commit and push")).toEqual([]);
    expect(spans("", "")).toEqual([]);
  });

  it("classifies each run between matched words", () => {
    expect(spans("fix the cash now", "fix the cache now")).toEqual([
      ["changed", "cash", "cache", 2],
    ]);
    expect(spans("open the web socket file", "open the websocket file")).toEqual([
      ["spacing", "web socket", "websocket", 2],
    ]);
    expect(spans("fix it now", "fix all of it now")).toEqual([["inserted", "", "all of", 1]]);
    expect(spans("fix it", "fix it now please")).toEqual([["suffix", "", "now please", 2]]);
    expect(spans("fix it right now", "fix it now")).toEqual([["drop", "right", "", 2]]);
    expect(spans("", "fix it")).toEqual([["no-preview", "", "fix it", 0]]);
  });

  it("reads a changed last word as a change, not a suffix", () => {
    expect(spans("add a time", "add a timeout here")).toEqual([
      ["changed", "time", "timeout here", 2],
    ]);
  });

  it("keeps several spans in one segment apart", () => {
    expect(spans("the cash is in sink", "the cache is in sync")).toEqual([
      ["changed", "cash", "cache", 1],
      ["changed", "sink", "sync", 4],
    ]);
  });
});

describe("literalWords", () => {
  it("sets aside only casing and punctuation", () => {
    expect(literalWords("Run `npm test --watch` on useShallow, it's TS2345.")).toEqual([
      "run",
      "npm",
      "test",
      "watch",
      "on",
      "useshallow",
      "its",
      "ts2345",
    ]);
  });
});

describe("scoreSession", () => {
  it("carries each final word's right or wrong back to its segment and span", () => {
    const score = scoreSession(
      { clip: "clip", pass: 1 },
      [
        // The final corrects the preview: flagged, and right.
        segment(" Invalidate the cash.", "Invalidate the cache.", "a"),
        // The final changes a right word to a wrong one: flagged, and wrong.
        segment(" When the branch changes.", "When the bench changes.", "b"),
        // Both read it wrong the same way: wrong, and no flag can see it.
        segment(" Then rebase onto devel.", "Then rebase onto devel.", "c"),
      ],
      "Invalidate the cache. When the branch changes. Then rebase onto develop."
    );
    expect(score.segments).toBe(3);
    expect(score.segmentsVerbatim).toBe(1);
    expect(score.segmentsDisagreeing).toBe(2);
    const wordStates = score.words.map((w) => `${w.word}:${w.wrong ? "x" : "ok"}:${w.kind ?? "-"}`);
    expect(wordStates).toEqual([
      "invalidate:ok:-",
      "the:ok:-",
      "cache:ok:changed",
      "when:ok:-",
      "the:ok:-",
      "bench:x:changed",
      "changes:ok:-",
      "then:ok:-",
      "rebase:ok:-",
      "onto:ok:-",
      "devel:x:-",
    ]);
    expect(score.spans.map((span) => [span.segment, span.wrongWords])).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });

  it("counts reference words the final left out, which no flag can carry", () => {
    const score = scoreSession(
      { clip: "clip", pass: 1 },
      [segment(" Commit push.", "Commit push.")],
      "Commit and push."
    );
    expect(score.referenceDeletions).toBe(1);
    expect(score.words.every((w) => !w.wrong)).toBe(true);
  });

  it("lets spacing and casing agree under the replay normaliser but not the literal one", () => {
    const score = scoreSession(
      { clip: "clip", pass: 1 },
      [segment(" wrap it in use shallow", "Wrap it in useShallow.")],
      "Wrap it in useShallow."
    );
    expect(score.segmentsVerbatim).toBe(0);
    expect(score.segmentsDisagreeing).toBe(0);
    expect(score.segmentsDisagreeingLiteral).toBe(1);
    expect(score.literalDisagreeingWords).toBe(1);
  });

  it("normalises each segment alone, so a spelled-out run never merges across a cut", () => {
    const score = scoreSession(
      { clip: "clip", pass: 1 },
      [segment(" run T", "run T", "a"), segment(" S check", "S check", "b")],
      "run ts check"
    );
    expect(score.words.map((w) => w.word)).toEqual(["run", "t", "s", "check"]);
  });
});

describe("scorePolicy", () => {
  const sessions = [
    scoreSession(
      { clip: "a", pass: 1 },
      [
        segment(" fix the cash", "fix the cache", "a"),
        segment(" open the web socket", "open the websocket", "b"),
        segment(" then", "then ship it", "c"),
        segment(" run it now", "run all of it now", "d"),
        segment(" stop now", "stop now", "e"),
      ],
      "fix the cache open the web socket then ship run it now stop here"
    ),
  ];

  it("counts flags, hits and misses per policy", () => {
    // Flagged: cache (changed, right), websocket (spacing, wrong: the reference
    // splits it), ship and it (suffix, right and wrong), all and of (inserted,
    // both wrong). The last "now" is wrong and no policy can see it.
    const any = scorePolicy("any", sessions);
    expect(any).toMatchObject({
      finalWords: 16,
      wrongWords: 5,
      flagged: 6,
      flaggedWrong: 4,
      flaggedRight: 2,
      missed: 1,
    });
    expect(any.precision).toBeCloseTo(4 / 6);
    expect(any.recall).toBeCloseTo(4 / 5);
    expect(any.lift).toBeCloseTo(4 / 6 / (5 / 16));

    expect(scorePolicy("substituted", sessions)).toMatchObject({
      flagged: 2,
      flaggedWrong: 1,
      missed: 4,
    });
    expect(scorePolicy("changed", sessions)).toMatchObject({
      flagged: 1,
      flaggedWrong: 0,
      precision: 0,
      recall: 0,
    });
    const interior = scorePolicy("interior", sessions);
    expect(interior).toMatchObject({ flagged: 3, flaggedWrong: 2, missed: 3 });
    expect(interior.recall).toBeCloseTo(2 / 5);
  });

  it("reports an undefined ratio as null, not zero", () => {
    const clean = [scoreSession({ clip: "a", pass: 1 }, [segment(" commit", "commit")], "commit")];
    const policy = scorePolicy("any", clean);
    expect(policy.precision).toBeNull();
    expect(policy.recall).toBeNull();
    expect(policy.lift).toBeNull();
    expect(scorePolicy("any", []).finalWords).toBe(0);
  });
});

describe("scoreRun and the report", () => {
  const clean = observation([delta("a", " Commit and posh."), complete("a", "Commit and push.")], {
    clip: "commit",
  });
  const broken = observation([delta("a", " half")], { clip: "commit", pass: 2 });
  const unknown = observation([complete("a", "Something.")], { clip: "gone" });
  const references = new Map([["commit", "Commit and push."]]);

  it("totals WER, deletions and span kinds across sessions", () => {
    const greek = observation(
      [
        delta("a", " alpha bravo charlie delta echo"),
        complete("a", "alpha wrong charlie echo extra"),
      ],
      { clip: "greek" }
    );
    const { summary } = scoreRun([greek], new Map([["greek", "alpha bravo charlie delta echo"]]));
    expect(summary.referenceDeletions).toBe(1);
    expect(summary.policies.find((p) => p.policy === "any")!.wrongWords).toBe(2);
    expect(summary.wer).toBeCloseTo(3 / 5);
    expect(
      summary.kinds
        .filter((k) => k.spans > 0)
        .map((k) => [k.kind, k.spans, k.previewWords, k.finalWords, k.wrongWords])
    ).toEqual([
      ["changed", 1, 1, 1, 1],
      ["suffix", 1, 0, 1, 1],
      ["drop", 1, 1, 0, 0],
    ]);
  });

  it("counts silent segments apart from the ones with words", () => {
    const { summary } = scoreRun(
      [
        observation([delta("a", " cash"), complete("a", "cache"), complete("b", "")], {
          clip: "cache",
        }),
      ],
      new Map([["cache", "cache"]])
    );
    expect(summary.segments).toBe(1);
    expect(summary.silentSegments).toBe(1);
    expect(summary.segmentsDisagreeing).toBe(1);
    expect(summary.segmentsVerbatim).toBe(0);
  });

  it("judges silence literally, so spoken symbols still count as words", () => {
    // The replay normaliser drops both words; the literal one keeps them apart.
    const score = scoreSession({ clip: "c", pass: 1 }, [segment(" dot", "slash")], "slash");
    expect(score.silentSegments).toBe(0);
    expect(score.segments).toBe(1);
    expect(score.segmentsDisagreeing).toBe(0);
    expect(score.segmentsDisagreeingLiteral).toBe(1);
    expect(score.literalDisagreeingWords).toBe(1);
  });

  it("scores clean sessions and lists the rest with their reasons", () => {
    const { summary, scored } = scoreRun([clean, broken, unknown], references);
    expect(scored).toHaveLength(1);
    expect(summary.sessions).toBe(3);
    expect(summary.scored).toBe(1);
    expect(summary.excluded).toEqual([
      { clip: "commit", pass: 2, reasons: ["preview never finalised", "no segment"] },
      { clip: "gone", pass: 1, reasons: ["clip has no reference"] },
    ]);
    expect(summary.segmentsDisagreeing).toBe(1);
    expect(summary.disagreeingWords).toBe(1);
    expect(summary.wer).toBe(0);
  });

  it("keeps transcript text out of the terminal headline", () => {
    const secret = observation([delta("a", " Zebra quokka."), complete("a", "Zebra quokka.")], {
      clip: "commit",
    });
    const { summary, scored } = scoreRun([secret], references);
    const headline = renderHeadline(summary).join("\n").toLowerCase();
    expect(headline).toContain("scored 1 of 1 sessions");
    expect(headline).toContain("character for character once trimmed: 1/1");
    expect(headline).not.toContain("zebra");
    expect(headline).not.toContain("quokka");
    const report = renderReport(
      {
        label: "t",
        startedAt: "2026-10-27T00:00:00.000Z",
        revision: "abc",
        dirty: false,
        passes: 1,
        terms: false,
        complete: true,
        audioMs: 60_000,
      },
      [secret],
      summary,
      scored
    );
    expect(report).toContain("~$0.017");
  });

  it("quotes each span in the report, which stays in .tmp/", () => {
    const { summary, scored } = scoreRun([clean], references);
    const report = renderReport(
      {
        label: "t",
        startedAt: "2026-10-27T00:00:00.000Z",
        revision: "abc",
        dirty: false,
        passes: 1,
        terms: false,
        complete: true,
        audioMs: 1_000,
      },
      [clean],
      summary,
      scored
    );
    expect(report).toContain('changed · "posh" → "push" · 0/1 wrong');
  });
});
