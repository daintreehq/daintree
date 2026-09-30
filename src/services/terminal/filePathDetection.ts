import { isAbsolute, resolve } from "@shared/utils/path";

export interface ResolvedFilePath {
  absolutePath: string;
  line?: number;
  col?: number;
}

// Matches a file-path-like token inside arbitrary text. Every alternative
// requires a path separator ('/' or '\') and a trailing `.ext`, so bare words
// and slash-commands (`/help`, `/api/v1`) never match. Global so the terminal
// link scanner can walk every match on a line. Kept byte-for-byte identical to
// the historical FileLinksAddon regex so link-scanning behavior is unchanged.
export const FILE_PATH_REGEX =
  /(?:^|[\s(])((?:\\\\wsl(?:\$|\.localhost)\\[^\\]+(?:\\[\w.-]+)+|\/[\w./-]+|[a-zA-Z]:[\\/][\w./\\-]+|(?:\.\.?[\\/])+[\w./\\-]+|[\w-]+[\\/][\w./\\-]+)\.[\w]+(?::\d+(?::\d+)?)?)/g;

const WINDOWS_ABS = /^(?:[a-zA-Z]:[\\/]|\\\\)/;

// A path token that contains spaces. FILE_PATH_REGEX treats a space as a token
// boundary, so `/Users/me/Library/Application Support/x.md` offers only its
// `Support/x.md` tail — which resolves against the cwd and links nothing real.
export interface SpacedFilePathCandidate {
  /** Span to underline, in the scanned text's coordinates. */
  startIndex: number;
  endIndex: number;
  /** The path as the filesystem spells it: quotes dropped, `\ ` decoded. */
  path: string;
  /**
   * The syntax alone can't settle it: an unquoted space is as likely to
   * separate two tokens as to sit inside a directory name. Such candidates
   * are only links once `probeDir` is confirmed to exist.
   */
  probeDir?: string;
}

// Quoted and shell-escaped forms carry their own boundaries, so they need no
// filesystem confirmation. Only space-containing spellings are taken here —
// a space-free quoted path stays the business of FILE_PATH_REGEX.
const QUOTED_PATH_REGEX = /(?:^|[\s(=:])(["'`])([^"'`\s][^"'`]*?)\1/g;
const QUOTED_PATH_SHAPE = /^(?:[a-zA-Z]:[\\/])?[\w./\\ -]*[\\/][\w./\\ -]*\.\w+(?::\d+(?::\d+)?)?$/;
const ESCAPED_PATH_REGEX = /(?:^|[\s(])((?:[\w./-]|\\ )+\.\w+(?::\d+(?::\d+)?)?)/g;

// Unquoted: anchored on an absolute root and grown word by word, each word
// joined by exactly one space. Bounded because the scan runs on every hover.
const SPACED_ANCHOR_REGEX = /(?:^|[\s(])((?:\/|[a-zA-Z]:[\\/])[\w./\\-]*)/g;
const SPACED_WORD_REGEX = /[\w./\\-]+(?::\d+(?::\d+)?)?/y;
const SPACED_TAIL_REGEX = /^[\w./\\-]*[\\/][\w./\\-]*\.\w+(?::\d+(?::\d+)?)?/;
const ABSOLUTE_WORD = /^(?:\/|[a-zA-Z]:[\\/])/;
const MAX_SPACED_WORDS = 8;

function stripLocationSuffix(path: string): string {
  return path.replace(/(?::\d+(?::\d+)?)$/, "");
}

/**
 * Find path tokens that contain spaces: quoted (`"/a b/c.md"`), shell-escaped
 * (`/a\ b/c.md`), and unquoted absolute paths whose space sits in a directory
 * component (`/a b/c.md`). Unquoted candidates carry `probeDir` — the parent
 * directory that must exist — and every plausible length is returned, longest
 * first per start, so the caller can keep the longest one that checks out.
 */
export function findSpacedFilePathCandidates(text: string): SpacedFilePathCandidate[] {
  const candidates: SpacedFilePathCandidate[] = [];
  const explicit: Array<[number, number]> = [];

  for (const match of text.matchAll(QUOTED_PATH_REGEX)) {
    const inner = match[2]!;
    if (!inner.includes(" ") || inner.endsWith(" ") || !QUOTED_PATH_SHAPE.test(inner)) continue;
    if (isPathExcluded(inner)) continue;
    const startIndex = match.index + match[0].length - inner.length - 1;
    const endIndex = startIndex + inner.length;
    candidates.push({ startIndex, endIndex, path: inner });
    explicit.push([startIndex - 1, endIndex + 1]);
  }

  for (const match of text.matchAll(ESCAPED_PATH_REGEX)) {
    const raw = match[1]!;
    if (!raw.includes("\\ ") || !raw.includes("/")) continue;
    const startIndex = match.index + match[0].length - raw.length;
    const endIndex = startIndex + raw.length;
    if (overlaps(explicit, startIndex, endIndex)) continue;
    candidates.push({ startIndex, endIndex, path: raw.replace(/\\ /g, " ") });
    explicit.push([startIndex, endIndex]);
  }

  for (const match of text.matchAll(SPACED_ANCHOR_REGEX)) {
    const first = match[1]!;
    const startIndex = match.index + match[0].length - first.length;
    if (overlaps(explicit, startIndex, startIndex + first.length)) continue;

    const wordEnds: number[] = [];
    let pos = startIndex + first.length;
    while (wordEnds.length < MAX_SPACED_WORDS - 1 && text[pos] === " ") {
      SPACED_WORD_REGEX.lastIndex = pos + 1;
      const word = SPACED_WORD_REGEX.exec(text);
      // A word that starts its own absolute path is the next token, not a
      // continuation of this one.
      if (!word || ABSOLUTE_WORD.test(word[0])) break;
      pos += 1 + word[0].length;
      wordEnds.push(pos);
    }

    for (let i = wordEnds.length - 1; i >= 0; i--) {
      const lastWordStart = (i === 0 ? startIndex + first.length : wordEnds[i - 1]!) + 1;
      // The last word has to carry a separator, which puts every space in the
      // candidate inside a directory component — the one thing a single stat
      // of the parent directory can then confirm.
      const tail = SPACED_TAIL_REGEX.exec(text.slice(lastWordStart, wordEnds[i]));
      if (!tail) continue;
      const endIndex = lastWordStart + tail[0].length;
      if (overlaps(explicit, startIndex, endIndex)) continue;
      const path = text.slice(startIndex, endIndex);
      candidates.push({
        startIndex,
        endIndex,
        path,
        probeDir: parentDirectory(stripLocationSuffix(path)),
      });
    }
  }

  return candidates;
}

function parentDirectory(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return path.slice(0, cut);
}

function overlaps(spans: ReadonlyArray<[number, number]>, start: number, end: number): boolean {
  return spans.some(([s, e]) => start < e && end > s);
}

// Matches a `file://` URL token inside arbitrary text — agent CLIs print
// generated images this way (`file:///Users/me/.codex/generated_images/x.png`).
// The body class is deliberately permissive about `|`, `\` and brackets: real
// Windows file URLs carry them (`file:///C|/x.png`, `file:///C:\Users\x.png`,
// both of which WHATWG normalizes to `/C:/…`), and excluding them the way
// xterm's web-links regex does would capture a truncated `file:///C` — which
// still parses as a URL and would link somewhere else entirely. Trailing
// sentence punctuation is consumed OUTSIDE group 1, and the lookahead demands
// a real token terminator so a partial match can never pose as the whole URL.
//
// The opening and closing delimiter sets are deliberately symmetric: a URL in
// backticks or quotes has to linkify the same way the selection path resolves
// it, or right-click "View file" and a click disagree about the same token.
// `$`/`^` mean logical-line ends, so callers scanning a terminal buffer must
// rejoin soft-wrapped rows first — a row boundary is not a token boundary.
export const FILE_URL_REGEX =
  /(?:^|[\s("'`<[{])(file:\/\/[^\s<>"'`]*[^\s<>"'`:,.!?;)\]}])[,:.;!?)\]}]*(?=$|[\s<>"'`])/gi;

// A `file:` pathname carrying a Windows drive arrives as `/C:/…`. Matched
// against the DECODED path so `%43`/`%3A` spellings resolve identically, and
// the trailing `/`-or-end keeps drive-relative `/C:foo.png` (a legitimate
// POSIX path, not a drive) from losing its leading slash.
const WINDOWS_DRIVE_PATHNAME = /^\/[A-Za-z]:(?:\/|$)/;
const WINDOWS_DRIVE_ONLY = /^[A-Za-z]:$/;

// Directory-shaped tokens: multi-segment paths with NO extension requirement,
// optionally slash-terminated. Deliberately loose — `and/or` matches — because
// candidates are validated against the filesystem before they ever become
// links; the regex proposes, the stat disposes. Single-segment absolute tokens
// (`/help`) are syntactically included for the same reason: slash-commands
// don't exist on disk, so validation drops them. Alternatives mirror
// FILE_PATH_REGEX's envelope (POSIX-absolute, drive-absolute, dot-relative,
// bare-relative) minus the `.ext` requirement.
export const DIR_PATH_REGEX =
  /(?:^|[\s(])((?:\/[\w./-]+|[a-zA-Z]:[\\/][\w./\\-]+|(?:\.\.?[\\/])+[\w./\\-]+|[\w.-]+[\\/][\w./\\-]+)[\\/]?)(?=$|[\s):,'"])/g;

/**
 * Resolve a directory-shaped token to an absolute path. No `:line[:col]`
 * handling — that suffix marks a file location, and a token carrying one is
 * the file regex's business. A trailing slash is stripped so `src/panels/`
 * and `src/panels` resolve identically.
 */
export function resolveDirPathCandidate(text: string, cwd: string): string | null {
  const trimmed = text.replace(/[\\/]+$/, "");
  if (!trimmed) return null;

  if (isAbsolute(trimmed)) return trimmed;
  if (!cwd) return null;
  if (WINDOWS_ABS.test(cwd)) {
    const sep = cwd.includes("\\") ? "\\" : "/";
    return `${cwd.replace(/[\\/]+$/, "")}${sep}${trimmed.replace(/[\\/]+/g, sep)}`;
  }
  return resolve(cwd, trimmed);
}

/** URLs and embedded escape sequences look path-ish but aren't files. */
export function isPathExcluded(text: string): boolean {
  return text.includes("://") || text.includes("\x1b");
}

/**
 * Turn a path-like token into an absolute path, stripping any `:line[:col]`
 * suffix. Relative tokens resolve against `cwd`; when `cwd` is empty a relative
 * token can't be resolved and returns null. Windows cwds join with the drive's
 * separator so a POSIX-style relative token still lands under the drive root.
 */
export function resolveFilePathCandidate(text: string, cwd: string): ResolvedFilePath | null {
  const match = /^(.*\.[^\s:]+?)(?::(\d+)(?::(\d+))?)?$/.exec(text);
  if (!match) return null;
  const pathPart = match[1];
  if (pathPart === undefined) return null;
  const line = match[2] ? Number(match[2]) : undefined;
  const col = match[3] ? Number(match[3]) : undefined;

  let absolutePath: string;
  if (isAbsolute(pathPart)) {
    absolutePath = pathPart;
  } else {
    if (!cwd) return null;
    if (WINDOWS_ABS.test(cwd)) {
      const sep = cwd.includes("\\") ? "\\" : "/";
      absolutePath = `${cwd.replace(/[\\/]+$/, "")}${sep}${pathPart.replace(/[\\/]+/g, sep)}`;
    } else {
      absolutePath = resolve(cwd, pathPart);
    }
  }

  return { absolutePath, line, col };
}

/**
 * Turn a `file://` URL token into an absolute filesystem path, mirroring
 * Node's `fileURLToPath`. Hand-rolled on the WHATWG `URL` global because the
 * renderer is sandboxed and has no Node builtins — the same reason
 * `@shared/utils/path` exists.
 *
 * No `cwd`: a file URL is absolute by definition. No `:line[:col]` peeling
 * either — a file URL names an exact resource, and `:42` is a legal POSIX
 * filename ending, so peeling would silently retarget `/tmp/render:2024` at
 * `/tmp/render`. Bare tokens keep their suffix handling because a bare
 * `foo.ts:42` really is a source location.
 */
export function resolveFileUrlCandidate(text: string): ResolvedFilePath | null {
  if (text.includes("\x1b")) return null;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "file:") return null;
  // Anything but a local authority is someone else's machine. WHATWG already
  // folds a `localhost` host to "" for file URLs (in any case), so this single
  // check covers both accepted spellings and rejects `file://server/share`.
  if (url.hostname !== "") return null;

  // Percent-encoded and query/fragment-free: the parser split those off, and
  // it already normalized `\` and `|` into `/` and `:`.
  const encodedPath = url.pathname;
  // `file:////server/share/x.png` slips past the host check with an empty
  // hostname but yields a `//`-prefixed pathname, which `@shared/utils/path`
  // reads as a UNC root. Reject the shape rather than let the empty-host form
  // smuggle a remote link past the local-authority rule.
  if (encodedPath.startsWith("//")) return null;

  // Encoded separators are rejected BEFORE decoding, as Node does: one that
  // survived into the decoded string would invent a path component the URL's
  // structure never had. Node only rejects `%5c` for Windows because its POSIX
  // path module treats `\` as an ordinary character — ours doesn't, since
  // `normalize()` rewrites every `\` to `/`, so here it's the same hazard as
  // `%2f` on both platforms.
  if (/%2f/i.test(encodedPath) || /%5c/i.test(encodedPath)) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(encodedPath);
  } catch {
    // Malformed escape (`%zz`). A link provider that throws takes down every
    // link on the line, so a bad token simply isn't a link.
    return null;
  }
  // No filesystem accepts a NUL, and the files IPC rejects one at its schema —
  // a link that can only ever fail is worse than no link.
  if (decoded.includes("\0")) return null;

  // Strip the drive's leading slash by position, never touching the letter's
  // case — Node doesn't either, and callers on case-sensitive volumes care.
  const absolutePath = WINDOWS_DRIVE_PATHNAME.test(decoded) ? decoded.slice(1) : decoded;

  // File-only feature: a root, a drive root, or a trailing-slash directory URL
  // has no file to view, and `file:///` would otherwise link the filesystem
  // root. A directory URL with no trailing slash falls through and fails
  // through the viewer's existing error path.
  if (!absolutePath || absolutePath.endsWith("/") || WINDOWS_DRIVE_ONLY.test(absolutePath)) {
    return null;
  }
  // Last gate before the path reaches `file.view`, which joins anything
  // relative onto the terminal's cwd — silently opening a file the URL never
  // named. Nothing that survives the steps above should be relative, so this
  // is the backstop for a spelling none of them anticipated.
  if (!isAbsolute(absolutePath)) return null;

  return { absolutePath };
}

/**
 * Detect a file path from a user's text *selection* (terminal or composer). The
 * whole trimmed selection must be a single path token — a path embedded in
 * prose ("see src/foo.ts for details") is intentionally rejected so the "View
 * file" menu section only appears when the user selected exactly a path.
 */
export function resolveSelectedFilePath(selection: string, cwd: string): ResolvedFilePath | null {
  const trimmed = selection.trim();
  if (!trimmed) return null;

  // `file://` is checked ahead of `isPathExcluded` rather than by loosening
  // it: the blanket `://` rejection still has to kill `http://` and `ssh://`,
  // so this is a scheme-specific carve-out in front of it, not a hole in it.
  // The whole-selection rule is identical to the bare-path branch below, which
  // is what keeps the context menu and a click on the same token in agreement.
  const urlMatches = [...trimmed.matchAll(FILE_URL_REGEX)];
  if (urlMatches.length === 1 && urlMatches[0]?.[1] === trimmed) {
    return resolveFileUrlCandidate(trimmed);
  }

  if (isPathExcluded(trimmed)) return null;

  // The user selected exactly this span, so an unquoted spaced path needs no
  // probe here — the selection itself is the evidence of where it ends.
  const spaced = findSpacedFilePathCandidates(trimmed).find((candidate) => {
    const quoted = candidate.startIndex === 1 && candidate.endIndex === trimmed.length - 1;
    const whole = candidate.startIndex === 0 && candidate.endIndex === trimmed.length;
    return whole || (quoted && trimmed[0] === trimmed[trimmed.length - 1]);
  });
  if (spaced) return resolveFilePathCandidate(spaced.path, cwd);

  const matches = [...trimmed.matchAll(FILE_PATH_REGEX)];
  if (matches.length !== 1) return null;
  const [match] = matches;
  if (!match || match[1] !== trimmed) return null;
  return resolveFilePathCandidate(trimmed, cwd);
}
