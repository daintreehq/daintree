import { createHash } from "node:crypto";

/**
 * Box frames and quote gutters agent CLIs draw around dialogs. Taken off both
 * ends of a row so the classifier reads the words, not the frame.
 */
const FRAME = /^[\s│▌╭╮╰╯─┃┏┓┗┛║]+|[\s│▌╭╮╰╯─┃┏┓┗┛║]+$/g;

/**
 * Rows every agent draws permanently — its empty input box and status footer.
 *
 * They are always on screen, so to a reader they look like a prompt waiting
 * for input. Leaving them in made the classifier pick "Ask Codex to do
 * anything" as the question being asked on a third of finished runs.
 */
const CHROME =
  /^(?:>|›|❯)\s*(?:Ask Codex to do anything|Type your message or @path\/to\/file)?\s*$|accept edits on \(shift\+tab|\d+% context left|Context left(?: until auto-compact)?: \d+%|\? for shortcuts|no sandbox\s+\S|bypass permissions on|⏵⏵\s*(?:auto mode|accept edits|bypass permissions|plan mode) on\b|auto mode on \(shift\+tab|⏸\s*(?:manual|plan|auto) mode on\b|Transcript saving is off\b/;

/**
 * The suggestion an empty input box shows as placeholder text: Claude Code's
 * `> Try "fix typecheck errors"`, and Codex's rotating `› Explain this
 * codebase`-style prompts. They read exactly like a question to a classifier —
 * a live session was carded as asking "Try "fix typecheck errors"" — and they
 * are never something the agent asked.
 */
const PLACEHOLDER =
  /^(?:>|›|❯)\s*(?:Try ".*"|Explain this codebase|Summarize recent commits|Implement \{feature\}|Find and fix a bug in @filename|Write tests for @filename|Improve documentation in @filename|Run \/review on my current changes|Use \/skills to list available skills)\s*$/;

/**
 * Other CLIs' empty-input placeholders, drawn with or without a prompt glyph:
 * Copilot, OpenCode, Mistral Vibe and Kiro. The classifier picked each as the
 * question or the status line on synthetic screens.
 */
const OTHER_PLACEHOLDER =
  /^(?:>|›|❯|┃)?\s*(?:Enter @ to mention files or \/ for commands|Ask anything\.\.\.(?:\s+".*")?|Ask Vibe anything or type \/ for commands\.\.\.|Ask about your codebase)\s*$/;

/**
 * Obvious credentials, so the screen that leaves the machine carries none of
 * them. A best-effort net, not a guarantee: anything shaped like a known key
 * or an `x=secret` assignment is replaced before the text is sent.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|pk|rk)-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b(Bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  // `KEY=value`, `export FOO_API_KEY=value`, `"token": "value"`, `password: value`.
  // The name may carry a prefix (`OPENAI_API_KEY`), which a word boundary
  // before `api` would miss.
  // A quoted value is taken whole, spaces and escaped quotes included.
  /([A-Za-z0-9_]{0,64}(?:api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*)(["'])(?:\\.|(?!\2)[^\\])*\2/gi,
  /([A-Za-z0-9_]{0,64}(?:api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*)[^\s"',}]{6,}/gi,
  // A password however short: `password: abc` is still a password. A value an
  // earlier pattern already replaced is left as it is.
  /([A-Za-z0-9_]{0,64}(?:password|passwd)["']?\s*[:=]\s*)(?!\[redacted\])[^\s"',}]+/gi,
  // Credentials in a connection string: `postgres://user:pass@host`, or a
  // password alone, `redis://:pass@host`. The scheme is bounded so a long run
  // of word characters can't be rescanned from every position.
  /(\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:@/]{0,256}:)(?!\[redacted\]@)[^\s@/]+(?=@)/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, prefix?: unknown) => {
      if (typeof prefix !== "string" || !match.startsWith(prefix)) return "[redacted]";
      return /[\s:=]$/.test(prefix) ? `${prefix}[redacted]` : `${prefix} [redacted]`;
    });
  }
  return out;
}

export interface PreparedScreen {
  /** Cleaned rows, newest last. */
  lines: string[];
  /** The cleaned rows joined, already redacted — the only form that is sent. */
  text: string;
  /**
   * Identity of the screen for change detection. Digits are folded so a ticking
   * spinner timer ("38s", "2.1k tokens") does not count as a change; anything
   * else that moves on screen does.
   */
  hash: string;
  /** The newest meaningful row, for the card's live activity line. */
  activity: string | null;
  /**
   * How much of the agent's context window is left, in percent, as its own
   * footer says; null when the footer shows none. Read before the footer is
   * stripped, since the footer is where it lives.
   */
  contextLeft: number | null;
  /** The pane's width the rows were joined at; absent when they were left as drawn. */
  cols?: number;
}

/**
 * Context left as each CLI's footer prints it: Codex "42% context left",
 * Claude Code "Context left until auto-compact: 12%", and the used share Grok
 * ("20K / 256K (8%)") and OpenCode ("16.4K (13%)") show instead.
 */
const CONTEXT_LEFT = [
  /\b(\d{1,3})% context left\b/i,
  /\bContext left(?: until auto-compact)?: (\d{1,3})%/i,
];
const CONTEXT_USED = [
  /\b\d+(?:\.\d+)?K \/ \d+(?:\.\d+)?K \((\d{1,3})%\)/,
  /^\s*BUILD\s+\d+(?:\.\d+)?K \((\d{1,3})%\)/,
];

function findContextLeft(rows: readonly string[]): number | null {
  for (let i = rows.length - 1; i >= Math.max(0, rows.length - 8); i--) {
    const row = rows[i]!;
    for (const pattern of CONTEXT_LEFT) {
      const match = pattern.exec(row);
      if (match) return Math.min(100, Number(match[1]));
    }
    for (const pattern of CONTEXT_USED) {
      const match = pattern.exec(row);
      if (match) return Math.max(0, 100 - Number(match[1]));
    }
  }
  return null;
}

/**
 * What only moves because time passes: spinner frames, elapsed timers, token
 * counters, retry attempts. Folded for the change hash so a working agent's
 * ticking status line is not a new screen — and nothing else is, so a real
 * question that differs only by a number still counts as changed.
 */
const TICKING = [
  /[✻✶✢✳✽✺·*⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒]/g,
  /\b\d+[hm]\s?\d+[ms]\b/g,
  /\b\d+(?:\.\d+)?\s?(?:ms|s|m|h|k)\b/g,
  /\b\d+(?:\.\d+)?k?\s+tokens\b/g,
  /\battempt \d+\/\d+/g,
];

export function foldTicking(text: string): string {
  // A line asking something keeps its numbers: "a timeout of 5s?" and "of
  // 60s?" ask different things. Status lines don't end in a question.
  let out = text
    .split("\n")
    .map((line) => {
      if (/\?\s*$/.test(line)) return line;
      let folded = line;
      for (const pattern of TICKING) folded = folded.replace(pattern, "#");
      return folded;
    })
    .join("\n");
  out = out.replace(/#(?:\s*#)+/g, "#");
  // A status line cut off at the pane's width ("… · /ps to view · …") shifts
  // its cut a character each time its timer grows a digit, so what follows the
  // timer on such a line is folded too — a 9m59s → 10m00s tick is not a new screen.
  return out.replace(/#[^#\n]*…[ \t]*$/gm, "#…");
}

/**
 * Whether the bottom of `raw` (a deeper read of the same terminal) still shows
 * `screen`'s last rows, ticking timers aside. A history read lands after the
 * screen it goes with was read; if the terminal moved in between, the history
 * describes a newer screen and the two must not be put together.
 */
export function sameScreenTail(screen: PreparedScreen, raw: string, rows = 4): boolean {
  const shown = screen.lines.filter((line) => line.trim() !== "");
  const count = Math.min(rows, shown.length);
  if (count === 0) return true;
  const mine = shown.slice(-count).map(foldTicking);
  const theirs = prepareScreen(raw, screen.cols)
    .lines.filter((line) => line.trim() !== "")
    .slice(-count)
    .map(foldTicking);
  if (theirs.length !== mine.length) return false;
  // When the compared rows reach the screen's first line, that line can be the
  // tail of one wrapped across the screen's top edge, which the deeper read
  // holds whole: it only has to end the same way.
  const reachesTop = count === shown.length;
  return mine.every((line, i) =>
    i === 0 && reachesTop ? theirs[i]!.endsWith(line) : theirs[i] === line
  );
}

/** Rows of `since_last_reading` sent at most, newest kept. */
export const SINCE_LAST_READING_ROWS = 80;
/** Bytes of `since_last_reading` sent at most, newest kept. */
const SINCE_LAST_READING_CHARS = 6_000;
/** Rows of the previous screen matched together to find it again in the history. */
const ANCHOR_ROWS = 3;

/**
 * The rows that scrolled up out of view between two readings: what the
 * history shows after the last reading's screen and above the current one.
 * The last screen is found again by a run of its own rows, tried from its
 * bottom up — its live bottom rows (a spinner, a prompt) are often redrawn and
 * never reach the history. Null when it cannot be found (it scrolled beyond
 * what was read, or the agent redrew it) or nothing scrolled away; the reader
 * then works from its note alone. Ticking timers are folded for the match only.
 */
export function scrolledSince(
  previous: readonly string[],
  history: readonly string[],
  current: readonly string[]
): string | null {
  const rows = (lines: readonly string[]) => lines.filter((line) => line.trim() !== "");
  const prev = rows(previous).map(foldTicking);
  const hist = rows(history);
  const folded = hist.map(foldTicking);
  const shown = rows(current);
  if (prev.length < ANCHOR_ROWS || shown.length === 0) return null;
  // Where the current screen begins in the history: its own top rows, found
  // last. Without it the cut cannot be placed. The screen's first line can be
  // the tail of a line wrapped across its top edge, which the history holds
  // whole, so the run is tried a line or two further down too.
  let currentStart = -1;
  for (let skip = 0; skip <= 2 && currentStart === -1; skip++) {
    const top = shown.slice(skip, skip + ANCHOR_ROWS).map(foldTicking);
    if (top.length < Math.min(ANCHOR_ROWS, shown.length - skip) || top.length === 0) break;
    const at = lastIndexOfRun(folded, top, folded.length);
    if (at !== -1) currentStart = Math.max(0, at - skip);
  }
  if (currentStart === -1) return null;
  for (let offset = 0; offset + ANCHOR_ROWS <= prev.length; offset++) {
    const end = prev.length - offset;
    const at = lastIndexOfRun(folded, prev.slice(end - ANCHOR_ROWS, end), folded.length);
    if (at === -1) continue;
    const from = at + ANCHOR_ROWS;
    // The last screen's rows are still on this one: nothing scrolled away.
    if (from >= currentStart) return null;
    let between = hist.slice(from, currentStart).slice(-SINCE_LAST_READING_ROWS);
    while (between.join("\n").length > SINCE_LAST_READING_CHARS && between.length > 1) {
      between = between.slice(1);
    }
    return between.join("\n");
  }
  return null;
}

/** The last index at which `run` starts in `lines`, with the run ending before `limit`. */
function lastIndexOfRun(lines: readonly string[], run: readonly string[], limit: number): number {
  for (let i = Math.min(limit, lines.length) - run.length; i >= 0; i--) {
    if (run.every((row, k) => lines[i + k] === row)) return i;
  }
  return -1;
}

/**
 * What opens a row the agent drew as a line of its own: a bullet, a tree
 * branch, a spinner, a prompt glyph, a list number or a checkbox. A row that
 * opens with one is never the tail of the row above.
 */
const LINE_START =
  /^(?:[⏺•●✦■⎿└├│┃▌✻✶✢✳✽✺·*❯›>→※◼◻☐☒✔✓✗✘⚠■□▶\-+–—#|]|\d+[.)](?:\s|$)|\[[ x]\]|[╭╰┌└─━═]|\[?\d{4}-\d{2}-\d{2}|\[?\d{2}:\d{2}:\d{2}|\[(?:INFO|WARN|ERROR|DEBUG)\b)/;

/** Columns a string takes in a terminal, counting wide characters as two. */
function cellWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    width +=
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff)
        ? 2
        : 1;
  }
  return width;
}

function indentOf(row: string): number {
  return row.length - row.trimStart().length;
}

/**
 * Puts back together the rows an agent wrapped itself. Codex and Claude Code
 * wrap their own text at the pane's width, so a question or a report reaches
 * the screen as several rows, and a reader shown one of them — "different
 * layout?" — quotes half a sentence. A row continues the one above when the
 * first word on it could not have fitted on that row (exactly how word wrap
 * breaks a line), it opens with no bullet or marker of its own, and it is
 * indented at least as deeply. Without the pane's width nothing is joined.
 */
export function joinWrappedRows(rows: readonly string[], cols: number | undefined): string[] {
  if (cols === undefined || cols < 20) return [...rows];
  const out: string[] = [];
  // The physical row the current logical line ends on: what the next one wraps from.
  let lastRow = "";
  for (const row of rows) {
    const text = row.trimEnd();
    const previous = out.length > 0 ? lastRow : "";
    const head = text.trimStart();
    const word = head.split(/\s/, 1)[0] ?? "";
    const continues =
      previous.trim() !== "" &&
      head !== "" &&
      !LINE_START.test(head) &&
      !/^[\s─━═╌]+$/.test(previous) &&
      indentOf(text) >= indentOf(out[out.length - 1]!) &&
      // A finished sentence followed by a capital is a new line as often as a
      // wrap; left apart, at worst one line reads as two.
      !(/[.!?:]$/.test(previous) && /^[A-Z]/.test(head)) &&
      // Wider than the pane, the row was wrapped by the terminal itself and
      // arrives whole; whatever follows it starts a line of its own.
      cellWidth(previous) <= cols &&
      cellWidth(previous) + 1 + cellWidth(word) > cols;
    if (continues) {
      // Word wrap breaks at a space and moves a word that fits on to the next
      // row, so only a token too long for a row — a path, a URL — is split mid
      // word: a path or a half-row token filling the row's edge, or one broken
      // after a hyphen or a slash. Prose that merely ends at the edge broke at
      // a space.
      const tail = previous.trimStart().split(/\s/).pop() ?? "";
      const split =
        /[-/]$/.test(previous) ||
        (cellWidth(previous) >= cols && (/[/\\]/.test(tail) || cellWidth(tail) >= cols / 2));
      const glue = split ? "" : " ";
      out[out.length - 1] = out[out.length - 1]!.trimEnd() + glue + head;
    } else {
      out.push(text);
    }
    lastRow = text;
  }
  return out;
}

/** A row of the agent's input box with something typed in it. */
const INPUT_ROW = /^(?:>|›|❯)\s+\S/;
/** A dialog's selected option, which some agents mark with the same glyph. */
const MENU_OPTION = /^(?:>|›|❯)\s*\d+[.)]\s/;
/** A status footer an agent draws under its input box: "GPT-6.1-Sol xhigh · ~/code". */
const FOOTER_ROW = /^[^✻✶✢✳✽⏺•●✦*].*\s·\s/;
/** The keys a dialog names under its choices: "Enter to confirm · Esc to cancel". */
const DIALOG_HINT =
  /\b(?:enter|esc|tab|space)\b[^·]*\bto\b|\bto (?:confirm|cancel|select|amend)\b/i;
/** A row the agent drew itself, or one of a menu's choices: never part of a draft. */
const NOT_DRAFT = /^(?:[⏺•●✦⎿└■✻✶✢✳✽✺]|(?:>|›|❯)\s|\d+[.)]\s)/;
/** The most rows a draft takes before it is more likely the agent's own output. */
const MAX_DRAFT_ROWS = 6;

