import type {
  IBuffer,
  IBufferCell,
  IBufferRange,
  IDisposable,
  ILink,
  ILinkProvider,
} from "@xterm/xterm";

/** The slice of a terminal the provider reads. */
export interface SuggestedCommandTerminal {
  readonly buffer: { readonly active: IBuffer; readonly normal: IBuffer };
  readonly cols: number;
  onResize(listener: (size: { cols: number; rows: number }) => void): IDisposable;
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
  /** Drawn as itself: a safe character in the default colours, nothing hiding it. */
  plain: boolean;
}

interface Row {
  /** Trailing blanks trimmed. Wide characters occupy one entry. */
  cells: Cell[];
  isWrapped: boolean;
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
// Characters that render as nothing, or as something other than themselves:
// controls, format characters (bidi, zero-width), line/paragraph separators,
// non-ASCII spaces, default-ignorables (fillers, variation selectors) and the
// blank Braille pattern.
const UNSAFE_CHAR = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800]|(?! )\p{Zs}/u;

// Claude Code draws a suggestion's text in the default colours. Requiring them
// is what proves the text is visible without resolving the theme: any colour,
// inverse or dim could be a foreground matched to its background.
function isPlainCell(cell: IBufferCell, ch: string): boolean {
  return (
    cell.isFgDefault() &&
    cell.isBgDefault() &&
    !cell.isInverse() &&
    !cell.isDim() &&
    !cell.isInvisible() &&
    !UNSAFE_CHAR.test(ch)
  );
}

function readRow(buffer: IBuffer, y: number, cols: number): Row | undefined {
  if (y < 0) return undefined;
  const line = buffer.getLine(y);
  if (!line) return undefined;
  const cells: Cell[] = [];
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
    cells.push({ ch, col, width, plain: ch === " " || isPlainCell(cell, ch) });
  }
  let end = cells.length;
  while (end > 0 && cells[end - 1]!.ch === " ") end--;
  cells.length = end;
  return { cells, isWrapped: line.isWrapped };
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

function isPlainFrom(row: Row, from: number): boolean {
  for (let i = from; i < row.cells.length; i++) if (!row.cells[i]!.plain) return false;
  return true;
}

/**
 * Whether Ink could have word-wrapped `upper` onto `lower`: `lower` is shaped
 * like a continuation (a head counts, since a command can contain ` ! `) and
 * its first word wouldn't have fit at the end of `upper`. Without the width the
 * rows were wrapped at, any continuation shape could be one.
 */
function couldWrapOnto(
  upper: Row | undefined,
  lower: Row,
  cols: number,
  widthKnown: boolean
): boolean {
  if (!upper || upper.cells.length === 0 || lower.isWrapped) return false;
  if (!isHead(lower) && !hasContinuationShape(lower)) return false;
  if (!widthKnown) return true;
  return rowWidth(upper) + 1 + leadingWordWidth(lower, CONTINUATION_INDENT) > cols;
}

