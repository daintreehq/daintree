import {
  getEffectiveAgentConfig,
  type AgentInputSuggestionConfig,
} from "../config/agentRegistry.js";
import type { TerminalInputLine } from "../types/terminalStatus.js";
import { expandCursorForward, stripAnsiCodes, tailCapturedOutput } from "./artifactParser.js";

/**
 * What an agent's input box holds, read off a serialized screen (#16189): the
 * suggested next prompt a CLI draws in its empty box is styled, and plain text
 * cannot tell it from words someone typed. Read as a draft or an echoed
 * request, it put replies in the user's mouth.
 *
 * Styling is weaker evidence than recorded input, so this is an observation of
 * the screen and never a verdict on who wrote what: an agent with no declared
 * rule, or a screen whose box can't be found, reads as `unknown`.
 */

const ALT_SCREEN_ENTER = "\x1b[?1049h";

// eslint-disable-next-line no-control-regex -- the serializer's own SGR sequences
const SGR = /\x1b\[([0-9;:]*)m/g;

const TOKEN =
  // eslint-disable-next-line no-control-regex -- walks the serializer's own escape sequences
  /\x1b\[([0-9;:]*)m|\x1b\[(\d*)C|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b\[[0-9;:?<=>]*[ -/]*[@-~]|\x1b[^[\]]|[^\x1b]/gu;

/** The rows the generic drop treats as an input box: any prompt glyph, then a gap. */
const GENERIC_PROMPT_ROW = /^\s*(?:❯|›|>)\s/;

/** Rows below the prompt row a box may run to before its bottom edge. */
const MAX_BOX_ROWS = 40;

/**
 * Characters of `inputLine.text` kept. The status answer splits one response
 * budget across a fleet, and its tails are what shrink: a fleet of long drafts
 * would otherwise overrun it on this field alone.
 */
export const INPUT_LINE_TEXT_MAX_CHARS = 200;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Cap on CUF expansion, matching the plain-text read's own. */
const MAX_CURSOR_FORWARD = 1000;

interface Cell {
  /** One code point, or one space a cursor-forward stands for. */
  char: string;
  dim: boolean;
  inverse: boolean;
  /** Where the cell's text sits in its row, as string offsets. */
  start: number;
  end: number;
}

interface SgrState {
  dim: boolean;
  inverse: boolean;
}

/**
 * The state after an SGR with these parameters. A colon group (`4:2` double
 * underline, `38:2::255:0:0`) is one code with sub-parameters, so only its
 * first number counts; `;`-separated colours skip their arguments, so an RGB
 * component of 2 or 7 is never read as dim or inverse.
 */
function applySgr(state: SgrState, params: string): SgrState {
  if (params === "") return { dim: false, inverse: false };
  let { dim, inverse } = state;
  const parts = params.split(";");
  for (let i = 0; i < parts.length; i++) {
    const code = Number(parts[i]!.split(":")[0]);
    if ((code === 38 || code === 48 || code === 58) && !parts[i]!.includes(":")) {
      i += parts[i + 1] === "5" ? 2 : parts[i + 1] === "2" ? 4 : 0;
    } else if (code === 0) {
      dim = false;
      inverse = false;
    } else if (code === 2) {
      dim = true;
    } else if (code === 22) {
      dim = false;
    } else if (code === 7) {
      inverse = true;
    } else if (code === 27) {
      inverse = false;
    }
  }
  return { dim, inverse };
}

/** A row's cells, with the SGR state it starts in carried in and the state it ends in returned. */
function rowCells(row: string, state: SgrState): { cells: Cell[]; state: SgrState } {
  const cells: Cell[] = [];
  let current = state;
  for (const match of row.matchAll(TOKEN)) {
    const token = match[0];
    const index = match.index;
    if (match[1] !== undefined) {
      current = applySgr(current, match[1]);
    } else if (match[2] !== undefined) {
      const parsed = match[2] === "" ? 1 : Number.parseInt(match[2], 10);
      const count = Math.min(
        Number.isFinite(parsed) && parsed > 0 ? parsed : 1,
        MAX_CURSOR_FORWARD
      );
      for (let i = 0; i < count; i++) {
        cells.push({ char: " ", dim: current.dim, inverse: false, start: index, end: index });
      }
    } else if (token.codePointAt(0)! >= 0x20) {
      cells.push({
        char: token,
        dim: current.dim,
        inverse: current.inverse,
        start: index,
        end: index + token.length,
      });
    }
  }
  return { cells, state: current };
}

function plainOf(cells: readonly Cell[]): string {
  return cells.map((cell) => cell.char).join("");
}

function isBlank(cell: Cell): boolean {
  return cell.char.trim() === "";
}

/** The SGR state after `text`, walking only its SGR sequences. */
function stateAfter(text: string, state: SgrState): SgrState {
  let current = state;
  for (const match of text.matchAll(SGR)) current = applySgr(current, match[1]!);
  return current;
}

/**
 * The rows on view. Only what follows the serializer's own switch into the
 * alternate screen is on screen; the normal buffer beneath it is kept as
 * `prefix` so a rewrite can put it back.
 */
interface ScreenRows {
  prefix: string;
  rows: string[];
  /** Row `i` as plain text, for matching a box's rows; read from the bottom, so built on demand. */
  plain(i: number): string;
}

function readRows(serialized: string): ScreenRows {
  const switchAt = serialized.lastIndexOf(ALT_SCREEN_ENTER);
  const split = switchAt === -1 ? 0 : switchAt + ALT_SCREEN_ENTER.length;
  const rows = serialized.slice(split).split("\n");
  const plain = new Map<number, string>();
  return {
    prefix: serialized.slice(0, split),
    rows,
    plain: (i) => {
      let text = plain.get(i);
      if (text === undefined) {
        text = stripAnsiCodes(expandCursorForward(rows[i]!));
        plain.set(i, text);
      }
      return text;
    },
  };
}

/**
 * The cells of rows `from` to `to`, inclusive. SGR state carries across rows,
 * so it is walked from the very top of the serialized screen.
 */
function cellsOf(screen: ScreenRows, from: number, to: number): Cell[][] {
  let state = stateAfter(screen.prefix, { dim: false, inverse: false });
  for (let r = 0; r < from; r++) state = stateAfter(screen.rows[r]!, state);
  const out: Cell[][] = [];
  for (let r = from; r <= to; r++) {
    const read = rowCells(screen.rows[r]!, state);
    state = read.state;
    out.push(read.cells);
  }
  return out;
}

interface CompiledRule {
  promptRow: RegExp;
  border: RegExp;
  placeholders: RegExp[];
}

const compiled = new WeakMap<AgentInputSuggestionConfig, CompiledRule>();

function compile(rule: AgentInputSuggestionConfig): CompiledRule {
  let entry = compiled.get(rule);
  if (entry === undefined) {
    entry = {
      promptRow: new RegExp(rule.promptRowPattern, "u"),
      border: new RegExp(rule.borderPattern, "u"),
      placeholders: (rule.placeholderPatterns ?? []).map((pattern) => new RegExp(pattern, "u")),
    };
    compiled.set(rule, entry);
  }
  return entry;
}

/** One box row's content cells: past the prompt glyph on the first row, past the indent on the rest. */
interface BoxRow {
  row: number;
  cells: Cell[];
}

/**
 * The input box: the last row that opens with the prompt glyph directly under
 * the box's top edge, down to its bottom edge, every row between indented or
 * blank as the box draws them. Rows that open with the glyph anywhere else are
 * echoes of messages already sent; an echo that happens to sit under a rule
 * runs into unindented transcript or a dialog before any edge, so it is no box.
 */
function findBox(screen: ScreenRows, rule: CompiledRule): BoxRow[] | null {
  candidates: for (let i = screen.rows.length - 1; i > 0; i--) {
    const match = rule.promptRow.exec(screen.plain(i));
    if (match === null || !rule.border.test(screen.plain(i - 1))) continue;
    for (let r = i + 1; r < screen.rows.length && r <= i + MAX_BOX_ROWS; r++) {
      const row = screen.plain(r);
      if (rule.border.test(row)) return boxRows(screen, i, r - 1, Array.from(match[0]).length);
      if (row.trim() !== "" && !/^\s/u.test(row)) continue candidates;
    }
  }
  return null;
}

function boxRows(screen: ScreenRows, from: number, to: number, skip: number): BoxRow[] {
  return cellsOf(screen, from, to).map((row, index) => {
    if (index === 0) return { row: from, cells: row.slice(skip) };
    const indent = row.findIndex((cell) => !isBlank(cell));
    return { row: from + index, cells: indent === -1 ? [] : row.slice(indent) };
  });
}

/**
 * The cells drawn as suggestion. A CLI that paints its own cursor in a focused
 * pane inverts the first character and dims only the rest (`ESC[7mm ESC[27;2m
 * erge #2079`), so an inverse grapheme opening the box counts with the dim run
 * it leads into. The serializer writes a dim space after it as a bare cursor
 * move, so blanks are passed over on the way to that run.
 */
function suggestionCells(box: readonly BoxRow[]): Set<Cell> {
  const dim = new Set(box.flatMap((row) => row.cells.filter((cell) => cell.dim)));
  const cells = box[0]!.cells;
  const start = cells.findIndex((cell) => !isBlank(cell) || cell.inverse);
  if (start === -1) return dim;
  let end = start;
  while (end < cells.length && cells[end]!.inverse && !cells[end]!.dim) end++;
  const cursor = cells.slice(start, end);
  const next = cells.slice(end).find((cell) => !isBlank(cell));
  if (
    cursor.length > 0 &&
    next?.dim === true &&
    Array.from(graphemes.segment(plainOf(cursor))).length === 1
  ) {
    for (const cell of cursor) dim.add(cell);
  }
  return dim;
}

function boxText(box: readonly BoxRow[], keep: (cell: Cell) => boolean): string {
  return box
    .map((row) => plainOf(row.cells.filter(keep)).trimEnd())
    .join("\n")
    .trim();
}

interface Reading {
  inputLine: TerminalInputLine;
  screen: ScreenRows | null;
  box: BoxRow[] | null;
  /** The cells the box draws as suggestion or placeholder. */
  styled: Set<Cell>;
  /** The whole suggestion, before `inputLine.text` is bounded. */
  suggestion?: string;
}

function read(serialized: string, rule: AgentInputSuggestionConfig | undefined): Reading {
  const unknown: Reading = {
    inputLine: { state: "unknown", text: "" },
    screen: null,
    box: null,
    styled: new Set(),
  };
  if (rule === undefined) return unknown;
  const compiledRule = compile(rule);
  const screen = readRows(serialized);
  const box = findBox(screen, compiledRule);
  if (box === null) return { ...unknown, screen };
  const styled = suggestionCells(box);
  const visible = box.flatMap((row) => row.cells.filter((cell) => !isBlank(cell)));
  const base = { screen, box, styled };
  if (visible.length === 0) return { ...base, inputLine: { state: "empty", text: "" } };
  if (visible.every((cell) => styled.has(cell))) {
    const text = boxText(box, (cell) => styled.has(cell) || isBlank(cell));
    if (compiledRule.placeholders.some((pattern) => pattern.test(text))) {
      return { ...base, inputLine: { state: "empty", text: "" } };
    }
    return { ...base, inputLine: bounded("suggestion", text), suggestion: text };
  }
  // A dim hint beside typed text (a slash command's argument hint) is not typed.
  return {
    ...base,
    inputLine: bounded(
      "typed",
      boxText(box, (cell) => !styled.has(cell))
    ),
  };
}

function bounded(state: "typed" | "suggestion", text: string): TerminalInputLine {
  const chars = Array.from(text);
  return chars.length <= INPUT_LINE_TEXT_MAX_CHARS
    ? { state, text }
    : { state, text: chars.slice(0, INPUT_LINE_TEXT_MAX_CHARS).join(""), truncated: true };
}

function rebuild(screen: ScreenRows, rows: readonly string[]): string {
  return screen.prefix + rows.join("\n");
}

export interface InputLineObservation {
  inputLine: TerminalInputLine;
  /**
   * The serialized screen with a suggestion marked in place as plain text
   * (`❯ [suggested by Claude Code: open the PR]`), for a read that strips
   * ANSI; the input unchanged when the box holds none. Never for a raw read,
   * which stays byte-faithful.
   */
  marked: string;
}

/** Read the input box of `serialized` by `rule`; with no rule the box reads as `unknown`. */
export function observeInputLine(
  serialized: string,
  rule: AgentInputSuggestionConfig | undefined
): InputLineObservation {
  const reading = read(serialized, rule);
  if (reading.inputLine.state !== "suggestion" || reading.screen === null || rule === undefined) {
    return { inputLine: reading.inputLine, marked: serialized };
  }
  // The whole mark goes on the prompt row and the rows the suggestion wrapped
  // onto are emptied, so no cut of the tail can keep its words without it.
  const box = reading.box!;
  const rows = [...reading.screen.rows];
  for (const row of box.slice(1)) {
    rows[row.row] = removeCells(
      rows[row.row]!,
      row.cells.filter((cell) => reading.styled.has(cell))
    );
  }
  const first = box[0]!;
  const styled = first.cells.filter((cell) => reading.styled.has(cell));
  // Every cell taken out sits at or after the first, so its offset holds.
  const row = rows[first.row]!;
  const at = styled[0]?.start ?? row.replace(/\r$/, "").length;
  const mark = `[suggested by ${rule.label}: ${reading.suggestion!.replace(/\n/g, " ")}]`;
  const kept = removeCells(row, styled);
  rows[first.row] = kept.slice(0, at) + mark + kept.slice(at);
  return { inputLine: reading.inputLine, marked: rebuild(reading.screen, rows) };
}

/**
 * The serialized screen with the input box's suggestion taken out, for a
 * reader that wants only what is on screen for certain (Canopy). By `rule`
 * when the box is found, which also takes a painted cursor's first cell;
 * otherwise every dim run on the last row that opens with a prompt glyph, the
 * generic drop every other agent keeps.
 */
export function dropInputSuggestion(serialized: string, rule?: AgentInputSuggestionConfig): string {
  const reading = read(serialized, rule);
  if (reading.box !== null && reading.screen !== null) {
    const rows = [...reading.screen.rows];
    for (const box of [...reading.box].reverse()) {
      const drop = box.cells.filter((cell) => reading.styled.has(cell));
      rows[box.row] = removeCells(rows[box.row]!, drop);
    }
    return rebuild(reading.screen, rows);
  }
  const screen = reading.screen ?? readRows(serialized);
  for (let i = screen.rows.length - 1; i >= 0; i--) {
    if (!GENERIC_PROMPT_ROW.test(screen.plain(i))) continue;
    const rows = [...screen.rows];
    rows[i] = removeCells(
      rows[i]!,
      cellsOf(screen, i, i)[0]!.filter((cell) => cell.dim)
    );
    return rebuild(screen, rows);
  }
  return serialized;
}

/** `row` without the text of `cells`, keeping every escape sequence around them. */
function removeCells(row: string, cells: readonly Cell[]): string {
  const sorted = cells.filter((cell) => cell.end > cell.start).sort((a, b) => b.start - a.start);
  let out = row;
  for (const cell of sorted) out = out.slice(0, cell.start) + out.slice(cell.end);
  return out;
}

/** The suggestion rule an agent declares, by the id a terminal reports for it. */
export function inputSuggestionRuleFor(
  agentId: string | null | undefined
): AgentInputSuggestionConfig | undefined {
  if (agentId === null || agentId === undefined) return undefined;
  return getEffectiveAgentConfig(agentId)?.inputSuggestion;
}

/**
 * The MCP terminal reads' capture (`terminal.getOutput`, `terminal.getStatus`
 * on both surfaces): the tail as `tailCapturedOutput` gives it, with a
 * suggestion marked in place on a plain-text read, and what the input box
 * holds. The box is read off the whole screen, so it is reported even when the
 * tail is cut above it.
 */
export function captureTerminalTail(
  serialized: string,
  maxLines: number,
  stripAnsi: boolean,
  agentId: string | null | undefined
): { content: string; lineCount: number; truncated: boolean; inputLine: TerminalInputLine } {
  const { inputLine, marked } = observeInputLine(serialized, inputSuggestionRuleFor(agentId));
  return {
    ...tailCapturedOutput(stripAnsi ? marked : serialized, maxLines, stripAnsi),
    inputLine,
  };
}
