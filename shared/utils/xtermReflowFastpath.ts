/**
 * Runtime fast paths for xterm's buffer-core hot loops, applied to a
 * Terminal instance's BufferLine prototype at creation time.
 *
 * `terminal.resize()` re-wraps the entire retained scrollback in one
 * synchronous main-thread task (PERF-110..112 guard this cost). Profiling
 * shows the time concentrates in two layers, both patched here. BufferLine
 * leaf methods copy or scan cells one at a time through JS loops
 * (`copyCellsFrom`, `resize` — including one typed-array view allocation
 * per line per width change, `replaceCells`, `getTrimmedLength`); the
 * replacements use bulk TypedArray moves, capacity-stable views (see
 * makeResize), and single-read scans. The Buffer reflow drivers (`resize`,
 * `_reflowLarger`'s scan, `_reflowSmaller`) iterate 100k+ lines through
 * `CircularList.get`; the ports hoist ring access (see snapshotRing) and
 * are otherwise verbatim, including marker events and viewport bookkeeping.
 * Every fast path falls back to the ORIGINAL method whenever a precondition
 * fails — combined chars or extended attrs present (sparse maps non-empty),
 * protect semantics requested, out-of-bounds ranges, or shape drift in a
 * future xterm version. Both `@xterm/xterm` (renderer) and
 * `@xterm/headless` (pty-host mirrors, parse authority, perf harness) share
 * this buffer core, so every process benefits.
 *
 * Reaching into `_core` privates follows the existing precedent
 * (`getXtermCellDimensions`, `readXtermRenderPaused`); versions are pinned
 * exactly in package.json and the equivalence suite
 * (`shared/utils/__tests__/xtermReflowFastpath.test.ts`) drives patched and
 * unpatched terminals through identical adversarial content and resize
 * sequences, so semantic drift on an xterm bump fails tests before it can
 * ship. Set DAINTREE_DISABLE_XTERM_REFLOW_FASTPATH=1 to disable (node-side
 * processes and the perf harness; also the A/B lever for benchmarks).
 */

type SparseMap = Record<number, unknown>;

interface BufferLineLike {
  length: number;
  isWrapped: boolean;
  _data: Uint32Array;
  _combined: SparseMap;
  _extendedAttrs: SparseMap;
  _invalidateStringCache(): void;
  _copySparseMapsFrom(src: BufferLineLike): void;
  setCell(index: number, cell: unknown): void;
  setCellFromCodepoint(index: number, codePoint: number, width: number, attrs: unknown): void;
  getWidth(index: number): number;
  copyCellsFrom(
    src: BufferLineLike,
    srcCol: number,
    destCol: number,
    length: number,
    applyInReverse: boolean
  ): void;
  resize(cols: number, fillCellData: unknown): boolean;
  replaceCells(start: number, end: number, fillCellData: unknown, respectProtect?: boolean): void;
  getTrimmedLength(): number;
  cleanupMemory(): number;
  copyFrom(line: BufferLineLike): void;
}

interface FillCellLike {
  content: number;
  fg: number;
  bg: number;
}

// Mirrors of const-enum values inlined into the pinned 6.1.0-beta.288
// bundles (src/common/buffer/{BufferLine,Constants}.ts upstream). The
// equivalence suite catches drift on version bumps.
const CELL_SIZE = 3;
const CLEANUP_THRESHOLD = 2;
const CONTENT_IS_COMBINED_MASK = 0x200000;
const CONTENT_HAS_CONTENT_MASK = 0x3fffff;
const CONTENT_WIDTH_SHIFT = 22;
const BG_HAS_EXTENDED = 0x10000000;

const REQUIRED_METHODS = [
  "copyCellsFrom",
  "resize",
  "replaceCells",
  "getTrimmedLength",
  "cleanupMemory",
  "copyFrom",
  "setCell",
  "setCellFromCodepoint",
  "getWidth",
  "_invalidateStringCache",
  "_copySparseMapsFrom",
] as const;

function isEmptySparse(map: SparseMap | undefined | null): boolean {
  if (typeof map !== "object" || map === null) return false;
  for (const key in map) {
    void key;
    return false;
  }
  return true;
}

function makeCopyCellsFrom(original: BufferLineLike["copyCellsFrom"]) {
  return function copyCellsFromFast(
    this: BufferLineLike,
    src: BufferLineLike,
    srcCol: number,
    destCol: number,
    length: number,
    applyInReverse: boolean
  ): void {
    const srcData = src?._data;
    const destData = this._data;
    const srcStart = srcCol * CELL_SIZE;
    const srcEnd = (srcCol + length) * CELL_SIZE;
    if (
      !(srcData instanceof Uint32Array) ||
      !(destData instanceof Uint32Array) ||
      srcCol < 0 ||
      destCol < 0 ||
      srcEnd > srcData.length ||
      destCol * CELL_SIZE + (srcEnd - srcStart) > destData.length ||
      !isEmptySparse(src._combined) ||
      !isEmptySparse(src._extendedAttrs)
    ) {
      original.call(this, src, srcCol, destCol, length, applyInReverse);
      return;
    }
    this._invalidateStringCache();
    const span = srcEnd - srcStart;
    if (srcData === destData) {
      destData.copyWithin(destCol * CELL_SIZE, srcStart, srcEnd);
    } else if (span <= 96) {
      // Reflow copies are mostly sub-line fragments; a manual element loop
      // beats the subarray-view allocation `set()` needs at this size.
      const destOffset = destCol * CELL_SIZE;
      for (let i = 0; i < span; i += 1) {
        destData[destOffset + i] = srcData[srcStart + i] ?? 0;
      }
    } else {
      destData.set(srcData.subarray(srcStart, srcEnd), destCol * CELL_SIZE);
    }
  };
}

