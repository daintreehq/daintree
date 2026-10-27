import { findSecretInValue } from "../../shared/utils/secretScrubber.js";

// Keyterms leave the machine with the audio (for Deepgram, in the WebSocket
// URL's query string), so anything shaped like a credential is dropped. These
// checks are deliberately looser than the shared scrubber, whose exact-length
// formats miss a truncated or unfamiliar key: a false positive here only costs
// a recognition hint.

// Prefixes no identifier shares, so even a short body after one is a piece of
// a key. A prefix counts at the start of a run or behind an `=` or path
// separator (`KEY=ghp_…`, `/tmp/ghp_…`).
const STRONG_PREFIX_RE =
  /(?:^|[=/+])(?:gh[oprsu]_|github_pat_|gl(?:pat|dt|ptt|rt)-|sk-(?:proj|ant|svcacct|admin)-|(?:sk|rk)_(?:live|test)_|whsec_|xox[abeoprs]-|xapp-|A[SKB]IA|AIza)[A-Za-z0-9_-]{4}/;
// Prefixes some identifiers share (`hf_hub_download`, `npm_config_registry`),
// so the body must be long and hold a digit or a capital, as real keys' do.
const WEAK_PREFIX_RE =
  /(?:^|[=/+])(?:sk-|pk_(?:live|test)_|npm_|hf_|gsk_|r8_|do[opr]_v1_|lin_api_|ntn_|pplx-|xai-|eyJ)([A-Za-z0-9_-]{12,})/;

// Words that name a credential wherever they appear: `GITHUB_TOKEN`,
// `clientSecret`, `db-password`.
const CREDENTIAL_WORDS = new Set([
  "apikey",
  "apikeys",
  "credential",
  "credentials",
  "passphrase",
  "passwd",
  "password",
  "passwords",
  "pwd",
  "secret",
  "secrets",
  "token",
  "tokens",
]);

// Too common to blank on sight (`useAuthStore`), but a value assigned to one
// is a credential: `Authorization: Basic …`, Docker's `"auth": "…"`, `DB_PASS=…`.
const ASSIGNED_CREDENTIAL_WORDS = new Set(["auth", "authorization", "pass"]);

// WORD_RE can't split an all-caps or all-lowercase run (`PGPASSWORD`,
// `secretkey`), so a name holding a value is also searched for these.
const CREDENTIAL_SUBSTRING_RE = /password|passwd|passphrase|secret|token|apikey|credential/;

// "key" alone is too common (`onKeyDown`, `primaryKey`), so it only names a
// credential after one of these, or at the end of an env-var name
// (`STRIPE_KEY`, not `MCP_DEDUP_KEY_COLLISION`).
const KEY_QUALIFIERS = new Set([
  "access",
  "api",
  "app",
  "auth",
  "client",
  "encryption",
  "license",
  "master",
  "private",
  "secret",
  "service",
  "signing",
  "ssh",
]);

const ENV_VAR_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

// Splits camelCase humps, acronyms and digit runs: `APIKeyV2` → API, Key, V, 2.
const WORD_RE = /[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[0-9]+/g;
const SEGMENT_SEPARATOR_RE = /[-_+/=]+/;
const HEX_RE = /^[0-9a-f]+$/i;
const HEX_ID_RE = /^[0-9a-f]{8,}$/i;
const DIGIT_RUN_RE = /[0-9]+/g;

// Below this a random-looking run is indistinguishable from an abbreviation.
const MIN_RANDOM_LENGTH = 16;
// Identifiers average 4+ chars per word; random base62 averages under 2. Both
// thresholds were calibrated against ~110k identifiers from this repo's own
// source, which they reject two of while catching ~99% of random base62 keys
// of 20 or more characters. A mixed-case key with no digits is the shape they
// miss most.
const MAX_RANDOM_CHARS_PER_WORD = 3;
const MIN_RANDOM_DIGIT_RUNS = 3;

// The characters of base64, base64url and hex key bodies, so a whole key is
// judged as one run. Passwords can hold anything; they're caught by context.
const CANDIDATE_RUN_RE = /[A-Za-z0-9_\-+/=]+/g;
// Blanking works per path component, so a name such as `voiceKeytermSecrets`
// in a path doesn't take the rest of the path with it.
const BLANKABLE_RUN_RE = /[A-Za-z0-9_\-+=]+/g;

// `NAME=value`, `NAME: value`, `"name":   "value"`, and `name:` at the end of a
// line with the value on the next; not `==`, `=>` or `::`. The name must start
// at a boundary, which keeps a long run with no delimiter linear.
const ASSIGNMENT_RE =
  /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]{1,64})["']?[ \t]*(?:=(?![=>])|:(?!:))[ \t]*(["']?)([^\s"',;(]*)(\(\)?)?/g;
