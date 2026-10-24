import { NOTIFY_REPLY_MAX_CHARS } from "../../../shared/types/terminalNotify.js";
import { tailCapturedOutput } from "../../../shared/utils/artifactParser.js";
import { detectHandback } from "../pty/HandbackDetector.js";

/** The target's last screen lines, captured when its notice fired. */
export interface NoticeReply {
  text: string;
  lineCount: number;
  /** Earlier lines were left out, by the line count or the character cap. */
  truncated: boolean;
}

/**
 * Rows read off the screen before a quote is cut down to its line count: more
 * than any pane is tall. Grok pins its transcript to the top of a tall pane,
 * so on a 90-row screen the reply sits some 70 rows above the composer.
 */
export const REPLY_SEARCH_ROWS = 500;

const HANDBACK_END_MARKERS = /\bEND-([a-z0-9]{6})\b/g;

/**
 * A closing marker a TUI wrapped at its hyphen: `END-` ends one row and the
 * code starts the next. Codex and Grok both wrap that way.
 */
const HANDBACK_END_SPLIT_HEAD = /\bEND-[\s─-▟|]*$/u;
const HANDBACK_END_SPLIT_TAIL = /^[\s─-▟⎿⏺|>›❯•●◦·]*([a-z0-9]{6})\b/u;

/** Block elements, which TUIs paint their scrollbars with. */
const BLOCK_GLYPH = /[▀-▟]/u;

/** Rows a column of block glyphs must span before it is taken for a scrollbar. */
const SCROLLBAR_MIN_ROWS = 3;

/**
 * Terminal-query replies a CLI echoed as caret text before it took raw input
 * (`^[_Gi=31;OK^[\` for the graphics probe, `^[[?62;4c` for device
 * attributes). They say nothing about the reply and read as garbage.
 */
