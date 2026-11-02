import type {
  ClaudeUsageStatement,
  ClaudeUsageWindow,
} from "../../../shared/types/ipc/agentQuota.js";
import { stripAnsi } from "./AgentPatternDetector.js";

/**
 * A Claude Code usage message as printed (#15727). `resetText` is terminal
 * content: it stays in the pty host and only {@link resolveResetsAt}'s epoch
 * leaves it.
 */
export interface ClaudeUsageMessage {
  window: ClaudeUsageWindow;
  statement: ClaudeUsageStatement;
  usedPercent: number | null;
  resetText: string | null;
}

/** Trailing rows read, as for the rate-limit banner: one far up is old news. */
const SCAN_LINES = 12;

/**
 * How far short of the pane's right edge a footer warning may end: Claude
 * draws it flush right behind a column of padding.
 */
const RIGHT_EDGE_SLACK = 4;

// What Claude draws a usage message behind: the tool-result gutter, a box or
// border, a warning sign. The diff, list, quote and prompt markers the
// rate-limit patterns also accept ("-", "*", ">", "❯") stay out: a message
// behind one is someone's text.
const CHROME = String.raw`[\s│┃╎╭╰─⎿⚠]*`;
// Border glyphs Claude may draw after a notification ("… ▔").
const TRAILING_BORDER = String.raw`[\s▔▁─━╮╯╗╝│┃]*`;
const WINDOW = String.raw`(5[ -]?hour|session|weekly|opus|sonnet|fable)`;
const YOUVE = String.raw`you(?:['’]ve|\s+have)`;
// A message ends its row or runs into " · resets …" / " · <hint>" segments;
// anything else after the limit is a sentence about one.
const TAIL = String.raw`(?:${TRAILING_BORDER}$|\s*[·∙•]\s*(.*)$)`;
const SEGMENT_SEPARATOR = /[·∙•]/;
const BORDER_GLYPHS = new Set("▔▁─━╮╯╗╝│┃");
// Claude's own segments never quote; code holding a message as a string does.
const CODE_DELIMITER = /["`]/;
const MESSAGE_START = /^(?:you|over|approaching)\b/i;
// What Claude's footer shows left of a warning: a key or mode glyph, then what
// it does: "? for shortcuts", "esc to clear", "⏵⏵ accept edits on (shift+tab
// to cycle)", "Press Ctrl-C again to exit".
const FOOTER_HINT =
  /^\s*(?:[?!]|⏵|⏸|esc\b|enter\b|tab\b|space\b|shift\+|ctrl[+-]|press\b|hold\b|paste\b)[\s\S]*?\b(?:for|to)\s+[a-z]/i;

interface Form {
  pattern: RegExp;
  statement: ClaudeUsageStatement;
  /** A form only a reset tail tells from prose. */
  needsReset?: true;
}

// Claude Code 2.1's warning is "You've used N% of your <window> limit",
// "Over N% of your <window> limit used" or "Approaching <window> limit", each
// with an optional " · resets <when>" and hint; a hit limit is "You've hit
// your <window> limit · resets <when>". Credit and spend limits ("usage credit
// limit", "team's shared budget") aren't quota windows and stay out.
const FORMS: readonly Form[] = [
  {
    pattern: new RegExp(
      String.raw`^${CHROME}${YOUVE}\s+used\s+(\d{1,3})%\s+of\s+your\s+${WINDOW}\s+limit${TAIL}`,
      "i"
    ),
    statement: "used",
  },
  {
    pattern: new RegExp(
      String.raw`^${CHROME}over\s+(\d{1,2})%\s+of\s+your\s+${WINDOW}\s+limit\s+used${TAIL}`,
      "i"
    ),
    statement: "over",
  },
  {
    pattern: new RegExp(String.raw`^${CHROME}approaching\s+${WINDOW}\s+limit${TAIL}`, "i"),
    statement: "approaching",
  },
  {
    pattern: new RegExp(
      String.raw`^${CHROME}${YOUVE}\s+(?:hit|reached)\s+your\s+${WINDOW}\s+limit${TAIL}`,
      "i"
    ),
    statement: "reached",
  },
  {
    pattern: new RegExp(
      String.raw`^${CHROME}${YOUVE}\s+(?:hit|reached)\s+your\s+(usage)\s+limit${TAIL}`,
      "i"
    ),
    statement: "reached",
  },
  {
    pattern: new RegExp(
      String.raw`^${CHROME}${YOUVE}\s+(?:hit|reached)\s+your\s+()limit${TAIL}`,
      "i"
    ),
    statement: "reached",
    needsReset: true,
  },
  // Older builds lead with the window: "5-hour limit reached ∙ resets 3pm".
  {
    pattern: new RegExp(String.raw`^${CHROME}(5[ -]?hour|session)\s+limit\s+reached${TAIL}`, "i"),
    statement: "reached",
    needsReset: true,
  },
];

const PERCENT_FORMS = new Set<ClaudeUsageStatement>(["used", "over"]);

const WINDOW_LABELS: Record<string, ClaudeUsageWindow> = {
  "": "limit",
  usage: "usage limit",
  session: "session limit",
  weekly: "weekly limit",
  opus: "Opus limit",
  sonnet: "Sonnet limit",
  fable: "Fable limit",
};

function windowOf(named: string): ClaudeUsageWindow {
  const word = named.toLowerCase();
  return word.startsWith("5") ? "5-hour limit" : WINDOW_LABELS[word]!;
}

interface MessageStart {
  text: string;
  /** Begins after a column gap rather than at the row's start. */
  atGap: boolean;
}

/**
 * Where on a row a message may start: the row's own start, or right after a
 * column gap on a row that reaches the pane's right edge with a key hint left
 * of the gap. That is where Claude draws its warning, flush right in the
 * prompt footer; a message after a gap anywhere else is someone's text.
 */
function messageStarts(row: string, cols: number | undefined): MessageStart[] {
  const starts: MessageStart[] = [{ text: row, atGap: false }];
  if (cols === undefined || row.trimEnd().length < cols - RIGHT_EDGE_SLACK) return starts;
  for (const gap of row.matchAll(/\S {2,}(?=\S)/g)) {
    const end = gap.index + gap[0].length;
    const text = row.slice(end);
    if (MESSAGE_START.test(text) && FOOTER_HINT.test(row.slice(0, end))) {
      starts.push({ text, atGap: true });
    }
  }
  return starts;
}

function withoutTrailingBorder(text: string): string {
  let end = text.length;
  while (end > 0 && (BORDER_GLYPHS.has(text[end - 1]!) || text[end - 1]!.trim() === "")) end--;
  return text.slice(0, end);
}

function segmentsOf(rest: string | undefined): string[] {
  if (rest === undefined) return [];
  return withoutTrailingBorder(rest)
    .split(SEGMENT_SEPARATOR)
    .map((segment) => segment.trim());
}

/**
 * A reset a narrow pane wrapped onto the next row: the rest of its time, or
 * the zone after it. Only a join that reads as a reset is taken, and one that
 * already reads only gains a zone, so an unrelated row under the message never
 * changes what it says.
 */
function carriedReset(text: string, next: string): string | null {
  const own = parseResetText(text);
  if (own !== null && own.zone !== undefined) return null;
  const carried = segmentsOf(next.trim())[0] ?? "";
  if (carried === "") return null;
  for (const joined of [`${text} ${carried}`.trim(), `${text}${carried}`]) {
    const parsed = parseResetText(joined);
    if (parsed === null) continue;
    // "(main)" under a bare time is a branch name, not the zone it lost.
    if (parsed.zone !== undefined && zoneFormat(parsed.zone) === null) continue;
    if (own === null || parsed.zone !== undefined) return joined;
  }
  return null;
}

function matchRow(
  row: string,
  next: string | undefined,
  cols: number | undefined
): ClaudeUsageMessage | null {
  if (!/limit/i.test(row)) return null;
  for (const start of messageStarts(row, cols)) {
    for (const form of FORMS) {
      const match = form.pattern.exec(start.text);
      if (match === null) continue;
      const percentForm = PERCENT_FORMS.has(form.statement);
      const named = percentForm ? match[2]! : match[1]!;
      const segments = segmentsOf(percentForm ? match[3] : match[2]);
      if (segments.some((segment) => CODE_DELIMITER.test(segment))) continue;
      const resetIndex = segments.findIndex((segment) => /^resets(?:\s|$)/i.test(segment));
      if (form.needsReset && resetIndex < 0) continue;
      const usedPercent = percentForm ? Number(match[1]) : null;
      if (usedPercent !== null && usedPercent > 100) continue;
      let resetText: string | null = null;
      if (resetIndex >= 0) {
        resetText = segments[resetIndex]!.slice("resets".length).trim();
        if (resetIndex === segments.length - 1 && next !== undefined) {
          resetText = carriedReset(resetText, next) ?? resetText;
        }
        // Claude truncates a footer warning that doesn't fit with "…"; any
        // other reset that doesn't read means the row isn't its footer.
        if (start.atGap && parseResetText(resetText) === null && !resetText.endsWith("…")) {
          continue;
        }
      }
      return { window: windowOf(named), statement: form.statement, usedPercent, resetText };
    }
  }
  return null;
}

/**
 * The Claude Code usage messages at the tail of a viewport, one per window,
 * the lowest on screen winning. Anchored like the rate-limit patterns, so a
 * row that only mentions a limit — prose, a diff, a quoted fixture — is never
 * read as one. `cols` is the pane's width, which places a footer warning.
 */
export function scanClaudeUsageMessages(
  lines: readonly string[],
  cols?: number
): ClaudeUsageMessage[] {
  const tail = lines.slice(-SCAN_LINES).map((line) => stripAnsi(line));
  const byWindow = new Map<ClaudeUsageWindow, ClaudeUsageMessage>();
  for (let i = 0; i < tail.length; i++) {
    const message = matchRow(tail[i]!, tail[i + 1], cols);
    if (message !== null) byWindow.set(message.window, message);
  }
  return [...byWindow.values()];
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Claude Code's reset: "3pm", "9:30am", "Oct 2 at 9pm", "Jan 3, 2027 at 9pm"
// (en-US, the year only when it isn't this one), then the IANA zone it used.
const RESET_TEXT =
  /^(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,\s*(\d{4}))?(?:,\s*|\s+at\s+))?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([A-Za-z][\w+-]*(?:\/[\w+-]+)*)\))?$/i;