/**
 * Capacity-stable width change. The original keeps `_data.length ===
 * length * CELL_SIZE` by allocating a fresh view (subarray on shrink, new
 * view/array on grow) for EVERY line on EVERY width change — 100k view
 * allocations per resize on a deep buffer, the single largest remaining
 * reflow cost. The fast path relaxes the invariant to `_data.length >=
 * length * CELL_SIZE` (the view may keep slack capacity; `length` is the
 * logical width): shrink just drops `length`, grow fills the new cells in
 * place when the view already has room. Every other BufferLine consumer
 * reads cells bounded by `length`/cols (audited across @xterm/xterm,
 * @xterm/headless, and addon bundles); the three methods that interpret the
 * VIEW length semantically — resize, cleanupMemory, copyFrom — are all
 * patched here to use the logical width, and the originals remain safe on
 * slack-carrying lines (they just normalize the view back to exact size).
 */
function makeResize(original: BufferLineLike["resize"]) {
  return function resizeFast(this: BufferLineLike, cols: number, fillCellData: unknown): boolean {
    const fill = fillCellData as FillCellLike | undefined;
    if (
      cols <= 0 ||
      !(this._data instanceof Uint32Array) ||
      typeof fill?.content !== "number" ||
      (fill.content & CONTENT_IS_COMBINED_MASK) !== 0 ||
      (fill.bg & BG_HAS_EXTENDED) !== 0 ||
      !isEmptySparse(this._combined) ||
      !isEmptySparse(this._extendedAttrs)
    ) {
      return original.call(this, cols, fillCellData);
    }
    this._invalidateStringCache();
    const uint32Cells = cols * CELL_SIZE;
    if (cols > this.length) {
      let data = this._data;
      if (data.length < uint32Cells) {
        const capacityCells = Math.floor(data.buffer.byteLength / 4);
        if (capacityCells >= uint32Cells && data.byteOffset === 0) {
          // One view at full buffer capacity; later grows within capacity
          // become fill-only.
          data = new Uint32Array(data.buffer, 0, capacityCells);
        } else {
          const grown = new Uint32Array(uint32Cells);
          grown.set(data);
          data = grown;
        }
        this._data = data;
      }
      const { content, fg, bg } = fill;
      for (let cell = this.length * CELL_SIZE; cell < uint32Cells; cell += CELL_SIZE) {
        data[cell] = content;
        data[cell + 1] = fg;
        data[cell + 2] = bg;
      }
    }
    this.length = cols;
    return uint32Cells * 4 * CLEANUP_THRESHOLD < this._data.buffer.byteLength;
  };
}

function makeCleanupMemory(original: BufferLineLike["cleanupMemory"]) {
  return function cleanupMemoryFast(this: BufferLineLike): number {
    if (!(this._data instanceof Uint32Array)) {
      return original.call(this);
    }
    // Logical width, not view length — a slack-carrying view must still be
    // reclaimable (with the original formula a full-capacity view never
    // measures as oversized). Identical to the original under the exact-view
    // invariant, where view length === logical cells.
    const logicalCells = this.length * CELL_SIZE;
    if (logicalCells * 4 * CLEANUP_THRESHOLD < this._data.buffer.byteLength) {
      const data = new Uint32Array(logicalCells);
      data.set(this._data.subarray(0, logicalCells));
      this._data = data;
      return 1;
    }
    return 0;
  };
}

function makeCopyFrom(original: BufferLineLike["copyFrom"]) {
  return function copyFromFast(this: BufferLineLike, line: BufferLineLike): void {
    const src = line?._data;
    if (!(src instanceof Uint32Array) || !(this._data instanceof Uint32Array)) {
      original.call(this, line);
      return;
    }
    this._invalidateStringCache();
    const needed = line.length * CELL_SIZE;
    if (this._data.length === src.length) {
      this._data.set(src);
    } else if (this._data.length >= needed && src.length >= needed) {
      this._data.set(src.subarray(0, needed));
    } else {
      this._data = new Uint32Array(src);
    }
    this.length = line.length;
    if (isEmptySparse(line._combined) && isEmptySparse(line._extendedAttrs)) {
      // _copySparseMapsFrom resets both maps then scans every cell's flags;
      // with empty source maps the scan can never transfer anything.
      this._combined = {};
      this._extendedAttrs = {};
    } else {
      this._copySparseMapsFrom(line);
    }
    this.isWrapped = line.isWrapped;
  };
}