const ECHOED_QUERY_REPLIES = /\^\[_G[^^\n]*\^\[\\|\^\[\[\?[0-9;]*c/g;

/**
 * Where a row ends in a block glyph set apart from the rest of it — alone on
 * the row, or after a gap of two or more spaces — or -1.
 */
function trailingBlockColumn(row: string): number {
  const trimmed = row.trimEnd();
  const column = trimmed.length - 1;
  if (column < 0 || !BLOCK_GLYPH.test(trimmed[column])) return -1;
  const before = trimmed.slice(0, column);
  return before.trim() === "" || before.endsWith("  ") ? column : -1;
}

/**
 * The screen's rows with a scrollbar taken out and blank runs collapsed to
 * one. Grok paints a scrollbar down every empty row of its transcript, which
 * would otherwise keep those rows from collapsing. Only an unbroken run of
 * rows with a set-apart block glyph in the same column counts, so a block or
 * two in a reply stay.
 */
function replyRows(content: string): string[] {
  const raw = content.replace(ECHOED_QUERY_REPLIES, "").split("\n");
  const columns = raw.map(trailingBlockColumn);
  const scrollbar = new Array<boolean>(raw.length).fill(false);
  let runStart = 0;
  for (let i = 1; i <= raw.length; i++) {
    if (i < raw.length && columns[i] !== -1 && columns[i] === columns[runStart]) continue;
    if (columns[runStart] !== -1 && i - runStart >= SCROLLBAR_MIN_ROWS) {
      scrollbar.fill(true, runStart, i);
    }
    runStart = i;
  }
  const rows: string[] = [];
  raw.forEach((line, index) => {
    const row = scrollbar[index] ? line.slice(0, columns[index]).trimEnd() : line;
    if (row.trim() === "" && rows.length > 0 && rows[rows.length - 1].trim() === "") return;
    rows.push(row);
  });
  return rows;
}

/** The last closing marker on row `i`, wrapped onto the next row or not. */
function closingMarkerAt(
  rows: readonly string[],
  i: number
): { endRow: number; code: string } | null {
  let code: string | undefined;
  for (const match of rows[i].matchAll(HANDBACK_END_MARKERS)) code = match[1];
  if (code !== undefined) return { endRow: i, code };
  if (i + 1 < rows.length && HANDBACK_END_SPLIT_HEAD.test(rows[i])) {
    const tail = HANDBACK_END_SPLIT_TAIL.exec(rows[i + 1]);
    if (tail !== null) return { endRow: i + 1, code: tail[1] };
  }
  return null;
}

/** Rows searched above a closing marker for its opening one: a capped summary wraps to fewer. */
const MAX_MARKER_ROWS = 40;

const HANDBACK_START_SPLIT_HEAD = /DAINTREE-DONE-[\s─-▟|]*$/u;

/** The row the opening marker for `code` nearest above row `from` starts on; -1 when none. */
function openingRowFor(rows: readonly string[], code: string, from: number): number {
  const start = `DAINTREE-DONE-${code}`;
  const splitTail = new RegExp(`^[\\s\\u2500-\\u259f\\u23bf\\u23fa|>›❯•●◦·]*${code}\\b`, "u");
  for (let r = from; r >= 0 && r >= from - MAX_MARKER_ROWS; r--) {
    if (rows[r].includes(start)) return r;
    if (
      r + 1 < rows.length &&
      HANDBACK_START_SPLIT_HEAD.test(rows[r]) &&
      splitTail.test(rows[r + 1])
    ) {
      return r;
    }
  }
  return -1;
}

/** The marker a notice or wait saw: its summary, and its code when the observation named it. */
export interface ObservedMarker {
  message: string | null;
  code?: string;
}

/**
 * The row the handback marker closes on, searching up from the bottom; -1 when
 * there is none. Each candidate is the exact pair its closing row belongs to,
 * judged by the detector the pty-host uses — never the echoed instruction, a
 * spinner's status line or a marker left open. When the marker observed is
 * known it must be that marker: the same code, or, with no code to go on, the
 * same summary. That keeps a quote from ending at an earlier turn's marker
 * still on screen, or another prompt's.
 */
function findHandbackEndRow(rows: readonly string[], observed: ObservedMarker | true): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    const marker = closingMarkerAt(rows, i);
    if (marker === null) continue;
    if (observed !== true && observed.code !== undefined && marker.code !== observed.code) {
      continue;
    }
    const opening = openingRowFor(rows, marker.code, i);
    if (opening === -1) continue;
    // The pair must close on this row: one already complete above it, with a
    // stray closing marker below, ends there instead.
    if (opening < i && detectHandback(rows.slice(opening, i).join("\n"), marker.code) !== null) {
      continue;
    }
    const pair = rows.slice(opening, marker.endRow + 1).join("\n");
    const match = detectHandback(pair, marker.code);
    if (match === null) continue;
    if (observed !== true && observed.code === undefined && match.message !== observed.message) {
      continue;
    }
    return marker.endRow;
  }
  return -1;
}

export interface ExtractedReply {
  reply: NoticeReply | null;
  /** The quote ends at the agent's handback marker. */
  reachedHandback: boolean;
}

/**
 * The reply a notice quotes: the last `lines` screen lines of `serialized`,
 * ANSI stripped. When the agent printed the handback it was asked for, the
 * quote ends at that marker wherever it sits on the screen, which drops the
 * composer and status rows an agent TUI draws below its reply. `endAt` is the
 * marker observed, when known, or `true` for any marker the detector accepts.
 */
export function extractReply(
  serialized: string,
  lines: number,
  endAt: ObservedMarker | boolean,
  maxChars: number = NOTIFY_REPLY_MAX_CHARS
): ExtractedReply {
  if (lines <= 0) return { reply: null, reachedHandback: false };
  const tail = tailCapturedOutput(serialized, REPLY_SEARCH_ROWS, true);
  let rows = replyRows(tail.content);
  let truncated = tail.truncated;
  let reachedHandback = false;
  if (endAt !== false) {
    const marker = findHandbackEndRow(rows, endAt);
    if (marker !== -1) {
      rows = rows.slice(0, marker + 1);
      reachedHandback = true;
    }
  }
  while (rows.length > 0 && rows[rows.length - 1].trim() === "") rows.pop();
  if (rows.length > lines) {
    rows = rows.slice(-lines);
    truncated = true;
  }
  while (rows.length > 0 && rows[0].trim() === "") rows.shift();
  let text = rows.join("\n");
  if (text.length > maxChars) {
    text = cutToNewestChars(text, maxChars);
    truncated = true;
  }
  if (text.length === 0) return { reply: null, reachedHandback: false };
  return { reply: { text, lineCount: text.split("\n").length, truncated }, reachedHandback };
}

/** {@link extractReply}'s quote alone. Null when there is nothing to quote. */
export function extractNoticeReply(
  serialized: string,
  lines: number,
  endAtHandback: boolean
): NoticeReply | null {
  return extractReply(serialized, lines, endAtHandback).reply;
}

/** The newest `max` characters of `text`, starting on a whole line where one fits. */
export function cutToNewestChars(text: string, max: number): string {
  const cut = text.slice(-max);
  const firstBreak = cut.indexOf("\n");
  return firstBreak !== -1 && firstBreak < cut.length - 1 ? cut.slice(firstBreak + 1) : cut;
}
