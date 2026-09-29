// @vitest-environment jsdom
/**
 * Per-keystroke cost of filtering the branch picker on a large repo. Types each
 * of `TYPED_QUERIES` one character at a time against 5k and 20k branches and
 * reports, as medians over repeated rounds:
 *
 * - util: `buildBranchRows` alone for every prefix (the search itself)
 * - hook: `setQuery` → committed `useBranchPicker` render, per keystroke
 *
 *   npx vitest run -c src/components/Worktree/__bench__/vitest.config.ts
 */
import { describe, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { buildBranchRows, toBranchOption } from "../branchPickerUtils";
import { useBranchPicker, type UseBranchPickerResult } from "../hooks/useBranchPicker";
import type { BranchWorktreeRef } from "../branchPickerUtils";
import type { BranchInfo } from "@shared/types";
import { TYPED_QUERIES, makeBranches } from "./branchFixture";

const SIZES = [5_000, 20_000];
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 7);
const WARMUP = 2;
const NO_WORKTREES: ReadonlyMap<string, BranchWorktreeRef> = new Map();
const RECENT = ["main"];

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

function prefixes(query: string): string[] {
  return Array.from({ length: query.length }, (_, i) => query.slice(0, i + 1));
}

function report(label: string, perRound: { total: number; worst: number }[], keystrokes: number) {
  const total = median(perRound.map((r) => r.total));
  const worst = median(perRound.map((r) => r.worst));
  // The suite's setup silences console; the bench writes straight to stdout.
  process.stdout.write(
    `${label.padEnd(18)} total ${total.toFixed(1).padStart(8)} ms  ` +
      `per-keystroke ${(total / keystrokes).toFixed(2).padStart(6)} ms  ` +
      `worst-keystroke ${worst.toFixed(2).padStart(6)} ms  (${keystrokes} keystrokes, median of ${ROUNDS})\n`
  );
}

describe("branch picker filter", () => {
  for (const size of SIZES) {
    it(`util ${size}`, () => {
      const options = makeBranches(size).map(toBranchOption);
      const keystrokes = TYPED_QUERIES.flatMap(prefixes);
      const rounds: { total: number; worst: number }[] = [];
      for (let r = 0; r < WARMUP + ROUNDS; r++) {
        let total = 0;
        let worst = 0;
        for (const query of keystrokes) {
          const t0 = performance.now();
          buildBranchRows(options, {
            query,
            recentBranchNames: RECENT,
            worktreeByBranch: NO_WORKTREES,
          });
          const dt = performance.now() - t0;
          total += dt;
          worst = Math.max(worst, dt);
        }
        if (r >= WARMUP) rounds.push({ total, worst });
      }
      report(`util ${size}`, rounds, keystrokes.length);
    });

    it(`hook ${size}`, () => {
      const branches: readonly BranchInfo[] = makeBranches(size);
      let latest: UseBranchPickerResult | null = null;
      // Recorded through a prop so the component never writes to outer bindings.
      const record = (picker: UseBranchPickerResult) => {
        latest = picker;
      };
      function Harness({ onRender }: { onRender: (picker: UseBranchPickerResult) => void }) {
        onRender(
          useBranchPicker({
            branches,
            selectedBranch: null,
            recentBranchNames: RECENT,
            worktreeByBranch: NO_WORKTREES,
            onSelect: () => {},
          })
        );
        return null;
      }
      render(<Harness onRender={record} />);
      const picker = () => latest!;
      act(() => picker().setOpen(true));

      const keystrokes = TYPED_QUERIES.flatMap(prefixes);
      const rounds: { total: number; worst: number }[] = [];
      for (let r = 0; r < WARMUP + ROUNDS; r++) {
        let total = 0;
        let worst = 0;
        for (const query of TYPED_QUERIES) {
          for (const prefix of prefixes(query)) {
            const t0 = performance.now();
            act(() => picker().setQuery(prefix));
            const dt = performance.now() - t0;
            total += dt;
            worst = Math.max(worst, dt);
          }
          act(() => picker().setQuery(""));
        }
        if (r >= WARMUP) rounds.push({ total, worst });
      }
      report(`hook ${size}`, rounds, keystrokes.length);
      cleanup();
    });
  }
});
