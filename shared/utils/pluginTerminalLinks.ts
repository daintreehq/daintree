import { formatErrorMessage } from "./errorMessage.js";

/** Matchers one plugin may declare, pattern and URL together. */
export const TERMINAL_LINK_MAX_PER_PLUGIN = 20;

/** Longest pattern source, in UTF-16 code units. */
export const TERMINAL_LINK_PATTERN_MAX_LENGTH = 256;

/** Most of a hovered row a pattern ever scans, in UTF-16 code units. */
export const TERMINAL_LINK_SCAN_MAX_CHARS = 512;

/** Longest text a pattern match may claim; a longer match is not a link. */
export const TERMINAL_LINK_MATCH_MAX_LENGTH = 256;

/** Pattern links offered on one row, across every plugin. */
export const TERMINAL_LINK_MAX_MATCHES_PER_ROW = 32;

export const TERMINAL_LINK_MAX_CAPTURE_GROUPS = 16;

/** Longest URL a URL matcher may claim. */
export const TERMINAL_LINK_URL_MAX_LENGTH = 2048;

export const TERMINAL_LINK_HOST_MAX_LENGTH = 253;

export const TERMINAL_LINK_PATH_PREFIX_MAX_LENGTH = 256;

/**
 * Ceiling on the product of every quantifier's maximum count, an unbounded one
 * counting as the scan cap, times every alternation's branch count.
 * Backtracking work grows with that product, so this keeps a pattern's worst
 * case on a full row to a single hover's worth.
 */
export const TERMINAL_LINK_PATTERN_REPETITION_BUDGET = 1_000_000;

/** One parsed term's facts, as far as the safety rules need them. */
interface Shape {
  /** Holds a quantifier anywhere inside. */
  quantified: boolean;
  /** Holds a `|` anywhere inside. */
  alternation: boolean;
}

class PatternRejection extends Error {}

/**
 * Walks a pattern in the `u`-mode grammar and refuses what can blow up or leak:
 * backreferences, lookarounds, named groups, a repeated group that itself
 * repeats or alternates (exponential backtracking), and more repetition and
 * alternation than {@link TERMINAL_LINK_PATTERN_REPETITION_BUDGET} allows. Anything it does not
 * recognise is refused rather than guessed at. The source has already
 * compiled, so the syntax itself is known to be well-formed.
 */
class PatternWalker {
  private pos = 0;
  private repetition = 1;
  captureGroups = 0;

  constructor(private readonly source: string) {}

  walk(): void {
    this.alternation();
    if (this.pos < this.source.length) throw new PatternRejection("has an unmatched ')'");
  }

  private peek(offset = 0): string | undefined {
    return this.source[this.pos + offset];
  }

  /**
   * Multiply the backtracking estimate by `factor`. A quantifier's count and an
   * alternation's branches both multiply it: a failing match can retry every
   * combination, so `(?:a|b)` thirty times over costs 2^30, not 60.
   */
  private charge(factor: number): void {
    this.repetition *= factor;
    if (this.repetition > TERMINAL_LINK_PATTERN_REPETITION_BUDGET) {
      throw new PatternRejection(
        "allows too much backtracking to scan on hover — give its *, + and {n,} an upper bound such as {1,32}, and use fewer alternatives"
      );
    }
  }

  private alternation(): Shape {
    const shape: Shape = { quantified: false, alternation: false };
    let branches = 1;
    for (;;) {
      const branch = this.sequence();
      shape.quantified ||= branch.quantified;
      shape.alternation ||= branch.alternation;
      if (this.peek() !== "|") break;
      shape.alternation = true;
      branches++;
      this.pos++;
    }
    if (branches > 1) this.charge(branches);
    return shape;
  }