interface ParsedReset {
  month: number | null;
  day: number | null;
  year: number | null;
  hour: number;
  minute: number;
  zone: string | undefined;
}

function parseResetText(text: string): ParsedReset | null {
  const match = RESET_TEXT.exec(text.trim());
  if (match === null) return null;
  const [, mon, day, year, hour, minute, meridiem, zone] = match;
  const month = mon === undefined ? null : MONTHS.indexOf(mon.toLowerCase());
  if (month === -1) return null;
  const h = Number(hour);
  const m = minute === undefined ? 0 : Number(minute);
  if (h < 1 || h > 12 || m > 59) return null;
  return {
    month,
    day: day === undefined ? null : Number(day),
    year: year === undefined ? null : Number(year),
    hour: (h % 12) + (meridiem!.toLowerCase() === "pm" ? 12 : 0),
    minute: m,
    zone,
  };
}

interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>();

function zoneFormat(zone: string | undefined): Intl.DateTimeFormat | null {
  const key = zone ?? "";
  let format = zoneFormats.get(key);
  if (format === undefined) {
    try {
      format = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
      });
    } catch {
      return null;
    }
    zoneFormats.set(key, format);
  }
  return format;
}

function wallTime(epoch: number, format: Intl.DateTimeFormat): WallTime {
  const parts = Object.fromEntries(
    format.formatToParts(epoch).map((part) => [part.type, Number(part.value)])
  );
  return {
    year: parts.year!,
    month: parts.month! - 1,
    day: parts.day!,
    hour: parts.hour! % 24,
    minute: parts.minute!,
  };
}

