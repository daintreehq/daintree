import type { IBufferCell, Terminal as HeadlessTerminal } from "@xterm/headless";
import {
  createVisibleCellContentSnapshot,
  createVisibleContentSnapshot,
  type VisibleContentCell,
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
  const cells = readVisibleActivityCells(terminal);
  return cells
    ? createVisibleCellContentSnapshot(cells)
    : createVisibleContentSnapshot(readVisibleActivityLines(terminal, n));
}

// Scans the FULL visible viewport (not a cursor-anchored bottom-n window):
// TUI agents stream spinner/status activity above a pinned bottom input box,
// and a collapsed window starves the temperature model (v0.19.0 regression).
// Blank cells are skipped before allocation, so an idle viewport costs reads
// but not allocations.
function readVisibleActivityCells(
  terminal: HeadlessTerminal | undefined
): VisibleContentCell[][] | undefined {
  if (!terminal) return undefined;

  const buffer = terminal.buffer.active as CursorBuffer;
  if (!buffer || typeof buffer.getLine !== "function" || typeof buffer.getNullCell !== "function") {
    return undefined;
  }

  const viewportTop = buffer.baseY;
  const viewportBottom = buffer.baseY + terminal.rows;
  const end = viewportBottom;
  const start = viewportTop;
  const reusableCell = buffer.getNullCell();

  const rows: VisibleContentCell[][] = [];
  for (let y = start; y < end; y += 1) {
    const line = buffer.getLine(y);
    if (!line || typeof line.getCell !== "function") {
      continue;
    }

    const row: VisibleContentCell[] = [];
    for (let x = 0; x < terminal.cols; x += 1) {
      const cell = line.getCell(x, reusableCell);
      if (!cell) continue;
      const width = cell.getWidth();
      if (width === 0) continue;
      const chars = cell.getChars();
      if (chars.length === 0 || /^\s*$/u.test(chars)) continue;
      row.push(createVisibleContentCellFrom(cell, chars, width));
    }
    rows.push(row);
  }

  return rows;
}

function createVisibleContentCellFrom(
  cell: IBufferCell,
  chars: string,
  width: number
): VisibleContentCell {
  const attributes =
    (cell.isBold() ? 1 : 0) |
    (cell.isItalic() ? 1 << 1 : 0) |
    (cell.isDim() ? 1 << 2 : 0) |
    (cell.isUnderline() ? 1 << 3 : 0) |
    (cell.isBlink() ? 1 << 4 : 0) |
    (cell.isInverse() ? 1 << 5 : 0) |
    (cell.isInvisible() ? 1 << 6 : 0) |
    (cell.isStrikethrough() ? 1 << 7 : 0) |
    (cell.isOverline() ? 1 << 8 : 0);

  return {
    chars,
    code: cell.getCode(),
    width,
    fgColorMode: cell.getFgColorMode(),
    fgColor: cell.getFgColor(),
    attributes,
  };
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
