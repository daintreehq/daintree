import { act } from "react";
import { createRoot } from "react-dom/client";
import { performance } from "node:perf_hooks";
import { DiffViewer } from "@/components/Worktree/DiffViewer";
import { runDiffTokenize, type DiffTokenizeResult } from "@/components/Worktree/diffTokenizer";
import { TooltipProvider } from "@/components/ui/tooltip";
import { diffTokenizeClient } from "@/services/DiffTokenizeService";

/**
 * What a giant diff hunk costs the diff table to MOUNT, one commit at a time.
 *
 * The renderer-side guard for #15677. The table is react-diff-view's, and it is
 * not windowed: every row it is handed becomes DOM in the commit that hands it
 * over. A single hunk of thousands of rows (an added file, the full-file merge)
 * used to arrive in one commit, and its token pass in a second; the viewer now
 * stages both a bounded batch per frame. This mounts the real `DiffViewer`,
 * real react-diff-view and real refractor tokens under jsdom and counts the
 * rows each commit added.
 *
 * What that buys and what it does not:
 *
 *   - REAL components and real React 19 reconciliation. Rows are counted as
 *     `tr.diff-line` elements that exist, highlighted rows as rows whose code
 *     cell holds a token span — never as a range the viewer reported.
 *   - NO compositor, no paint and no Chromium layout, which is where most of
 *     the original stall was (#15677 measured it in Electron's Chromium). These
 *     are JS-thread commit costs, not frames; the timings are a regression
 *     guard, not evidence that a frame got shorter.
 *   - Frames are driven by hand (a queued `requestAnimationFrame`) and the
 *     token pass is computed up front by the real tokenizer, then delivered on
 *     cue, so the plain mount and the token pass are observed separately. The
 *     worker's compute and transport are excluded on purpose: PERF-160..164
 *     own them.
 *
 * Every predicate is stated against `SLICE_ROW_CEILING`, an independent
 * structural bound well above the viewer's own batch: the benchmark must not
 * pass a table merely because it agrees with whatever batch the code ships.
 */

/** Most rows one commit may add, or newly highlight, for the table to count as staged. */
export const SLICE_ROW_CEILING = 1000;

/** The issue's fixture size: a 5,000-row single hunk, under the 256 KiB soft-collapse gate. */
export const BENCH_LINES = 5000;

/** ~33 bytes a line, about the density of ordinary source, and every line highlights. */
function sourceLine(i: number): string {
  return `export const item${i} = make(${i});`;
}

export interface DiffTableFixture {
  diff: string;
  source?: string;
  fullFile?: boolean;
  /** Rows the split table must end with, counted from how the fixture was built. */
  expectedRows: number;
}

/** A newly added file: one hunk, one row per line. */
export function buildAddedFileFixture(lines: number): DiffTableFixture {
  const body: string[] = [];
  for (let i = 1; i <= lines; i++) body.push(`+${sourceLine(i)}`);
  return {
    diff: [
      "diff --git a/src/fixture/added.ts b/src/fixture/added.ts",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/src/fixture/added.ts",
      `@@ -0,0 +1,${lines} @@`,
      ...body,
      "",
    ].join("\n"),
    expectedRows: lines,
  };
}

/**
 * A modified file viewed whole: five one-line replacements spread through it,
 * expanded by `fullFile` into a single merged hunk. Each replacement is a
 * delete immediately followed by its insert, which split view draws as one
 * row, so the table ends with exactly one row per line of the file.
 *
 * The merge currently renders the three leading context lines of every hunk
 * after the first as blank rows, with or without staging: the synthetic old
 * side the viewer rebuilds leaves lines inside hunks empty, and the expansion
 * takes those over the hunk's own. A pre-existing quirk of the full-file view,
 * not of this benchmark; it is why token completeness is counted over the
 * plain table's non-blank cells.
 */
