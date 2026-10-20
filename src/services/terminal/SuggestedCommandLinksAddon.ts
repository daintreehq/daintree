import type { IBuffer, IBufferCell, IBufferRange, ILink, ILinkProvider } from "@xterm/xterm";

/** The slice of a terminal the provider reads: its active buffer and width. */
export interface SuggestedCommandTerminal {
  readonly buffer: { readonly active: IBuffer };
  readonly cols: number;
}

/** Called with the exact command a clicked `! command` suggestion shows. */
export type OnRunSuggestedCommand = (command: string) => void;

export interface SuggestedCommand {
  command: string;
  range: IBufferRange;
}

interface Cell {
  ch: string;
  col: number;
  width: number;
}

interface Row {
  /** Trailing blanks trimmed. Wide characters occupy one entry. */
  cells: Cell[];
  isWrapped: boolean;
  /** A cell carries text the screen doesn't show as itself. */
  unsafe: boolean;
}

// Claude Code prints a suggestion as its own paragraph line: two spaces, `!`,
// a space, the command. On a message's first line Ink draws its `⏺` marker in
// place of the first space.
const HEAD_PREFIXES: ReadonlyArray<readonly string[]> = [
  [" ", " ", "!", " "],
  ["⏺", " ", "!", " "],
];
const HEAD_LENGTH = 4;
// Ink resumes a wrapped paragraph line after the paragraph's own indent.
const CONTINUATION_INDENT = 2;
const MAX_ROWS = 16;
const MAX_COMMAND_LENGTH = 2048;

// Characters that render as nothing, or as something other than themselves:
// controls, format characters (bidi, zero-width), line/paragraph separators,
// non-ASCII spaces, fillers and variation selectors.
const UNSAFE_CATEGORY = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|(?! )\p{Zs}/u;

// Default-ignorable code points outside those categories: fillers and
// variation selectors. Matched by code point, since several are combining marks
// a regex character class can't hold.
const UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x034f, 0x034f],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xffa0, 0xffa0],
  [0xe0100, 0xe01ef],
];

function hasUnsafeChar(ch: string): boolean {
  if (UNSAFE_CATEGORY.test(ch)) return true;
  for (const char of ch) {
    const codePoint = char.codePointAt(0)!;
    if (UNSAFE_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high)) return true;
  }
  return false;
}

function isVisibleCell(cell: IBufferCell, ch: string): boolean {
  if (cell.isInvisible()) return false;
  if (hasUnsafeChar(ch)) return false;
  if (
    !cell.isFgDefault() &&
    cell.getFgColorMode() === cell.getBgColorMode() &&
    cell.getFgColor() === cell.getBgColor()
  ) {
    return false;
  }
  return true;
}

function readRow(buffer: IBuffer, y: number, cols: number): Row | undefined {
  if (y < 0) return undefined;
  const line = buffer.getLine(y);
  if (!line) return undefined;
  const cells: Cell[] = [];
  let unsafe = false;
  let scratch: IBufferCell | undefined;
  // A row can outlast a narrowing resize; only what fits the pane is on screen.
  const limit = Math.min(line.length, cols);
  for (let col = 0; col < limit; col++) {
    const cell = line.getCell(col, scratch);
    if (!cell) break;
    scratch = cell;
    const width = cell.getWidth();
    if (width === 0) continue;
    // Ink moves the cursor over gaps, leaving empty cells that read as blanks.
    const ch = cell.getChars() || " ";
    if (ch !== " " && !isVisibleCell(cell, ch)) unsafe = true;
    cells.push({ ch, col, width });
  }
  let end = cells.length;
  while (end > 0 && cells[end - 1]!.ch === " ") end--;
  cells.length = end;
  return { cells, isWrapped: line.isWrapped, unsafe };
}

function isHead(row: Row): boolean {
  if (row.isWrapped || row.cells.length <= HEAD_LENGTH) return false;
  if (row.cells[HEAD_LENGTH]!.ch === " ") return false;
  return HEAD_PREFIXES.some((prefix) => prefix.every((ch, i) => row.cells[i]!.ch === ch));
}

function hasContinuationShape(row: Row): boolean {
  return (
    row.cells.length > CONTINUATION_INDENT &&
    row.cells[0]!.ch === " " &&
    row.cells[1]!.ch === " " &&
    row.cells[CONTINUATION_INDENT]!.ch !== " "
  );
}

/** Columns the row occupies, from the left edge to its last visible cell. */
function rowWidth(row: Row): number {
  const last = row.cells[row.cells.length - 1];
  return last ? last.col + last.width : 0;
}

function leadingWordWidth(row: Row, from: number): number {
  let width = 0;
  for (let i = from; i < row.cells.length && row.cells[i]!.ch !== " "; i++) {
    width += row.cells[i]!.width;
  }
  return width;
}

function trailingWordWidth(row: Row): number {
  let width = 0;
  for (let i = row.cells.length - 1; i >= 0 && row.cells[i]!.ch !== " "; i--) {
    width += row.cells[i]!.width;
  }
  return width;
}

function textFrom(row: Row, from: number): string {
  let text = "";
  for (let i = from; i < row.cells.length; i++) text += row.cells[i]!.ch;
  return text;
}