/**
 * Takes out a reply the user is typing in the agent's input box: a block that
 * opens with a prompt glyph after a blank row, runs on for a few rows of plain
 * text (a draft written over several lines), and has nothing under it but the
 * agent's status footer. It is the user's words, not the agent's: read as part
 * of the screen, a half-typed "fix the tests" turned a finished turn into a
 * working one and rewrote its card, and it changes with every key, so it is
 * neither sent nor part of the screen's identity. A menu is never taken for
 * one: no numbered choice, no row the agent drew, no dialog's key hints.
 */
function dropDraft(lines: string[]): void {
  let end = lines.length - 1;
  let footers = 0;
  while (end >= 0) {
    const line = lines[end]!;
    if (line === "") end--;
    else if (
      footers < 2 &&
      FOOTER_ROW.test(line) &&
      !DIALOG_HINT.test(line) &&
      !INPUT_ROW.test(line)
    ) {
      footers++;
      end--;
    } else break;
  }
  if (end < 0) return;
  let start = end;
  while (start > 0 && lines[start - 1] !== "" && end - start < MAX_DRAFT_ROWS) start--;
  // The input box sits under the agent's output, a blank row above it: a block
  // at the top of what was read is history, not a draft.
  if (start === 0 || lines[start - 1] !== "") return;
  const head = lines[start]!;
  if (!INPUT_ROW.test(head) || MENU_OPTION.test(head) || DIALOG_HINT.test(head)) return;
  for (let row = start + 1; row <= end; row++) {
    const line = lines[row]!;
    if (NOT_DRAFT.test(line) || DIALOG_HINT.test(line)) return;
  }
  lines.splice(start, end - start + 1);
  // Blank runs are already one row; the draft's going must not make two.
  if (start > 0 && lines[start - 1] === "" && (start === lines.length || lines[start] === "")) {
    lines.splice(start - 1, 1);
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
}

export function prepareScreen(
  raw: string,
  /** The pane's width, to put wrapped rows back together; absent, rows stay as drawn. */
  cols?: number
): PreparedScreen {
  const lines: string[] = [];
  const rows = joinWrappedRows(raw.replace(/\r/g, "").split("\n"), cols);
  for (const row of rows) {
    const line = row.replace(FRAME, "").replace(/\s{3,}/g, "  ");
    if (CHROME.test(line) || PLACEHOLDER.test(line) || OTHER_PLACEHOLDER.test(line)) continue;
    // Collapse runs of blank rows; a dialog's spacing carries no meaning here.
    if (line.length === 0 && (lines.length === 0 || lines[lines.length - 1] === "")) continue;
    lines.push(line);
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  dropDraft(lines);
  const text = redactSecrets(lines.join("\n"));
  const hash = createHash("sha1").update(foldTicking(text)).digest("hex");
  return {
    lines: text.split("\n"),
    text,
    hash,
    activity: findActivity(lines),
    contextLeft: findContextLeft(rows),
    ...(cols !== undefined && cols >= 20 ? { cols } : {}),
  };
}

function findActivity(lines: readonly string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = cleanStatusLine(lines[i]!);
    if (line.length < 4) continue;
    return redactSecrets(line).slice(0, 160);
  }
  return null;
}

/**
 * A screen row as a row of the inbox shows it: the agent's bullet, a spinner
 * glyph and its ticking timer taken off, the words kept verbatim. Left on, the
 * glyph and the seconds changed the row's words on every read of a working agent.
 */
export function cleanStatusLine(line: string): string {
  let text = line.replace(/^\s*(?:[⏺•●✦⎿└■✻✶✢✳✽✺·*▌]\s*)+/, "");
  // Only the row's last parenthesis, and only a short one, is looked at: an
  // unanchored search tried every "(" on a long row, each against the rest.
  const open = text.lastIndexOf("(");
  if (open !== -1 && text.length - open <= TIMER_TAIL_CHARS && TIMER_TAIL.test(text.slice(open))) {
    text = text.slice(0, open);
  }
  return text.trim();
}

/** A spinner's trailing timer and key hint: "(12s · ↓ 1.2k tokens · esc to interrupt)". */
const TIMER_TAIL = /^\((?:\d[^)]*)?(?:esc to \w+|thinking|thought for|ctrl\+\w to \w+)[^)]*\)\s*$/;
const TIMER_TAIL_CHARS = 160;

export { isSecretPrompt } from "../../../shared/utils/secretPrompt.js";
