// Structural-signal classifier (#6668). Sits above the regex-based
// AgentPatternDetector tier and consumes per-frame snapshots of the headless
// terminal's bottom rows, captured at DEC mode 2026 frame-close events
// (\x1b[?2026l). Three classifiers run per frame:
//
//   1. Bottom-row invariant — frame-to-frame diff confined to the bottom rows
//      indicates a cosmetic redraw; suppresses idle→working escalation that
//      would otherwise fire on raw line rewrites.
//   2. Monotonic time-counter — strictly increasing "1s/2s/3s" / "1m" / "1h"
//      tokens on the bottom row plus a structurally identical non-numeric
//      prefix is a positive working confirmation independent of glyph cycling.
//   3. Per-cell codepoint cycle — a cell that revisits 2-20 distinct codepoints
//      across recent frames while its neighbors stay stable is a spinner.
//
// All classifier state is held internally and resets on `reset()`. Inputs are
// pure data (no xterm dependency); the analyzer is safe to unit-test without
// a real terminal.

export type StructuralSignal = "none" | "cosmetic-only" | "time-counter" | "spinner";

export interface FrameCell {
  // UTF32 codepoint of the cell's last codepoint (matches IBufferCell.getCode).
  // Allocation-free integer compare for the cycle ring buffer.
  code: number;
  // 0 (wide continuation), 1, or 2 — matches IBufferCell.getWidth.
  width: number;
}

export interface FrameSnapshot {
  // Captured at \x1b[?2026l (frame-close) time.
  capturedAt: number;
  // Total terminal rows at capture time. Used for resize invalidation.
  terminalRows: number;
  // Total terminal cols at capture time. Used for resize invalidation.
  terminalCols: number;
  // Bottom N rows, ordered top-to-bottom (so `rows[rows.length - 1]` is the
  // viewport bottom). Each inner array is exactly `terminalCols` cells long.
  rows: FrameCell[][];
  // Bottom-row text (already-translated string for the time-counter regex).
  // Avoids a second pass when the analyzer needs character-level data.
  bottomRowText: string;
  // The next row up — used by the cosmetic classifier to determine whether
  // changes are confined to the bottom row (vs. spreading further up).
  // Empty string when terminalRows < 2.
  secondToBottomText: string;
}

export interface StructuralSignalResult {
  signal: StructuralSignal;
  // 0..1 confidence — higher means more certain. Used by ActivityMonitor when
  // building state-change metadata for "pattern" trigger events.
  confidence: number;
}

interface CycleRingEntry {
  // Codepoint at this cell, captured `capturedAt` on this frame.
  code: number;
  capturedAt: number;
}

const TIME_COUNTER_REGEX = /\b(\d+)\s*([smh])\b/i;
// Bottom 3 rows are snapshotted; cosmetic-only classification is limited to
// cases where the LAST row is the only changing region. The cycle detector
// also scans the bottom 3 rows since some agents (Codex) put the spinner glyph
// one row up.
const RING_BUFFER_SIZE = 8;
const MIN_DISTINCT_VALUES_FOR_CYCLE = 2;
const MAX_DISTINCT_VALUES_FOR_CYCLE = 20;
const MIN_FRAMES_FOR_SPINNER = 3;
const MIN_CELL_INTERVAL_MS = 60;
const MAX_CELL_INTERVAL_MS = 250;
// Neighborhood radius checked for stability when validating spinner candidate.
const NEIGHBOR_RADIUS = 2;

export class SynchronizedFrameAnalyzer {
  private previousSnapshot: FrameSnapshot | null = null;

  // Time-counter history: prefix string + last seen integer + unit. Reset on
  // any structural change to the prefix or unit.
  private lastCounterPrefix: string | null = null;
  private lastCounterValue = 0;
  private lastCounterUnit = "";
  private counterStreak = 0;

  // Per-cell ring buffers keyed by viewport-bottom-relative `(rowOffset, col)`.
  // rowOffset 0 = bottom row, 1 = second-to-bottom, 2 = third-to-bottom.
  private cellRings = new Map<string, CycleRingEntry[]>();

  classify(snapshot: FrameSnapshot): StructuralSignalResult {
    if (
      this.previousSnapshot &&
      (this.previousSnapshot.terminalRows !== snapshot.terminalRows ||
        this.previousSnapshot.terminalCols !== snapshot.terminalCols)
    ) {
      // Resize invalidates all per-cell history. Keep the new snapshot but
      // skip classification this frame — there is no comparable prior state.
      this.cellRings.clear();
      this.lastCounterPrefix = null;
      this.lastCounterValue = 0;
      this.lastCounterUnit = "";
      this.counterStreak = 0;
      this.previousSnapshot = snapshot;
      return { signal: "none", confidence: 0 };
    }

    this.recordCellRings(snapshot);

    const counterResult = this.detectTimeCounter(snapshot);
    if (counterResult.signal !== "none") {
      this.previousSnapshot = snapshot;
      return counterResult;
    }

    const spinnerResult = this.detectSpinner(snapshot);
    if (spinnerResult.signal !== "none") {
      this.previousSnapshot = snapshot;
      return spinnerResult;
    }

    const cosmeticResult = this.detectCosmeticOnly(snapshot);
    this.previousSnapshot = snapshot;
    return cosmeticResult;
  }