// `--password hunter2`, `-token abc`, and an argv array's `"--token", "abc"`:
// a flag whose value is the next argument.
const FLAG_VALUE_RE =
  /(?<![A-Za-z0-9_-])--?([A-Za-z][A-Za-z0-9_-]{0,63})["']?,?[ \t]+(["']?)([^\s"',;]*)/g;
// Values that are code rather than a credential: `password: string`,
// `MAX_TOKENS=8192`, `token = getToken()`, `secret: process.env.SECRET`,
// `password: ${DB_PASSWORD}`. A call with arguments may be wrapping a literal,
// so only an empty one counts.
const TYPE_WORDS = new Set([
  "any",
  "boolean",
  "false",
  "null",
  "number",
  "object",
  "string",
  "true",
  "undefined",
  "unknown",
]);
const MEMBER_CHAIN_RE = /^[a-z_][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const ENV_REFERENCE_RE = /^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Z_][A-Z0-9_]*)$/;
const URL_CREDENTIALS_RE = /\b[a-z][a-z0-9+.-]{1,30}:\/\/[^\s/@:]+:[^\s/@]+@/i;
const NETRC_RE = /^\s*(?:machine\s+\S+|default)\b.*\bpassword\s+\S/;

function segmentsOf(run: string): string[] {
  return run.split(SEGMENT_SEPARATOR_RE).filter(Boolean);
}

function wordsOf(run: string): string[] {
  return segmentsOf(run).flatMap((segment) => segment.match(WORD_RE) ?? []);
}

// Commit SHAs, UUIDs and hex-encoded keys. Requiring a digit spares words that
// happen to use only a-f ("deadbeef", "facade").
function isHexId(value: string): boolean {
  return HEX_ID_RE.test(value) && /[0-9]/.test(value);
}

// Hex is left to `isOpaqueId`: a SHA and a hex key look alike, and neither has
// a camelCase or separated slice that could escape as an identifier, so
// blanking the run alone is enough.
function looksRandom(value: string): boolean {
  if (value.length < MIN_RANDOM_LENGTH || HEX_RE.test(value)) return false;
  const words = value.match(WORD_RE)?.length ?? 1;
  if (value.length / words < MAX_RANDOM_CHARS_PER_WORD) return true;
  return (value.match(DIGIT_RUN_RE)?.length ?? 0) >= MIN_RANDOM_DIGIT_RUNS;
}

function hasCredentialPrefix(run: string): boolean {
  if (STRONG_PREFIX_RE.test(run)) return true;
  const body = WEAK_PREFIX_RE.exec(run)?.[1];
  return body !== undefined && /[0-9A-Z]/.test(body);
}

// A key, or a piece of one: a known prefix, or a high-entropy run. A base64url
// body splits into short pieces that each pass alone, so they're also judged
// joined, less any hex: a UUID or SHA beside a name (`request_id=<uuid>`) is
// an ID, not one long key.
function isCredentialShaped(run: string): boolean {
  if (hasCredentialPrefix(run)) return true;
  const segments = segmentsOf(run);
  if (segments.some(looksRandom)) return true;
  const pieces = segments.filter((segment) => !HEX_RE.test(segment));
  return pieces.length > 1 && looksRandom(pieces.join(""));
}

function isOpaqueId(run: string): boolean {
  const segments = segmentsOf(run);
  if (segments.some(isHexId)) return true;
  return segments.length > 1 && isHexId(segments.join(""));
}

function namesCredential(run: string): boolean {
  const words = wordsOf(run);
  const isEnvVar = ENV_VAR_RE.test(run);
  return words.some((word, i) => {
    const lower = word.toLowerCase();
    if (CREDENTIAL_WORDS.has(lower)) return true;
    if (lower !== "key" && lower !== "keys") return false;
    if (isEnvVar && i === words.length - 1) return true;
    return i > 0 && KEY_QUALIFIERS.has(words[i - 1].toLowerCase());
  });
}

// A number is code to a keyterm filter, but strict callers send the line on,
// where `PGPASSWORD=123456` is a password.
function isCodeValue(value: string, call: string | undefined, strict: boolean): boolean {
  if (call !== undefined) return call === "()";
  if ((!strict && /^\d+$/.test(value)) || ENV_REFERENCE_RE.test(value)) return true;
  return TYPE_WORDS.has(value.toLowerCase()) || MEMBER_CHAIN_RE.test(value);
}

// Looser than `namesCredential`, which also blanks names on sight: a name is
// only judged this way when a value comes with it.
function namesHeldCredential(name: string): boolean {
  if (namesCredential(name) || CREDENTIAL_SUBSTRING_RE.test(name.toLowerCase())) return true;
  return wordsOf(name).some((word) => ASSIGNED_CREDENTIAL_WORDS.has(word.toLowerCase()));
}

function assignsCredential(text: string, strict: boolean): boolean {
  for (const match of text.matchAll(ASSIGNMENT_RE)) {
    const [, name, quote, value, call] = match;
    if (!namesHeldCredential(name)) continue;
    if (quote) return true;
    // `password:` closing the line holds its value on the next one.
    if (!value) {
      if (text.slice(match.index + match[0].length).trim() === "") return true;
      continue;
    }
    if (!isCodeValue(value, call, strict)) return true;
  }
  return false;
}

