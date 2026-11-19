import type {
  CodexLimitBucketEvidence,
  CodexLimitEvidence,
  CodexLimitReset,
  CodexLimitUnknownReason,
  CodexLimitWindowEvidence,
} from "../../../shared/types/codexLimitReset.js";
import { existsSync, readlinkSync } from "node:fs";
import { stripAnsi } from "./AgentPatternDetector.js";
import { instantsOf, wallTime, zoneFormat, type WallTime } from "./zonedWallTime.js";

/** The reset a Codex banner prints, as written: a date only when it isn't the day it printed. */
export interface CodexBannerTime {
  date: { year: number; month: number; day: number } | null;
  hour: number;
  minute: number;
}

/**
 * A Codex stop banner as printed (#17906). It stays in the pty host, the
 * model bucket's name included: only {@link resolveCodexLimitReset}'s answer
 * leaves. `limitName` is null for the account's ordinary limit.
 */
export type CodexLimitBanner =
  | { kind: "at"; time: CodexBannerTime; limitName: string | null }
  | { kind: "later"; limitName: string | null }
  | { kind: "no-reset" }
  /** A stop banner starts here but doesn't read as any form Codex prints. */
  | { kind: "unreadable" };

/** Trailing rows a banner must reach into: one that ended further up is old news. */
const SCAN_LINES = 12;
/** Rows one banner may wrap across: the longest upsell, two URLs, at a narrow width. */
const MAX_BANNER_ROWS = 10;

// Codex draws its error as one history line, `■ {message}`, flush left and
// word-wrapped with no indent (codex-rs/tui/src/history_cell/notices.rs). The
// marker is required: text that only reads like a banner is someone's.
const MARKER = /^■ ?/;
// Glyphs reach the String.raw patterns below as `${}` strings, which the build
// escapes; a tagged template's own text ships as written, and one glyph there
// makes the pty host's whole chunk a two-byte string (#17023).
const APOSTROPHES = "'’";
const OPENERS = [
  new RegExp(String.raw`^You[${APOSTROPHES}]ve hit your usage limit\b`),
  /^Your workspace is out of credits\b/,
  /^You hit your spend cap\b/,
];
/** What a stop's first words are, for telling a half-drawn one from another error. */
const OPENER_TEXTS = [
  "You've hit your usage limit",
  "You\u2019ve hit your usage limit",
  "Your workspace is out of credits",
  "You hit your spend cap",
];
// A row that opens another history cell, a prompt or a footer: an indent, a
// box or pointer glyph (• ■ › ❯ │ └ ─), or any other symbol set off by a space
// (⚠). The rows reach here without the blank ones between cells, so this is
// what ends a banner. A wrapped banner's own rows start with a word, a number,
// punctuation the terminal wrapped onto them, or a URL in parentheses.
const CELL_BOUNDARY = /^(?:\s|[•■›❯│└─]|\p{S}\s)/u;

// chrono's `%-I:%M %p`, after `%b %-d{st|nd|rd|th}, %Y ` when the reset isn't
// on the day Codex printed it (codex-rs/protocol/src/error.rs).
const TIME = String.raw`(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})(st|nd|rd|th), (\d{4}) )?(\d{1,2}):(\d{2}) (AM|PM)`;
const RETRY = String.raw`(?:at ${TIME}|later)\.`;