  reset(): void {
    this.previousSnapshot = null;
    this.cellRings.clear();
    this.lastCounterPrefix = null;
    this.lastCounterValue = 0;
    this.lastCounterUnit = "";
    this.counterStreak = 0;
  }

  private detectTimeCounter(snapshot: FrameSnapshot): StructuralSignalResult {
    const match = TIME_COUNTER_REGEX.exec(snapshot.bottomRowText);
    if (!match) {
      this.lastCounterPrefix = null;
      this.lastCounterValue = 0;
      this.lastCounterUnit = "";
      this.counterStreak = 0;
      return { signal: "none", confidence: 0 };
    }

    const value = Number.parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    const prefix = snapshot.bottomRowText.slice(0, match.index).trim();

    if (
      this.lastCounterPrefix === prefix &&
      this.lastCounterUnit === unit &&
      value > this.lastCounterValue
    ) {
      this.lastCounterValue = value;
      this.counterStreak += 1;
      // Two consecutive increments confirm a live counter; one could be a
      // first observation of a static value followed by a second frame.
      if (this.counterStreak >= 2) {
        return { signal: "time-counter", confidence: 0.9 };
      }
      return { signal: "none", confidence: 0 };
    }

    this.lastCounterPrefix = prefix;
    this.lastCounterValue = value;
    this.lastCounterUnit = unit;
    this.counterStreak = 1;
    return { signal: "none", confidence: 0 };
  }

  private detectSpinner(snapshot: FrameSnapshot): StructuralSignalResult {
    if (snapshot.rows.length === 0) {
      return { signal: "none", confidence: 0 };
    }

    let bestConfidence = 0;
    let foundSpinner = false;

    for (let rowOffset = 0; rowOffset < snapshot.rows.length; rowOffset++) {
      const cols = snapshot.rows[snapshot.rows.length - 1 - rowOffset];
      if (!cols) continue;
      for (let col = 0; col < cols.length; col++) {
        const ring = this.cellRings.get(this.cellKey(rowOffset, col));
        if (!ring || ring.length < MIN_FRAMES_FOR_SPINNER) continue;

        const cycleStrength = evaluateCycleStrength(ring);
        if (cycleStrength === 0) continue;

        // Neighbor stability: cells within NEIGHBOR_RADIUS columns on the same
        // row should NOT also be cycling — that would indicate a pure
        // cosmetic redraw of the whole row, not a localized spinner glyph.
        if (!this.neighborsStable(rowOffset, col, cols.length)) continue;

        foundSpinner = true;
        if (cycleStrength > bestConfidence) {
          bestConfidence = cycleStrength;
        }
      }
    }

    if (foundSpinner) {
      return { signal: "spinner", confidence: bestConfidence };
    }
    return { signal: "none", confidence: 0 };
  }

  private detectCosmeticOnly(snapshot: FrameSnapshot): StructuralSignalResult {
    const prev = this.previousSnapshot;
    if (!prev) {
      return { signal: "none", confidence: 0 };
    }

    if (prev.rows.length === 0 || snapshot.rows.length === 0) {
      return { signal: "none", confidence: 0 };
    }

    const prevBottom = prev.rows[prev.rows.length - 1];
    const currBottom = snapshot.rows[snapshot.rows.length - 1];

    const bottomChanged = !cellRowsEqual(prevBottom, currBottom);
    if (!bottomChanged) {
      return { signal: "none", confidence: 0 };
    }

    // Any change in rows above the bottom disqualifies "cosmetic-only" —
    // genuine work scrolls or paints higher rows. Compare the rows pairwise
    // when both snapshots have the same number of captured rows.
    const minHigherRows = Math.min(prev.rows.length, snapshot.rows.length) - 1;
    for (let i = 0; i < minHigherRows; i++) {
      if (!cellRowsEqual(prev.rows[i], snapshot.rows[i])) {
        return { signal: "none", confidence: 0 };
      }
    }

    return { signal: "cosmetic-only", confidence: 0.8 };
  }

