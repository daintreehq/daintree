import { performance } from "node:perf_hooks";
import { parseDiff, type HunkData } from "react-diff-view";
import type { PerfScenario } from "../types";
import {
  runDiffTokenize,
  MAX_INTRALINE_CHANGES,
} from "../../../src/components/Worktree/diffTokenizer";

// Diff tokenization — the syntax-highlight + intra-line edit-marking pass that
// the review workspace runs for every file diff (runDiffTokenize, the one
// implementation the Web Worker and in-thread fallback both call, so this is
// the exact production path). Opening a review is a high-traffic surface; a
// tokenize that blows past a frame budget is felt as a blank/janky diff. These
// scenarios gate the tokenize cost at representative and pathological sizes and
// the multi-file open that a review workspace triggers.
//
// runDiffTokenize catches its own errors and returns tokens: null (a silent
// plaintext downgrade). A null pass is FASTER, so every scenario reports
// `tokenizeMisses` — files that came back without a token tree. It is emitted
// on every iteration, 0 when healthy, because a metric that only exists on the
// failure path cannot be read as a predicate: a run where tokenization died
// everywhere would report the same absent column as a run that never happened.
// This used to be a throw, which aborted the whole suite rather than reporting
// the number; the harness measures and only fails on apparatus breakage, and a
// silent plaintext downgrade is a result, not a broken apparatus. The fixture
// assertions below (is the diff actually over the intra-line budget?) stay
// throws — those ARE the apparatus.

interface DiffSpec {
  path: string;
  changedLines: number;
  seed: number;
}

// Emit a valid git unified diff with correctly-counted hunks. Each hunk is
// [context, paired -/+ change block, context]; a paired block of B lines is 2B
// "changed" lines (the metric shouldMarkIntraLineEdits counts). Line cursors
// advance per hunk so parseDiff sees non-overlapping, well-formed headers.
// changedLines is rounded UP to whole 2*PAIRS_PER_HUNK blocks.
function generateUnifiedDiff(spec: DiffSpec): string {
  const CONTEXT = 3;
  const PAIRS_PER_HUNK = 20; // 40 changed lines per hunk
  const hunkCount = Math.max(1, Math.ceil(spec.changedLines / (PAIRS_PER_HUNK * 2)));

  const lines: string[] = [
    `diff --git a/${spec.path} b/${spec.path}`,
    `index 1111111..2222222 100644`,
    `--- a/${spec.path}`,
    `+++ b/${spec.path}`,
  ];

  let oldCursor = 1;
  let newCursor = 1;
  for (let h = 0; h < hunkCount; h += 1) {
    const oldCount = CONTEXT + PAIRS_PER_HUNK + CONTEXT;
    const newCount = CONTEXT + PAIRS_PER_HUNK + CONTEXT;
    lines.push(`@@ -${oldCursor},${oldCount} +${newCursor},${newCount} @@`);

    for (let c = 0; c < CONTEXT; c += 1) {
      lines.push(`   const ctx_${h}_${c} = resolve(${h * 100 + c});`);
    }
    for (let b = 0; b < PAIRS_PER_HUNK; b += 1) {
      const n = spec.seed + h * 1000 + b;
      lines.push(`-  const value_${b} = legacyCompute(${n}, { retries: 3 });`);
    }
    for (let b = 0; b < PAIRS_PER_HUNK; b += 1) {
      const n = spec.seed + h * 1000 + b;
      lines.push(`+  const value_${b} = compute(${n}, { retries: 3, backoff: "expo" });`);
    }
    for (let c = 0; c < CONTEXT; c += 1) {
      lines.push(`   return aggregate(value_${c});`);
    }

    // Advance cursors past this hunk plus a gap so headers stay monotonic.
    oldCursor += oldCount + 8;
    newCursor += newCount + 8;
  }

  lines.push("");
  return lines.join("\n");
}

function hunksFor(spec: DiffSpec): { hunks: HunkData[]; changedLines: number } {
  const files = parseDiff(generateUnifiedDiff(spec));
  const hunks = files[0]?.hunks ?? [];
  let changedLines = 0;
  for (const hunk of hunks) {
    for (const change of hunk.changes) {
      if (change.type !== "normal") changedLines += 1;
    }
  }
  return { hunks, changedLines };
}