// "You’ve hit your usage limit." then " Try again …", or an upsell ending the
// way each plan's copy does: "… credits or try again" (Plus, Pro), "… your
// admin or try again" (Business), ", or try again" (Free/Go, a promo). A model
// bucket's own limit names it and offers a switch. Credit and spend-cap stops
// state no reset at all.
const GENERAL = new RegExp(
  String.raw`^You[${APOSTROPHES}]ve hit your usage limit\.(?: Try again| .+?(?:,| credits| your admin) or try again) ${RETRY}$`
);
const MODEL = new RegExp(
  String.raw`^You[${APOSTROPHES}]ve hit your usage limit for (.+?)\. Switch to another model now, or try again ${RETRY}$`
);
const NO_RESET = [
  /^Your workspace is out of credits\. .*\bcontinue\.$/,
  /^You hit your spend cap .*\bcontinue\.$/,
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function ordinalSuffix(day: number): string {
  if (day >= 11 && day <= 13) return "th";
  return ["th", "st", "nd", "rd"][day % 10] ?? "th";
}

/** Undefined for a time that isn't one Codex prints. */
function parseTime(groups: (string | undefined)[]): CodexBannerTime | undefined {
  const [mon, dayText, suffix, yearText, hourText, minuteText, meridiem] = groups;
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (hour < 1 || hour > 12 || minute > 59) return undefined;
  const time = { hour: (hour % 12) + (meridiem === "PM" ? 12 : 0), minute };
  if (mon === undefined) return { date: null, ...time };
  const month = MONTHS.indexOf(mon);
  const day = Number(dayText);
  const year = Number(yearText);
  if (suffix !== ordinalSuffix(day)) return undefined;
  // "Feb 30th" rolls into March under Date.UTC; that isn't a date Codex prints.
  if (new Date(Date.UTC(year, month, day)).getUTCDate() !== day) return undefined;
  return { date: { year, month, day }, ...time };
}

/** What a whole banner says; undefined while its text isn't a complete one. */
function classify(text: string): CodexLimitBanner | undefined {
  if (NO_RESET.some((pattern) => pattern.test(text))) return { kind: "no-reset" };
  const model = MODEL.exec(text);
  const match = model ?? GENERAL.exec(text);
  if (match === null) return undefined;
  const limitName = model === null ? null : model[1]!;
  const groups = match.slice(model === null ? 1 : 2);
  if (groups[5] === undefined) return { kind: "later", limitName };
  const time = parseTime(groups.slice(0, 7));
  // A complete sentence with a time Codex can't have printed isn't its banner.
  return time === undefined ? undefined : { kind: "at", time, limitName };
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/** Whether a code point takes two cells: CJK, Hangul, fullwidth forms. */
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    code >= 0x20000
  );
}

/** The cells a row's text takes, as the terminal laid it out. */
function cellWidth(text: string): number {
  let width = 0;
  for (const char of text) width += isWide(char.codePointAt(0)!) ? 2 : 1;
  return width;
}

/**
 * Whether `next` carries on the line `row` started. Codex word-wraps, so a row
 * that still had room for the next row's first word didn't wrap into it; the
 * terminal's own wrap fills a row to the edge. Without a width, any row that
 * isn't a cell boundary carries on.
 */
function continues(row: string, next: string, cols: number | undefined): boolean {
  if (next === "" || CELL_BOUNDARY.test(next)) return false;
  if (cols === undefined) return true;
  const firstWord = next.split(" ", 1)[0]!;
  return cellWidth(row) + 1 + cellWidth(firstWord) > cols;
}

/**
 * Rows read back as the line Codex wrapped. Word wrap ate a space at each
 * break; a row filled to the pane's edge may instead be the terminal's own
 * wrap, which broke inside a word, so that join is tried both ways.
 */
function joinings(rows: readonly string[], cols: number | undefined): string[] {
  const spaced = collapse(rows.join(" "));
  const filled = (row: string) => cols !== undefined && cellWidth(row) === cols;
  if (!rows.slice(0, -1).some(filled)) return [spaced];
  const tight = rows
    .map((row, i) => (i < rows.length - 1 && !filled(row) ? `${row} ` : row))
    .join("");
  return [spaced, collapse(tight)];
}

/**
 * The lowest Codex stop banner in a viewport, or null. A banner opens at the
 * left edge, behind Codex's error marker, and reads only as a whole sentence
 * in one of the forms Codex prints, so prose about a limit or a quoted banner
 * reads as none. One that opens as a stop but reads as no form is
 * `unreadable` rather than an older one above it. `cols` is the pane's width,
 * which tells the terminal's own wrap from Codex's.
 */
export function scanCodexLimitBanner(
  lines: readonly string[],
  cols?: number
): CodexLimitBanner | null {
  const rows = lines.map((line) => stripAnsi(line).trimEnd());
  const tailStart = Math.max(0, rows.length - SCAN_LINES);
  const firstStart = Math.max(0, tailStart - MAX_BANNER_ROWS + 1);
  for (let i = rows.length - 1; i >= firstStart; i--) {
    if (!MARKER.test(rows[i]!)) continue;
    // Whole rows, the marker kept, so a row's width still tells the terminal's wrap.
    const parts = [rows[i]!];
    for (let j = i + 1; j < rows.length && parts.length < MAX_BANNER_ROWS; j++) {
      if (!continues(rows[j - 1]!, rows[j]!, cols)) break;
      parts.push(rows[j]!);
    }
    const message = (text: string) => text.replace(MARKER, "");
    const texts = joinings(parts, cols).map(message);
    if (!texts.some((text) => OPENERS.some((opener) => opener.test(text)))) {
      // A stop caught half-drawn, before its first words are all there, its
      // own row read alone too in case an older row below got joined to it.
      const drawing = [...texts, collapse(message(rows[i]!))].some((text) =>
        OPENER_TEXTS.some((opener) => opener.startsWith(text))
      );
      if (drawing) return i + parts.length - 1 >= tailStart ? { kind: "unreadable" } : null;
      // Another error behind the marker.
      continue;
    }
    for (let end = 1; end <= parts.length; end++) {
      const read = new Map<string, CodexLimitBanner>();
      for (const text of joinings(parts.slice(0, end), cols)) {
        const banner = classify(message(text));
        if (banner !== undefined) read.set(JSON.stringify(banner), banner);
      }
      if (read.size === 0) continue;
      const ends = i + end - 1 >= tailStart;
      // Two ways of joining the wrap that say different things (a model name
      // split at the edge) can't be told apart.
      if (read.size > 1) return ends ? { kind: "unreadable" } : null;
      return ends ? [...read.values()][0]! : null;
    }
    return i + parts.length - 1 >= tailStart ? { kind: "unreadable" } : null;
  }
  return null;
}