function makeReplaceCells(original: BufferLineLike["replaceCells"]) {
  return function replaceCellsFast(
    this: BufferLineLike,
    start: number,
    end: number,
    fillCellData: unknown,
    respectProtect?: boolean
  ): void {
    const fill = fillCellData as FillCellLike | undefined;
    if (
      respectProtect === true ||
      typeof fill?.content !== "number" ||
      typeof fill.fg !== "number" ||
      typeof fill.bg !== "number" ||
      (fill.content & CONTENT_IS_COMBINED_MASK) !== 0 ||
      (fill.bg & BG_HAS_EXTENDED) !== 0 ||
      start < 0 ||
      !(this._data instanceof Uint32Array) ||
      !isEmptySparse(this._combined) ||
      !isEmptySparse(this._extendedAttrs)
    ) {
      original.call(this, start, end, fillCellData, respectProtect);
      return;
    }
    this._invalidateStringCache();
    if (start && this.getWidth(start - 1) === 2) {
      this.setCellFromCodepoint(start - 1, 0, 1, fillCellData);
    }
    if (end < this.length && this.getWidth(end - 1) === 2) {
      this.setCellFromCodepoint(end, 0, 1, fillCellData);
    }
    const data = this._data;
    const limit = Math.min(end, this.length);
    const { content, fg, bg } = fill;
    for (let i = start; i < limit; i += 1) {
      const cell = i * CELL_SIZE;
      data[cell] = content;
      data[cell + 1] = fg;
      data[cell + 2] = bg;
    }
  };
}

function getTrimmedLengthFast(this: BufferLineLike): number {
  const data = this._data;
  for (let i = this.length - 1; i >= 0; i -= 1) {
    const content = data[i * CELL_SIZE] ?? 0;
    if ((content & CONTENT_HAS_CONTENT_MASK) !== 0) {
      return i + (content >> CONTENT_WIDTH_SHIFT);
    }
  }
  return 0;
}

interface EmitterLike<T> {
  fire(event: T): void;
}

interface CircularListLike {
  length: number;
  maxLength: number;
  _array: (BufferLineLike | undefined)[];
  _startIndex: number;
  onDeleteEmitter: EmitterLike<{ index: number; amount: number }>;
  onInsertEmitter: EmitterLike<{ index: number; amount: number }>;
  onTrimEmitter: EmitterLike<number>;
  get(index: number): BufferLineLike | undefined;
  set(index: number, value: BufferLineLike | undefined): void;
  push(value: BufferLineLike): void;
  pop(): BufferLineLike | undefined;
  trimStart(count: number): void;
}

interface BufferLike {
  lines: CircularListLike;
  ydisp: number;
  ybase: number;
  y: number;
  x: number;
  savedX: number;
  savedY: number;
  scrollTop: number;
  scrollBottom: number;
  _cols: number;
  _rows: number;
  _stringCache: { clear(): void };
  _optionsService: {
    rawOptions: {
      windowsPty?: { backend?: unknown; buildNumber?: unknown };
      reflowCursorLine?: boolean;
    };
  };
  _memoryCleanupQueue: { clear(): void; enqueue(task: () => boolean): void };
  _memoryCleanupPosition: number;
  _isReflowEnabled: boolean;
  getNullCell(attr?: unknown): FillCellLike;
  getBlankLine(attr: unknown, isWrapped?: boolean): BufferLineLike;
  _getCorrectBufferLength(rows: number): number;
  _batchedMemoryCleanup(): boolean;
  _reflow(newCols: number, newRows: number): void;
  _reflowLargerAdjustViewport(newCols: number, newRows: number, countRemoved: number): void;
  resize(newCols: number, newRows: number): void;
  _reflowLarger(newCols: number, newRows: number): void;
  _reflowSmaller(newCols: number, newRows: number): void;
}

type BufferLineCtor = new (
  stringCache: unknown,
  cols: number,
  fillCellData: unknown,
  isWrapped: boolean
) => BufferLineLike;

const lineCtorByBufferProto = new WeakMap<object, BufferLineCtor>();

interface RingSnapshot {
  arr: (BufferLineLike | undefined)[];
  start: number;
  max: number;
}

/**
 * The reflow drivers iterate 100k+ lines through `CircularList.get()` — a
 * function call plus modulo per line. Snapshotting the ring (backing array,
 * normalized start, capacity) turns each access into one add and at most one
 * subtract. Snapshots are only valid while no operation moves `_startIndex`
 * or swaps `_array` (push-at-capacity, trimStart, maxLength changes) — every
 * hoisted loop below re-snapshots after any such mutation.
 */
function snapshotRing(lines: CircularListLike): RingSnapshot {
  const max = lines.maxLength;
  const raw = lines._startIndex % max;
  return { arr: lines._array, start: raw < 0 ? raw + max : raw, max };
}

function ringLine(snap: RingSnapshot, index: number): BufferLineLike | undefined {
  let physical = snap.start + index;
  if (physical >= snap.max) physical -= snap.max;
  return snap.arr[physical];
}

function ringSet(snap: RingSnapshot, index: number, value: BufferLineLike | undefined): void {
  let physical = snap.start + index;
  if (physical >= snap.max) physical -= snap.max;
  snap.arr[physical] = value;
}

/** Port of BufferReflow's getWrappedLineTrimmedLength with direct cell reads. */
function wrappedRowTrimmedLength(rows: BufferLineLike[], i: number, cols: number): number {
  const row = rows[i];
  if (!row) return 0;
  if (i === rows.length - 1) {
    return row.getTrimmedLength();
  }
  const content = row._data[(cols - 1) * CELL_SIZE] ?? 0;
  const endsInNull =
    (content & CONTENT_HAS_CONTENT_MASK) === 0 && content >> CONTENT_WIDTH_SHIFT === 1;
  const nextContent = rows[i + 1]?._data[0] ?? 0;
  if (endsInNull && nextContent >> CONTENT_WIDTH_SHIFT === 2) {
    return cols - 1;
  }
  return cols;
}

