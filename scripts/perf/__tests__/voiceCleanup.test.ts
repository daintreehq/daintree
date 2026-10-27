import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { REPLAY_CLIPS } from "../../../e2e/helpers/voiceReplayFixtures";
import {
  CLEANUP_CORPUS,
  REPLAY_TRANSCRIPTS,
  type CleanupCase,
  type FixKind,
} from "../lib/voiceCleanupCorpus";
import {
  corpusProblems,
  locateUncertain,
  percentile,
  requestCost,
  scoreText,
  seededShuffle,
  summariseVariant,
  VOICE_CLEANUP_SCHEMA_VERSION,
  VOICE_CLEANUP_SCORING_VERSION,
  type Trial,
} from "../lib/voiceCleanupScore";
import { inputHash, renderReport, rescore } from "../voice-cleanup";

function makeCase(overrides: Partial<CleanupCase>): CleanupCase {
  return {
    id: "case",
    style: "openai",
    source: "context",
    raw: "um invalidate the cash when the branch changes",
    reference: "Invalidate the cache when the branch changes.",
    fixes: { "the cache": "misread" },
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

  it("scores every accepted reference as a perfect cleanup of its own case", () => {
    const imperfect = CLEANUP_CORPUS.flatMap((entry) =>
      [entry.reference, ...(entry.alsoAccept ?? [])].flatMap((reference) => {
        const score = scoreText(entry, reference);
        const fixesApply = reference === entry.reference;
        const perfect =
          score.matchesReference &&
          score.edits === 0 &&
          score.broken === 0 &&
          score.novelWords === 0 &&
          score.addedWords === 0 &&
          (!fixesApply || score.missedFixes.length === 0) &&
          score.missedDrops.length === 0 &&
          score.lostKeeps.length === 0;
        return perfect ? [] : [`${entry.id}: ${reference}`];
      })
    );
    expect(imperfect).toEqual([]);
  });
});