const MINUTE_MS = 60_000;
/** How far a server's reset may sit behind the moment its banner printed. */
const CLOCK_SLACK_MS = 2 * MINUTE_MS;
/** A span of print days past which a bare time names too many to list. */
const MAX_PRINT_DAYS = 400;

function nextDay(wall: WallTime): WallTime {
  const date = new Date(Date.UTC(wall.year, wall.month, wall.day + 1));
  return {
    ...wall,
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
  };
}

function dayKey(wall: WallTime): number {
  return Date.UTC(wall.year, wall.month, wall.day);
}

/**
 * Every instant a printed reset can mean, earliest first, each the start of
 * the minute Codex printed. Codex printed it some time after `printedAfter`
 * (the last look at the pane without it) and by `observedAt`, and its reset
 * was still to come then. A bare time is on the local day it printed, which is
 * the day it was seen unless that span crosses midnight. None for a time the
 * zone's clock never shows, two for one it shows twice (a fold). Null when
 * `zone` can't be read.
 */
export function codexBannerResetCandidates(
  time: CodexBannerTime,
  observedAt: number,
  printedAfter: number,
  zone: string | undefined
): number[] | null {
  const format = zoneFormat(zone);
  if (format === null) return null;
  const from = Math.min(printedAfter, observedAt);
  const at = { hour: time.hour, minute: time.minute };
  const instants: number[] = [];
  if (time.date !== null) {
    instants.push(...instantsOf({ ...time.date, ...at }, format));
  } else {
    const last = dayKey(wallTime(observedAt, format));
    let day = wallTime(from, format);
    for (let n = 0; dayKey(day) <= last; n++) {
      if (n === MAX_PRINT_DAYS) return [];
      instants.push(...instantsOf({ ...day, ...at }, format));
      day = nextDay(day);
    }
  }
  const earliest = from - MINUTE_MS - CLOCK_SLACK_MS;
  return [...new Set(instants)].filter((instant) => instant >= earliest).sort((a, b) => a - b);
}

// Where Codex's chrono looks a zone name up, and where a system's
// /etc/localtime links to.
const ZONEINFO_DIRS = [
  "/usr/share/zoneinfo/",
  "/share/zoneinfo/",
  "/etc/zoneinfo/",
  "/usr/share/lib/zoneinfo/",
  "/var/db/timezone/zoneinfo/",
];

type Exists = (file: string) => boolean;