export function buildFullFileFixture(lines: number): DiffTableFixture {
  const oldLines = Array.from({ length: lines }, (_, i) => sourceLine(i + 1));
  const newLines = oldLines.slice();
  const changedAt = [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => Math.floor(lines * f));
  for (const k of changedAt) newLines[k] = `export const item${k + 1} = make(${k + 1}, true);`;
  const out = [
    "diff --git a/src/fixture/full.ts b/src/fixture/full.ts",
    "index 1111111..2222222 100644",
    "--- a/src/fixture/full.ts",
    "+++ b/src/fixture/full.ts",
  ];
  for (const k of changedAt) {
    const from = k - 3;
    out.push(`@@ -${from + 1},7 +${from + 1},7 @@`);
    for (let j = from; j < k; j++) out.push(` ${oldLines[j]}`);
    out.push(`-${oldLines[k]}`, `+${newLines[k]}`);
    for (let j = k + 1; j <= k + 3; j++) out.push(` ${oldLines[j]}`);
  }
  out.push("");
  return {
    diff: out.join("\n"),
    source: `${newLines.join("\n")}\n`,
    fullFile: true,
    expectedRows: lines,
  };
}

export interface DiffTableSample {
  /** Rows the fixture should end with. Proves the workload was delivered. */
  expectedRows: number;
  /** Rows in the DOM after the first commit. The point of the exercise. */
  initialMountedRows: number;
  /** The first commit, from `render` to a committed tree. */
  initialRenderMs: number;
  /** Most rows any later commit added. */
  maxSliceRows: number;
  /** Most rows any commit newly highlighted, the token pass's delivery included. */
  maxSliceTokenizedRows: number;
  /** The slowest single commit after the first. */
  maxSliceMs: number;
  /** Commits after the first: frames run plus the token delivery. */
  slices: number;
  finalRows: number;
  /**
   * Code cells with text in them, counted on the plain table before the token
   * pass is delivered, so a pass that erased text cannot lower its own bar. A
   * blank line has nothing to tokenize, and the full-file merge renders some
   * (see `buildFullFileFixture`), so completeness is stated per cell against
   * this rather than per row against the fixture.
   */
  highlightableCells: number;
  /** Code cells holding a token span once everything has landed. */
  finalTokenizedCells: number;
  /** Code cells whose text differs from the plain table's: tokens must never change the code. */
  textMismatches: number;
  /** Every timed commit summed: the JS cost of getting the whole table on screen. */
  completeMs: number;
  /** Token requests the viewer made. One pass per open, however many slices. */
  tokenRequests: number;
  /** Nonzero when a commit exceeded the ceiling, nothing rendered, or rows went missing. */
  stagingMisses: number;
  /** Nonzero when the pass missed a cell with code in it, or changed any cell's text. */
  tokenMisses: number;
}

function rowCount(root: HTMLElement): number {
  return root.querySelectorAll("tr.diff-line").length;
}

function tokenizedRowCount(root: HTMLElement): number {
  let count = 0;
  for (const row of root.querySelectorAll("tr.diff-line")) {
    if (row.querySelector("td.diff-code span")) count++;
  }
  return count;
}

function codeCells(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("tr.diff-line > td.diff-code"));
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Every miss this instrument can detect, in one place. A table that rendered
 * nothing, one that mounted or highlighted past the ceiling in a single commit,
 * and one that finished short of the fixture all fail; a fast reading is
 * worthless if the table it timed was incomplete.
 */
export function scoreStaging(sample: Omit<DiffTableSample, "stagingMisses" | "tokenMisses">): {
  stagingMisses: number;
  tokenMisses: number;
} {
  let stagingMisses = 0;
  if (sample.initialMountedRows === 0) stagingMisses++;
  if (sample.initialMountedRows > SLICE_ROW_CEILING) stagingMisses++;
  if (sample.maxSliceRows > SLICE_ROW_CEILING) stagingMisses++;
  if (sample.maxSliceTokenizedRows > SLICE_ROW_CEILING) stagingMisses++;
  if (sample.finalRows !== sample.expectedRows) stagingMisses++;
  let tokenMisses = 0;
  if (sample.highlightableCells === 0) tokenMisses++;
  if (sample.finalTokenizedCells !== sample.highlightableCells) tokenMisses++;
  if (sample.textMismatches > 0) tokenMisses++;
  return { stagingMisses, tokenMisses };
}

export interface MeasureOptions {
  /**
   * Withhold the token pass. A negative control for `tokenMisses`: the table
   * renders every row correctly and plain, which only the token predicate can
   * tell apart from a healthy run.
   */
  withholdTokens?: boolean;
}

/**
 * Mount the fixture, run frames until nothing is scheduled, deliver the token
 * pass, then run frames again until nothing is scheduled.
 */