function wallAsUtc(wall: WallTime): number {
  return Date.UTC(wall.year, wall.month, wall.day, wall.hour, wall.minute);
}

const DAY_MS = 86_400_000;

/**
 * Every instant a zone's clock reads `wall`, earliest first: none in a
 * daylight-saving gap, two in a fold. Each candidate takes the zone's offset
 * from a day either side and is kept only if the clock reads `wall` there.
 */
function instantsOf(wall: WallTime, format: Intl.DateTimeFormat): number[] {
  const target = wallAsUtc(wall);
  const instants = new Set<number>();
  for (const probe of [target - DAY_MS, target, target + DAY_MS]) {
    const instant = target - (wallAsUtc(wallTime(probe, format)) - probe);
    if (wallAsUtc(wallTime(instant, format)) === target) instants.add(instant);
  }
  return [...instants].sort((a, b) => a - b);
}

/**
 * How far past a bare reset time a message may be seen and still mean today's.
 * Claude prints the reset's minute without its seconds, and the pane is read a
 * moment after it prints, so a time further back than this is tomorrow's.
 */
const JUST_PASSED_MS = 2 * 60_000;

/**
 * The epoch ms a printed reset names, read in the zone Claude printed beside
 * it (this machine's when it printed none), against when it was seen: a bare
 * time is its next showing, a date without a year is this year's. Null for a
 * reset that doesn't read as one, or names a time the zone's clock skips.
 */
export function resolveResetsAt(resetText: string | null, observedAt: number): number | null {
  if (resetText === null) return null;
  const reset = parseResetText(resetText);
  if (reset === null) return null;
  const format = zoneFormat(reset.zone);
  if (format === null) return null;
  const seen = wallTime(observedAt, format);
  const earliest = observedAt - JUST_PASSED_MS;
  if (reset.month === null) {
    for (const days of [0, 1]) {
      const wall = { ...seen, day: seen.day + days, hour: reset.hour, minute: reset.minute };
      const next = instantsOf(wall, format).find((instant) => instant >= earliest);
      if (next !== undefined) return next;
    }
    return null;
  }
  const wall: WallTime = {
    year: reset.year ?? seen.year,
    month: reset.month,
    day: reset.day!,
    hour: reset.hour,
    minute: reset.minute,
  };
  // "Feb 30" rolls into March under Date.UTC; that isn't a date Claude prints.
  if (new Date(Date.UTC(wall.year, wall.month, wall.day)).getUTCDate() !== wall.day) return null;
  const instants = instantsOf(wall, format);
  // A fold shows the time twice: the showing still to come, else the later.
  return instants.find((instant) => instant >= earliest) ?? instants.at(-1) ?? null;
}
