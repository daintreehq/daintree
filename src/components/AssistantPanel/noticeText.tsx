import type { ReactNode } from "react";
import { AssistantLink } from "./AssistantLink";

/**
 * Bare URLs inside a notice, made navigable — and nothing else made anything.
 *
 * ## Why this is not markdown
 *
 * A notice carries TERMINAL text: the engine's command results are padded columns and
 * hard-wrapped continuation lines (`plan     standard`), and `NoticeRow` renders them
 * under `whitespace-pre-wrap` precisely so those columns survive. Running that through
 * the markdown pipeline `AssistantMessage` uses would reflow it — a run of spaces
 * collapses, a leading `-` becomes a list, an indented block becomes a code fence — and
 * would open an authoring surface on text nobody authored as prose. So this walks the
 * string and emits string fragments plus links, changing nothing else. Every character
 * of the input is emitted exactly once, in order, so the rendered text stays identical
 * to the message.
 *
 * ## Why only https
 *
 * Markdown links reach `AssistantLink` having already passed react-markdown's
 * `defaultUrlTransform`, which admits `http`, `https`, `mailto` and `xmpp`. Plain notice
 * text passes through no such sanitizer, and the only guard left downstream is the main
 * process allowlist (`electron/utils/openExternal.ts`), which admits `http:` and
 * `mailto:` as well. So the narrowing happens HERE rather than in `AssistantLink`: that
 * primitive is shared with rendered markdown, where `http:` and `mailto:` are
 * legitimate, and tightening it would change the markdown contract to fix a problem
 * markdown does not have.
 *
 * `http:` staying inert is deliberate. Notices carry backend and loopback diagnostics,
 * and a plaintext address is worth reading and copying but is not worth one-click
 * navigation out of text the engine composed.
 *
 * ## The host you read is the host you reach
 *
 * The href is the SAME STRING that is displayed: a token is parsed to decide whether it
 * is admissible, never to produce the address. That alone is not enough, because the
 * browser re-parses the attribute before it navigates and the WHATWG parser rewrites far
 * more than it looks like it does. `https:///evil.test` resolves to `evil.test`,
 * `https://%65xample.com` to `example.com`, a fraction slash inside a host
 * (`https://good.test⁄evil.test`) reads as a path separator without being one and
 * punycodes the whole thing into a host nobody meant to visit, and the legacy IPv4
 * spellings — `https://2130706433/`, `https://0x7f.1/`, `https://127.1/` — all land on
 * 127.0.0.1 while naming nothing of the sort.
 *
 * So the ORIGIN is checked rather than assumed: the host written in the token has to
 * survive the parser unchanged, ASCII case aside. That one comparison disposes of every
 * example above, along with userinfo and mixed-script homographs, and it does it without
 * a confusables list that would rot. The cost is that a genuine internationalised host
 * stays inert, which is the right way round for text the engine composed.
 *
 * A rendered label can be turned against that promise from OUTSIDE the token, though: a
 * directional override anywhere earlier in the message stays in force across everything
 * after it, so `evil.test` can be painted as something else entirely while the href is
 * untouched. That is why each link is wrapped in `<bdi>` — the label gets its own bidi
 * context and reads as itself whatever the message around it is doing. Isolating rather
 * than refusing, because a notice in an RTL language is ordinary and must still work.
 *
 * This is a claim about the ORIGIN, and only the origin. Path and query still mean what
 * URL semantics say they mean — `…/public/../admin` is `/admin` — which is the same
 * thing they mean everywhere else and is not this component's to relitigate.
 */

/**
 * Where a candidate may begin: start of text, whitespace, or an opening delimiter.
 *
 * Typographic quotes are in here for the same reason the straight ones are. Engine prose
 * is written with them, and `Read “https://docs…/setup”` is a URL a reader can see.
 */
const OPENERS = new Set(["(", "[", "{", "<", '"', "'", "“", "‘", "«", "‹"]);

/**
 * The token boundary — `White_Space` rather than the regex `\s` class.
 *
 * The two classes differ over two characters, and one of them matters: `\s` matches
 * U+FEFF, so a byte-order mark would END a token rather than be caught as the zero-width
 * character it is, and half an address would link while the invisible remainder rendered
 * flush against it. (The other, U+0085 NEXT LINE, is a line break either way.)
 */
const WHITESPACE = /\p{White_Space}/u;