/** Port of reflowSmallerGetNewLineLengths (BufferReflow.ts), same math. */
function smallerNewLineLengths(
  wrappedLines: BufferLineLike[],
  oldCols: number,
  newCols: number
): number[] {
  const newLineLengths: number[] = [];
  let cellsNeeded = 0;
  for (let i = 0; i < wrappedLines.length; i += 1) {
    cellsNeeded += wrappedRowTrimmedLength(wrappedLines, i, oldCols);
  }

  let srcCol = 0;
  let srcLine = 0;
  let cellsAvailable = 0;
  while (cellsAvailable < cellsNeeded) {
    if (cellsNeeded - cellsAvailable < newCols) {
      newLineLengths.push(cellsNeeded - cellsAvailable);
      break;
    }
    srcCol += newCols;
    const oldTrimmedLength = wrappedRowTrimmedLength(wrappedLines, srcLine, oldCols);
    if (srcCol > oldTrimmedLength) {
      srcCol -= oldTrimmedLength;
      srcLine += 1;
    }
    const endsWithWide =
      (wrappedLines[srcLine]?._data[(srcCol - 1) * CELL_SIZE] ?? 0) >> CONTENT_WIDTH_SHIFT === 2;
    if (endsWithWide) {
      srcCol -= 1;
    }
    const lineLength = endsWithWide ? newCols - 1 : newCols;
    newLineLengths.push(lineLength);
    cellsAvailable += lineLength;
  }

  return newLineLengths;
}

/**
 * Exact equivalent of `line.getTrimmedLength() > newCols` that never scans
 * below `newCols - 1`: any content at or above `newCols` decides via that
 * cell's own trimmed end (it is the last content cell — the scan runs from
 * the top); content exactly at `newCols - 1` overflows only when wide; and
 * content below that can reach at most `(newCols - 2) + 2 = newCols`, which
 * never overflows. Turns the dominant per-line check of a shrink reflow
 * from O(cols) into O(cols - newCols + 1) — O(1) for splitter-drag steps.
 */
function lineOverflowsWidth(line: BufferLineLike, newCols: number): boolean {
  const data = line._data;
  for (let i = line.length - 1; i >= newCols; i -= 1) {
    const content = data[i * CELL_SIZE] ?? 0;
    if ((content & CONTENT_HAS_CONTENT_MASK) !== 0) {
      return i + (content >> CONTENT_WIDTH_SHIFT) > newCols;
    }
  }
  if (newCols >= 1) {
    const content = data[(newCols - 1) * CELL_SIZE] ?? 0;
    if ((content & CONTENT_HAS_CONTENT_MASK) !== 0) {
      return newCols - 1 + (content >> CONTENT_WIDTH_SHIFT) > newCols;
    }
  }
  return false;
}

function bufferHasPatchableShape(buffer: BufferLike, nullCell: FillCellLike | undefined): boolean {
  return (
    typeof nullCell?.content === "number" &&
    typeof nullCell.fg === "number" &&
    typeof nullCell.bg === "number" &&
    (nullCell.content & CONTENT_IS_COMBINED_MASK) === 0 &&
    (nullCell.bg & BG_HAS_EXTENDED) === 0 &&
    Array.isArray(buffer.lines?._array) &&
    typeof buffer.lines._startIndex === "number" &&
    buffer.lines.maxLength > 0
  );
}

/**
 * Port of Buffer.resize with the two whole-buffer per-line loops hoisted:
 * ring access is direct and the per-line width change inlines the
 * empty-sparse-maps fast case instead of dispatching BufferLine.resize per
 * line. Everything else — row adjustment, maxLength trims, cursor clamps,
 * reflow dispatch, memory-cleanup scheduling — is verbatim.
 */
