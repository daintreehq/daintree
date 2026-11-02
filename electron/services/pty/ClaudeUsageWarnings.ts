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

// The gutter, box and pointer glyphs banners sit behind, as RATE_LIMIT_PATTERNS
// knows them.
const CHROME = String.raw`[\s•●■▪*>❯›⟩│┃╎╭╰─⚠⎿-]*`;
const WINDOW = String.raw`(5[ -]?hour|session|weekly|opus|sonnet|fable)`;
const YOUVE = String.raw`you(?:['’]ve|\s+have)`;
// A message ends its row or runs into " · resets …" / " · <hint>" segments;
// anything else after the limit is a sentence about one.
const TAIL = String.raw`(?:\s*$|\s*[·∙•]\s*(.*)$)`;
const SEGMENT_SPLIT = /\s*[·∙•]\s*/;

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
      String.raw`^${CHROME}${YOUVE}\s+(?:hit|reached)\s+your\s+()usage\s+limit${TAIL}`,
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
    pattern: new RegExp(
      String.raw`^${CHROME}(5[ -]?hour|session)\s+limit\s+reached${TAIL}`,
      "i"
    ),
    statement: "reached",
    needsReset: true,
  },
];

const PERCENT_FORMS = new Set<ClaudeUsageStatement>(["used", "over"]);

function windowOf(named: string): ClaudeUsageWindow {
  const word = named.toLowerCase();
  if (word === "") return "unnamed";
  if (word.startsWith("5")) return "5-hour";
  return word as ClaudeUsageWindow;
}

/**
 * Where on a row a message may start: the row's own start, or after a column
 * gap, since Claude draws its warning at the right of the prompt footer beside
 * "? for shortcuts" or a mode indicator.
 */
function columnStarts(row: string): string[] {
  const starts = [row];
  for (const gap of row.matchAll(/\S {2,}(?=\S)/g)) {
    starts.push(row.slice(gap.index + gap[0].length));
  }
  return starts;
}

function resetSegment(rest: string | undefined): { text: string; last: boolean } | null {
  if (rest === undefined) return null;
  const segments = rest.split(SEGMENT_SPLIT);
  const index = segments.findIndex((segment) => /^resets\s+\S/i.test(segment));
  if (index < 0) return null;
  return {
    text: segments[index]!.replace(/^resets\s+/i, "").trim(),
    last: index === segments.length - 1,
  };
}

function matchRow(row: string, next: string | undefined): ClaudeUsageMessage | null {
  if (!/limit/i.test(row)) return null;
  for (const start of columnStarts(row)) {
    for (const form of FORMS) {
      const match = form.pattern.exec(start);
      if (match === null) continue;
      const percentForm = PERCENT_FORMS.has(form.statement);
      const named = percentForm ? match[2]! : match[1]!;
      const rest = percentForm ? match[3] : match[2];
      const reset = resetSegment(rest);
      if (form.needsReset && reset === null) continue;
      const usedPercent = percentForm ? Number(match[1]) : null;
      if (usedPercent !== null && usedPercent > 100) continue;
      let resetText = reset?.text ?? null;
      // A narrow pane wraps the reset onto the next row. Only a join that
      // reads as a reset is kept, so an unrelated row under it never changes
      // what this message is.
      if (reset?.last && next !== undefined && parseResetText(reset.text) === null) {
        const joined = `${reset.text} ${next.trim().split(SEGMENT_SPLIT)[0] ?? ""}`;
        if (parseResetText(joined) !== null) resetText = joined;
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
 * read as one.
 */
export function scanClaudeUsageMessages(lines: readonly string[]): ClaudeUsageMessage[] {
  const tail = lines.slice(-SCAN_LINES).map((line) => stripAnsi(line));
  const byWindow = new Map<ClaudeUsageWindow, ClaudeUsageMessage>();
  for (let i = 0; i < tail.length; i++) {
    const message = matchRow(tail[i]!, tail[i + 1]);
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

/** The instant a zone's clock reads `wall`, settled over the zone's offset. */
function instantOf(wall: WallTime, format: Intl.DateTimeFormat): number {
  const target = wallAsUtc(wall);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const next = target - (wallAsUtc(wallTime(guess, format)) - guess);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

/**
 * Leeway for a time-only reset that has just passed: Claude prints a bare time
 * only for a reset within a day, so one earlier than this is tomorrow's.
 */
const JUST_PASSED_MS = 10 * 60_000;

/**
 * The epoch ms a printed reset names, read in the zone Claude printed beside
 * it (this machine's when it printed none), against when it was seen: a bare
 * time is its next showing, a date without a year is this year's. Null for a
 * reset that doesn't read as one.
 */
export function resolveResetsAt(resetText: string | null, observedAt: number): number | null {
  if (resetText === null) return null;
  const reset = parseResetText(resetText);
  if (reset === null) return null;
  const format = zoneFormat(reset.zone);
  if (format === null) return null;
  const seen = wallTime(observedAt, format);
  if (reset.month === null) {
    const today = instantOf({ ...seen, hour: reset.hour, minute: reset.minute }, format);
    if (today >= observedAt - JUST_PASSED_MS) return today;
    return instantOf(
      { ...seen, day: seen.day + 1, hour: reset.hour, minute: reset.minute },
      format
    );
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
  return instantOf(wall, format);
}