/**
 * Characters that disqualify a token from ever becoming a link.
 *
 * Control (`Cc`), because the URL parser strips or re-encodes several of them and a
 * stripped character is one the reader saw and the browser did not. Format (`Cf`), which
 * is where the invisibles that change how a string READS live — bidi overrides,
 * zero-width joiners, the soft hyphen, the byte-order mark. Private use (`Co`), which
 * has no agreed appearance at all. Backslash last, because the WHATWG parser reads it as
 * `/` for special schemes, so `https:\\evil.test` resolves to a host the displayed text
 * does not name.
 *
 * Not every character that renders as nothing is in those categories — a variation
 * selector or a Hangul filler is not — and the categories are not widened to chase them,
 * because the classes that would catch them (`Mn`, `Lo`) are mostly ordinary text. What
 * stops an invisible from mattering is the origin check: it can survive in a path, where
 * it cannot change where the click goes.
 *
 * Separators need no entry: every one of them is `White_Space` and so ends the token.
 */
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Co}\\]/gu;

/** A host written plainly enough that reading it and resolving it cannot diverge. */
const PLAIN_HOST = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f.:]+\])$/;

/** An authority's port: absent, or a colon and digits. Anything else is not a port. */
const PORT = /^(?::\d*)?$/;

const SCHEME_LENGTH = "https://".length;

/** Punctuation a sentence can leave behind at the end of an address. */
const TRAILING = new Set([
  ".",
  ",",
  ";",
  ":",
  "!",
  "?",
  ")",
  "]",
  "}",
  ">",
  '"',
  "'",
  "”",
  "’",
  "»",
  "›",
]);

const CLOSERS = new Map([
  [")", "("],
  ["]", "["],
  ["}", "{"],
  [">", "<"],
]);

/**
 * Everything about one whitespace-delimited run that its candidates need to consult.
 *
 * Measured ONCE per run rather than once per `https://` inside it. A run can hold many
 * candidates — `(https://a(https://a…` is a single token by this definition — and the
 * per-candidate questions ("does my prefix leave a bracket open?", "is there a forbidden
 * character ahead of me?") used to be answered by rescanning that prefix every time. The
 * engine's `command:result` frame is allowed 200,000 characters, so quadratic here is a
 * frozen renderer, not a slow one.
 */
interface Run {
  /** Where the measurement starts. Every candidate in this run begins at or after it. */
  base: number;
  end: number;
  /** Index of the last `FORBIDDEN` character, or -1. */
  lastForbidden: number;
  /** Where the run's trailing punctuation begins — shared by every candidate. */
  trimStart: number;
  /**
   * Per bracket kind that CLOSES inside the trailing punctuation: where those closers
   * are, and how many openers the prefix leaves unmatched at each possible start.
   */
  brackets: { closers: number[]; unmatched: Int32Array }[];
}

function scanRun(message: string, base: number): Run {
  let end = base;
  while (end < message.length && !WHITESPACE.test(message.charAt(end))) end += 1;

  let lastForbidden = -1;
  FORBIDDEN.lastIndex = 0;
  const text = message.slice(base, end);
  let hit: RegExpExecArray | null;
  while ((hit = FORBIDDEN.exec(text)) !== null) lastForbidden = base + hit.index;

  let trimStart = end;
  while (trimStart > base && TRAILING.has(message.charAt(trimStart - 1))) trimStart -= 1;

  const brackets: Run["brackets"] = [];
  for (const [closer, opener] of CLOSERS) {
    const closers: number[] = [];
    for (let i = trimStart; i < end; i += 1) if (message.charAt(i) === closer) closers.push(i);
    if (closers.length === 0) continue;
    // Right to left, because an opener is matched by the first unmatched closer to its
    // right — which makes the answer for every start a suffix of the answer for the one
    // before it, and so a single pass instead of one per candidate.
    const unmatched = new Int32Array(trimStart - base + 1);
    let open = 0;
    let closed = 0;
    for (let i = trimStart - 1; i >= base; i -= 1) {
      const ch = message.charAt(i);
      if (ch === opener) {
        if (closed > 0) closed -= 1;
        else open += 1;
      } else if (ch === closer) closed += 1;
      unmatched[i - base] = open;
    }
    brackets.push({ closers, unmatched });
  }

  return { base, end, lastForbidden, trimStart, brackets };
}