function makeBufferResize(original: BufferLike["resize"]) {
  return function bufferResizeFast(this: BufferLike, newCols: number, newRows: number): void {
    let nullCell: FillCellLike | undefined;
    try {
      nullCell = this.getNullCell();
    } catch {
      nullCell = undefined;
    }
    const lineCtor = lineCtorByBufferProto.get(Object.getPrototypeOf(this) as object);
    if (!nullCell || !lineCtor || !bufferHasPatchableShape(this, nullCell)) {
      original.call(this, newCols, newRows);
      return;
    }

    this._stringCache.clear();
    let dirtyMemoryLines = 0;

    const newMaxLength = this._getCorrectBufferLength(newRows);
    if (newMaxLength > this.lines.maxLength) {
      this.lines.maxLength = newMaxLength;
    }

    const fillContent = nullCell.content;
    const fillFg = nullCell.fg;
    const fillBg = nullCell.bg;

    if (this.lines.length > 0) {
      if (this._cols < newCols) {
        const newCells = newCols * CELL_SIZE;
        const snap = snapshotRing(this.lines);
        const count = this.lines.length;
        for (let i = 0; i < count; i += 1) {
          const line = ringLine(snap, i);
          if (!line) continue;
          if (
            line.length < newCols &&
            line._data instanceof Uint32Array &&
            isEmptySparse(line._combined) &&
            isEmptySparse(line._extendedAttrs)
          ) {
            // Capacity-stable grow (see makeResize): reuse the existing view
            // when it already spans the new width, fill only the new cells.
            line._invalidateStringCache();
            let data = line._data;
            if (data.length < newCells) {
              const capacityCells = Math.floor(data.buffer.byteLength / 4);
              if (capacityCells >= newCells && data.byteOffset === 0) {
                data = new Uint32Array(data.buffer, 0, capacityCells);
              } else {
                const grown = new Uint32Array(newCells);
                grown.set(data);
                data = grown;
              }
              line._data = data;
            }
            for (let cell = line.length * CELL_SIZE; cell < newCells; cell += CELL_SIZE) {
              data[cell] = fillContent;
              data[cell + 1] = fillFg;
              data[cell + 2] = fillBg;
            }
            line.length = newCols;
            dirtyMemoryLines += +(newCells * 4 * CLEANUP_THRESHOLD < data.buffer.byteLength);
          } else {
            dirtyMemoryLines += +line.resize(newCols, nullCell);
          }
        }
      }

      let addToY = 0;
      if (this._rows < newRows) {
        for (let y = this._rows; y < newRows; y += 1) {
          if (this.lines.length < newRows + this.ybase) {
            const windowsPty = this._optionsService.rawOptions.windowsPty;
            if (windowsPty?.backend !== undefined || windowsPty?.buildNumber !== undefined) {
              this.lines.push(new lineCtor(this._stringCache, newCols, nullCell, false));
            } else {
              if (this.ybase > 0 && this.lines.length <= this.ybase + this.y + addToY + 1) {
                this.ybase -= 1;
                addToY += 1;
                if (this.ydisp > 0) {
                  this.ydisp -= 1;
                }
              } else {
                this.lines.push(new lineCtor(this._stringCache, newCols, nullCell, false));
              }
            }
          }
        }
      } else {
        for (let y = this._rows; y > newRows; y -= 1) {
          if (this.lines.length > newRows + this.ybase) {
            if (this.lines.length > this.ybase + this.y + 1) {
              this.lines.pop();
            } else {
              this.ybase += 1;
              this.ydisp += 1;
            }
          }
        }
      }

      if (newMaxLength < this.lines.maxLength) {
        const amountToTrim = this.lines.length - newMaxLength;
        if (amountToTrim > 0) {
          this.lines.trimStart(amountToTrim);
          this.ybase = Math.max(this.ybase - amountToTrim, 0);
          this.ydisp = Math.max(this.ydisp - amountToTrim, 0);
          this.savedY = Math.max(this.savedY - amountToTrim, 0);
        }
        this.lines.maxLength = newMaxLength;
      }

      this.x = Math.min(this.x, newCols - 1);
      this.y = Math.min(this.y, newRows - 1);
      if (addToY) {
        this.y += addToY;
      }
      this.savedX = Math.min(this.savedX, newCols - 1);

      this.scrollTop = 0;
    }

    this.scrollBottom = newRows - 1;

    if (this._isReflowEnabled) {
      this._reflow(newCols, newRows);

      if (this._cols > newCols) {
        const newCells = newCols * CELL_SIZE;
        const snap = snapshotRing(this.lines);
        const count = this.lines.length;
        for (let i = 0; i < count; i += 1) {
          const line = ringLine(snap, i);
          if (!line) continue;
          if (
            line.length > newCols &&
            line._data instanceof Uint32Array &&
            isEmptySparse(line._combined) &&
            isEmptySparse(line._extendedAttrs)
          ) {
            // Capacity-stable shrink (see makeResize): the logical width
            // drops, the view keeps its slack for the next grow.
            line._invalidateStringCache();
            line.length = newCols;
            dirtyMemoryLines += +(newCells * 4 * CLEANUP_THRESHOLD < line._data.buffer.byteLength);
          } else {
            dirtyMemoryLines += +line.resize(newCols, nullCell);
          }
        }
      }
    }

    this._cols = newCols;
    this._rows = newRows;

    if (this.lines.length > 0) {
      const maxY = Math.max(0, this.lines.length - this.ybase - 1);
      this.y = Math.min(this.y, maxY);
    }

    this._memoryCleanupQueue.clear();
    if (dirtyMemoryLines > 0.1 * this.lines.length) {
      this._memoryCleanupPosition = 0;
      this._memoryCleanupQueue.enqueue(() => this._batchedMemoryCleanup());
    }
  };
}

/** Port of BufferReflow.reflowLargerGetLinesToRemove with hoisted ring access. */
function reflowLargerGetLinesToRemoveFast(
  lines: CircularListLike,
  oldCols: number,
  newCols: number,
  bufferAbsoluteY: number,
  nullCell: FillCellLike,
  reflowCursorLine: boolean
): number[] {
  const toRemove: number[] = [];
  const snap = snapshotRing(lines);
  const count = lines.length;

  for (let y = 0; y < count - 1; y += 1) {
    let i = y;
    let nextLine = ringLine(snap, (i += 1));
    if (!nextLine?.isWrapped) {
      continue;
    }

    const wrappedLines: BufferLineLike[] = [ringLine(snap, y)!];
    while (i < count && nextLine.isWrapped) {
      wrappedLines.push(nextLine);
      nextLine = ringLine(snap, (i += 1))!;
    }

    if (!reflowCursorLine) {
      if (bufferAbsoluteY >= y && bufferAbsoluteY < i) {
        y += wrappedLines.length - 1;
        continue;
      }
    }

    let destLineIndex = 0;
    let destCol = wrappedRowTrimmedLength(wrappedLines, destLineIndex, oldCols);
    let srcLineIndex = 1;
    let srcCol = 0;
    while (srcLineIndex < wrappedLines.length) {
      const srcTrimmedTineLength = wrappedRowTrimmedLength(wrappedLines, srcLineIndex, oldCols);
      const srcRemainingCells = srcTrimmedTineLength - srcCol;
      const destRemainingCells = newCols - destCol;
      const cellsToCopy = Math.min(srcRemainingCells, destRemainingCells);

      wrappedLines[destLineIndex]!.copyCellsFrom(
        wrappedLines[srcLineIndex]!,
        srcCol,
        destCol,
        cellsToCopy,
        false
      );

      destCol += cellsToCopy;
      if (destCol === newCols) {
        destLineIndex += 1;
        destCol = 0;
      }
      srcCol += cellsToCopy;
      if (srcCol === srcTrimmedTineLength) {
        srcLineIndex += 1;
        srcCol = 0;
      }

      if (destCol === 0 && destLineIndex !== 0) {
        if (wrappedLines[destLineIndex - 1]!.getWidth(newCols - 1) === 2) {
          wrappedLines[destLineIndex]!.copyCellsFrom(
            wrappedLines[destLineIndex - 1]!,
            newCols - 1,
            destCol,
            1,
            false
          );
          destCol += 1;
          wrappedLines[destLineIndex - 1]!.setCell(newCols - 1, nullCell);
        }
      }
    }

    wrappedLines[destLineIndex]!.replaceCells(destCol, newCols, nullCell);

    let countToRemove = 0;
    for (let j = wrappedLines.length - 1; j > 0; j -= 1) {
      if (j > destLineIndex || wrappedLines[j]!.getTrimmedLength() === 0) {
        countToRemove += 1;
      } else {
        break;
      }
    }

    if (countToRemove > 0) {
      toRemove.push(y + wrappedLines.length - countToRemove);
      toRemove.push(countToRemove);
    }

    y += wrappedLines.length - 1;
  }
  return toRemove;
}