describe("corpusProblems", () => {
  it("flags fixes the raw transcript already has, drops with nothing to drop and keeps that go missing", () => {
    const problems = corpusProblems([
      makeCase({
        id: "a",
        raw: "invalidate the cache",
        fixes: { "the cache": "misread" },
        drops: [],
      }),
      makeCase({ id: "b", raw: "invalidate the cash", drops: ["um"] }),
      makeCase({ id: "c", keep: ["branch changes now"] }),
      makeCase({ id: "d", uncertain: ["cash"] }),
      makeCase({ id: "d", style: "deepgram", uncertain: ["cache"] }),
      makeCase({ id: "e", keep: ["the branch"], reference: "Invalidate the cache on change." }),
      makeCase({
        id: "f",
        fixes: { "the cache": "misread", rebuild: "form" },
        raw: "um rerun --watch",
        drops: [],
      }),
    ]);
    expect(problems).toEqual([
      'a: fix "the cache" is already in the raw transcript',
      'b: drop "um" leaves nothing to take out',
      'c: keep "branch changes now" is not in the raw',
      "d: only Deepgram flags unsure words",
      "d: duplicate id",
      'd: unsure phrase "cache" is not in the raw transcript',
      'e: keep "the branch" does not survive into "Invalidate the cache on change."',
      'f: fix "rebuild" is not in the reference',
      'f: keep "--watch" does not survive into "Invalidate the cache when the branch changes."',
    ]);
  });

  it("flags a fix that isn't classed as a misread or a form", () => {
    const unclassed = (id: string, kind: unknown) =>
      makeCase({ id, fixes: { "the cache": kind as FixKind } });
    expect(corpusProblems([unclassed("u", undefined), unclassed("v", "typo")])).toEqual([
      'u: fix "the cache" is not classed as a misread or a form',
      'v: fix "the cache" is not classed as a misread or a form',
    ]);
  });

  it("flags a reference with a number the speaker never gave, but not a list's item numbers", () => {
    expect(
      corpusProblems([
        makeCase({
          id: "g",
          raw: "deepgram nova three is slow",
          reference: "Deepgram Nova-3 is slow.",
          fixes: {},
          drops: [],
        }),
        makeCase({
          id: "h",
          raw: "first read it second fix it in e two e",
          reference: "1. Read it.\n2. Fix it in e2e.",
          fixes: {},
          drops: [],
        }),
        makeCase({
          id: "i",
          raw: "retry 3 times then 3 more",
          reference: "Retry 3 times, then 3 more.",
          alsoAccept: ["Retry 3 times, then more."],
          fixes: {},
          drops: [],
        }),
      ])
    ).toEqual([
      'g: "Deepgram Nova-3 is slow." has the number 3, which the raw doesn\'t',
      'i: keep "3" does not survive into "Retry 3 times, then more."',
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
      misreadsLanded: 1,
      formsLanded: 0,
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
    ).toMatchObject({ broken: 0, novelWords: 3, addedWords: 3 });
  });

  it("counts an insertion built from words it was allowed, and a known word used too often", () => {
    const entry = makeCase({});
    // The misheard word put back beside its fix: nothing is novel, but it was added.
    expect(scoreText(entry, "Invalidate the cache when the branch changes, cash.")).toMatchObject({
      broken: 0,
      novelWords: 0,
      addedWords: 1,
    });
    expect(
      scoreText(entry, "Invalidate the cache when the branch changes the branch.")
    ).toMatchObject({ novelWords: 2, addedWords: 2 });
    // Filler the raw transcript already had is not an addition.
    expect(scoreText(entry, entry.raw.replace("cash", "cache")).addedWords).toBe(0);
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
      fixes: {},
    });
    expect(scoreText(entry, "Bring the umbrella.").missedDrops).toEqual([]);
    expect(scoreText(entry, "Bring the umbrella and the umbrella.").missedDrops).toEqual([]);
    expect(scoreText(entry, "Um, bring the umbrella.").missedDrops).toEqual(["um"]);
  });

  it("reads a typographic apostrophe as a straight one, either way round", () => {
    const entry = makeCase({
      raw: "I don't, I don't want it",
      reference: "I don't want it.",
      fixes: {},
      drops: ["I don't, I don't"],
    });
    expect(scoreText(entry, "I don\u2019t, I don\u2019t want it.").missedDrops).toEqual([
      "I don't, I don't",
    ]);
    expect(
      scoreText({ ...entry, drops: ["I don\u2019t, I don\u2019t"] }, "I don't, I don't want it.")
        .missedDrops
    ).toEqual(["I don\u2019t, I don\u2019t"]);
    expect(scoreText(entry, "I don\u2019t want it.").missedDrops).toEqual([]);
  });

  it("still finds a stutter whose punctuation was taken out", () => {
    const entry = makeCase({
      raw: "can you, can you check the logs",
      reference: "Can you check the logs?",
      fixes: {},
      drops: ["can you, can you"],
    });
    expect(scoreText(entry, "Can you check the logs?").missedDrops).toEqual([]);
    expect(scoreText(entry, "Can you can you check the logs?").missedDrops).toEqual([
      "can you, can you",
    ]);
    expect(scoreText(entry, "Can you. Can you check the logs?").missedDrops).toEqual([
      "can you, can you",
    ]);
  });

  it("holds the raw transcript's code, references, flags, paths and numbers without being told to", () => {
    const entry = makeCase({
      raw: "um in @src/App.tsx rename `isOpen` and run it with --watch twice, 3 times in shared/config",
      reference:
        "In @src/App.tsx rename `isOpen` and run it with --watch twice, 3 times in shared/config.",
      fixes: {},
    });
    const kept = scoreText(entry, entry.reference);
    expect(kept.lostKeeps).toEqual([]);
    expect(kept.keepsTotal).toBe(5);
    // Every one survives the word normaliser, which drops the symbols.
    const mangled = scoreText(
      entry,
      "In src/App.tsx rename isOpen and run it with watch twice, three times in shared config."
    );
    expect(mangled.edits).toBe(0);
    expect(mangled.lostKeeps).toEqual([
      "@src/App.tsx",
      "`isOpen`",
      "--watch",
      "shared/config",
      "3",
    ]);
  });

  it("needs every copy of a protected span and number, each whole and exact", () => {
    const entry = makeCase({
      raw: "run --watch then --watch on 3 files and 3 dirs in package.json",
      reference: "Run --watch, then --watch on 3 files and 3 dirs in package.json.",
      fixes: {},
      drops: [],
      // A keep that is also a protected span gets the span's exact check.
      keep: ["package.json"],
    });
    expect(scoreText(entry, entry.reference).lostKeeps).toEqual([]);
    expect(
      scoreText(entry, "Run --watch on 3 files and 3 dirs in package.json.").lostKeeps
    ).toEqual(["--watch"]);
    expect(
      scoreText(entry, "Run ---watch, then --watch on 3 files and 3 dirs in package.json.")
        .lostKeeps
    ).toEqual(["--watch"]);
    expect(
      scoreText(entry, "Run --watch, then --watch on 3 files and 33 dirs in package.json.")
        .lostKeeps
    ).toEqual(["3"]);
    expect(
      scoreText(entry, "Run --watch, then --watch on 3 files and 3 dirs in Package.json.").lostKeeps
    ).toEqual(["package.json"]);
  });

  it("needs every copy of a kept span, letter for letter but for the first one's case", () => {
    const entry = makeCase({
      raw: "don't stop and don't wait for src/App.tsx",
      reference: "Don't stop and don't wait for src/App.tsx.",
      fixes: {},
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
      fixes: { "--watch": "form" },
      drops: [],
    });
    expect(scoreText(entry, "Run it with -- watch.").missedFixes).toEqual(["--watch"]);
    expect(scoreText(entry, "Run it with --WATCH.").missedFixes).toEqual(["--watch"]);
    expect(scoreText(entry, "Run it with --watch.").missedFixes).toEqual([]);
  });

  it("needs a fix as many times as the reference has it", () => {
    const entry = makeCase({
      raw: "run dash dash watch then dash dash watch again",
      reference: "Run --watch, then --watch again.",
      fixes: { "--watch": "form" },
      drops: [],
    });
    expect(scoreText(entry, "Run --watch, then dash dash watch again.")).toMatchObject({
      formsLanded: 0,
      missedFixes: ["--watch"],
    });
    expect(scoreText(entry, entry.reference)).toMatchObject({ formsLanded: 1, missedFixes: [] });
  });

  it("scores a passage's misread and form fixes apart", () => {
    const entry = makeCase({
      raw: "ask codecs to check the work tree",
      reference: "Ask Codex to check the worktree.",
      fixes: { Codex: "misread", worktree: "form" },
      drops: [],
    });
    const landed = (text: string) => {
      const { misreadsLanded, formsLanded, missedFixes } = scoreText(entry, text);
      return { misreadsLanded, formsLanded, missedFixes };
    };
    expect(landed(entry.raw)).toEqual({
      misreadsLanded: 0,
      formsLanded: 0,
      missedFixes: ["Codex", "worktree"],
    });
    // Joined and cased, with the wrong word still in it.
    expect(landed("Ask codecs to check the worktree.")).toEqual({
      misreadsLanded: 0,
      formsLanded: 1,
      missedFixes: ["Codex"],
    });
    expect(landed("Ask Codex to check the work tree.")).toEqual({
      misreadsLanded: 1,
      formsLanded: 0,
      missedFixes: ["worktree"],
    });
    expect(landed(entry.reference)).toEqual({ misreadsLanded: 1, formsLanded: 1, missedFixes: [] });
  });

  it("matches a reference by words and lines, and takes any accepted alternative", () => {
    const entry = makeCase({
      raw: "first read the test second find the race",
      reference: "1. Read the test.\n2. Find the race.",
      alsoAccept: ["First, read the test. Second, find the race."],
      fixes: {},
      drops: [],
    });
    expect(scoreText(entry, "1. read the test\n\n2. find the race").matchesReference).toBe(true);
    expect(scoreText(entry, "1. Read the test. 2. Find the race.").matchesReference).toBe(false);
    const alternative = scoreText(entry, "First, read the test. Second, find the race.");
    // Scored against the alternative it matches, not the list it doesn't.
    expect(alternative).toMatchObject({ matchesReference: true, edits: 0, broken: 0 });
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
    // The same at $0.10, $0.01 and $0.50.
    expect(requestCost("gpt-6-luna", usage)).toBeCloseTo((5.6 + 29.44 + 21.5) / 1e6, 12);
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
    expect(percentile([3, 1, 2], 50)).toBe(2);
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
    fixes: {},
  });
  const corpus = [{ ...short, fixes: {}, drops: [] }, long];

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
    const usage = (inputTokens: number, cachedTokens: number, outputTokens: number) => ({
      inputTokens,
      cachedTokens,
      outputTokens,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    });
    const trials = [
      trial({ caseId: "short", landed: "commit and push", disposition: "declined" }),
      trial({ caseId: "short", landed: "commit and push", disposition: "declined" }),
      trial({
        caseId: "short",
        landed: "Commit and push.",
        usage: usage(1_000, 900, 10),
      }),
      trial({
        caseId: "long",
        landed: long.raw,
        proposal: "The cache is stale.",
        disposition: "rejected",
        rejectReason: "edit_size",
        roundTripMs: 2_500,
        usage: usage(3_000, 2_700, 30),
      }),
      // A reply that failed fast must not pull the round-trip figures down.
      trial({ caseId: "long", landed: long.raw, disposition: "failed", roundTripMs: 100 }),
      trial({ caseId: "short", landed: "x", variant: "b" }),
    ];
    const summary = summariseVariant("a", trials, corpus);

    expect(summary.trials).toBe(5);
    expect(summary.dispositions).toEqual({
      applied: 1,
      declined: 2,
      rejected: 1,
      failed: 1,
      skipped: 0,
    });
    expect(summary.rejectReasons).toEqual({ edit_size: 1 });
    expect(summary.cleanUntouched).toEqual({ kept: 2, of: 3 });
    expect(summary.roundTrip).toMatchObject({ count: 4, max: 2_500, overTarget: 0.25 });
    expect(summary.promptLengthRoundTrip).toMatchObject({ count: 1, p50: 2_500 });
    expect(summary.total.count).toBe(5);
    expect(summary.tokens).toMatchObject({ meanInput: 2_000, cachedShare: 0.9, meanOutput: 20 });
    // The rejected proposal would have repaired the stale passage; nothing landed did.
    expect(summary.proposed.repairRate).toBeGreaterThan(summary.landed.repairRate);
    expect(summary.landed.repairRate).toBe(0);
  });

  it("times the first streamed text over the replies that showed some", () => {
    const trials = [
      trial({ caseId: "short", landed: "commit and push", firstTextMs: 400 }),
      trial({ caseId: "long", landed: long.raw, firstTextMs: 900 }),
      // Unstreamed, and a failure that showed text before it went wrong.
      trial({ caseId: "short", landed: "commit and push" }),
      trial({ caseId: "long", landed: long.raw, disposition: "failed", firstTextMs: 50 }),
    ];
    const summary = summariseVariant("a", trials, corpus);
    expect(summary.firstText).toMatchObject({ count: 2, p50: 400, max: 900 });
    expect(summary.promptLengthFirstText).toMatchObject({ count: 1, p50: 900 });
  });

  it("leaves the cost unknown when any request's is", () => {
    const trials = [
      trial({ caseId: "short", landed: "commit and push" }),
      trial({ caseId: "short", landed: "commit and push", costUsd: 0.003 }),
      trial({ caseId: "short", landed: "commit and push", costUsd: null }),
    ];
    expect(summariseVariant("a", trials, corpus)).toMatchObject({
      meanCostUsd: null,
      totalCostUsd: null,
    });
    const priced = summariseVariant("a", trials.slice(0, 2), corpus);
    expect(priced.meanCostUsd).toBeCloseTo(0.002);
    expect(priced.totalCostUsd).toBeCloseTo(0.004);
  });

  it("scores every variant's raw baseline against the same reference", () => {
    const entry = makeCase({
      id: "alt",
      raw: "um so can you check it",
      reference: "Can you check it?",
      alsoAccept: ["So can you check it?"],
      fixes: {},
      drops: [],
    });
    const rows = [
      { variant: "a", landed: "So can you check it?" },
      { variant: "b", landed: "Can you check it?" },
    ].map(({ variant, landed }): Trial => ({
      caseId: "alt",
      variant,
      repeat: 1,
      disposition: "applied",
      landed,
      proposal: landed,
      landedScore: scoreText(entry, landed),
      proposalScore: scoreText(entry, landed),
      roundTripMs: 1_000,
      totalMs: 1_000,
      costUsd: 0.001,
    }));
    const [a, b] = ["a", "b"].map((variant) => summariseVariant(variant, rows, [entry]));
    expect(a!.landed.rawWer).toBe(b!.landed.rawWer);
    expect(a!.landed.wer).toBe(0);
    expect(b!.landed.wer).toBe(0);
  });

  it("pools misread and form fixes apart, for what landed and what was proposed", () => {
    const mixed = makeCase({
      id: "mixed",
      raw: "ask codecs to check the work tree",
      reference: "Ask Codex to check the worktree.",
      fixes: { Codex: "misread", worktree: "form" },
      drops: [],
    });
    const forms = makeCase({
      id: "forms",
      raw: "run n p m test dash dash watch",
      reference: "Run npm test --watch.",
      fixes: { "npm test": "form", "--watch": "form" },
      drops: [],
    });
    const entries = [mixed, forms];
    const row = (
      variant: string,
      entry: CleanupCase,
      landed: string,
      proposal = landed
    ): Trial => ({
      caseId: entry.id,
      variant,
      repeat: 1,
      disposition: proposal === landed ? "applied" : "rejected",
      landed,
      proposal,
      landedScore: scoreText(entry, landed),
      proposalScore: scoreText(entry, proposal),
      roundTripMs: 1_000,
      totalMs: 1_000,
      costUsd: 0.001,
    });
    const trials = [
      // Turned down whole, so the misread it fixed never landed.
      row("a", mixed, mixed.raw, mixed.reference),
      row("a", mixed, "Ask codecs to check the worktree."),
      row("a", forms, forms.reference),
      row("b", mixed, mixed.reference),
    ];
    const summary = summariseVariant("a", trials, entries);
    expect(summary.landed).toMatchObject({
      totals: { misreads: 2, forms: 4 },
      misreadRate: 0,
      formRate: 0.75,
    });
    expect(summary.proposed).toMatchObject({
      totals: { misreads: 2, forms: 4 },
      misreadRate: 0.5,
      formRate: 1,
    });
    expect(summariseVariant("b", trials, entries).landed).toMatchObject({
      totals: { misreads: 1, forms: 1 },
      misreadRate: 1,
      formRate: 1,
    });
  });
});

