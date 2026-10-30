import type { IBuffer, IBufferCell, IBufferRange } from "@xterm/xterm";

/** The slice of a terminal a clean copy reads. */
export interface CleanCopyTerminal {
  readonly cols: number;
  readonly buffer: { readonly active: IBuffer };
  getSelection(): string;
  getSelectionPosition?(): IBufferRange | undefined;
}

/** Where a buffer's rows stop being laid out at another pane width. */
export interface RowLayoutWidth {
  widthKnownFrom(buffer: IBuffer): number;
}

interface Cell {
  ch: string;
  col: number;
  width: number;
}

interface Row {
  y: number;
  /** Trailing blanks trimmed. Wide characters occupy one entry. */
  cells: Cell[];
}

interface Line {
  /** As the selection has it: xterm's own wraps joined, nothing trimmed. */
  text: string;
  /** Column `text` starts at on its first row. */
  from: number;
  /** Its rows top to bottom, more than one where xterm wrapped it; absent when only the text is known. */
  rows?: Row[];
}

// Past this, the rows aren't read and the text is cleaned without rejoining.
const MAX_ROWS = 5000;

// Claude Code's message marker, drawn in place of the first column of the
// body's indent. It's chrome, never content, so it reads as that indent.
const MESSAGE_MARKER = /^⏺ /;

// Bullets and numbers a list item opens with, and the spaces before its text.
const LIST_MARKER = /^(?:[-*+•◦▪‣⏺]|\d{1,3}[.)]) +(?=\S)/;