/** Port of BufferReflow.reflowLargerCreateNewLayout (no per-line gets to hoist). */
function reflowLargerCreateNewLayoutFast(
  lines: CircularListLike,
  toRemove: number[]
): { layout: number[]; countRemoved: number } {
  const layout: number[] = [];
  let nextToRemoveIndex = 0;
  let nextToRemoveStart = toRemove[nextToRemoveIndex];
  let countRemovedSoFar = 0;
  const count = lines.length;
  for (let i = 0; i < count; i += 1) {
    if (nextToRemoveStart === i) {
      const countToRemove = toRemove[(nextToRemoveIndex += 1)] ?? 0;
      lines.onDeleteEmitter.fire({
        index: i - countRemovedSoFar,
        amount: countToRemove,
      });
      i += countToRemove - 1;
      countRemovedSoFar += countToRemove;
      nextToRemoveStart = toRemove[(nextToRemoveIndex += 1)];
    } else {
      layout.push(i);
    }
  }
  return { layout, countRemoved: countRemovedSoFar };
}

/** Port of BufferReflow.reflowLargerApplyNewLayout with hoisted ring access. */
function reflowLargerApplyNewLayoutFast(lines: CircularListLike, newLayout: number[]): void {
  const snap = snapshotRing(lines);
  const newLayoutLines: (BufferLineLike | undefined)[] = [];
  for (let i = 0; i < newLayout.length; i += 1) {
    newLayoutLines.push(ringLine(snap, newLayout[i] ?? 0));
  }

  for (let i = 0; i < newLayoutLines.length; i += 1) {
    ringSet(snap, i, newLayoutLines[i]);
  }
  lines.length = newLayout.length;
}

function makeReflowLarger(original: BufferLike["_reflowLarger"]) {
  return function reflowLargerFast(this: BufferLike, newCols: number, newRows: number): void {
    let nullCell: FillCellLike | undefined;
    try {
      nullCell = this.getNullCell();
    } catch {
      nullCell = undefined;
    }
    if (!nullCell || !bufferHasPatchableShape(this, nullCell)) {
      original.call(this, newCols, newRows);
      return;
    }
    const reflowCursorLine = this._optionsService.rawOptions.reflowCursorLine === true;
    const toRemove = reflowLargerGetLinesToRemoveFast(
      this.lines,
      this._cols,
      newCols,
      this.ybase + this.y,
      nullCell,
      reflowCursorLine
    );
    if (toRemove.length > 0) {
      const newLayoutResult = reflowLargerCreateNewLayoutFast(this.lines, toRemove);
      reflowLargerApplyNewLayoutFast(this.lines, newLayoutResult.layout);
      this._reflowLargerAdjustViewport(newCols, newRows, newLayoutResult.countRemoved);
    }
  };
}

/**
 * Port of Buffer._reflowSmaller with hoisted ring access. The wrapped-group
 * gather walks back to the group head with direct reads instead of repeated
 * `unshift`; the O(n) rearrange pass reads the original layout and writes the
 * new one through the snapshot. `lines.pop()` and the `length` setter only
 * touch `_length`/raw slots (never `_startIndex`/`_array` identity), so the
 * snapshots stay valid across them — the rearrange loop overwrites every
 * logical slot it reads, exactly like the original.
 */