describe("rescore", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "voice-cleanup-rescore-"));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  // A run saved under scoring v2, before fixes had a kind.
  function savedRun(): string {
    const ids = ["context-codex:deepgram", "zustand-selector:deepgram"];
    const entries = ids.map((id) => CLEANUP_CORPUS.find((entry) => entry.id === id)!);
    const landed: Record<string, Record<string, string>> = {
      "gpt-6-luna:none": {
        "context-codex:deepgram": "Ask Codex to review the diff before you open the PR.",
        "zustand-selector:deepgram":
          "Zoo stand selector in the worktree store is returning a new array on every render. Wrap it in useShallow.",
        "gone:openai": "Gone.",
      },
      "gpt-6.1-terra:none": {
        "context-codex:deepgram": "Ask Codex to review the diff before you open the PR.",
        "zustand-selector:deepgram": entries[1]!.raw,
      },
    };
    const trials = Object.entries(landed).flatMap(([variant, texts]) =>
      Object.entries(texts).map(([caseId, text]) => ({
        caseId,
        variant,
        repeat: 1,
        disposition: "applied",
        landed: text,
        proposal: text,
        landedScore: { fixesLanded: 0, missedFixes: [] },
        proposalScore: { fixesLanded: 0, missedFixes: [] },
        roundTripMs: 900,
        totalMs: 950,
        costUsd: 0.001,
      }))
    );
    const run = {
      schemaVersion: VOICE_CLEANUP_SCHEMA_VERSION,
      scoringVersion: 2,
      complete: true,
      label: "saved",
      startedAt: "2026-10-27T00:00:00.000Z",
      finishedAt: "2026-10-27T00:10:00.000Z",
      git: { revision: "d9fb374140562949f69da5315595785413ab7b56", dirty: false },
      node: "v22.23.2",
      platform: "darwin-arm64",
      seed: 14793,
      repeats: 1,
      stream: true,
      variants: [
        { id: "gpt-6-luna:none", model: "gpt-6-luna", effort: "none" },
        { id: "gpt-6.1-terra:none", model: "gpt-6.1-terra", effort: "none" },
      ],
      profile: { customDictionary: [], projectName: "daintree", projectPath: "/p", language: "en" },
      promptHash: "prompt",
      corpusHash: "corpus",
      corpus: [
        ...entries.map((entry) => ({
          id: entry.id,
          style: entry.style,
          source: entry.source,
          chars: entry.raw.length,
          inputHash: inputHash(entry),
          sent: {},
        })),
        {
          id: "gone:openai",
          style: "openai",
          source: "context",
          chars: 5,
          inputHash: "x",
          sent: {},
        },
      ],
      prices: {},
      predictionProbes: [],
      trials,
      summaries: [],
    };
    const file = path.join(directory, "saved.json");
    writeFileSync(file, JSON.stringify(run));
    return file;
  }

  it("gives a run saved before fixes had a kind both scores, in the report too", () => {
    const { run, corpus } = rescore(savedRun());
    expect(run.scoringVersion).toBe(VOICE_CLEANUP_SCORING_VERSION);
    expect(run.rescoreExclusions).toEqual([{ id: "gone:openai", reason: "removed", trials: 1 }]);
    const [luna, terra] = run.summaries;
    expect(luna!.landed).toMatchObject({
      totals: { misreads: 2, forms: 2 },
      misreadRate: 0.5,
      formRate: 1,
    });
    expect(luna!.proposed).toMatchObject({ misreadRate: 0.5, formRate: 1 });
    expect(terra!.landed).toMatchObject({ misreadRate: 0.5, formRate: 0 });

    const report = renderReport(run, corpus);
    expect(report).toContain(
      "Rescored with scoring v3, leaving out gone:openai (removed, 1 trials)."
    );
    expect(report).toContain("| Variant | Repaired | Misreads | Forms | Drops |");
    // Once for what landed, once for what was proposed.
    expect(report.match(/\| gpt-6-luna:none \| [^|]+ \| 50\.0% \| 100\.0% \|/g)).toHaveLength(2);
    expect(report).toContain("| deepgram | 2 | 1/2 · 2/2 · 1/2 | 1/2 · 0/2 · 1/2 |");
    expect(report).toContain("missed misreads Zustand; missed forms worktree, useShallow");
  });
});
