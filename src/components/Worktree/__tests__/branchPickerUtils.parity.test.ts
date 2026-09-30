import { describe, it, expect } from "vitest";
import Fuse from "fuse.js";
import {
  BRANCH_FUSE_OPTIONS,
  searchBranches,
  toBranchOption,
  type BranchOption,
} from "../branchPickerUtils";
import { TYPED_QUERIES, makeBranches } from "../__bench__/branchFixture";

// `searchBranches` narrows Fuse to the branches that can possibly match before
// scoring. These suites hold it to an unfiltered Fuse search over the same list:
// same items, same order, same scores, same match indices.

function expectParity(options: readonly BranchOption[], queries: readonly string[]) {
  const exhaustive = new Fuse(options, BRANCH_FUSE_OPTIONS);
  for (const query of queries) {
    const expected = exhaustive.search(query);
    const actual = searchBranches(options, query);
    expect({ query, results: actual }).toEqual({ query, results: expected });
  }
}

function seededRandom(seed: number) {
  return () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;
}

/** Substrings of real names with 0–3 random edits: the near-miss typos fuzzy search exists for. */
function typoQueries(options: readonly BranchOption[], count: number, seed: number): string[] {
  const rnd = seededRandom(seed);
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789-/_. ";
  const queries: string[] = [];
  for (let q = 0; q < count; q++) {
    const name = options[Math.floor(rnd() * options.length)]!.name;
    const start = Math.floor(rnd() * name.length);
    let text = name.slice(start, start + 2 + Math.floor(rnd() * 12));
    const edits = Math.floor(rnd() * 4);
    for (let e = 0; e < edits && text.length > 1; e++) {
      const at = Math.floor(rnd() * text.length);
      const ch = alphabet[Math.floor(rnd() * alphabet.length)]!;
      const kind = rnd();
      if (kind < 0.33) text = text.slice(0, at) + ch + text.slice(at + 1);
      else if (kind < 0.66) text = text.slice(0, at) + text.slice(at + 1);
      else text = text.slice(0, at) + ch + text.slice(at);
    }
    if (rnd() < 0.2) text = text.toUpperCase();
    queries.push(text.trim() || "ab");
  }
  return queries;
}

describe("searchBranches parity with an unfiltered Fuse search", () => {
  it("matches on every keystroke of typed queries over 20k branches", () => {
    const options = makeBranches(20_000).map(toBranchOption);
    const keystrokes = TYPED_QUERIES.flatMap((q) =>
      Array.from({ length: q.length - 1 }, (_, i) => q.slice(0, i + 2))
    );
    expectParity(options, [
      ...new Set(keystrokes),
      "team-3 br",
      "terminal picker",
      "orgin fetaure",
      "(current)",
      "remote",
      "main",
      "zzzzzz",
      // One, two and three edits of budget, spent on typos.
      "tem-3",
      "treminal",
      "dashbaord-sidebr",
      "feature/migraton-4",
    ]);
  }, 60_000);

  it("matches on typo'd queries over 20k branches", () => {
    const options = makeBranches(20_000).map(toBranchOption);
    expectParity(options, typoQueries(options, 40, 7));
  }, 60_000);

  it("matches on many random typo'd queries over 2k branches", () => {
    const options = makeBranches(2_000).map(toBranchOption);
    expectParity(options, typoQueries(options, 400, 99));
  }, 60_000);

  it("matches on awkward names and queries", () => {
    const options = [
      { name: "main", current: true, commit: "a" },
      { name: "İstanbul/feature", current: false, commit: "b" },
      { name: "ΟΔΟΣ/fix", current: false, commit: "c" },
      { name: "emoji/🚀-launch", current: false, commit: "d" },
      { name: "tab\there", current: false, commit: "e" },
      { name: "a".repeat(40) + "/long", current: false, commit: "f" },
      { name: "feature/x", current: false, commit: "g", remote: "origin" },
      { name: "ab", current: false, commit: "h" },
    ].map(toBranchOption);
    expectParity(options, [
      "istanbul",
      "i̇stanbul",
      "οδος",
      "οδοσ",
      "🚀",
      "🚀-la",
      "tab\there",
      "tab\th",
      "a".repeat(32),
      "a".repeat(31) + "/",
      "a".repeat(33),
      "a".repeat(40) + "/lo",
      "feature (remote)",
      "(current)",
      "ab",
      "ba",
      "  feature   x  ",
      // Fuse drops a token its matcher can't span, so `main` alone decides these.
      "main zz\nqq",
      "main zz\rqq",
      "main zz\u2028qq",
      "main zz\u2029qq",
    ]);
  });
});