function makeReflowSmaller(original: BufferLike["_reflowSmaller"]) {
  return function reflowSmallerFast(this: BufferLike, newCols: number, newRows: number): void {
    let nullCell: FillCellLike | undefined;
    try {
      nullCell = this.getNullCell();
    } catch {
      nullCell = undefined;
    }
    if (!nullCell || !bufferHasPatchableShape(this, nullCell)) {
      original.call(this, newCols, newRows);
      return;
    }
    const reflowCursorLine = this._optionsService.rawOptions.reflowCursorLine === true;
    const snap = snapshotRing(this.lines);

    const toInsert: { start: number; newLines: BufferLineLike[] }[] = [];
    let countToInsert = 0;
    for (let y = this.lines.length - 1; y >= 0; y -= 1) {
      let nextLine = ringLine(snap, y);
      if (!nextLine || (!nextLine.isWrapped && !lineOverflowsWidth(nextLine, newCols))) {
        continue;
      }

      const endY = y;
      while (nextLine.isWrapped && y > 0) {
        nextLine = ringLine(snap, (y -= 1))!;
      }
      const wrappedLines: BufferLineLike[] = [];
      for (let i = y; i <= endY; i += 1) {
        wrappedLines.push(ringLine(snap, i)!);
      }

      if (!reflowCursorLine) {
        const absoluteY = this.ybase + this.y;
        if (absoluteY >= y && absoluteY < y + wrappedLines.length) {
          continue;
        }
      }

      const lastLineLength = wrappedLines[wrappedLines.length - 1]!.getTrimmedLength();
      const destLineLengths = smallerNewLineLengths(wrappedLines, this._cols, newCols);
      const linesToAdd = destLineLengths.length - wrappedLines.length;
      let trimmedLines: number;
      if (this.ybase === 0 && this.y !== this.lines.length - 1) {
        trimmedLines = Math.max(0, this.y - this.lines.maxLength + linesToAdd);
      } else {
        trimmedLines = Math.max(0, this.lines.length - this.lines.maxLength + linesToAdd);
      }

      const newLines: BufferLineLike[] = [];
      for (let i = 0; i < linesToAdd; i += 1) {
        const newLine = this.getBlankLine(undefined, true);
        newLines.push(newLine);
      }
      if (newLines.length > 0) {
        toInsert.push({
          start: y + wrappedLines.length + countToInsert,
          newLines,
        });
        countToInsert += newLines.length;
      }
      for (const newLine of newLines) {
        wrappedLines.push(newLine);
      }

      let destLineIndex = destLineLengths.length - 1;
      let destCol = destLineLengths[destLineIndex] ?? 0;
      if (destCol === 0) {
        destLineIndex -= 1;
        destCol = destLineLengths[destLineIndex] ?? 0;
      }
      let srcLineIndex = wrappedLines.length - linesToAdd - 1;
      let srcCol = lastLineLength;
      while (srcLineIndex >= 0) {
        const cellsToCopy = Math.min(srcCol, destCol);
        if (wrappedLines[destLineIndex] === undefined) {
          break;
        }
        wrappedLines[destLineIndex]!.copyCellsFrom(
          wrappedLines[srcLineIndex]!,
          srcCol - cellsToCopy,
          destCol - cellsToCopy,
          cellsToCopy,
          true
        );
        destCol -= cellsToCopy;
        if (destCol === 0) {
          destLineIndex -= 1;
          destCol = destLineLengths[destLineIndex] ?? 0;
        }
        srcCol -= cellsToCopy;
        if (srcCol === 0) {
          srcLineIndex -= 1;
          const wrappedLinesIndex = Math.max(srcLineIndex, 0);
          srcCol = wrappedRowTrimmedLength(wrappedLines, wrappedLinesIndex, this._cols);
        }
      }

      for (let i = 0; i < wrappedLines.length; i += 1) {
        const destLength = destLineLengths[i];
        if (destLength !== undefined && destLength < newCols) {
          wrappedLines[i]!.setCell(destLength, nullCell);
        }
      }

      let viewportAdjustments = linesToAdd - trimmedLines;
      while (viewportAdjustments > 0) {
        viewportAdjustments -= 1;
        if (this.ybase === 0) {
          if (this.y < newRows - 1) {
            this.y += 1;
            this.lines.pop();
          } else {
            this.ybase += 1;
            this.ydisp += 1;
          }
        } else {
          if (
            this.ybase <
            Math.min(this.lines.maxLength, this.lines.length + countToInsert) - newRows
          ) {
            if (this.ybase === this.ydisp) {
              this.ydisp += 1;
            }
            this.ybase += 1;
          }
        }
      }
      this.savedY = Math.min(this.savedY + linesToAdd, this.ybase + newRows - 1);
    }

    if (toInsert.length > 0) {
      const insertEvents: { index: number; amount: number }[] = [];

      const originalLines: (BufferLineLike | undefined)[] = [];
      const preInsertSnap = snapshotRing(this.lines);
      const originalLinesLength = this.lines.length;
      for (let i = 0; i < originalLinesLength; i += 1) {
        originalLines.push(ringLine(preInsertSnap, i));
      }

      let originalLineIndex = originalLinesLength - 1;
      let nextToInsertIndex = 0;
      let nextToInsert = toInsert[nextToInsertIndex];
      this.lines.length = Math.min(this.lines.maxLength, this.lines.length + countToInsert);
      const writeSnap = snapshotRing(this.lines);
      let countInsertedSoFar = 0;
      for (
        let i = Math.min(this.lines.maxLength - 1, originalLinesLength + countToInsert - 1);
        i >= 0;
        i -= 1
      ) {
        if (nextToInsert && nextToInsert.start > originalLineIndex + countInsertedSoFar) {
          for (let nextI = nextToInsert.newLines.length - 1; nextI >= 0; nextI -= 1) {
            ringSet(writeSnap, i, nextToInsert.newLines[nextI]);
            i -= 1;
          }
          i += 1;

          insertEvents.push({
            index: originalLineIndex + 1,
            amount: nextToInsert.newLines.length,
          });

          countInsertedSoFar += nextToInsert.newLines.length;
          nextToInsert = toInsert[(nextToInsertIndex += 1)];
        } else {
          ringSet(writeSnap, i, originalLines[originalLineIndex]);
          originalLineIndex -= 1;
        }
      }

      let insertCountEmitted = 0;
      for (let i = insertEvents.length - 1; i >= 0; i -= 1) {
        const event = insertEvents[i]!;
        event.index += insertCountEmitted;
        this.lines.onInsertEmitter.fire(event);
        insertCountEmitted += event.amount;
      }
      const amountToTrim = Math.max(0, originalLinesLength + countToInsert - this.lines.maxLength);
      if (amountToTrim > 0) {
        this.lines.onTrimEmitter.fire(amountToTrim);
      }
    }
  };
}