/**
 * Where a candidate starting at `start` ends, once the sentence's punctuation is off it.
 *
 * A closing bracket is kept when the token opened it — `…/Foo_(bar)` is one address, not
 * an address inside parentheses — so a closer is part of the address exactly when its
 * position in the trailing run is within the depth the prefix leaves open, and the cut
 * falls just after the last such closer. Counting occurrences rather than matching them
 * gets it wrong in both directions: a stray `)` earlier in a path cancels a real opener,
 * and `…/what's-new'` reads the apostrophe in `what's` as an opening quote and so keeps
 * the sentence's closing one.
 *
 * A trailing quote never survives. An opening quote cannot be inside a token that begins
 * at `https`, so a quote at the end is the prose's, not the address's — which does cost
 * the rare address that genuinely ends in one (`…/a'b'` links as `…/a'b`). Quoted URLs
 * in prose are common and raw trailing apostrophes in URLs are not, and the character is
 * still there to read and copy either way.
 */
function tokenEnd(run: Run, start: number): number {
  let cut = run.trimStart;
  for (const { closers, unmatched } of run.brackets) {
    const depth = unmatched[start - run.base] ?? 0;
    if (depth === 0) continue;
    const last = closers[Math.min(depth, closers.length) - 1] ?? -1;
    if (last + 1 > cut) cut = last + 1;
  }
  return cut;
}

/** The host an authority is written as, or `null` if it is not written as a plain one. */
function writtenHost(authority: string): string | null {
  let split: number;
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close === -1) return null;
    split = close + 1;
  } else {
    const colon = authority.indexOf(":");
    split = colon === -1 ? authority.length : colon;
  }
  if (!PORT.test(authority.slice(split))) return null;
  // Everything a userinfo section would leave here — `user`, `user:pw`, a bare `@` —
  // either fails the port shape or fails this.
  const host = authority.slice(0, split);
  return PLAIN_HOST.test(host) ? host : null;
}

/**
 * Whether this exact string may be handed to `AssistantLink` as both text and href.
 *
 * Assumes the caller has already excluded `FORBIDDEN` characters — that is answered once
 * per run rather than once per candidate inside it.
 *
 * The authority is checked BEFORE the whole token is parsed, and that ordering is load
 * bearing rather than tidiness: a dishonest authority is refused after reading the few
 * characters it occupies, so a long token full of candidates cannot be made to reparse
 * its whole shrinking tail once per candidate.
 */
function isSafeHttpsUrl(token: string): boolean {
  const rest = token.slice(SCHEME_LENGTH);
  const pathStart = rest.search(/[/?#]/);
  const host = writtenHost(pathStart === -1 ? rest : rest.slice(0, pathStart));
  if (host === null) return false;

  let origin: URL;
  try {
    origin = new URL(`https://${host}/`);
  } catch {
    return false;
  }
  if (origin.username !== "" || origin.password !== "") return false;
  if (origin.hostname.toLowerCase() !== host.toLowerCase()) return false;

  try {
    return new URL(token).protocol === "https:";
  } catch {
    return false;
  }
}

/** The message split into inert strings and admissible links, in order. */
function splitNoticeText(message: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const scheme = /https:\/\//gi;
  let cursor = 0;
  let key = 0;
  let run: Run | null = null;
  let match: RegExpExecArray | null;

  while ((match = scheme.exec(message)) !== null) {
    const start = match.index;
    // Set before anything can skip, so every path below leaves the search strictly past
    // this scheme and the loop always advances.
    scheme.lastIndex = start + match[0].length;

    const before = start === 0 ? "" : message.charAt(start - 1);
    // Glued to the preceding word (`xhttps://…`): linking only the tail would present a
    // fragment of a token as though it were the whole address.
    if (start !== 0 && !WHITESPACE.test(before) && !OPENERS.has(before)) continue;

    if (run === null || start >= run.end) run = scanRun(message, start);
    // Nothing in the trailing trim set is a forbidden character, so a candidate contains
    // one exactly when the run's last one falls at or after where the candidate starts.
    if (run.lastForbidden >= start) continue;

    const token = message.slice(start, tokenEnd(run, start));
    if (!isSafeHttpsUrl(token)) continue;

    if (start > cursor) parts.push(message.slice(cursor, start));
    parts.push(
      // `<bdi>` and not a styled wrapper: it is plain inline, so `break-words` still
      // breaks a long address across lines the way it does in the surrounding text.
      <bdi key={`u${key++}`}>
        <AssistantLink href={token}>{token}</AssistantLink>
      </bdi>
    );
    cursor = start + token.length;
    scheme.lastIndex = cursor;
  }

  if (cursor < message.length) parts.push(message.slice(cursor));
  return parts;
}

export function NoticeText({ message }: { message: string }) {
  return <>{splitNoticeText(message)}</>;
}