/**
 * Read the suggestion whose head is buffer row `headY` (0-based), joining the
 * rows Claude Code wrapped it onto.
 *
 * Ink word-wraps a paragraph at the pane width and resumes it after a
 * two-space indent, with a real newline between the rows, so xterm records no
 * wrap. A row is only taken as a continuation when its first word could not
 * have fit on the row above: that is the one case a word-wrapper breaks, so a
 * short command followed by an indented line of prose stays one row. The space
 * a word wrap drops comes back as one space; a token wider than the text box
 * is cut mid-word at the right edge and rejoins with none.
 *
 * Anything that makes the shown text and the run text differ leaves the whole
 * suggestion inert rather than running part of it: a concealed or unsafe cell,
 * an over-budget run, or a hard wrap after rows xterm reflowed on resize,
 * where the width Ink wrapped at is no longer known.
 */
export function readSuggestedCommand(
  buffer: IBuffer,
  cols: number,
  headY: number
): SuggestedCommand | null {
  let row = readRow(buffer, headY, cols);
  if (!row || !isHead(row)) return null;
  const startCol = row.cells[HEAD_LENGTH]!.col;

  let command = "";
  let from = HEAD_LENGTH;
  let y = headY;
  let reflowed = false;
  for (let rows = 1; ; rows++) {
    if (row.unsafe) return null;
    command += textFrom(row, from);
    if (command.length > MAX_COMMAND_LENGTH) return null;

    const next = readRow(buffer, y + 1, cols);
    if (!next || next.cells.length === 0) break;
    if (next.isWrapped) {
      if (rows >= MAX_ROWS) return null;
      // xterm's own wrap: the upper row ran to the edge, blanks included.
      command += " ".repeat(Math.max(0, cols - rowWidth(row)));
      reflowed = true;
      from = 0;
    } else {
      if (isHead(next) || !hasContinuationShape(next)) break;
      if (rowWidth(row) + 1 + leadingWordWidth(next, CONTINUATION_INDENT) <= cols) break;
      if (reflowed || rows >= MAX_ROWS) return null;
      const midWord =
        rowWidth(row) === cols &&
        trailingWordWidth(row) + leadingWordWidth(next, CONTINUATION_INDENT) >
          cols - CONTINUATION_INDENT;
      if (!midWord) command += " ";
      from = CONTINUATION_INDENT;
    }
    y++;
    row = next;
  }

  const last = row.cells[row.cells.length - 1]!;
  return {
    command,
    range: {
      start: { x: startCol + 1, y: headY + 1 },
      end: { x: last.col + last.width, y: y + 1 },
    },
  };
}

/** The suggestion covering buffer row `y` (0-based), whichever of its rows it is. */
export function findSuggestedCommand(
  buffer: IBuffer,
  cols: number,
  y: number
): SuggestedCommand | null {
  for (let headY = y; headY > y - MAX_ROWS; headY--) {
    const row = readRow(buffer, headY, cols);
    if (!row || row.cells.length === 0) return null;
    if (isHead(row)) {
      const found = readSuggestedCommand(buffer, cols, headY);
      return found && found.range.end.y >= y + 1 ? found : null;
    }
    if (!row.isWrapped && !hasContinuationShape(row)) return null;
  }
  return null;
}

function sameRange(a: IBufferRange, b: IBufferRange): boolean {
  return (
    a.start.x === b.start.x && a.start.y === b.start.y && a.end.x === b.end.x && a.end.y === b.end.y
  );
}

export class SuggestedCommandLinksAddon implements ILinkProvider {
  private _terminal: SuggestedCommandTerminal | null;
  private _isEnabled: () => boolean;
  private _onRun: OnRunSuggestedCommand;

  constructor(
    terminal: SuggestedCommandTerminal,
    isEnabled: () => boolean,
    onRun: OnRunSuggestedCommand
  ) {
    this._terminal = terminal;
    this._isEnabled = isEnabled;
    this._onRun = onRun;
  }

  provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
    const terminal = this._terminal;
    // Agent identity is read live: a shell can become a Claude pane and back.
    if (!terminal || bufferLineNumber < 1 || !this._isEnabled()) {
      callback(undefined);
      return;
    }
    const found = findSuggestedCommand(terminal.buffer.active, terminal.cols, bufferLineNumber - 1);
    callback(found ? [new SuggestedCommandLink(found, () => this._activate(found))] : undefined);
  }

  // xterm keeps a link alive while the pointer stays on it, so the screen can
  // change under a hovered link. Re-read it and run only what is shown now.
  private _activate(hovered: SuggestedCommand): void {
    const terminal = this._terminal;
    if (!terminal || !this._isEnabled()) return;
    const current = readSuggestedCommand(
      terminal.buffer.active,
      terminal.cols,
      hovered.range.start.y - 1
    );
    if (!current || current.command !== hovered.command) return;
    if (!sameRange(current.range, hovered.range)) return;
    this._onRun(current.command);
  }

  dispose(): void {
    this._terminal = null;
  }
}

// No hover/leave callbacks, like `ImageLinksAddon`: a command is not a URL or
// path, so it stays out of the "Open link" / "Copy link address" menu.
class SuggestedCommandLink implements ILink {
  decorations = { pointerCursor: true, underline: true };
  range: IBufferRange;
  text: string;

  constructor(
    found: SuggestedCommand,
    private _onActivate: () => void
  ) {
    this.range = found.range;
    this.text = found.command;
  }

  activate(_event: MouseEvent, _text: string): void {
    this._onActivate();
  }
}