interface TerminalCoreLike {
  _core?: {
    _bufferService?: {
      buffers?: {
        normal?: BufferLike & {
          lines?: {
            get?: (index: number) => BufferLineLike | undefined;
          };
        };
      };
    };
  };
}

const REQUIRED_BUFFER_METHODS = [
  "resize",
  "_reflow",
  "_reflowLarger",
  "_reflowSmaller",
  "_reflowLargerAdjustViewport",
  "getNullCell",
  "getBlankLine",
  "_getCorrectBufferLength",
  "_batchedMemoryCleanup",
] as const;

const patchedLinePrototypes = new WeakSet<object>();
const patchedBufferPrototypes = new WeakSet<object>();

function patchLinePrototype(line: BufferLineLike): boolean {
  const proto = Object.getPrototypeOf(line) as Record<string, unknown> | null;
  if (!proto || typeof proto !== "object") return false;
  if (patchedLinePrototypes.has(proto)) return true;

  if (!(line._data instanceof Uint32Array)) return false;
  if (typeof line.length !== "number" || line._data.length !== line.length * CELL_SIZE) {
    return false;
  }
  if (typeof line._combined !== "object" || line._combined === null) return false;
  if (typeof line._extendedAttrs !== "object" || line._extendedAttrs === null) return false;
  for (const method of REQUIRED_METHODS) {
    if (typeof proto[method] !== "function") return false;
  }

  const target = proto as unknown as BufferLineLike;
  proto.copyCellsFrom = makeCopyCellsFrom(target.copyCellsFrom);
  proto.resize = makeResize(target.resize);
  proto.replaceCells = makeReplaceCells(target.replaceCells);
  proto.getTrimmedLength = getTrimmedLengthFast;
  proto.cleanupMemory = makeCleanupMemory(target.cleanupMemory);
  proto.copyFrom = makeCopyFrom(target.copyFrom);
  patchedLinePrototypes.add(proto);
  return true;
}

function patchBufferPrototype(buffer: BufferLike, line: BufferLineLike): boolean {
  const proto = Object.getPrototypeOf(buffer) as Record<string, unknown> | null;
  if (!proto || typeof proto !== "object") return false;
  if (patchedBufferPrototypes.has(proto)) return true;

  for (const method of REQUIRED_BUFFER_METHODS) {
    if (typeof proto[method] !== "function") return false;
  }
  const isReflowEnabled = Object.getOwnPropertyDescriptor(proto, "_isReflowEnabled");
  if (typeof isReflowEnabled?.get !== "function") return false;
  if (!Array.isArray(buffer.lines?._array)) return false;
  if (typeof buffer.lines._startIndex !== "number") return false;
  if (typeof buffer._stringCache?.clear !== "function") return false;
  if (typeof buffer._optionsService?.rawOptions !== "object") return false;
  if (typeof buffer._memoryCleanupQueue?.clear !== "function") return false;
  if (typeof buffer._memoryCleanupQueue?.enqueue !== "function") return false;
  const lineCtor = line.constructor as BufferLineCtor | undefined;
  if (typeof lineCtor !== "function") return false;
  let nullCell: FillCellLike | undefined;
  try {
    nullCell = buffer.getNullCell();
  } catch {
    return false;
  }
  if (!bufferHasPatchableShape(buffer, nullCell)) return false;

  lineCtorByBufferProto.set(proto, lineCtor);
  const target = proto as unknown as BufferLike;
  proto.resize = makeBufferResize(target.resize);
  proto._reflowLarger = makeReflowLarger(target._reflowLarger);
  proto._reflowSmaller = makeReflowSmaller(target._reflowSmaller);
  patchedBufferPrototypes.add(proto);
  return true;
}

/**
 * Patches the BufferLine and Buffer prototypes reachable from `terminal`.
 * Idempotent per prototype (one call per process/bundle does the work; later
 * calls return true immediately). Each layer applies independently and every
 * fast path falls back to the original method at runtime; returns true only
 * when BOTH layers are active so the equivalence suite fails loudly if an
 * xterm bump drifts the shapes.
 */
export function applyXtermReflowFastpath(terminal: unknown): boolean {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
      ?.env;
    if (env?.DAINTREE_DISABLE_XTERM_REFLOW_FASTPATH === "1") {
      return false;
    }

    const buffer = (terminal as TerminalCoreLike)?._core?._bufferService?.buffers?.normal;
    const line = buffer?.lines?.get?.(0);
    if (!buffer || !line || typeof line !== "object") return false;

    const lineOk = patchLinePrototype(line);
    const bufferOk = lineOk && patchBufferPrototype(buffer, line);
    return lineOk && bufferOk;
  } catch {
    return false;
  }
}
