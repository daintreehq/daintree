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
 * This is a claim about the ORIGIN, and only the origin. Path and query still mean what
 * URL semantics say they mean — `…/public/../admin` is `/admin` — which is the same
 * thing they mean everywhere else and is not this component's to relitigate.
 */

/** Where a candidate may begin: start of text, whitespace, or an opening delimiter. */
const OPENERS = new Set(["(", "[", "{", "<", '"', "'"]);

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
 * stops an invisible from mattering is the origin check below: it can survive in a path,
 * where it cannot change where the click goes.
 *
 * Separators need no entry: every one of them is `White_Space` and so ends the token.
 */
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Co}\\]/gu;

/** An authority's port: absent, or a colon and digits. Anything else is not a port. */
const PORT = /^(?::\d*)?$/;

const SCHEME_LENGTH = "https://".length;

/** Punctuation a sentence can leave behind at the end of an address. */
const TRAILING = new Set([".", ",", ";", ":", "!", "?", ")", "]", "}", ">", '"', "'"]);

const CLOSERS = new Map([
  [")", "("],
  ["]", "["],
  ["}", "{"],
  [">", "<"],
]);

/** The `OPENERS` that pair with something — quotes open and close with the same mark. */
const BRACKETS = new Set(CLOSERS.values());

/**
 * Drop the trailing punctuation that belongs to the sentence rather than to the address.
 *
 * A closing bracket is kept when the token opened it — `…/Foo_(bar)` is one address, not
 * an address inside parentheses — so the trailing run is MATCHED against the depth the
 * rest of the token leaves open, left to right, and cut back to the last closer that
 * found a partner. Counting occurrences instead of matching them gets it wrong in both
 * directions: a stray `)` earlier in a path cancels a real opener, and `…/what's-new'`
 * reads the apostrophe in `what's` as an opening quote and so keeps the sentence's
 * closing one.
 *
 * A trailing quote never survives. An opening quote cannot be inside a token that begins
 * at `https`, so a quote at the end is the prose's, not the address's — which does cost
 * the rare address that genuinely ends in one (`…/a'b'` links as `…/a'b`). Quoted URLs
 * in prose are common and raw trailing apostrophes in URLs are not, and the character is
 * still there to read and copy either way.
 *
 * One pass over the prefix and one over the run. Re-scanning the prefix per dropped
 * character is quadratic, and a run of `)))…` is exactly the shape that exploits it.
 */
function trimTrailing(token: string): string {
  let runStart = token.length;
  while (runStart > 0 && TRAILING.has(token.charAt(runStart - 1))) runStart -= 1;
  if (runStart === token.length) return token;

  const depth = new Map<string, number>();
  for (const ch of token.slice(0, runStart)) {
    const opener = CLOSERS.get(ch);
    if (opener !== undefined) {
      depth.set(opener, Math.max(0, (depth.get(opener) ?? 0) - 1));
    } else if (BRACKETS.has(ch)) {
      depth.set(ch, (depth.get(ch) ?? 0) + 1);
    }
  }

  let cut = token.length;
  for (let i = runStart; i < token.length; i += 1) {
    const opener = CLOSERS.get(token.charAt(i));
    const open = opener === undefined ? 0 : (depth.get(opener) ?? 0);
    if (opener !== undefined && open > 0) {
      depth.set(opener, open - 1);
      // Matched, so this closer and everything before it is part of the address again.
      cut = token.length;
    } else if (cut === token.length) {
      cut = i;
    }
  }
  return token.slice(0, cut);
}

/** The host and port an authority is written as, or `null` if it is not written as one. */
function splitHost(authority: string): string | null {
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
  // Everything a userinfo section would put here — `user`, `user:pw`, a bare `@` — either
  // fails the port shape or survives into a host the parser will disagree with.
  return split === 0 ? null : authority.slice(0, split);
}

/**
 * Whether this exact string may be handed to `AssistantLink` as both text and href.
 *
 * Assumes the caller has already excluded `FORBIDDEN` characters — the loop does that
 * once per whitespace-delimited run rather than once per candidate inside it.
 *
 * The authority is checked BEFORE the whole token is parsed, and that ordering is load
 * bearing rather than tidiness: a dishonest authority is refused after reading the few
 * characters it occupies, so a long token full of candidates cannot be made to reparse
 * its whole shrinking tail once per candidate.
 */
function isSafeHttpsUrl(token: string): boolean {
  const rest = token.slice(SCHEME_LENGTH);
  const pathStart = rest.search(/[/?#]/);
  const host = splitHost(pathStart === -1 ? rest : rest.slice(0, pathStart));
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
  // The whitespace-delimited run the last candidate fell in, and the last forbidden
  // character inside it. Candidates only move forward, so a run holding several of them
  // is still walked once.
  let runEnd = -1;
  let lastForbidden = -1;
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

    if (start >= runEnd) {
      runEnd = start;
      while (runEnd < message.length && !WHITESPACE.test(message.charAt(runEnd))) runEnd += 1;
      lastForbidden = -1;
      FORBIDDEN.lastIndex = 0;
      const run = message.slice(start, runEnd);
      let hit: RegExpExecArray | null;
      while ((hit = FORBIDDEN.exec(run)) !== null) lastForbidden = start + hit.index;
    }
    // Nothing in the trailing trim set is a forbidden character, so a candidate contains
    // one exactly when the run's last one falls at or after where the candidate starts.
    if (lastForbidden >= start) continue;

    const token = trimTrailing(message.slice(start, runEnd));
    if (!isSafeHttpsUrl(token)) continue;

    if (start > cursor) parts.push(message.slice(cursor, start));
    parts.push(
      <AssistantLink key={`u${key++}`} href={token}>
        {token}
      </AssistantLink>
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
