import type { IBufferCell, Terminal as HeadlessTerminal } from "@xterm/headless";
import {
  createVisibleContentSnapshot,
  isCollapsibleFillText,
  type VisibleContentSnapshot,
} from "../SustainedChangeTracker.js";

type CursorBufferLine = {
  translateToString: (trimRight?: boolean) => string;
  getCell?: (index: number, cell?: IBufferCell) => IBufferCell | undefined;
};

type CursorBuffer = {
  cursorY?: number;
  baseY: number;
  getNullCell?: () => IBufferCell;
  getLine: (index: number) => CursorBufferLine | undefined;
};

export function readLastNLines(terminal: HeadlessTerminal | undefined, n: number): string[] {
  if (!terminal) return [];

  const buffer = terminal.buffer.active;
  if (!buffer) return [];

  const viewportTop = buffer.baseY;
  const viewportBottom = buffer.baseY + terminal.rows;

  const lines: string[] = [];
  for (let i = viewportTop; i < viewportBottom; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (text.trim().length > 0) {
      lines.push(text);
    }
  }
  return lines.slice(-n);
}

export function readVisibleActivityLines(
  terminal: HeadlessTerminal | undefined,
  n: number
): string[] {
  if (!terminal) return [];

  const buffer = terminal.buffer.active as CursorBuffer;
  if (!buffer || typeof buffer.getLine !== "function") return [];

  const viewportTop = buffer.baseY;
  const viewportBottom = buffer.baseY + terminal.rows;
  const end = viewportBottom;
  const start = Math.max(viewportTop, end - n);

  const lines: string[] = [];
  for (let i = start; i < end; i += 1) {
    const line = buffer.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  return lines;
}

export function readVisibleActivitySnapshot(
  terminal: HeadlessTerminal | undefined,
  n: number
): VisibleContentSnapshot | undefined {
  return (
    buildViewportUnitsSnapshot(terminal) ??
    createVisibleContentSnapshot(readVisibleActivityLines(terminal, n))
  );
}

// FNV-1a stream, identical to SustainedChangeTracker.hashStrings: each unit's
// chars, then a LF separator byte per unit.
const FNV_SEED = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const HASH_UNIT_SEPARATOR = 10;

// Exactly the code points JS regex \s matches (tab through CR, space, and the
// Unicode space set). Mirrors the /^\s*$/u blank-cell test without running a
// regex per cell on the polling hot path — including its refusal to treat
// other C0 controls as blank, so parity with the legacy check is exact.
function isWhitespaceCode(code: number): boolean {
  if (code === 32 || (code >= 9 && code <= 13)) return true;
  if (code < 0x00a0) return false;
  return (
    code === 0x00a0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

function isBlankCellText(chars: string): boolean {
  if (chars.length === 1) {
    return isWhitespaceCode(chars.charCodeAt(0));
  }
  return /^\s*$/u.test(chars);
}

/**
 * Fused single-pass equivalent of the old readVisibleActivityCells →
 * normalizeCellUnits → createSnapshotFromUnits pipeline (PERF-035). Scans the
 * FULL visible viewport (not a cursor-anchored bottom-n window): TUI agents
 * stream spinner/status activity above a pinned bottom input box, and a
 * collapsed window starves the temperature model (v0.19.0 regression).
 *
 * Runs on every ActivityMonitor polling tick of every agent terminal, so it
 * avoids the per-cell allocations the old pipeline paid (a VisibleContentCell
 * object, a NormalizedVisibleUnit object, and a 6-segment template-string key
 * per visible cell, plus a second full pass to hash them):
 *
 *   * default-styled single-width cells — the overwhelming majority of real
 *     terminal content — use their raw chars as the unit key. Styled or wide
 *     cells keep the full 6-segment key. The two forms cannot collide (a
 *     full key always carries 5 "|" separators and is longer than any 1–2
 *     codepoint chars value), and within each form key equality is exactly
 *     the old scheme's, so unit-level deltas (changed/changedChars) are
 *     unchanged.
 *   * the FNV-1a hash is accumulated while units are built instead of in a
 *     second pass over every key char.
 *   * the inverse attribute (masked out of keys by design — see
 *     foregroundContentAttributes) is never read at all.
 */
function buildViewportUnitsSnapshot(
  terminal: HeadlessTerminal | undefined
): VisibleContentSnapshot | undefined {
  if (!terminal) return undefined;

  const buffer = terminal.buffer.active as CursorBuffer;
  if (!buffer || typeof buffer.getLine !== "function" || typeof buffer.getNullCell !== "function") {
    return undefined;
  }

  const start = buffer.baseY;
  const end = buffer.baseY + terminal.rows;
  const cols = terminal.cols;
  const reusableCell = buffer.getNullCell();

  const units: string[] = [];
  let hash = FNV_SEED;
  let lastKey: string | undefined;

  for (let y = start; y < end; y += 1) {
    const line = buffer.getLine(y);
    if (!line || typeof line.getCell !== "function") {
      continue;
    }

    for (let x = 0; x < cols; x += 1) {
      const cell = line.getCell(x, reusableCell);
      if (!cell) continue;
      const width = cell.getWidth();
      if (width === 0) continue;
      const chars = cell.getChars();
      if (chars.length === 0 || isBlankCellText(chars)) continue;

      // Attribute bit layout matches the old createVisibleContentCellFrom,
      // minus the inverse bit (1 << 5), which foregroundContentAttributes
      // always masked out of keys.
      const attributes =
        (cell.isBold() ? 1 : 0) |
        (cell.isItalic() ? 1 << 1 : 0) |
        (cell.isDim() ? 1 << 2 : 0) |
        (cell.isUnderline() ? 1 << 3 : 0) |
        (cell.isBlink() ? 1 << 4 : 0) |
        (cell.isInvisible() ? 1 << 6 : 0) |
        (cell.isStrikethrough() ? 1 << 7 : 0) |
        (cell.isOverline() ? 1 << 8 : 0);
      const fgColorMode = cell.getFgColorMode();
      const fgColor = cell.getFgColor();

      const key =
        attributes === 0 && fgColorMode === 0 && fgColor === -1 && width === 1 && chars.length <= 2
          ? chars
          : `${chars}|${cell.getCode()}|${width}|${fgColorMode}|${fgColor}|${attributes}`;

      if (lastKey === key && isCollapsibleFillText(chars)) continue;
      units.push(key);
      for (let i = 0; i < key.length; i += 1) {
        hash ^= key.charCodeAt(i);
        hash = Math.imul(hash, FNV_PRIME);
      }
      hash ^= HASH_UNIT_SEPARATOR;
      hash = Math.imul(hash, FNV_PRIME);
      lastKey = key;
    }
  }

  return {
    text: units.join(""),
    units,
    hash: hash >>> 0,
    length: units.length,
  };
}

/**
 * Generation-keyed cache over readVisibleActivitySnapshot (PERF-035). The
 * viewport can only change when the parser applies data or the terminal
 * resizes/reflows, yet the polling cycle re-extracted and re-hashed the full
 * rows×cols grid every 50ms tick per agent. Attach() subscribes to
 * onWriteParsed/onResize so any parse or resize invalidates; producers whose
 * write callbacks read the snapshot in the same job must call invalidate()
 * in that callback too, because xterm fires per-write callbacks before the
 * onWriteParsed event.
 */
export class ViewportSnapshotCache {
  private generation = 0;
  private snapshotGeneration = -1;
  private snapshotN = -1;
  private snapshot: VisibleContentSnapshot | undefined;
  private disposables: Array<{ dispose: () => void }> = [];

  attach(terminal: HeadlessTerminal): void {
    this.detach();
    this.disposables.push(terminal.onWriteParsed(() => this.invalidate()));
    this.disposables.push(terminal.onResize(() => this.invalidate()));
  }

  detach(): void {
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        // Terminal already disposed — ignore.
      }
    }
    this.disposables = [];
    this.invalidate();
  }

  invalidate(): void {
    this.generation += 1;
    this.snapshot = undefined;
  }

  read(terminal: HeadlessTerminal | undefined, n: number): VisibleContentSnapshot | undefined {
    if (
      this.snapshot !== undefined &&
      this.snapshotGeneration === this.generation &&
      this.snapshotN === n
    ) {
      return this.snapshot;
    }
    const snapshot = readVisibleActivitySnapshot(terminal, n);
    if (snapshot !== undefined) {
      this.snapshot = snapshot;
      this.snapshotGeneration = this.generation;
      this.snapshotN = n;
    }
    return snapshot;
  }
}

export function readCursorLine(terminal: HeadlessTerminal | undefined): string | null {
  if (!terminal) return null;

  const buffer = terminal.buffer.active as CursorBuffer;
  if (!buffer || typeof buffer.getLine !== "function") return null;
  const cursorY = buffer.cursorY ?? 0;
  const line = buffer.getLine(buffer.baseY + cursorY);
  return line ? line.translateToString(true) : null;
}

// All non-empty viewport lines in order (the pre-slice list `readLastNLines`
// draws from). Used to build the host-side viewport mirror in worker mode.
export function readViewportNonEmptyLines(terminal: HeadlessTerminal | undefined): string[] {
  if (!terminal) return [];
  const buffer = terminal.buffer.active;
  if (!buffer) return [];

  const viewportTop = buffer.baseY;
  const viewportBottom = buffer.baseY + terminal.rows;
  const lines: string[] = [];
  for (let i = viewportTop; i < viewportBottom; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (text.trim().length > 0) {
      lines.push(text);
    }
  }
  return lines;
}