export async function measureDiffTable(
  fixture: DiffTableFixture,
  { withholdTokens = false }: MeasureOptions = {}
): Promise<DiffTableSample> {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, cb);
    return id;
  };
  globalThis.cancelAnimationFrame = (id: number) => {
    frames.delete(id);
  };

  const held: (() => void)[] = [];
  const failures: unknown[] = [];
  let computing = 0;
  let tokenRequests = 0;
  // An own property shadowing the prototype method; deleting it restores the client.
  diffTokenizeClient.tokenize = (_key, request) =>
    new Promise<DiffTokenizeResult | null>((resolve) => {
      tokenRequests++;
      computing++;
      runDiffTokenize(request).then(
        (result) => {
          computing--;
          held.push(() => resolve(result));
        },
        (error: unknown) => {
          computing--;
          failures.push(error);
        }
      );
    });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    const renderStart = performance.now();
    act(() => {
      root.render(
        <TooltipProvider>
          <DiffViewer
            diff={fixture.diff}
            source={fixture.source}
            fullFile={fixture.fullFile}
            viewType="split"
          />
        </TooltipProvider>
      );
    });
    const initialRenderMs = performance.now() - renderStart;
    const initialMountedRows = rowCount(container);

    let maxSliceRows = 0;
    let maxSliceTokenizedRows = 0;
    let maxSliceMs = 0;
    let completeMs = initialRenderMs;
    let slices = 0;
    let rows = initialMountedRows;
    let tokenized = tokenizedRowCount(container);
    const recordSlice = (ms: number) => {
      const nowRows = rowCount(container);
      const nowTokenized = tokenizedRowCount(container);
      maxSliceRows = Math.max(maxSliceRows, nowRows - rows);
      maxSliceTokenizedRows = Math.max(maxSliceTokenizedRows, nowTokenized - tokenized);
      maxSliceMs = Math.max(maxSliceMs, ms);
      completeMs += ms;
      slices++;
      rows = nowRows;
      tokenized = nowTokenized;
    };
    const runFrames = () => {
      for (let guard = 0; frames.size > 0 && guard < 10_000; guard++) {
        const queued = [...frames.values()];
        frames.clear();
        const start = performance.now();
        act(() => {
          for (const cb of queued) cb(performance.now());
        });
        recordSlice(performance.now() - start);
      }
    };

    runFrames();

    // The plain table is the reference the token pass is judged against: its
    // text is the code, and its non-blank cells are the ones to highlight.
    const plainText = codeCells(container).map((cell) => cell.textContent ?? "");
    const highlightableCells = plainText.filter((text) => text.trim() !== "").length;

    if (!withholdTokens) {
      // The tokenizer runs untimed: the grammar load and the walk are the
      // worker's cost, not the table's.
      await act(async () => {
        for (let guard = 0; (computing > 0 || held.length === 0) && guard < 2_000; guard++) {
          if (failures.length > 0) break;
          await settle();
        }
      });
      if (failures.length > 0) throw failures[0];
      if (held.length === 0) throw new Error("the tokenizer never produced a pass");
      const deliverStart = performance.now();
      await act(async () => {
        for (const release of held.splice(0)) release();
      });
      recordSlice(performance.now() - deliverStart);

      runFrames();
    }

    const finalCells = codeCells(container);
    let textMismatches = Math.abs(finalCells.length - plainText.length);
    finalCells.forEach((cell, i) => {
      if ((cell.textContent ?? "") !== plainText[i]) textMismatches++;
    });

    const partial = {
      expectedRows: fixture.expectedRows,
      initialMountedRows,
      initialRenderMs,
      maxSliceRows,
      maxSliceTokenizedRows,
      maxSliceMs,
      slices,
      finalRows: rowCount(container),
      highlightableCells,
      finalTokenizedCells: finalCells.filter((cell) => cell.querySelector("span") !== null).length,
      textMismatches,
      completeMs,
      tokenRequests,
    };
    return { ...partial, ...scoreStaging(partial) };
  } finally {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(diffTokenizeClient, "tokenize");
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancel;
  }
}

/** Flattens a sample under a prefix, for the scenario's metrics record. */
export function toMetrics(prefix: string, sample: DiffTableSample): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(sample)) {
    out[`${prefix}${key[0]!.toUpperCase()}${key.slice(1)}`] = value;
  }
  return out;
}