/** The last buffer row holding anything, or -1 for an empty buffer. */
function lastContentRow(buffer: IBuffer): number {
  for (let y = buffer.length - 1; y >= 0; y--) {
    if (buffer.getLine(y)?.translateToString(true)) return y;
  }
  return -1;
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
 * short command followed by an indented line of prose stays one row, and the
 * space the wrap dropped comes back as one space.
 *
 * Where the rows can't say what the command is, the whole suggestion stays
 * inert rather than running part of it or more than it:
 * - text that isn't drawn plainly (concealed, coloured, unsafe characters);
 * - an upper row filled to the edge, where a token cut mid-word and a word
 *   that ended at the margin leave identical rows;
 * - a row that would continue the command but reads as a new suggestion, or a
 *   suggestion that could be the continuation of the row above it;
 * - a possible continuation on rows whose wrap width is unknown: rows from
 *   before `widthKnownFrom` were laid out for another pane width, and so were
 *   rows xterm reflowed on a resize;
 * - an xterm wrap whose upper row stops short of the edge (wide-character
 *   padding and blanks look alike), a command ending in a backslash (the
 *   escaped space after it can't survive the trim), or an over-budget run.
 */
export function readSuggestedCommand(
  buffer: IBuffer,
  cols: number,
  headY: number,
  widthKnownFrom = 0
): SuggestedCommand | null {
  let row = readRow(buffer, headY, cols);
  if (!row || !isHead(row)) return null;
  const startCol = row.cells[HEAD_LENGTH]!.col;
  let widthKnown = headY >= widthKnownFrom;
  if (couldWrapOnto(readRow(buffer, headY - 1, cols), row, cols, widthKnown)) return null;

  let command = "";
  let from = HEAD_LENGTH;
  let y = headY;
  for (let rows = 1; ; rows++) {
    if (!isPlainFrom(row, from)) return null;
    command += textFrom(row, from);
    if (command.length > MAX_COMMAND_LENGTH) return null;

    const next = readRow(buffer, y + 1, cols);
    if (!next) break;
    if (next.isWrapped) {
      // xterm's own wrap carries the text on cell for cell.
      if (rowWidth(row) < cols || next.cells.length === 0 || rows >= MAX_ROWS) return null;
      widthKnown = false;
      from = 0;
    } else {
      if (next.cells.length === 0) break;
      if (!couldWrapOnto(row, next, cols, widthKnown)) break;
      if (!widthKnown || isHead(next) || rowWidth(row) >= cols || rows >= MAX_ROWS) return null;
      command += " ";
      from = CONTINUATION_INDENT;
    }
    y++;
    row = next;
  }
  if (command.endsWith("\\")) return null;

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
  y: number,
  widthKnownFrom = 0
): SuggestedCommand | null {
  for (let headY = y; headY > y - MAX_ROWS; headY--) {
    const row = readRow(buffer, headY, cols);
    if (!row || row.cells.length === 0) return null;
    if (isHead(row)) {
      const found = readSuggestedCommand(buffer, cols, headY, widthKnownFrom);
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
  private _resizeListener: IDisposable;
  private _cols: number;
  // First normal-buffer row known to be laid out at the current width.
  private _widthKnownFrom: number;

  constructor(
    terminal: SuggestedCommandTerminal,
    isEnabled: () => boolean,
    onRun: OnRunSuggestedCommand
  ) {
    this._terminal = terminal;
    this._isEnabled = isEnabled;
    this._onRun = onRun;
    this._cols = terminal.cols;
    // Whatever is already on screen (a restored buffer, output from before the
    // pane opened) may have been laid out at another width.
    this._widthKnownFrom = lastContentRow(terminal.buffer.normal) + 1;
    // Claude Code repaints the screen at the new width on a resize, but rows
    // already in scrollback keep the width they were wrapped at.
    this._resizeListener = terminal.onResize(({ cols }) => {
      if (cols === this._cols) return;
      this._cols = cols;
      this._widthKnownFrom = terminal.buffer.normal.baseY;
    });
  }

  private _knownFrom(buffer: IBuffer): number {
    // The alternate screen has no scrollback; an app there redraws it whole.
    return buffer.type === "normal" ? this._widthKnownFrom : 0;
  }

  provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
    const terminal = this._terminal;
    // Agent identity is read live: a shell can become a Claude pane and back.
    if (!terminal || bufferLineNumber < 1 || !this._isEnabled()) {
      callback(undefined);
      return;
    }
    const buffer = terminal.buffer.active;
    const found = findSuggestedCommand(
      buffer,
      terminal.cols,
      bufferLineNumber - 1,
      this._knownFrom(buffer)
    );
    callback(found ? [new SuggestedCommandLink(found, () => this._activate(found))] : undefined);
  }

  // xterm keeps a link alive while the pointer stays on it, so the screen can
  // change under a hovered link. Re-read it and run only what is shown now.
  private _activate(hovered: SuggestedCommand): void {
    const terminal = this._terminal;
    if (!terminal || !this._isEnabled()) return;
    const buffer = terminal.buffer.active;
    const current = readSuggestedCommand(
      buffer,
      terminal.cols,
      hovered.range.start.y - 1,
      this._knownFrom(buffer)
    );
    if (!current || current.command !== hovered.command) return;
    if (!sameRange(current.range, hovered.range)) return;
    this._onRun(current.command);
  }

  dispose(): void {
    this._resizeListener.dispose();
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

  activate(event: MouseEvent, _text: string): void {
    // A double click's second click would open a second terminal.
    if (event.detail > 1) return;
    this._onActivate();
  }
}
