import { performance } from "node:perf_hooks";
import type { PerfScenario } from "../types";
import { createRng } from "../lib/workloads";
import { percentile } from "../lib/stats";
import {
  createActionRanker,
  extractAcronym,
  type ActionRanker,
  type SearchableAction,
  type RankContext,
} from "../../../src/lib/actionPaletteSearch";
import type { ActionFrecencyEntry } from "../../../shared/types/actions";

// Command/panel palette fuzzy filter. The palette re-ranks the WHOLE action
// catalog on every keystroke (rankActionMatches — src/lib/actionPaletteSearch.ts),
// so the number that the user feels is the per-keystroke re-rank latency, not
// the open animation. These scenarios drive the real ranking code over a
// realistic catalog and gate the per-keystroke tail: a filter recompute must
// stay well inside one frame (16.6 ms) so typing in the palette never stutters.

const CATEGORIES = [
  "git",
  "terminal",
  "panel",
  "agent",
  "browser",
  "worktree",
  "forge",
  "settings",
  "view",
  "fleet",
  "recipe",
  "devserver",
  "general",
] as const;

const VERBS = [
  "Open",
  "Close",
  "Toggle",
  "Create",
  "Delete",
  "Restart",
  "Focus",
  "Split",
  "Move",
  "Copy",
  "Rename",
  "Broadcast",
  "Arm",
  "Commit",
  "Push",
  "Pull",
  "Switch",
  "Reveal",
];

const NOUNS = [
  "Terminal",
  "Panel",
  "Worktree",
  "Branch",
  "Agent",
  "Browser Tab",
  "Dev Server",
  "Fleet",
  "Recipe",
  "Settings",
  "Diff",
  "Review Workspace",
  "Sidebar",
  "Command Palette",
  "Notification",
  "Project",
];

// A catalog entry built the way the palette builds SearchableAction: lowercase
// fields + acronym precomputed once at registration, then reused on every
// keystroke. Building it faithfully here keeps the benchmark measuring the
// per-keystroke ranking cost, not string-lowercasing that production amortizes.
function makeSearchable(
  id: string,
  title: string,
  category: string,
  description: string,
  keywords: string[],
  enabled: boolean
): SearchableAction {
  return {
    id,
    title,
    category,
    description,
    enabled,
    titleLower: title.toLowerCase(),
    categoryLower: category.toLowerCase(),
    descriptionLower: description.toLowerCase(),
    titleAcronym: extractAcronym(title),
    keywordsLower: keywords.map((k) => k.toLowerCase()),
  };
}

function buildCatalog(size: number): SearchableAction[] {
  const rng = createRng(70170 + size);
  const catalog: SearchableAction[] = [];
  for (let i = 0; i < size; i += 1) {
    const category = CATEGORIES[Math.floor(rng() * CATEGORIES.length)]!;
    const verb = VERBS[Math.floor(rng() * VERBS.length)]!;
    const noun = NOUNS[Math.floor(rng() * NOUNS.length)]!;
    const title = `${category[0]!.toUpperCase()}${category.slice(1)}: ${verb} ${noun}`;
    const description = `${verb} the ${noun.toLowerCase()} in the current ${category} context`;
    const keywords = [verb.toLowerCase(), noun.toLowerCase().split(" ")[0]!, category];
    // ~8% disabled, mirroring a real catalog where some actions are gated by
    // context — the ranker still scores them, just sorts them last.
    catalog.push(
      makeSearchable(`${category}.${i}`, title, category, description, keywords, rng() > 0.08)
    );
  }
  return catalog;
}

// A realistic recency list — heavy users hammer a handful of commands, so the
// ranker's MRU/frecency branch runs against a populated map on every keystroke.
function buildMruList(catalog: SearchableAction[]): ActionFrecencyEntry[] {
  const rng = createRng(999);
  const now = 1_700_000_000_000;
  return catalog.slice(0, 15).map((item, index) => ({
    id: item.id,
    score: 1 + Math.floor(rng() * 12),
    lastAccessedAt: now - index * 60_000,
  }));
}

const RANK_CONTEXT: RankContext = {
  focusedTerminalKind: "agent",
  focusedWorktreeId: "wt-3",
  isSettingsOpen: false,
};

// Realistic queries typed character-by-character — the palette fires one
// rankActionMatches per keystroke, so every prefix is a real re-rank. Includes
// short high-yield prefixes (worst case — many matches survive scoring),
// acronym queries (wtd), and multi-word queries.
//
// `expectMatch` is what makes `rankMisses` two-sided. The generated catalog has
// no "New" verb, so "new terminal" genuinely resolves to nothing — and a query
// that matches nothing is the CHEAP end of the ranker, since no candidate
// survives to be scored and sorted. Recording it as the miss case keeps it in
// the typing mix as itself, and catches both a ranker that stopped matching and
// one that stopped filtering.
const TYPED_QUERIES: ReadonlyArray<{ text: string; expectMatch: boolean }> = [
  { text: "git commit", expectMatch: true },
  { text: "new terminal", expectMatch: false },
  { text: "broadcast", expectMatch: true },
  { text: "wtd", expectMatch: true },
  { text: "settings", expectMatch: true },
  { text: "split panel", expectMatch: true },
  { text: "diff", expectMatch: true },
];

