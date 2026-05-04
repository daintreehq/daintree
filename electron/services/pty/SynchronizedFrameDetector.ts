// Hooks the headless terminal's parser for DEC mode 2026 (Synchronized Output)
// brackets and emits a frame-close event with a snapshot of the bottom rows.
//
// `\x1b[?2026h` opens a frame; `\x1b[?2026l` closes it. The parser API
// (Terminal.parser.registerCsiHandler) handles fragmented CSI sequences
// correctly — node-pty can deliver `\x1b[?20` and `26h` in separate chunks,
// and naive raw-byte scanning would miss the split (#4899). Returning `false`
// from the handler lets xterm's built-in DEC handler run too, preserving
// `terminal.modes.synchronizedOutputMode` for any other consumer.
//
// A 1500ms timeout force-resets the nesting counter if a `?2026h` is not
// followed by a `?2026l` (e.g. agent crash mid-frame). Without this safety
// net the detector would silently stop firing frame events and the
// structural-signal tier would degrade to never-fire (#4974).
//
// Snapshots use `IBuffer.getNullCell()` as a reusable cell object to avoid
// allocating a fresh `IBufferCell` per cell per frame — at 100ms cadence and
// 200 columns × 3 rows that's ~6,000 cells/sec.

import type { Terminal as HeadlessTerminal, IDisposable, IBufferCell } from "@xterm/headless";
import type { FrameSnapshot, FrameCell } from "./SynchronizedFrameAnalyzer.js";

const MISSING_CLOSE_TIMEOUT_MS = 1500;
const SNAPSHOT_ROW_COUNT = 3;

export interface SynchronizedFrameDetectorOptions {
  // Number of bottom rows to capture per frame. Defaults to 3.
  snapshotRowCount?: number;
  // How long to wait for a `?2026l` before force-resetting the counter.
  // Defaults to 1500ms.
  missingCloseTimeoutMs?: number;
}

export class SynchronizedFrameDetector {
  private readonly disposables: IDisposable[] = [];
  private nestingDepth = 0;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private readonly snapshotRowCount: number;
  private readonly missingCloseTimeoutMs: number;
  private isDisposed = false;

  constructor(
    private readonly terminal: HeadlessTerminal,
    private readonly onFrameClose: (snapshot: FrameSnapshot) => void,
    options?: SynchronizedFrameDetectorOptions
  ) {
    this.snapshotRowCount = options?.snapshotRowCount ?? SNAPSHOT_ROW_COUNT;
    this.missingCloseTimeoutMs = options?.missingCloseTimeoutMs ?? MISSING_CLOSE_TIMEOUT_MS;

    const openHandler = terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) =>
      this.handleOpen(params)
    );
    const closeHandler = terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) =>
      this.handleClose(params)
    );
    this.disposables.push(openHandler, closeHandler);
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        // Disposable already torn down — ignore.
      }
    }
    this.disposables.length = 0;
    this.nestingDepth = 0;
  }

  // Test-only accessor — exposed for unit tests that need to verify the
  // counter state. Not part of the public contract.
  getNestingDepth(): number {
    return this.nestingDepth;
  }

  private handleOpen(params: (number | number[])[]): boolean {
    if (this.isDisposed) return false;
    if (!matchesParam(params, 2026)) return false;

    this.nestingDepth += 1;
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
    }
    this.timeoutHandle = setTimeout(() => {
      // Missing close — force-reset so the next legitimate open re-arms the
      // detector. Do NOT emit a frame on timeout: the snapshot would reflect
      // a half-rendered state.
      this.nestingDepth = 0;
      this.timeoutHandle = null;
    }, this.missingCloseTimeoutMs);
    return false;
  }

  private handleClose(params: (number | number[])[]): boolean {
    if (this.isDisposed) return false;
    if (!matchesParam(params, 2026)) return false;

    if (this.nestingDepth === 0) {
      // Stray close (likely the timeout already cleared the counter, or the
      // CLI emitted an unbalanced close on startup). Don't fire.
      return false;
    }
    this.nestingDepth -= 1;
    if (this.nestingDepth > 0) {
      // Inner close — the outermost frame hasn't committed yet.
      return false;
    }

    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }

    try {
      const snapshot = this.captureSnapshot();
      this.onFrameClose(snapshot);
    } catch (error) {
      if (process.env.DAINTREE_VERBOSE) {
        console.warn("[SynchronizedFrameDetector] Snapshot capture failed:", error);
      }
    }
    return false;
  }

  private captureSnapshot(): FrameSnapshot {
    const terminal = this.terminal;
    const buffer = terminal.buffer.active;
    const rowCount = Math.min(this.snapshotRowCount, terminal.rows);
    const viewportBottom = buffer.baseY + terminal.rows;
    const startY = viewportBottom - rowCount;

    const reusableCell: IBufferCell = buffer.getNullCell();
    const rows: FrameCell[][] = [];
    let bottomRowText = "";
    let secondToBottomText = "";

    for (let y = startY; y < viewportBottom; y++) {
      const line = buffer.getLine(y);
      if (!line) {
        rows.push(new Array<FrameCell>(terminal.cols).fill({ code: 0, width: 1 }));
        continue;
      }
      const cols: FrameCell[] = new Array(terminal.cols);
      for (let x = 0; x < terminal.cols; x++) {
        const cell = line.getCell(x, reusableCell);
        if (cell) {
          cols[x] = { code: cell.getCode(), width: cell.getWidth() };
        } else {
          cols[x] = { code: 0, width: 1 };
        }
      }
      rows.push(cols);
      if (y === viewportBottom - 1) {
        bottomRowText = line.translateToString(true);
      } else if (y === viewportBottom - 2) {
        secondToBottomText = line.translateToString(true);
      }
    }

    return {
      capturedAt: Date.now(),
      terminalRows: terminal.rows,
      terminalCols: terminal.cols,
      rows,
      bottomRowText,
      secondToBottomText,
    };
  }
}

function matchesParam(params: (number | number[])[], target: number): boolean {
  // xterm groups CSI params separated by `;` as flat entries (e.g.
  // `\x1b[?25;2026h` arrives as `params = [25, 2026]`). Scan all entries so
  // combined private-mode sequences still trigger the handler. Sub-param
  // arrays (colon-separated, e.g. `\x1b[?2026:1h`) are matched on the head.
  for (const param of params) {
    if (Array.isArray(param)) {
      if (param.length > 0 && param[0] === target) return true;
    } else if (param === target) {
      return true;
    }
  }
  return false;
}
