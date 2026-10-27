import { describe, expect, it } from "vitest";
import { REPLAY_CLIPS } from "../../../e2e/helpers/voiceReplayFixtures";
import { CLEANUP_CORPUS, REPLAY_TRANSCRIPTS, type CleanupCase } from "../lib/voiceCleanupCorpus";
import {
  corpusProblems,
  locateUncertain,
  percentile,
  requestCost,
  scoreText,
  seededShuffle,
  summariseVariant,
  type Trial,
} from "../lib/voiceCleanupScore";

function makeCase(overrides: Partial<CleanupCase>): CleanupCase {
  return {
    id: "case",
    style: "openai",
    source: "context",
    raw: "um invalidate the cash when the branch changes",
    reference: "Invalidate the cache when the branch changes.",
    fixes: ["the cache"],
    drops: ["um"],
    ...overrides,
  };
}

describe("cleanup corpus", () => {
  it("has no case whose checks could never pass or never fail", () => {
    expect(corpusProblems(CLEANUP_CORPUS)).toEqual([]);
  });

  it("has a transcript in every provider style for every replay clip", () => {
    expect(Object.keys(REPLAY_TRANSCRIPTS).sort()).toEqual(REPLAY_CLIPS.map((c) => c.id).sort());
    const replayIds = CLEANUP_CORPUS.filter((entry) => entry.source === "replay").map((e) => e.id);
    for (const clip of REPLAY_CLIPS) {
      expect(replayIds).toContain(`${clip.id}:openai`);
      expect(replayIds).toContain(`${clip.id}:deepgram`);
    }
  });

  it("scores every reference as a perfect cleanup of its own case", () => {
    const imperfect = CLEANUP_CORPUS.filter((entry) => {
      const score = scoreText(entry, entry.reference);
      return (
        !score.matchesReference ||
        score.broken > 0 ||
        score.novelWords > 0 ||
        score.missedFixes.length > 0 ||
        score.missedDrops.length > 0 ||
        score.lostKeeps.length > 0
      );
    });
    expect(imperfect.map((entry) => entry.id)).toEqual([]);
  });
});

describe("corpusProblems", () => {
  it("flags fixes the raw transcript already has, drops with nothing to drop and keeps that go missing", () => {
    const problems = corpusProblems([
      makeCase({ id: "a", raw: "invalidate the cache", fixes: ["the cache"], drops: [] }),
      makeCase({ id: "b", raw: "invalidate the cash", drops: ["um"] }),
      makeCase({ id: "c", keep: ["branch changes now"] }),
      makeCase({ id: "d", uncertain: ["cash"] }),
      makeCase({ id: "d", style: "deepgram", uncertain: ["cache"] }),
    ]);
    expect(problems).toEqual([
      'a: fix "the cache" is already in the raw transcript',
      'b: drop "um" leaves nothing to take out',
      'c: keep "branch changes now" is not in the raw',
      "d: only Deepgram flags unsure words",
      "d: duplicate id",
      'd: unsure phrase "cache" is not in the raw transcript',
    ]);
  });
});

describe("scoreText", () => {
  it("credits the repaired word, the landed fix and the dropped filler", () => {
    const entry = makeCase({});
    const score = scoreText(entry, entry.reference);
    expect(score).toMatchObject({
      repaired: 1,
      repairable: 1,
      broken: 0,
      novelWords: 0,
      fixesLanded: 1,
      dropsLanded: 1,
      matchesReference: true,
      untouched: false,
    });
  });

  it("finds nothing landed in a passage handed back as it was", () => {
    const entry = makeCase({});
    expect(scoreText(entry, entry.raw)).toMatchObject({
      repaired: 0,
      missedFixes: ["the cache"],
      missedDrops: ["um"],
      untouched: true,
      matchesReference: false,
    });
  });

  it("counts words a summary lost and words an answer added", () => {
    const entry = makeCase({});
    expect(scoreText(entry, "Invalidate the cache.")).toMatchObject({ repaired: 1, broken: 4 });
    expect(
      scoreText(entry, "Invalidate the cache when the branch changes, then rebuild it.")
    ).toMatchObject({ broken: 0, novelWords: 3 });
  });

  it("counts a word changed for another as broken, not repaired", () => {
    const entry = makeCase({});
    const score = scoreText(entry, "Invalidate the cache when the bench changes.");
    expect(score).toMatchObject({ repaired: 1, broken: 1, novelWords: 1 });
  });

  it("matches filler as a whole word only", () => {
    const entry = makeCase({
      raw: "um bring the umbrella",
      reference: "Bring the umbrella.",
      fixes: [],
    });
    expect(scoreText(entry, "Bring the umbrella.").missedDrops).toEqual([]);
    expect(scoreText(entry, "Um, bring the umbrella.").missedDrops).toEqual(["um"]);
  });

  it("needs every copy of a kept span, letter for letter but for the first one's case", () => {
    const entry = makeCase({
      raw: "don't stop and don't wait for src/App.tsx",
      reference: "Don't stop and don't wait for src/App.tsx.",
      fixes: [],
      drops: [],
      keep: ["don't", "src/App.tsx"],
    });
    expect(scoreText(entry, "Don't stop, and don't wait for src/App.tsx.").lostKeeps).toEqual([]);
    expect(scoreText(entry, "Don't stop and wait for src/App.tsx.").lostKeeps).toEqual(["don't"]);
    expect(scoreText(entry, "Don't stop and don't wait for src/app.tsx.").lostKeeps).toEqual([
      "src/App.tsx",
    ]);
  });

  it("checks a fix character for character", () => {
    const entry = makeCase({
      raw: "run it with dash dash watch",
      reference: "Run it with --watch.",
      fixes: ["--watch"],
      drops: [],
    });
    expect(scoreText(entry, "Run it with -- watch.").missedFixes).toEqual(["--watch"]);
    expect(scoreText(entry, "Run it with --watch.").missedFixes).toEqual([]);
  });

  it("matches a reference by words and lines, and takes any accepted alternative", () => {
    const entry = makeCase({
      raw: "first read the test second find the race",
      reference: "1. Read the test.\n2. Find the race.",
      alsoAccept: ["First, read the test. Second, find the race."],
      fixes: [],
      drops: [],
    });
    expect(scoreText(entry, "1. read the test\n\n2. find the race").matchesReference).toBe(true);
    expect(scoreText(entry, "1. Read the test. 2. Find the race.").matchesReference).toBe(false);
    expect(scoreText(entry, "First, read the test. Second, find the race.").matchesReference).toBe(
      true
    );
  });
});