// A shell argument is a literal, so unlike an assignment a dotted value isn't
// taken for code. Help text's `--token string` and `--password $DB_PASSWORD`
// still aren't credentials.
function passesCredentialFlag(text: string, strict: boolean): boolean {
  for (const [, name, quote, value] of text.matchAll(FLAG_VALUE_RE)) {
    if (!namesHeldCredential(name)) continue;
    if (quote) return true;
    if (!value || value.startsWith("-")) continue;
    if ((!strict && /^\d+$/.test(value)) || ENV_REFERENCE_RE.test(value)) continue;
    if (!TYPE_WORDS.has(value.toLowerCase())) return true;
  }
  return false;
}

/**
 * Whether `term` looks like a credential, names one (`OPENAI_API_KEY`), or is
 * an opaque ID such as a commit SHA or UUID.
 */
export function isSecretShaped(term: string): boolean {
  return isCredentialShaped(term) || isOpaqueId(term) || namesCredential(term);
}

/**
 * Whether `text` holds a credential: a known secret format, a key-shaped run,
 * credentials in a URL or a `.netrc` line, or a value assigned to a
 * credential name or passed to a credential flag. `strict` also counts a
 * bare number there, for text that leaves the machine as written.
 */
export function holdsCredential(text: string, strict = false): boolean {
  if (findSecretInValue(text)) return true;
  if (URL_CREDENTIALS_RE.test(text) || NETRC_RE.test(text)) return true;
  for (const [run] of text.matchAll(CANDIDATE_RUN_RE)) {
    if (isCredentialShaped(run)) return true;
  }
  return assignsCredential(text, strict) || passesCredentialFlag(text, strict);
}

/**
 * Like {@link holdsCredential}, but also true for an opaque ID, whose pieces
 * would pass on their own once a name is split into tokens.
 */
export function holdsCredentialOrId(text: string): boolean {
  if (holdsCredential(text)) return true;
  for (const [run] of text.matchAll(CANDIDATE_RUN_RE)) {
    if (isOpaqueId(run)) return true;
  }
  return false;
}

// A wrapped key body: nothing but key characters, perhaps inside TUI framing.
const BARE_RUN_RE = /^[\s│┃║|⎿]*[A-Za-z0-9_\-+/=]+[\s│┃║|]*$/;

/**
 * Prepares terminal lines for identifier extraction, keeping their positions.
 *
 * A line holding a credential is emptied whole, and so is the line after it,
 * which may hold the rest of a key an agent's TUI wrapped, and any further
 * lines that are still one bare run of key characters, up to a blank line. Cutting the key out
 * instead would leave any piece that slipped past detection, or that sat
 * beside a recognised token, free to match as an identifier. In the lines that
 * remain, opaque IDs and bare credential names are blanked. `strict` is for
 * lines sent on as text rather than mined for words (see {@link holdsCredential}).
 *
 * `joined` is the same lines from a terminal with its cursor moves closed up
 * rather than kept as spaces, the way the raw stream's bytes run. A repaint
 * can split a key across moves, so the joined form holding a credential, or a
 * bare run of a wrapped one, counts too, and an ID only the join makes empties
 * the line rather than leave its pieces. A credential name only the join makes
 * doesn't: closing up prose makes those (`API key` → `APIkey`).
 */
export function redactSecretShapedLines(
  lines: readonly string[],
  strict = false,
  joined: readonly string[] = lines
): string[] {
  let wrapping = false;
  let firstAfter = false;
  return lines.map((line, i) => {
    const closed = joined[i] ?? line;
    const split = closed !== line;
    if (holdsCredential(line, strict) || (split && holdsCredential(closed, strict))) {
      wrapping = true;
      firstAfter = true;
      return "";
    }
    if (wrapping) {
      // A blank line ends a wrapped key.
      const continues =
        line.trim() !== "" &&
        (firstAfter || BARE_RUN_RE.test(line) || (split && BARE_RUN_RE.test(closed)));
      firstAfter = false;
      if (continues) return "";
      wrapping = false;
    }
    if (split && joinsOpaqueId(closed, line)) return "";
    return line.replace(BLANKABLE_RUN_RE, (run) =>
      isOpaqueId(run) || namesCredential(run) ? " " : run
    );
  });
}

// An ID in a run the spaced line doesn't have came from pieces it keeps
// apart, each too short to read as one: a hex key split by a repaint.
function joinsOpaqueId(joined: string, spaced: string): boolean {
  const runs = new Set(spaced.match(BLANKABLE_RUN_RE));
  for (const [run] of joined.matchAll(BLANKABLE_RUN_RE)) {
    if (!runs.has(run) && isOpaqueId(run)) return true;
  }
  return false;
}