  private sequence(): Shape {
    const shape: Shape = { quantified: false, alternation: false };
    while (this.pos < this.source.length && this.peek() !== "|" && this.peek() !== ")") {
      const atom = this.atom();
      const max = this.quantifier();
      if (max !== null) {
        if (max > 1 && (atom.quantified || atom.alternation)) {
          throw new PatternRejection(
            "repeats a group that itself repeats or has alternatives, which can take exponential time — repeat a character class instead"
          );
        }
        this.charge(Math.min(max, TERMINAL_LINK_SCAN_MAX_CHARS) + 1);
        atom.quantified = true;
      }
      shape.quantified ||= atom.quantified;
      shape.alternation ||= atom.alternation;
    }
    return shape;
  }

  private atom(): Shape {
    const ch = this.peek();
    if (ch === "(") return this.group();
    if (ch === "[") {
      this.characterClass();
      return { quantified: false, alternation: false };
    }
    if (ch === "\\") {
      this.escape();
      return { quantified: false, alternation: false };
    }
    this.pos++;
    return { quantified: false, alternation: false };
  }

  private group(): Shape {
    this.pos++;
    if (this.peek() === "?") {
      const kind = this.peek(1);
      if (kind === ":") {
        this.pos += 2;
      } else if (
        kind === "=" ||
        kind === "!" ||
        (kind === "<" && /[=!]/.test(this.peek(2) ?? ""))
      ) {
        throw new PatternRejection(
          "uses a lookaround, which can read text outside the match — match the text itself instead"
        );
      } else if (kind === "<") {
        throw new PatternRejection(
          "uses a named group — use plain parentheses; groups reach the command by position"
        );
      } else {
        throw new PatternRejection(`uses an unsupported group "(?${kind ?? ""}"`);
      }
    } else {
      this.captureGroups++;
    }
    const inner = this.alternation();
    if (this.peek() !== ")") throw new PatternRejection("has an unclosed group");
    this.pos++;
    return inner;
  }

  private characterClass(): void {
    this.pos++;
    while (this.pos < this.source.length && this.peek() !== "]") {
      if (this.peek() === "\\") this.escape();
      else this.pos++;
    }
    if (this.peek() !== "]") throw new PatternRejection("has an unclosed character class");
    this.pos++;
  }

  private escape(): void {
    const next = this.peek(1);
    if (next === undefined) throw new PatternRejection("ends in a lone backslash");
    if (/[1-9]/.test(next) || next === "k") {
      throw new PatternRejection("uses a backreference, which can take exponential time");
    }
    this.pos += 2;
    if ((next === "p" || next === "P" || next === "u") && this.peek() === "{") {
      const close = this.source.indexOf("}", this.pos);
      if (close === -1) throw new PatternRejection("has an unclosed escape");
      this.pos = close + 1;
    } else if (next === "u") {
      this.pos += 4;
    } else if (next === "x") {
      this.pos += 2;
    } else if (next === "c") {
      this.pos += 1;
    }
  }

  /** The quantifier's maximum count if one follows, `null` if none does. */
  private quantifier(): number | null {
    const ch = this.peek();
    let max: number;
    if (ch === "*" || ch === "+") {
      max = Infinity;
      this.pos++;
    } else if (ch === "?") {
      max = 1;
      this.pos++;
    } else if (ch === "{") {
      const match = /^\{(\d+)(,(\d*))?\}/.exec(this.source.slice(this.pos));
      if (!match) throw new PatternRejection("has a malformed {n,m} quantifier");
      const min = Number(match[1]);
      max = match[2] === undefined ? min : match[3] === "" ? Infinity : Number(match[3]);
      this.pos += match[0].length;
    } else {
      return null;
    }
    if (this.peek() === "?") this.pos++;
    return max;
  }
}

function patternFlags(ignoreCase: boolean): string {
  return ignoreCase ? "iu" : "u";
}

/**
 * Why a matcher's pattern can't be used, or `null` when it can. Run at manifest
 * validation so an author learns at load time, and again before the renderer
 * compiles one, so nothing that skipped the manifest gate reaches a hover.
 */