interface FilterStreamResult {
  totalReRankMs: number;
  reRankCount: number;
  p99KeystrokeMs: number;
  totalMatches: number;
  /**
   * Queries whose completed text disagreed with its expected outcome.
   * `reRankCount` is a function of the query list and `totalMatches` is an
   * aggregate one surviving query can prop up, so neither notices a scoring
   * branch that went dark — and a ranker that returns an empty array is the
   * fastest one there is.
   */
  rankMisses: number;
}

// Type each query one keystroke at a time, timing every individual re-rank.
function runFilterStream(
  rank: ActionRanker<SearchableAction>,
  mru: ActionFrecencyEntry[]
): FilterStreamResult {
  const perKeystroke: number[] = [];
  let totalMatches = 0;
  let rankMisses = 0;

  for (const query of TYPED_QUERIES) {
    let finalMatches = 0;
    for (let end = 1; end <= query.text.length; end += 1) {
      const prefix = query.text.slice(0, end);
      const start = performance.now();
      const matches = rank(prefix, mru, RANK_CONTEXT);
      perKeystroke.push(performance.now() - start);
      totalMatches += matches.length;
      finalMatches = matches.length;
    }
    if (finalMatches > 0 !== query.expectMatch) rankMisses += 1;
  }

  return {
    totalReRankMs: perKeystroke.reduce((sum, ms) => sum + ms, 0),
    reRankCount: perKeystroke.length,
    p99KeystrokeMs: percentile(perKeystroke, 99),
    totalMatches,
    rankMisses,
  };
}

export const paletteFilterScenarios: PerfScenario[] = [
  {
    id: "PERF-170",
    name: "Palette Fuzzy Filter - Progressive Typing",
    description:
      "Drive the real rankActionMatches ranker over a ~380-action catalog (BUILT_IN_ACTION_IDS " +
      "scale) while typing 7 representative queries one keystroke at a time — every prefix is a " +
      "full re-rank, as in the live palette. durationMs is the whole typing session; " +
      "p99KeystrokeMs is the p99 single re-rank the user feels and must stay well inside a frame.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 10, ci: 18, nightly: 24 },
    warmups: 2,
    correctness: ["rankMisses"],
    run() {
      // Catalog + MRU are precomputed once at palette registration in production,
      // so build them outside the timed bracket — the gate measures re-ranking.
      const catalog = buildCatalog(380);
      const mru = buildMruList(catalog);
      const rank = createActionRanker(catalog);
      const start = performance.now();
      const result = runFilterStream(rank, mru);
      const durationMs = performance.now() - start;

      return {
        durationMs,
        metrics: {
          reRankCount: result.reRankCount,
          p99KeystrokeMs: result.p99KeystrokeMs,
          avgKeystrokeMs: result.totalReRankMs / Math.max(1, result.reRankCount),
          totalMatches: result.totalMatches,
          rankMisses: result.rankMisses,
        },
      };
    },
  },
  {
    id: "PERF-171",
    name: "Palette Fuzzy Filter - Catalog Scaling",
    description:
      "Worst-case single-character query ('e' — many matches survive scoring) re-ranked against " +
      "growing catalogs (380/760/1520 actions). Budgets the per-1k-action re-rank slope so a " +
      "super-linear ranking regression (e.g. an accidental O(n²) sort/score) trips the gate even " +
      "if the small-catalog case still looks fast.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 8, ci: 14, nightly: 20 },
    warmups: 1,
    correctness: ["rankMisses"],
    run() {
      const sizes = [380, 760, 1520];
      const REPEATS = 12;
      // Build every catalog + MRU up front so the timed bracket contains only
      // rankActionMatches calls, not O(n) fixture construction.
      const fixtures = sizes.map((size) => {
        const catalog = buildCatalog(size);
        return {
          size,
          rank: createActionRanker(catalog),
          mru: buildMruList(catalog),
        };
      });
      const worstBySize = new Map<number, number>();
      let checksum = 0;
      // Catalog sizes where the single-character worst case survived nothing.
      // The whole premise is that many matches survive scoring; a ranker that
      // returns an empty array posts the best slope this scenario can measure.
      let rankMisses = 0;

      const start = performance.now();
      for (const { size, rank, mru } of fixtures) {
        const samples: number[] = [];
        let lastMatchCount = 0;
        for (let r = 0; r < REPEATS; r += 1) {
          const t0 = performance.now();
          const matches = rank("e", mru, RANK_CONTEXT);
          samples.push(performance.now() - t0);
          checksum += matches.length;
          lastMatchCount = matches.length;
        }
        if (lastMatchCount === 0) rankMisses += 1;
        worstBySize.set(size, percentile(samples, 95));
      }
      const durationMs = performance.now() - start;

      const worstLarge = worstBySize.get(1520) ?? 0;
      const msPerKAction = worstLarge / (1520 / 1000);

      return {
        durationMs,
        metrics: {
          worstMs380: worstBySize.get(380) ?? 0,
          worstMs1520: worstLarge,
          msPerKAction,
          checksum,
          rankMisses,
        },
      };
    },
  },
];
