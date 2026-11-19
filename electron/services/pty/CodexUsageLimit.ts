import type {
  CodexLimitBucketEvidence,
  CodexLimitEvidence,
  CodexLimitReset,
  CodexLimitUnknownReason,
  CodexLimitWindowEvidence,
} from "../../../shared/types/codexLimitReset.js";
import { readlinkSync } from "node:fs";
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

/**
 * Rows read back as the line Codex wrapped. Word wrap ate a space at each
 * break; a row filled to the pane's edge may instead be the terminal's own
 * wrap, which broke inside a word, so that join is tried both ways.
 */
function joinings(rows: readonly string[], cols: number | undefined): string[] {
  const spaced = collapse(rows.join(" "));
  if (cols === undefined || !rows.slice(0, -1).some((row) => row.length === cols)) {
    return [spaced];
  }
  const tight = rows
    .map((row, i) => (i < rows.length - 1 && row.length !== cols ? `${row} ` : row))
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
      if (rows[j] === "" || CELL_BOUNDARY.test(rows[j]!)) break;
      parts.push(rows[j]!);
    }
    const message = (text: string) => text.replace(MARKER, "");
    const texts = joinings(parts, cols).map(message);
    if (!texts.some((text) => OPENERS.some((opener) => opener.test(text)))) {
      // A stop caught half-drawn, before its first words are all there.
      const drawing = texts.some((text) => OPENER_TEXTS.some((opener) => opener.startsWith(text)));
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

const ZONEINFO_DIRS = [
  "/usr/share/zoneinfo/",
  "/usr/share/lib/zoneinfo/",
  "/var/db/timezone/zoneinfo/",
];

function zoneFromFile(file: string): string | null {
  const dir = ZONEINFO_DIRS.find((prefix) => file.startsWith(prefix));
  const zone = dir === undefined ? "" : file.slice(dir.length);
  return zone !== "" && isZoneName(zone) ? zone : null;
}

/**
 * The zone a Codex process started with `env` writes its local times in: a
 * named zone for a launch `TZ`, undefined when it sets none and so follows
 * the system's (see {@link codexSystemZone}), or null when the launch names
 * one that can't be read here, which is never guessed. An empty `TZ` is UTC
 * to Codex's chrono; a POSIX rule string, or a zone file outside the system's
 * zoneinfo, isn't one `Intl` can vouch for. Codex on Windows ignores `TZ`.
 */
export function codexLaunchZone(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform
): string | null | undefined {
  if (platform === "win32") return undefined;
  const raw = env.TZ;
  if (raw === undefined) return undefined;
  if (raw === "") return "UTC";
  const zone = raw.startsWith(":") ? raw.slice(1) : raw;
  if (zone.startsWith("/")) return zoneFromFile(zone);
  return zone !== "" && isZoneName(zone) ? zone : null;
}

/**
 * Whether Codex's chrono finds the same zone `Intl` reads for `zone`. Chrono
 * opens the zone file by that exact name, so a spelling only `Intl`'s
 * case-insensitive lookup accepts may be another zone, or none, to Codex.
 */
function isZoneName(zone: string): boolean {
  const format = zoneFormat(zone);
  if (format === null) return false;
  const canonical = format.resolvedOptions().timeZone;
  return canonical === zone || canonical.toLowerCase() !== zone.toLowerCase();
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
  readLink: (file: string) => string = readlinkSync
): string | null | undefined {
  if (platform !== "win32") {
    try {
      const zone = zoneFromFile(readLink("/etc/localtime"));
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

/** Windows spent when the reading was asked for; a reset already past is a stale reading. */
function spentWindows(
  bucket: CodexLimitBucketEvidence,
  requestedAt: number
): CodexLimitWindowEvidence[] {
  return bucket.windows.filter(
    (window) =>
      window.usedPercent >= 100 && (window.resetsAt === null || window.resetsAt > requestedAt)
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
  const { requestedAt, buckets } = value as Record<string, unknown>;
  if (typeof requestedAt !== "number" || !Number.isFinite(requestedAt)) return null;
  if (!Array.isArray(buckets) || !buckets.every(isBucket)) return null;
  return { requestedAt, buckets };
}

/**
 * When the window that stopped the pane resets, from its banner and a reading
 * of its own Codex home, or why that can't be told (#17906).
 *
 * The banner names the bucket and the minute; a reading asked for after it
 * showed, before that minute began, confirms the window and adds every other
 * spent window of the same bucket, the latest reset winning, to the second. A
 * reading of a bucket the banner can't mean never stretches it. Where the
 * reading contradicts the banner, can't settle a time the banner prints
 * twice, came too late to tell what was spent at the stop, or is missing a
 * reset it needs, the answer is unknown, never a guess. So the question is
 * best asked when the stop shows. `Try again later.` resolves only from a
 * prompt reading that shows the bucket spent.
 */
export function resolveCodexLimitReset(
  observation: CodexLimitObservation,
  evidence: CodexLimitEvidence | null
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

  if (banner.kind === "later") {
    if (reading === null || reading.requestedAt - observedAt > LATER_EVIDENCE_MS) {
      return unknown("no-reset-stated");
    }
    const answers = new Set<number>();
    for (const bucket of buckets) {
      const spent = spentWindows(bucket, reading.requestedAt);
      if (bucket.unreadable || spent.some((window) => window.resetsAt === null)) {
        return unknown("quota-incomplete");
      }
      if (spent.length > 0) answers.add(Math.max(...spent.map((window) => window.resetsAt!)));
    }
    if (answers.size > 1) return unknown("ambiguous-bucket");
    const [answer] = answers;
    return answer === undefined ? unknown("no-reset-stated") : known(answer, "quota");
  }

  if (candidates === null) return unknown("zone-unknown");
  if (candidates.length === 0) return unknown("unreadable-time");
  const fromBanner = () =>
    candidates.length === 1
      ? known(candidates[0]! + MINUTE_MS, "banner")
      : unknown("ambiguous-time");
  if (reading === null || buckets.length === 0) return fromBanner();
  // Any bucket the banner could mean with a window that can't be read, or a
  // spent one with no reset, may be the one that stopped it.
  const incomplete = buckets.some(
    (bucket) =>
      bucket.unreadable ||
      spentWindows(bucket, reading.requestedAt).some((window) => window.resetsAt === null)
  );
  if (incomplete) return unknown("quota-incomplete");
  // A reading can only vouch for a reset whose minute hadn't begun when it was
  // asked for: within or after it, the window may have rolled already.
  if (candidates.some((candidate) => candidate <= reading.requestedAt)) {
    if (candidates.length > 1) return unknown("ambiguous-time");
    // Nothing spent now: the banner's window has reset and nothing else blocks.
    // Something spent may have been spent since, or all along; it can't be told.
    const spentNow = buckets.some((bucket) => spentWindows(bucket, reading.requestedAt).length > 0);
    return spentNow ? unknown("late-reading") : fromBanner();
  }
  const answers = new Set<number>();
  for (const bucket of buckets) {
    const spent = spentWindows(bucket, reading.requestedAt);
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
