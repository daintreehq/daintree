import { describe, expect, it } from "vitest";
import { REPLAY_CLIPS } from "../../../e2e/helpers/voiceReplayFixtures";
import { validateCorrection } from "../../../electron/services/voiceCorrectionGuard";
import { CLEANUP_CORPUS, REPLAY_TRANSCRIPTS, type CleanupCase } from "../lib/voiceCleanupCorpus";
import { ADVERSARIAL_PROPOSALS, GUARD_VARIANTS } from "../lib/voiceCleanupGuards";
import { PROMPT_VARIANTS, revise } from "../lib/voiceCleanupPrompts";
import {
  corpusProblems,
  locateUncertain,
  longestSentence,
  percentile,
  requestCost,
  scoreText,
  seededShuffle,
  summariseVariant,
  type Disposition,
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
      expect(replayIds).toContain(`${clip.id}:grok`);
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
      makeCase({ id: "a", raw: "invalidate the cache", fixes: ["the cache"], drops: [] }),
      makeCase({ id: "b", raw: "invalidate the cash", drops: ["um"] }),
      makeCase({ id: "c", keep: ["branch changes now"] }),
      makeCase({ id: "d", uncertain: ["cash"] }),
      makeCase({ id: "d", style: "deepgram", uncertain: ["cache"] }),
      makeCase({ id: "e", keep: ["the branch"], reference: "Invalidate the cache on change." }),
      makeCase({ id: "f", fixes: ["the cache", "rebuild"], raw: "um rerun --watch", drops: [] }),
    ]);
    expect(problems).toEqual([
      'a: fix "the cache" is already in the raw transcript',
      'b: drop "um" leaves nothing to take out',
      'c: keep "branch changes now" is not in the raw',
      "d: only Deepgram and Grok flag unsure words",
      "d: duplicate id",
      'd: unsure phrase "cache" is not in the raw transcript',
      'e: keep "the branch" does not survive into "Invalidate the cache on change."',
      'f: fix "rebuild" is not in the reference',
      'f: keep "--watch" does not survive into "Invalidate the cache when the branch changes."',
    ]);
  });

  it("flags a reference with a number the speaker never gave, but not a list's item numbers", () => {
    expect(
      corpusProblems([
        makeCase({
          id: "g",
          raw: "deepgram nova three is slow",
          reference: "Deepgram Nova-3 is slow.",
          fixes: [],
          drops: [],
        }),
        makeCase({
          id: "h",
          raw: "first read it second fix it in e two e",
          reference: "1. Read it.\n2. Fix it in e2e.",
          fixes: [],
          drops: [],
        }),
        makeCase({
          id: "i",
          raw: "retry 3 times then 3 more",
          reference: "Retry 3 times, then 3 more.",
          alsoAccept: ["Retry 3 times, then more."],
          fixes: [],
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
      fixes: [],
    });
    expect(scoreText(entry, "Bring the umbrella.").missedDrops).toEqual([]);
    expect(scoreText(entry, "Bring the umbrella and the umbrella.").missedDrops).toEqual([]);
    expect(scoreText(entry, "Um, bring the umbrella.").missedDrops).toEqual(["um"]);
  });

  it("reads a typographic apostrophe as a straight one, either way round", () => {
    const entry = makeCase({
      raw: "I don't, I don't want it",
      reference: "I don't want it.",
      fixes: [],
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
      fixes: [],
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
      fixes: [],
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
      fixes: [],
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
    expect(scoreText(entry, "Run it with --WATCH.").missedFixes).toEqual(["--watch"]);
    expect(scoreText(entry, "Run it with --watch.").missedFixes).toEqual([]);
  });

  it("needs a fix as many times as the reference has it", () => {
    const entry = makeCase({
      raw: "run dash dash watch then dash dash watch again",
      reference: "Run --watch, then --watch again.",
      fixes: ["--watch"],
      drops: [],
    });
    expect(scoreText(entry, "Run --watch, then dash dash watch again.").missedFixes).toEqual([
      "--watch",
    ]);
    expect(scoreText(entry, entry.reference).missedFixes).toEqual([]);
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
    const alternative = scoreText(entry, "First, read the test. Second, find the race.");
    // Scored against the alternative it matches, not the list it doesn't.
    expect(alternative).toMatchObject({ matchesReference: true, edits: 0, broken: 0 });
  });
});

describe("run-ons and agent-ready text", () => {
  const runOn = makeCase({
    raw: "so the build fails on windows and then it retries forever and the log fills up so can you cap it",
    reference:
      "The build fails on Windows, and then it retries forever and the log fills up. Can you cap it?",
    fixes: [],
    drops: ["so"],
    maxSentenceWords: 15,
  });

  it("counts the words of the longest sentence or line", () => {
    expect(longestSentence("One two. Three four five!\nSix")).toBe(3);
    expect(longestSentence("It's a one-line change.")).toBe(5);
    expect(longestSentence("")).toBe(0);
  });

  it("calls a run-on split only under the passage's cap", () => {
    expect(scoreText(runOn, runOn.reference)).toMatchObject({ split: true, agentReady: true });
    const unsplit =
      "The build fails on Windows and then it retries forever and the log fills up, can you cap it?";
    expect(scoreText(runOn, unsplit)).toMatchObject({ split: false, agentReady: false });
    expect(
      scoreText(makeCase({}), "Invalidate the cache when the branch changes.").split
    ).toBeNull();
  });

  it("is agent-ready only with every fix and drop landed and nothing kept lost", () => {
    const entry = makeCase({ keep: ["branch"] });
    expect(scoreText(entry, entry.reference).agentReady).toBe(true);
    expect(scoreText(entry, "Invalidate the cash when the branch changes.").agentReady).toBe(false);
    expect(scoreText(entry, "Um, invalidate the cache when the branch changes.").agentReady).toBe(
      false
    );
  });

  it("flags a run-on cap the raw already meets, or a reference breaks", () => {
    const problems = corpusProblems([
      makeCase({ id: "short", maxSentenceWords: 20 }),
      { ...runOn, id: "long", maxSentenceWords: 8 },
    ]);
    expect(problems).toContain("short: the raw has no sentence over 20 words");
    expect(problems.some((problem) => problem.startsWith('long: "The build'))).toBe(true);
  });
});

describe("prompt and guard variants", () => {
  it("keeps v11 frozen apart from production's constants and revises it edit by edit", () => {
    const v11 = PROMPT_VARIANTS.v11!.instructions;
    expect(v11.core).toContain("MEANING IS FIXED");
    expect(revise(v11, { core: [["MEANING IS FIXED", "MEANING IS FIXED!"]] }).core).toContain(
      "MEANING IS FIXED!"
    );
    expect(() => revise(v11, { core: [["no such text", "x"]] })).toThrow(/exactly once/);
    expect(() => revise(v11, { suffix: [["-", "x"]] })).toThrow(/exactly once/);
  });

  it("builds every prompt variant", () => {
    for (const [name, variant] of Object.entries(PROMPT_VARIANTS)) {
      expect(variant.instructions.core.length, name).toBeGreaterThan(4_800);
      expect(variant.instructions.suffix, name).toContain("JSON object");
    }
  });

  it("names a passage the corpus has for every harmful cleanup", () => {
    const ids = new Set(CLEANUP_CORPUS.map((entry) => entry.id));
    expect(ADVERSARIAL_PROPOSALS.filter(({ caseId }) => !ids.has(caseId))).toEqual([]);
  });

  it("refuses under v11 every harmful cleanup a word count can see", () => {
    const landed = ADVERSARIAL_PROPOSALS.filter(({ caseId, proposal }) => {
      const entry = CLEANUP_CORPUS.find((candidate) => candidate.id === caseId)!;
      return validateCorrection(entry.raw, proposal, GUARD_VARIANTS.v11!.limits).ok;
    }).map(({ harm }) => harm);
    expect(landed).toEqual([
      "swaps who does what",
      "drops the Yeah that answers the agent",
      "drops the just that means only",
    ]);
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
    fixes: [],
  });
  const corpus = [{ ...short, fixes: [], drops: [] }, long];

  type TrialOverrides = Partial<Omit<Trial, "landings">> &
    Pick<Trial, "caseId"> & { landed: string; disposition?: Disposition; rejectReason?: string };

  // One landing, under the guard "g".
  function trial({
    landed,
    disposition = "applied",
    rejectReason,
    ...rest
  }: TrialOverrides): Trial {
    const entry = corpus.find((candidate) => candidate.id === rest.caseId)!;
    const proposal = rest.proposal ?? landed;
    return {
      variant: "a",
      repeat: 1,
      proposal,
      proposalScore: scoreText(entry, proposal),
      landings: {
        g: {
          disposition,
          ...(rejectReason ? { rejectReason } : {}),
          landed,
          landedScore: scoreText(entry, landed),
        },
      },
      roundTripMs: 1_000,
      totalMs: 1_010,
      costUsd: 0.001,
      ...rest,
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
    const summary = summariseVariant("a", "g", trials, corpus);

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

  it("tells a guard's catches from what it let through and held back", () => {
    const risky = "The cache.";
    const trials = [
      // A meaning risk refused, and one landed.
      trial({
        caseId: "short",
        landed: "commit and push",
        proposal: "push",
        disposition: "rejected",
        rejectReason: "edit_size",
      }),
      trial({ caseId: "short", landed: "push" }),
      // A sound cleanup refused, which was agent-ready.
      trial({
        caseId: "long",
        landed: long.raw,
        proposal: "The cache is stale.",
        disposition: "rejected",
        rejectReason: "edit_size",
      }),
      // Refused for confidence, which no guard check decided.
      trial({
        caseId: "long",
        landed: long.raw,
        proposal: risky,
        disposition: "rejected",
        rejectReason: "low_confidence",
      }),
    ];
    expect(summariseVariant("a", "g", trials, corpus).guardChecks).toEqual({
      caught: 1,
      letThrough: 1,
      heldBack: 1,
      heldBackReady: 1,
    });
  });

  it("times the first streamed text over the replies that showed some", () => {
    const trials = [
      trial({ caseId: "short", landed: "commit and push", firstTextMs: 400 }),
      trial({ caseId: "long", landed: long.raw, firstTextMs: 900 }),
      // Unstreamed, and a failure that showed text before it went wrong.
      trial({ caseId: "short", landed: "commit and push" }),
      trial({ caseId: "long", landed: long.raw, disposition: "failed", firstTextMs: 50 }),
    ];
    const summary = summariseVariant("a", "g", trials, corpus);
    expect(summary.firstText).toMatchObject({ count: 2, p50: 400, max: 900 });
    expect(summary.promptLengthFirstText).toMatchObject({ count: 1, p50: 900 });
  });

  it("leaves the cost unknown when any request's is", () => {
    const trials = [
      trial({ caseId: "short", landed: "commit and push" }),
      trial({ caseId: "short", landed: "commit and push", costUsd: 0.003 }),
      trial({ caseId: "short", landed: "commit and push", costUsd: null }),
    ];
    expect(summariseVariant("a", "g", trials, corpus)).toMatchObject({
      meanCostUsd: null,
      totalCostUsd: null,
    });
    const priced = summariseVariant("a", "g", trials.slice(0, 2), corpus);
    expect(priced.meanCostUsd).toBeCloseTo(0.002);
    expect(priced.totalCostUsd).toBeCloseTo(0.004);
  });

  it("scores every variant's raw baseline against the same reference", () => {
    const entry = makeCase({
      id: "alt",
      raw: "um so can you check it",
      reference: "Can you check it?",
      alsoAccept: ["So can you check it?"],
      fixes: [],
      drops: [],
    });
    const rows = [
      { variant: "a", landed: "So can you check it?" },
      { variant: "b", landed: "Can you check it?" },
    ].map(({ variant, landed }): Trial => ({
      caseId: "alt",
      variant,
      repeat: 1,
      proposal: landed,
      proposalScore: scoreText(entry, landed),
      landings: {
        g: { disposition: "applied", landed, landedScore: scoreText(entry, landed) },
      },
      roundTripMs: 1_000,
      totalMs: 1_000,
      costUsd: 0.001,
    }));
    const [a, b] = ["a", "b"].map((variant) => summariseVariant(variant, "g", rows, [entry]));
    expect(a!.landed.rawWer).toBe(b!.landed.rawWer);
    expect(a!.landed.wer).toBe(0);
    expect(b!.landed.wer).toBe(0);
  });
});