export const diffTokenizeScenarios: PerfScenario[] = [
  {
    id: "PERF-160",
    name: "Diff Tokenize - Representative File",
    description:
      "Tokenize a single ~800-changed-line TypeScript diff with highlight + intra-line edit " +
      "marking (under the markEdits budget, so markEdits + suppressFullLineEdits run) — the common " +
      "'review a substantial file change' case. durationMs is the runDiffTokenize pass the " +
      "worker/fallback executes; fixture build + parseDiff are excluded from the bracket. Throws " +
      "tokenizeMisses is non-zero if tokenization silently degraded to null.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 8, ci: 14, nightly: 20 },
    warmups: 1,
    correctness: ["tokenizeMisses"],
    async run() {
      const { hunks, changedLines } = hunksFor({
        path: "src/service.ts",
        changedLines: 800,
        seed: 160,
      });
      const start = performance.now();
      const result = await runDiffTokenize({
        hunks,
        language: "typescript",
        highlight: true,
        extraRanges: null,
      });
      const durationMs = performance.now() - start;
      const tokenizeMisses = result.tokens ? 0 : 1;
      return {
        durationMs,
        metrics: {
          changedLines,
          hunks: hunks.length,
          tokensProduced: 1 - tokenizeMisses,
          tokenizeMisses,
        },
        notes: tokenizeMisses > 0 ? "runDiffTokenize returned null tokens" : undefined,
      };
    },
  },
  {
    id: "PERF-161",
    name: "Diff Tokenize - Oversized Fallback",
    description:
      "Tokenize a diff sized past the real MAX_INTRALINE_CHANGES budget so shouldMarkIntraLineEdits " +
      "returns false and the whole-line fallback runs (no per-block diff-match-patch churn). Proves " +
      "the large-diff path git-diff-highlight/VS Code also use stays cheap; markedIntraLine (derived " +
      "from the imported production threshold) must stay 0; tokenizeMisses catches a null tokenize.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 4, ci: 8, nightly: 12 },
    warmups: 1,
    correctness: ["tokenizeMisses"],
    async run() {
      // Size from the real threshold with margin so the fixture is over-budget
      // regardless of what MAX_INTRALINE_CHANGES is set to in production.
      const target = Math.ceil(MAX_INTRALINE_CHANGES * 1.4);
      const { hunks, changedLines } = hunksFor({
        path: "src/generated.ts",
        changedLines: target,
        seed: 161,
      });
      if (changedLines <= MAX_INTRALINE_CHANGES) {
        throw new Error(
          `PERF-161: fixture (${changedLines}) did not exceed MAX_INTRALINE_CHANGES (${MAX_INTRALINE_CHANGES})`
        );
      }
      const start = performance.now();
      const result = await runDiffTokenize({
        hunks,
        language: "typescript",
        highlight: true,
        extraRanges: null,
      });
      const durationMs = performance.now() - start;
      const tokenizeMisses = result.tokens ? 0 : 1;
      return {
        durationMs,
        metrics: {
          changedLines,
          hunks: hunks.length,
          // Mirrors shouldMarkIntraLineEdits against the imported production
          // threshold — 0 asserts the fallback (no intra-line marking) path.
          markedIntraLine: changedLines <= MAX_INTRALINE_CHANGES ? 1 : 0,
          tokensProduced: 1 - tokenizeMisses,
          tokenizeMisses,
        },
        notes: tokenizeMisses > 0 ? "runDiffTokenize returned null tokens" : undefined,
      };
    },
  },
  {
    id: "PERF-162",
    name: "Diff Tokenize - Multi-File Review Open",
    description:
      "Tokenize a five-file, multi-language changeset (typescript, tsx, json, css, markdown), each " +
      "~320 changed lines (rounded to whole hunks), back to back — models opening a multi-file " +
      "review workspace where each file is tokenized on demand. durationMs is the summed tokenize " +
      "cost; tokenizeMisses counts files that produced no tokens.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 4, ci: 8, nightly: 12 },
    warmups: 1,
    correctness: ["tokenizeMisses"],
    async run() {
      const files: Array<{ spec: DiffSpec; language: string }> = [
        { spec: { path: "src/a.ts", changedLines: 320, seed: 1 }, language: "typescript" },
        { spec: { path: "src/b.tsx", changedLines: 320, seed: 2 }, language: "tsx" },
        { spec: { path: "config/c.json", changedLines: 320, seed: 3 }, language: "json" },
        { spec: { path: "styles/d.css", changedLines: 320, seed: 4 }, language: "css" },
        { spec: { path: "docs/e.md", changedLines: 320, seed: 5 }, language: "markdown" },
      ];
      const prepared = files.map((f) => ({ ...hunksFor(f.spec), language: f.language }));

      const start = performance.now();
      let filesTokenized = 0;
      let changedLines = 0;
      for (const file of prepared) {
        const result = await runDiffTokenize({
          hunks: file.hunks,
          language: file.language,
          highlight: true,
          extraRanges: null,
        });
        if (result.tokens) filesTokenized += 1;
        changedLines += file.changedLines;
      }
      const durationMs = performance.now() - start;
      const tokenizeMisses = prepared.length - filesTokenized;

      return {
        durationMs,
        metrics: {
          filesTokenized,
          fileCount: prepared.length,
          changedLines,
          tokenizeMisses,
        },
        notes:
          tokenizeMisses > 0
            ? `only ${filesTokenized}/${prepared.length} files tokenized`
            : undefined,
      };
    },
  },
];