export function checkTerminalLinkPattern(source: string, ignoreCase = false): string | null {
  if (source.length === 0) return "pattern must not be empty";
  if (source.length > TERMINAL_LINK_PATTERN_MAX_LENGTH) {
    return `pattern is longer than ${TERMINAL_LINK_PATTERN_MAX_LENGTH} characters`;
  }
  let compiled: RegExp;
  try {
    compiled = new RegExp(source, patternFlags(ignoreCase));
  } catch (err) {
    return `pattern isn't a valid regular expression: ${formatErrorMessage(err, "it doesn't compile")}`;
  }
  const walker = new PatternWalker(source);
  try {
    walker.walk();
  } catch (err) {
    if (err instanceof PatternRejection) return `pattern ${err.message}`;
    throw err;
  }
  if (walker.captureGroups > TERMINAL_LINK_MAX_CAPTURE_GROUPS) {
    return `pattern has more than ${TERMINAL_LINK_MAX_CAPTURE_GROUPS} capture groups`;
  }
  if (new RegExp(`^(?:${compiled.source})$`, compiled.flags).test("")) {
    return "pattern matches empty text, so it would underline nothing";
  }
  return null;
}

/** A pattern compiled for scanning, or `null` when it fails {@link checkTerminalLinkPattern}. */
export function compileTerminalLinkPattern(source: string, ignoreCase = false): RegExp | null {
  if (checkTerminalLinkPattern(source, ignoreCase) !== null) return null;
  return new RegExp(source, `g${patternFlags(ignoreCase)}`);
}

export interface TerminalLinkPatternMatch {
  /** Offset of the match in the scanned text. */
  index: number;
  text: string;
  /** Capture groups by position, `null` where an optional group took no part. */
  groups: (string | null)[];
}

/**
 * Every match of `regex` (compiled by {@link compileTerminalLinkPattern}) in
 * `text`, up to `limit`. Only the first {@link TERMINAL_LINK_SCAN_MAX_CHARS}
 * code units are read; a match that runs into that cut is dropped, since the
 * cut could be what made it match (a `\b` or `$` landing on it).
 */
export function findTerminalLinkMatches(
  regex: RegExp,
  text: string,
  limit = TERMINAL_LINK_MAX_MATCHES_PER_ROW
): TerminalLinkPatternMatch[] {
  const clipped = text.length > TERMINAL_LINK_SCAN_MAX_CHARS;
  const scanned = clipped ? text.slice(0, TERMINAL_LINK_SCAN_MAX_CHARS) : text;
  const matches: TerminalLinkPatternMatch[] = [];
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while (matches.length < limit && (match = regex.exec(scanned)) !== null) {
    const matched = match[0];
    if (matched.length === 0) {
      // A whole code point on: under the `u` flag, an index inside a surrogate
      // pair is read from the pair's start, so stepping one unit would find
      // this same empty match again, forever.
      const codePoint = scanned.codePointAt(match.index) ?? 0;
      regex.lastIndex = match.index + (codePoint > 0xffff ? 2 : 1);
      continue;
    }
    if (matched.length > TERMINAL_LINK_MATCH_MAX_LENGTH) continue;
    if (clipped && match.index + matched.length === scanned.length) continue;
    matches.push({
      index: match.index,
      text: matched,
      groups: match.slice(1).map((group) => group ?? null),
    });
  }
  regex.lastIndex = 0;
  return matches;
}

/**
 * Names under these suffixes resolve only on this machine or a local network,
 * or not at all, so they are never a hosted service's records: the reserved
 * TLDs `urlUtils` treats as local, plus the common LAN conventions. IP literals
 * never get this far — a host must be a name — which keeps this module free of
 * `ipaddr.js` for the standalone CLI that validates manifests with it.
 */
const LOCAL_HOST_SUFFIXES = [
  ".localhost",
  ".test",
  ".local",
  ".internal",
  ".localdomain",
  ".lan",
  ".home",
  ".arpa",
  ".invalid",
] as const;

