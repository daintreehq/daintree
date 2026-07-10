import type { IBufferCell, Terminal as HeadlessTerminal } from "@xterm/headless";
import {
  createVisibleContentSnapshot,
  isCollapsibleFillText,
  type VisibleContentSnapshot,
  type VisibleContentUnit,
} from "../SustainedChangeTracker.js";

type CursorBufferLine = {
  translateToString: (trimRight?: boolean) => string;
  getCell?: (index: number, cell?: IBufferCell) => IBufferCell | undefined;
  _line?: RawBufferLine;
};

type RawBufferLine = {
  _data: Uint32Array;
  _combined: Record<number, string | undefined>;
  _extendedAttrs: Record<number, { underlineStyle?: number } | undefined>;
  length: number;
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

// Mirrors the pinned xterm 6.1 buffer layout. The public BufferLineApiView
// retains `_line`; shape checks below keep a public-cell fallback for drift.
const CELL_SIZE = 3;
const CONTENT_CODEPOINT_MASK = 0x1fffff;
const CONTENT_IS_COMBINED_MASK = 0x200000;
const CONTENT_HAS_CONTENT_MASK = 0x3fffff;
const CONTENT_WIDTH_SHIFT = 22;
const COLOR_MODE_MASK = 0x3000000;
const COLOR_PALETTE_16 = 0x1000000;
const COLOR_PALETTE_256 = 0x2000000;
const COLOR_RGB = 0x3000000;
const FG_BOLD = 0x8000000;
const FG_UNDERLINE = 0x10000000;
const FG_BLINK = 0x20000000;
const FG_INVISIBLE = 0x40000000;
const FG_STRIKETHROUGH = 0x80000000;
const BG_ITALIC = 0x4000000;
const BG_DIM = 0x8000000;
const BG_HAS_EXTENDED = 0x10000000;
const BG_OVERLINE = 0x40000000;

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

function isCollapsibleFillCode(code: number): boolean {
  return (
    code === 0x2d ||
    code === 0x5f ||
    code === 0x3d ||
    code === 0x2e ||
    code === 0x00b7 ||
    code === 0x2022 ||
    code === 0x2219 ||
    code === 0x25cf ||
    code === 0x2500 ||
    code === 0x2501 ||
    code === 0x2550 ||
    code === 0x254c ||
    code === 0x254d ||
    code === 0x23af ||
    code === 0x2581 ||
    code === 0x2594
  );
}

function rawBufferLine(line: CursorBufferLine, cols: number): RawBufferLine | undefined {
  const raw = line._line;
  return raw?._data instanceof Uint32Array &&
    raw._data.length >= cols * CELL_SIZE &&
    typeof raw._combined === "object" &&
    raw._combined !== null &&
    typeof raw._extendedAttrs === "object" &&
    raw._extendedAttrs !== null
    ? raw
    : undefined;
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
 *   * default-styled single-width raw cells — the overwhelming majority of
 *     real terminal content — use their numeric code point as the unit key,
 *     avoiding one string allocation per occupied cell. Combined cells keep
 *     a string key; styled and wide cells keep the full 6-segment key.
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

  const units: VisibleContentUnit[] = [];
  let hash = FNV_SEED;
  let lastKey: VisibleContentUnit | undefined;

  for (let y = start; y < end; y += 1) {
    const line = buffer.getLine(y);
    if (!line || typeof line.getCell !== "function") {
      continue;
    }

    const raw = rawBufferLine(line, cols);
    let cellLimit = cols;
    if (raw) {
      cellLimit = 0;
      for (let x = Math.min(cols, raw.length) - 1; x >= 0; x -= 1) {
        const content = raw._data[x * CELL_SIZE] ?? 0;
        if ((content & CONTENT_HAS_CONTENT_MASK) !== 0) {
          cellLimit = Math.min(cols, x + (content >>> CONTENT_WIDTH_SHIFT));
          break;
        }
      }
    }

    for (let x = 0; x < cellLimit; x += 1) {
      let chars: string | undefined;
      let code: number;
      let width: number;
      let attributes: number;
      let fgColorMode: number;
      let fgColor: number;
      let rawCodePoint: number | undefined;

      if (raw) {
        const offset = x * CELL_SIZE;
        const content = raw._data[offset] ?? 0;
        width = content >>> CONTENT_WIDTH_SHIFT;
        if (width === 0) continue;

        const codePoint = content & CONTENT_CODEPOINT_MASK;
        if ((content & CONTENT_IS_COMBINED_MASK) !== 0) {
          chars = raw._combined[x] ?? "";
          if (chars.length === 0 || isBlankCellText(chars)) continue;
          code = chars.charCodeAt(chars.length - 1);
        } else {
          if (codePoint === 0 || isWhitespaceCode(codePoint)) continue;
          code = codePoint;
          rawCodePoint = codePoint;
        }

        const fg = raw._data[offset + 1] ?? 0;
        const bg = raw._data[offset + 2] ?? 0;
        if (fg === 0 && bg === 0) {
          attributes = 0;
          fgColorMode = 0;
          fgColor = -1;
        } else {
          const hasExtendedUnderline =
            (bg & BG_HAS_EXTENDED) !== 0 && (raw._extendedAttrs[x]?.underlineStyle ?? 0) !== 0;
          attributes =
            ((fg & FG_BOLD) !== 0 ? 1 : 0) |
            ((bg & BG_ITALIC) !== 0 ? 1 << 1 : 0) |
            ((bg & BG_DIM) !== 0 ? 1 << 2 : 0) |
            ((fg & FG_UNDERLINE) !== 0 || hasExtendedUnderline ? 1 << 3 : 0) |
            ((fg & FG_BLINK) !== 0 ? 1 << 4 : 0) |
            ((fg & FG_INVISIBLE) !== 0 ? 1 << 6 : 0) |
            ((fg & FG_STRIKETHROUGH) !== 0 ? 1 << 7 : 0) |
            ((bg & BG_OVERLINE) !== 0 ? 1 << 8 : 0);
          fgColorMode = fg & COLOR_MODE_MASK;
          fgColor =
            fgColorMode === COLOR_PALETTE_16 || fgColorMode === COLOR_PALETTE_256
              ? fg & 0xff
              : fgColorMode === COLOR_RGB
                ? fg & 0xffffff
                : -1;
        }
      } else {
        const cell = line.getCell(x, reusableCell);
        if (!cell) continue;
        width = cell.getWidth();
        if (width === 0) continue;
        chars = cell.getChars();
        if (chars.length === 0 || isBlankCellText(chars)) continue;
        code = cell.getCode();
        // Attribute bit layout matches the old createVisibleContentCellFrom,
        // minus inverse, which foregroundContentAttributes masks out.
        attributes =
          (cell.isBold() ? 1 : 0) |
          (cell.isItalic() ? 1 << 1 : 0) |
          (cell.isDim() ? 1 << 2 : 0) |
          (cell.isUnderline() ? 1 << 3 : 0) |
          (cell.isBlink() ? 1 << 4 : 0) |
          (cell.isInvisible() ? 1 << 6 : 0) |
          (cell.isStrikethrough() ? 1 << 7 : 0) |
          (cell.isOverline() ? 1 << 8 : 0);
        fgColorMode = cell.getFgColorMode();
        fgColor = cell.getFgColor();
      }

      const defaultSingleWidth =
        attributes === 0 && fgColorMode === 0 && fgColor === -1 && width === 1;
      let key: VisibleContentUnit;
      let collapsible: boolean;
      if (defaultSingleWidth && rawCodePoint !== undefined) {
        key = rawCodePoint;
        collapsible = isCollapsibleFillCode(rawCodePoint);
      } else {
        const resolvedChars =
          chars ??
          (rawCodePoint! <= 0xffff
            ? String.fromCharCode(rawCodePoint!)
            : String.fromCodePoint(rawCodePoint!));
        key =
          defaultSingleWidth && resolvedChars.length <= 2
            ? resolvedChars
            : `${resolvedChars}|${code}|${width}|${fgColorMode}|${fgColor}|${attributes}`;
        collapsible = isCollapsibleFillText(resolvedChars);
      }

      if (lastKey === key && collapsible) continue;
      units.push(key);
      if (typeof key === "number") {
        if (key <= 0xffff) {
          hash ^= key;
          hash = Math.imul(hash, FNV_PRIME);
        } else {
          const astral = key - 0x10000;
          hash ^= 0xd800 + (astral >> 10);
          hash = Math.imul(hash, FNV_PRIME);
          hash ^= 0xdc00 + (astral & 0x3ff);
          hash = Math.imul(hash, FNV_PRIME);
        }
      } else {
        for (let i = 0; i < key.length; i += 1) {
          hash ^= key.charCodeAt(i);
          hash = Math.imul(hash, FNV_PRIME);
        }
      }
      hash ^= HASH_UNIT_SEPARATOR;
      hash = Math.imul(hash, FNV_PRIME);
      lastKey = key;
    }
  }

  return {
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