describe("locateUncertain", () => {
  it("places repeated words in order, once each", () => {
    expect(locateUncertain("the pain and the pain", ["pain", "pain"])).toEqual([
      { from: 4, to: 8 },
      { from: 17, to: 21 },
    ]);
  });

  it("refuses a phrase the transcript doesn't have", () => {
    expect(() => locateUncertain("the pane", ["pain"])).toThrow(/not in the raw transcript/);
  });
});

describe("requestCost", () => {
  it("bills cached input at the cached rate and the rest at the full rate", () => {
    const usage = { inputTokens: 3_000, cachedTokens: 2_944, outputTokens: 43 };
    // 56 uncached at $1, 2,944 cached at $0.05, 43 output at $5, per million.
    expect(requestCost("gpt-6.1-terra", usage)).toBeCloseTo((56 + 147.2 + 215) / 1e6, 12);
    expect(requestCost("gpt-6-luna", usage)).toBeLessThan(requestCost("gpt-6.1-terra", usage)!);
  });

  it("is unknown without a price or a usage", () => {
    const usage = { inputTokens: 10, cachedTokens: 0, outputTokens: 1 };
    expect(requestCost("gpt-unknown", usage)).toBeNull();
    expect(requestCost("gpt-6-luna", undefined)).toBeNull();
  });
});

describe("percentile", () => {
  it("takes the nearest rank", () => {
    const values = Array.from({ length: 20 }, (_, i) => 20 - i);
    expect(percentile(values, 50)).toBe(10);
    expect(percentile(values, 95)).toBe(19);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });
});

describe("seededShuffle", () => {
  it("replays the same order for a seed and a different one for another", () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const first = seededShuffle(items, 14793);
    expect(seededShuffle(items, 14793)).toEqual(first);
    expect(seededShuffle(items, 14794)).not.toEqual(first);
    expect([...first].sort((a, b) => a - b)).toEqual(items);
    expect(items).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });
});

describe("summariseVariant", () => {
  const short = makeCase({ id: "short", raw: "commit and push", reference: "commit and push" });
  const long = makeCase({
    id: "long",
    raw: `um ${"the cash is stale ".repeat(10).trim()}`,
    reference: "The cache is stale.",
    fixes: [],
  });
  const corpus = [{ ...short, fixes: [], drops: [] }, long];

  function trial(overrides: Partial<Trial> & Pick<Trial, "caseId" | "landed">): Trial {
    const entry = corpus.find((candidate) => candidate.id === overrides.caseId)!;
    return {
      variant: "a",
      repeat: 1,
      disposition: "applied",
      proposal: overrides.landed,
      landedScore: scoreText(entry, overrides.landed),
      proposalScore: scoreText(entry, overrides.proposal ?? overrides.landed),
      roundTripMs: 1_000,
      totalMs: 1_010,
      costUsd: 0.001,
      ...overrides,
    };
  }

  it("counts dispositions, clean passages kept and requests over the send yardstick", () => {
    const trials = [
      trial({ caseId: "short", landed: "commit and push", disposition: "declined" }),
      trial({
        caseId: "long",
        landed: long.raw,
        proposal: "The cache is stale.",
        disposition: "rejected",
        rejectReason: "edit_size",
        roundTripMs: 2_500,
      }),
      trial({ caseId: "long", landed: long.raw, disposition: "failed", roundTripMs: null }),
      trial({ caseId: "short", landed: "x", variant: "b" }),
    ];
    const summary = summariseVariant("a", trials, corpus);

    expect(summary.trials).toBe(3);
    expect(summary.dispositions).toEqual({
      applied: 0,
      declined: 1,
      rejected: 1,
      failed: 1,
      skipped: 0,
    });
    expect(summary.rejectReasons).toEqual({ edit_size: 1 });
    expect(summary.cleanUntouched).toEqual({ kept: 1, of: 1 });
    expect(summary.roundTrip).toMatchObject({ count: 2, max: 2_500, overTarget: 0.5 });
    expect(summary.promptLengthRoundTrip).toMatchObject({ count: 1, p50: 2_500 });
    expect(summary.total.count).toBe(3);
    // The rejected proposal would have repaired the stale passage; nothing landed did.
    expect(summary.proposed.repairRate).toBeGreaterThan(summary.landed.repairRate);
    expect(summary.landed.repairRate).toBe(0);
  });

  it("leaves the cost unknown when any request's is", () => {
    const trials = [
      trial({ caseId: "short", landed: "commit and push" }),
      trial({ caseId: "short", landed: "commit and push", costUsd: null }),
    ];
    expect(summariseVariant("a", trials, corpus)).toMatchObject({
      meanCostUsd: null,
      totalCostUsd: null,
    });
    expect(summariseVariant("a", trials.slice(0, 1), corpus).meanCostUsd).toBeCloseTo(0.001);
  });
});