// Lines that stand on their own: headings, quotes, tables, rules.
const STRUCTURAL = /^\s*(?:#{1,6}\s|>|\||([-*_])(?:\s*\1){2,}\s*$)/;

// Anything code-, diff- or tree-shaped. One such line keeps its whole block
// as it was drawn, since the lines of code around it can look like prose.
const CODE_EVIDENCE = [
  /[─-╿⎿]/, // box drawing, tool-output trees, Claude Code's ⎿
  /^\s*(?:```|~~~)/,
  /[{;]\s*$/,
  /^\s*[}\])]/,
  /^\s*(?:\/\/|\/\*|\*\/|<\/?[A-Za-z!])/,
  /^\s*(?:@@ |diff --git |\+\+\+ |--- )/,
  /^\s*\d+ +[+-]/, // a diff's line-number gutter
  /^\s*[$%❯›] /, // shell prompts
  /^\s*(?:[\w$]+\s+)?[A-Za-z_$][\w$.[\]]*\s*[-+*/|&]?=[^=>]/, // an assignment or declaration
  /\S {2,}\S/, // columns aligned with runs of spaces
];

// A wrap never follows a row that ends like this, or lands on one that starts with anything but prose.
const UPPER_STOPS = /[:;{[(\\=|&]$/;
const LOWER_STARTS = /^[\p{L}\p{N}("'“‘`[#@~/.$—–-]/u;

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/ /g, " ");
}

function readRow(buffer: IBuffer, y: number, cols: number): Row | undefined {
  const line = buffer.getLine(y);
  if (!line) return undefined;
  const cells: Cell[] = [];
  let scratch: IBufferCell | undefined;
  const limit = Math.min(line.length, cols);
  for (let col = 0; col < limit; col++) {
    const cell = line.getCell(col, scratch);
    if (!cell) break;
    scratch = cell;
    const width = cell.getWidth();
    if (width === 0) continue;
    cells.push({ ch: cell.getChars() || " ", col, width });
  }
  let end = cells.length;
  while (end > 0 && cells[end - 1]!.ch === " ") end--;
  cells.length = end;
  return { y, cells };
}

/**
 * The selection as lines with the rows under them, rebuilt the way xterm
 * builds its selection text; null where the rebuild doesn't come out as the
 * text xterm hands Copy, which is what a column selection does.
 */
function readSelectedLines(
  buffer: IBuffer,
  cols: number,
  range: IBufferRange,
  text: string
): Line[] | null {
  const { start, end } = range;
  if (end.y < start.y || end.y - start.y >= MAX_ROWS) return null;
  const lines: Line[] = [];
  for (let y = start.y; y <= end.y; y++) {
    const bufferLine = buffer.getLine(y);
    const row = readRow(buffer, y, cols);
    if (!bufferLine || !row) return null;
    const from = y === start.y ? Math.min(start.x, cols) : 0;
    const to = y === end.y ? Math.min(end.x, cols) : undefined;
    const piece = bufferLine.translateToString(true, from, to);
    const previous = lines[lines.length - 1];
    if (y > start.y && bufferLine.isWrapped && previous) {
      previous.text += piece;
      previous.rows!.push(row);
    } else {
      lines.push({ text: piece, from, rows: [row] });
    }
  }
  const rebuilt = normalize(lines.map((line) => line.text).join("\n"));
  if (rebuilt !== normalize(text)) return null;
  for (const line of lines) line.text = normalize(line.text);
  return lines;
}

function textLines(text: string): Line[] {
  return normalize(text)
    .split("\n")
    .map((line) => ({ text: line, from: 0 }));
}

function rowText(row: Row): string {
  return row.cells.map((cell) => cell.ch).join("");
}

function firstContent(row: Row): number {
  return row.cells.findIndex((cell) => cell.ch !== " ");
}

/** Columns the row occupies, from the left edge to its last visible cell. */
function rowWidth(row: Row): number {
  const last = row.cells[row.cells.length - 1];
  return last ? last.col + last.width : 0;
}

/** The column a wrapped row of this paragraph or list item resumes at. */
function hangingIndent(row: Row): number {
  const index = firstContent(row);
  const marker = LIST_MARKER.exec(rowText(row).slice(index));
  return row.cells[index + (marker ? marker[0].length : 0)]!.col;
}

/**
 * Whether the agent could have word-wrapped `upper` onto `lower`. A
 * word-wrapper breaks a line only where the next word won't fit, and resumes
 * at the paragraph's hanging indent; a row ending at the margin is how a token
 * cut mid-word looks too, so the space a join would put back can't be known.
 */
function couldWrapOnto(upper: Row, lower: Row, hang: number, cols: number): boolean {
  const index = firstContent(lower);
  if (index < 0 || lower.cells[index]!.col !== hang) return false;
  const text = rowText(lower).slice(index);
  if (LIST_MARKER.test(text) || !LOWER_STARTS.test(text)) return false;
  if (UPPER_STOPS.test(rowText(upper))) return false;
  let word = 0;
  for (let i = index; i < lower.cells.length && lower.cells[i]!.ch !== " "; i++) {
    word += lower.cells[i]!.width;
  }
  const upperWidth = rowWidth(upper);
  return upperWidth + 1 + word > cols && upperWidth + lower.cells[index]!.width <= cols;
}

/** Which lines sit in a block that holds code, a diff or a tree. Blank lines bound a block, except inside a fence. */
function protectedLines(lines: readonly Line[]): boolean[] {
  const result = new Array<boolean>(lines.length).fill(false);
  let blockStart = 0;
  let evidence = false;
  let inFence = false;
  const close = (endExclusive: number) => {
    if (evidence) result.fill(true, blockStart, endExclusive);
    blockStart = endExclusive;
    evidence = false;
  };
  lines.forEach((line, i) => {
    if (/^\s*(?:```|~~~)/.test(line.text)) inFence = !inFence;
    if (!inFence && line.text.trim() === "") {
      close(i);
      blockStart = i + 1;
      return;
    }
    if (inFence || CODE_EVIDENCE.some((pattern) => pattern.test(line.text))) evidence = true;
  });
  close(lines.length);
  return result;
}

/** Rejoin the rows an agent wrapped to fit the pane, where nothing else could explain the break. */
function rejoinWraps(lines: Line[], cols: number, knownFrom: number): Line[] {
  const locked = protectedLines(lines);
  const out: Line[] = [];
  let hang = -1;
  lines.forEach((line, i) => {
    const row = line.rows?.length === 1 ? line.rows[0] : undefined;
    const joinable =
      row !== undefined &&
      row.y >= knownFrom &&
      !locked[i] &&
      line.text.trim() !== "" &&
      !STRUCTURAL.test(line.text);
    const previous = out[out.length - 1];
    const upper = previous?.rows?.[previous.rows.length - 1];
    if (joinable && upper && hang >= 0 && couldWrapOnto(upper, row, hang, cols)) {
      previous!.text = `${previous!.text.trimEnd()} ${line.text.trimStart()}`;
      previous!.rows!.push(row);
      return;
    }
    out.push({ ...line, rows: line.rows && [...line.rows] });
    hang = joinable ? hangingIndent(row) : -1;
  });
  return out;
}

function leadingSpaces(text: string): number {
  return text.length - text.trimStart().length;
}

function cleanLines(lines: Line[], cols: number, knownFrom: number | null): string {
  for (const line of lines) {
    if (line.from === 0) line.text = line.text.replace(MESSAGE_MARKER, "  ");
  }
  const joined = knownFrom === null ? lines : rejoinWraps(lines, cols, knownFrom);

  // A selection that starts in the indent (or just past the marker) counts
  // from the left edge; one that starts partway through the text has no
  // indent of its own.
  const first = joined[0];
  let firstIsFree = false;
  if (first && first.from > 0) {
    const before = first.rows?.[0]?.cells.some(
      (cell) => cell.col < first.from && cell.ch !== " " && !(cell.col === 0 && cell.ch === "⏺")
    );
    if (before === false) first.text = " ".repeat(first.from) + first.text;
    else {
      first.text = first.text.trimStart();
      firstIsFree = true;
    }
  }

  const texts = joined.map((line) => line.text.replace(/[ \t]+$/, ""));
  let common = Infinity;
  texts.forEach((text, i) => {
    if (text === "" || (i === 0 && firstIsFree)) return;
    common = Math.min(common, leadingSpaces(text));
  });
  const dedented = texts.map((text, i) =>
    text === "" || (i === 0 && firstIsFree) || common === Infinity ? text : text.slice(common)
  );
  let startIndex = 0;
  let endIndex = dedented.length;
  while (startIndex < endIndex && dedented[startIndex] === "") startIndex++;
  while (endIndex > startIndex && dedented[endIndex - 1] === "") endIndex--;
  return dedented.slice(startIndex, endIndex).join("\n");
}

/**
 * The text a string-only clean leaves: Claude Code's message markers dropped,
 * trailing padding gone, the indent every line shares removed, and no line
 * breaks touched.
 */
export function cleanCopyText(text: string): string {
  return withLineEnding(text, cleanLines(textLines(text), 0, null));
}

function withLineEnding(source: string, cleaned: string): string {
  return source.includes("\r\n") ? cleaned.replace(/\n/g, "\r\n") : cleaned;
}

/**
 * The terminal's selection, cleaned for pasting somewhere else: Claude Code's
 * message markers dropped, trailing padding gone (spaces an app painted
 * included), the indent every line shares removed so relative indentation
 * survives, and the line breaks an agent made to fit the pane rejoined.
 *
 * Rejoining needs the rows themselves, since agent TUIs wrap with a real
 * newline and a hanging indent that xterm can't tell from an intended break.
 * A break is only taken for a wrap where nothing else could explain it: the
 * next row resumes at exactly the paragraph's hanging indent, its first word
 * wouldn't have fit, neither row opens a list item, heading, quote or table,
 * the block holds nothing code-, diff- or tree-shaped, and both rows were laid
 * out at the pane's width now. Anything else stays a line break: a missed
 * join costs a backspace, merging two lines of code loses what they said.
 *
 * Without the rows (a column selection, a selection that changed since
 * `captured` was read, no layout width), the text is cleaned without
 * rejoining anything.
 */
export function cleanTerminalSelection(
  terminal: CleanCopyTerminal,
  layout: RowLayoutWidth | null,
  captured?: string
): string {
  const text = terminal.getSelection();
  if (captured !== undefined && normalize(text) !== normalize(captured)) {
    return cleanCopyText(captured);
  }
  if (!text) return "";
  const range = terminal.getSelectionPosition?.();
  const buffer = terminal.buffer.active;
  const lines = range ? readSelectedLines(buffer, terminal.cols, range, text) : null;
  if (!lines) return cleanCopyText(text);
  const knownFrom = layout ? layout.widthKnownFrom(buffer) : null;
  return withLineEnding(text, cleanLines(lines, terminal.cols, knownFrom));
}