const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME_PATTERN = new RegExp(`^${HOST_LABEL}(?:\\.${HOST_LABEL})+$`);

function isLocalHostname(host: string): boolean {
  return LOCAL_HOST_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));
}

/**
 * Why a URL matcher's `host` can't be claimed, or `null` when it can. A host is
 * a lowercase public DNS name with at least two labels: no port, credentials,
 * path, wildcard or trailing dot, no IP literal, and nothing loopback, private
 * or local-only — those belong to the browser and dev preview panels.
 */
export function checkTerminalLinkHost(host: string): string | null {
  if (host.length === 0 || host.length > TERMINAL_LINK_HOST_MAX_LENGTH) {
    return `host must be 1 to ${TERMINAL_LINK_HOST_MAX_LENGTH} characters`;
  }
  if (!HOSTNAME_PATTERN.test(host)) {
    return `host "${host}" must be a lowercase domain name like "records.example.com", with no scheme, port, path or wildcard`;
  }
  // No top-level domain is all digits, so this catches every IPv4 spelling.
  if (/^\d+$/.test(host.slice(host.lastIndexOf(".") + 1))) {
    return `host "${host}" is an IP address — name a domain instead`;
  }
  if (isLocalHostname(host)) {
    return `host "${host}" is loopback, private or local-only, which plugins can't claim`;
  }
  // The URL parser's reading has to be the host itself: `0x7f.0x1` passes the
  // shape above but parses as 127.0.0.1, and would never match its own URLs.
  let parsed: string;
  try {
    parsed = new URL(`https://${host}/`).hostname;
  } catch {
    return `host "${host}" isn't a domain name a URL can have`;
  }
  if (parsed !== host) {
    return `host "${host}" isn't a plain domain name; a URL reads it as "${parsed}"`;
  }
  return null;
}

/** Why a URL matcher's `pathPrefix` can't be used, or `null` when it can. */
export function checkTerminalLinkPathPrefix(pathPrefix: string): string | null {
  if (!pathPrefix.startsWith("/")) return 'pathPrefix must start with "/"';
  if (pathPrefix.length > TERMINAL_LINK_PATH_PREFIX_MAX_LENGTH) {
    return `pathPrefix is longer than ${TERMINAL_LINK_PATH_PREFIX_MAX_LENGTH} characters`;
  }
  if (!/^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/.test(pathPrefix)) {
    return "pathPrefix must be a URL path, with no query, fragment or spaces";
  }
  // Encoded dots too: the URL parser resolves `%2e%2e` like `..`, so a prefix
  // holding one could never match a parsed path.
  const isDotSegment = (segment: string) => /^(?:\.|%2e){1,2}$/i.test(segment);
  if (pathPrefix.split("/").some(isDotSegment)) {
    return 'pathPrefix must not contain "." or ".." segments';
  }
  return null;
}

export interface TerminalLinkUrlTarget {
  scheme: "https" | "http";
  host: string;
  pathPrefix?: string;
}

/**
 * Whether `url` is one `target` claims. The URL is parsed rather than compared
 * as text, and the host rules are checked again on what was parsed, so a
 * credential prefix, a non-default port or a lookalike spelling never matches.
 * The check reads the URL alone: a name is never resolved, so a public-looking
 * domain that a local DNS points at a private address can still be claimed.
 */
export function urlMatchesTerminalLinkTarget(url: string, target: TerminalLinkUrlTarget): boolean {
  if (url.length > TERMINAL_LINK_URL_MAX_LENGTH) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== `${target.scheme}:`) return false;
  if (parsed.username !== "" || parsed.password !== "" || parsed.port !== "") return false;
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname !== target.host || checkTerminalLinkHost(hostname) !== null) return false;
  return target.pathPrefix === undefined || parsed.pathname.startsWith(target.pathPrefix);
}