/** The zone `Intl` reads for `name`, as it names it; null when it reads none. */
function canonicalZone(name: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * The zone a zone file holds, read off its path: only a file chrono can open
 * there, in a system zoneinfo folder, under a name `Intl` reads. Named as
 * `Intl` names it, so one zone spelled many ways is one zone here.
 */
function zoneFromFile(file: string, exists: Exists): string | null {
  const dir = ZONEINFO_DIRS.find((prefix) => file.startsWith(prefix));
  const name = dir === undefined ? "" : file.slice(dir.length);
  return name !== "" && exists(file) ? canonicalZone(name) : null;
}

/**
 * The zone a Codex process started with `env` writes its local times in: a
 * named zone for a launch `TZ`, undefined when it sets none and so follows
 * the system's (see {@link codexSystemZone}), or null when the launch names
 * one that can't be read here, which is never guessed. An empty `TZ` is UTC
 * to Codex's chrono. A name counts only when a zone file of exactly that name
 * is there for chrono to open, since `Intl` also takes spellings no file has;
 * a POSIX rule string isn't one. Codex on Windows ignores `TZ`.
 */
export function codexLaunchZone(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
  exists: Exists = existsSync
): string | null | undefined {
  if (platform === "win32") return undefined;
  const raw = env.TZ;
  if (raw === undefined) return undefined;
  if (raw === "") return "UTC";
  const zone = raw.startsWith(":") ? raw.slice(1) : raw;
  if (zone === "" || zone.includes("..")) return null;
  if (zone.startsWith("/")) return zoneFromFile(zone, exists);
  for (const dir of ZONEINFO_DIRS) {
    if (exists(dir + zone)) return canonicalZone(zone);
  }
  return null;
}

/**
 * The system zone, read now, since a Codex with no `TZ` of its own prints in
 * whatever the system's is at that moment, and this process's `Intl` keeps
 * the zone it started in. On macOS and Linux it is `/etc/localtime`'s link;
 * without one, and on Windows, this process's `Intl` zone (undefined) stands
 * in only while this process has no `TZ` of its own. Null when neither can.
 */
export function codexSystemZone(
  platform: NodeJS.Platform = process.platform,
  ownTz: string | undefined = process.env.TZ,
  readLink: (file: string) => string = readlinkSync,
  exists: Exists = existsSync
): string | null | undefined {
  if (platform !== "win32") {
    try {
      const zone = zoneFromFile(readLink("/etc/localtime"), exists);
      if (zone !== null) return zone;
    } catch {
      // Not a link: fall back to this process's zone.
    }
  }
  return ownTz === undefined ? undefined : null;
}

/** A banner as the pty host holds it, with what was known when it first showed. */
export interface CodexLimitObservation {
  banner: CodexLimitBanner;
  observedAt: number;
  /** `at` banners: the instants its time can mean; null when the zone isn't known. */
  candidates: number[] | null;
  /** The Codex process is the one Daintree launched, so its zone and home are the launch's. */
  attributed: boolean;
}

/**
 * How long after the banner a reading may still speak for `Try again later.`:
 * with no time to tie it to, a window spent long after is another stop's. It
 * covers a stop that settles at the rate-limit deadline, and the read.
 */
const LATER_EVIDENCE_MS = 60_000;

const GENERAL_BUCKETS = new Set(["codex", "gpt-reserve"]);

/**
 * Whether a bucket's limit prints the general banner: Codex names a model only
 * for a `limitName` that is neither empty nor `codex`/`gpt-reserve`, whatever
 * the bucket's id.
 */
function isGeneralBucket(bucket: CodexLimitBucketEvidence): boolean {
  const name = bucket.limitName?.trim().toLowerCase() ?? "";
  return name === "" || GENERAL_BUCKETS.has(name);
}

/** The buckets the banner can be about: by the name Codex printed, never by time. */
function bucketsFor(limitName: string | null, buckets: readonly CodexLimitBucketEvidence[]) {
  if (limitName === null) return buckets.filter(isGeneralBucket);
  const printed = collapse(limitName);
  return buckets.filter(
    (bucket) => !isGeneralBucket(bucket) && collapse(bucket.limitName ?? "") === printed
  );
}

/**
 * Windows spent when the reading was taken. The server took it some time
 * between the request and the reply, so a reset before the reply may have
 * rolled already and doesn't count.
 */
function spentWindows(
  bucket: CodexLimitBucketEvidence,
  receivedAt: number
): CodexLimitWindowEvidence[] {
  return bucket.windows.filter(
    (window) =>
      window.usedPercent >= 100 && (window.resetsAt === null || window.resetsAt > receivedAt)
  );
}

function isWindow(value: unknown): value is CodexLimitWindowEvidence {
  if (!value || typeof value !== "object") return false;
  const { usedPercent, resetsAt } = value as Record<string, unknown>;
  return (
    typeof usedPercent === "number" &&
    Number.isFinite(usedPercent) &&
    (resetsAt === null || (typeof resetsAt === "number" && Number.isFinite(resetsAt)))
  );
}

function isBucket(value: unknown): value is CodexLimitBucketEvidence {
  if (!value || typeof value !== "object") return false;
  const { limitId, limitName, windows, unreadable } = value as Record<string, unknown>;
  return (
    (limitId === null || typeof limitId === "string") &&
    (limitName === null || typeof limitName === "string") &&
    Array.isArray(windows) &&
    windows.every(isWindow) &&
    typeof unreadable === "boolean"
  );
}

/** Evidence from across the process boundary, or null when it isn't evidence. */
export function readCodexLimitEvidence(value: unknown): CodexLimitEvidence | null {
  if (!value || typeof value !== "object") return null;
  const { requestedAt, receivedAt, buckets } = value as Record<string, unknown>;
  if (typeof requestedAt !== "number" || !Number.isFinite(requestedAt)) return null;
  if (typeof receivedAt !== "number" || !Number.isFinite(receivedAt)) return null;
  if (receivedAt < requestedAt) return null;
  if (!Array.isArray(buckets) || !buckets.every(isBucket)) return null;
  return { requestedAt, receivedAt, buckets };
}

/**
 * When the window that stopped the pane resets, from its banner and a reading
 * of its own Codex home, or why that can't be told (#17906).
 *
 * The banner names the bucket and the minute. A reading asked for after it
 * showed, and back before that minute began, confirms the window and adds
 * every other spent window of the same bucket, the latest reset winning, to
 * the second; with no reading, the answer is the end of the printed minute. A
 * reading of a bucket the banner can't mean never stretches it. Once the
 * printed minute has begun, what was spent at the stop can't be told any
 * more, so the question is one to ask when the stop shows. Where the reading
 * contradicts the banner, can't settle a time the banner prints twice, or is
 * missing a reset it needs, the answer is unknown, never a guess. `Try again
 * later.` resolves only from a prompt reading that shows the bucket spent.
 */
export function resolveCodexLimitReset(
  observation: CodexLimitObservation,
  evidence: CodexLimitEvidence | null,
  now: number
): CodexLimitReset {
  const { banner, observedAt, candidates } = observation;
  const unknown = (reason: CodexLimitUnknownReason): CodexLimitReset => ({
    status: "unknown",
    reason,
    observedAt,
  });
  const known = (resetsAt: number, source: "banner" | "quota"): CodexLimitReset => ({
    status: "known",
    resetsAt,
    precision: source === "quota" ? "second" : "minute",
    source,
    observedAt,
  });
  if (banner.kind === "no-reset") return unknown("no-reset");
  if (banner.kind === "unreadable") return unknown("unreadable-banner");
  if (!observation.attributed) return unknown("unattributed");

  const reading = evidence !== null && evidence.requestedAt >= observedAt ? evidence : null;
  const buckets = reading === null ? [] : bucketsFor(banner.limitName, reading.buckets);
  const incomplete = (receivedAt: number) =>
    buckets.some(
      (bucket) =>
        bucket.unreadable ||
        spentWindows(bucket, receivedAt).some((window) => window.resetsAt === null)
    );

  if (banner.kind === "later") {
    if (reading === null || reading.requestedAt - observedAt > LATER_EVIDENCE_MS) {
      return unknown("no-reset-stated");
    }
    if (incomplete(reading.receivedAt)) return unknown("quota-incomplete");
    const spent = buckets.map((bucket) => spentWindows(bucket, reading.receivedAt));
    // One bucket the banner could mean is spent and another isn't: which
    // stopped the pane can't be told.
    if (spent.some((windows) => windows.length === 0) && spent.some((w) => w.length > 0)) {
      return unknown("ambiguous-bucket");
    }
    const answers = new Set(
      spent.filter((w) => w.length > 0).map((w) => Math.max(...w.map((window) => window.resetsAt!)))
    );
    if (answers.size > 1) return unknown("ambiguous-bucket");
    const [answer] = answers;
    return answer === undefined ? unknown("no-reset-stated") : known(answer, "quota");
  }

  if (candidates === null) return unknown("zone-unknown");
  if (candidates.length === 0) return unknown("unreadable-time");
  // A reading vouches only for a reset whose minute hadn't begun when it came
  // back; within or after that minute the window may have rolled already, and
  // what else was spent at the stop can't be told.
  const asOf = reading === null ? now : reading.receivedAt;
  if (candidates.some((candidate) => candidate <= asOf)) {
    return unknown(candidates.length > 1 ? "ambiguous-time" : "late-reading");
  }
  if (reading === null || buckets.length === 0) {
    return candidates.length === 1
      ? known(candidates[0]! + MINUTE_MS, "banner")
      : unknown("ambiguous-time");
  }
  // Any bucket the banner could mean with a window that can't be read, or a
  // spent one with no reset, may be the one that stopped it.
  if (incomplete(reading.receivedAt)) return unknown("quota-incomplete");
  const answers = new Set<number>();
  for (const bucket of buckets) {
    const spent = spentWindows(bucket, reading.receivedAt);
    const matched = spent.some((window) =>
      candidates.some(
        (candidate) => window.resetsAt! >= candidate && window.resetsAt! < candidate + MINUTE_MS
      )
    );
    if (matched) answers.add(Math.max(...spent.map((window) => window.resetsAt!)));
  }
  if (answers.size > 1) return unknown("ambiguous-bucket");
  const [answer] = answers;
  return answer === undefined ? unknown("quota-disagrees") : known(answer, "quota");
}