  private recordCellRings(snapshot: FrameSnapshot): void {
    for (let rowOffset = 0; rowOffset < snapshot.rows.length; rowOffset++) {
      const cols = snapshot.rows[snapshot.rows.length - 1 - rowOffset];
      if (!cols) continue;
      for (let col = 0; col < cols.length; col++) {
        const cell = cols[col];
        if (!cell) continue;
        if (cell.width === 0) continue;
        const key = this.cellKey(rowOffset, col);
        let ring = this.cellRings.get(key);
        if (!ring) {
          ring = [];
          this.cellRings.set(key, ring);
        }
        ring.push({ code: cell.code, capturedAt: snapshot.capturedAt });
        if (ring.length > RING_BUFFER_SIZE) {
          ring.shift();
        }
      }
    }
  }

  private neighborsStable(rowOffset: number, col: number, rowWidth: number): boolean {
    let cyclingNeighbors = 0;
    for (let dx = -NEIGHBOR_RADIUS; dx <= NEIGHBOR_RADIUS; dx++) {
      if (dx === 0) continue;
      const neighborCol = col + dx;
      if (neighborCol < 0 || neighborCol >= rowWidth) continue;
      const neighborRing = this.cellRings.get(this.cellKey(rowOffset, neighborCol));
      if (!neighborRing || neighborRing.length < MIN_FRAMES_FOR_SPINNER) continue;
      if (evaluateCycleStrength(neighborRing) > 0) {
        cyclingNeighbors += 1;
      }
    }
    // Allow at most 1 cycling neighbor (some spinner glyphs are 2 cells wide
    // for combining marks). More than that and it's likely a row-wide
    // cosmetic redraw.
    return cyclingNeighbors <= 1;
  }

  private cellKey(rowOffset: number, col: number): string {
    return `${rowOffset}:${col}`;
  }
}

function cellRowsEqual(a: FrameCell[] | undefined, b: FrameCell[] | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].code !== b[i].code) return false;
    if (a[i].width !== b[i].width) return false;
  }
  return true;
}

// Returns 0 when the ring is not a spinner candidate; otherwise 0..1 confidence.
function evaluateCycleStrength(ring: CycleRingEntry[]): number {
  if (ring.length < MIN_FRAMES_FOR_SPINNER) return 0;

  const distinctCodes = new Set<number>();
  for (const entry of ring) {
    distinctCodes.add(entry.code);
  }

  // A static cell (no rotation) is not a spinner. A cell hopping through too
  // many distinct codepoints (e.g. fast-scrolling text) isn't either.
  if (
    distinctCodes.size < MIN_DISTINCT_VALUES_FOR_CYCLE ||
    distinctCodes.size > MAX_DISTINCT_VALUES_FOR_CYCLE
  ) {
    return 0;
  }

  // Require revisitation: a real glyph cycle returns to previously-seen
  // codepoints (⠋→⠙→⠹→⠸→⠋), whereas a monotonically-incrementing counter
  // (0→1→2→3) would otherwise pass distinct-count + interval checks. Once
  // the ring is longer than the distinct-codepoint count, at least one
  // codepoint has been revisited.
  if (ring.length <= distinctCodes.size) return 0;

  // Inter-frame interval must fall in spinner range. Tolerate a single
  // out-of-range interval (e.g. user input pause or PTY backpressure) before
  // rejecting; exclude that outlier from the average so a slow chunk of
  // frames doesn't drag a real spinner past the upper bound.
  let totalIntervalInRange = 0;
  let inRangeCount = 0;
  let outOfRangeIntervals = 0;
  for (let i = 1; i < ring.length; i++) {
    const dt = ring[i].capturedAt - ring[i - 1].capturedAt;
    if (dt < MIN_CELL_INTERVAL_MS || dt > MAX_CELL_INTERVAL_MS) {
      outOfRangeIntervals += 1;
    } else {
      totalIntervalInRange += dt;
      inRangeCount += 1;
    }
  }
  if (outOfRangeIntervals > 1) return 0;
  if (inRangeCount === 0) return 0;
  const avgInterval = totalIntervalInRange / inRangeCount;
  if (avgInterval < MIN_CELL_INTERVAL_MS || avgInterval > MAX_CELL_INTERVAL_MS) {
    return 0;
  }

  // Confidence: more distinct values + consistent interval = higher confidence.
  const distinctScore = Math.min(distinctCodes.size / 4, 1);
  const intervalScore =
    1 -
    Math.abs(avgInterval - (MIN_CELL_INTERVAL_MS + MAX_CELL_INTERVAL_MS) / 2) /
      ((MAX_CELL_INTERVAL_MS - MIN_CELL_INTERVAL_MS) / 2);
  return Math.max(0.5, Math.min(1, 0.6 * distinctScore + 0.4 * intervalScore));
}
