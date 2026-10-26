import { findSecretInValue } from "../../shared/utils/secretScrubber.js";

// Keyterms leave the machine with the audio (for Deepgram, in the WebSocket
// URL's query string), so anything shaped like a credential is dropped. These
// checks are deliberately looser than the shared scrubber, whose exact-length
// formats miss a truncated or unfamiliar key: a false positive here only costs
// a recognition hint.

// A prefix counts at the start of a run or behind an `=` or path separator
// (`KEY=sk-…`, `/tmp/ghp_…`). Its body must hold a digit or a capital, which
// real keys always do and `hf_hub_download` or `npm_config_registry` don't.
const CREDENTIAL_PREFIX_RE =
  /(?:^|[=/+])(?:gh[oprsu]_|github_pat_|gl(?:pat|dt|ptt|rt)-|sk-|(?:sk|rk|pk)_(?:live|test)_|whsec_|xox[abeoprs]-|xapp-|npm_|hf_|gsk_|r8_|do[opr]_v1_|lin_api_|ntn_|pplx-|xai-|A[SKB]IA|AIza|eyJ)([A-Za-z0-9_-]{12,})/;

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
// thresholds were calibrated against ~150k identifiers from this repo's own
// source, which they reject one of while catching ~97-99% of random base62.
const MAX_RANDOM_CHARS_PER_WORD = 3;
const MIN_RANDOM_DIGIT_RUNS = 3;

// Every character a credential body uses, so a whole key is judged as one run.
const CANDIDATE_RUN_RE = /[A-Za-z0-9_\-+/=]+/g;
// `NAME=value`, `NAME: value`, `"name": "value"`.
const ASSIGNMENT_RE = /([A-Za-z0-9_-]+)["']?[ \t]{0,4}[:=][ \t]{0,4}["']?[^\s"']/g;

function segmentsOf(run: string): string[] {
  return run.split(SEGMENT_SEPARATOR_RE).filter(Boolean);
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
  if (value.length < MIN_RANDOM_LENGTH || HEX_ID_RE.test(value)) return false;
  const words = value.match(WORD_RE)?.length ?? 1;
  if (value.length / words < MAX_RANDOM_CHARS_PER_WORD) return true;
  return (value.match(DIGIT_RUN_RE)?.length ?? 0) >= MIN_RANDOM_DIGIT_RUNS;
}

function hasCredentialPrefix(run: string): boolean {
  const body = CREDENTIAL_PREFIX_RE.exec(run)?.[1];
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
  const words = segmentsOf(run).flatMap((segment) => segment.match(WORD_RE) ?? []);
  const isEnvVar = ENV_VAR_RE.test(run);
  return words.some((word, i) => {
    const lower = word.toLowerCase();
    if (CREDENTIAL_WORDS.has(lower)) return true;
    if (lower !== "key" && lower !== "keys") return false;
    if (isEnvVar && i === words.length - 1) return true;
    return i > 0 && KEY_QUALIFIERS.has(words[i - 1].toLowerCase());
  });
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
 * or a value assigned to a credential name.
 */
export function holdsCredential(text: string): boolean {
  if (findSecretInValue(text)) return true;
  for (const [run] of text.matchAll(CANDIDATE_RUN_RE)) {
    if (isCredentialShaped(run)) return true;
  }
  for (const [, name] of text.matchAll(ASSIGNMENT_RE)) {
    if (namesCredential(name)) return true;
  }
  return false;
}

/**
 * Prepares terminal lines for identifier extraction, keeping their positions.
 *
 * A line holding a credential is emptied whole, along with the line after it,
 * which may hold the rest of a key an agent's TUI wrapped. Cutting the key out
 * instead would leave any piece that slipped past detection, or that sat beside
 * a recognised token, free to match as an identifier. In the lines that remain,
 * opaque IDs and bare credential names are blanked.
 */
export function redactSecretShapedLines(lines: readonly string[]): string[] {
  let dropNext = false;
  return lines.map((line) => {
    if (holdsCredential(line)) {
      dropNext = true;
      return "";
    }
    if (dropNext) {
      dropNext = false;
      return "";
    }
    return line.replace(CANDIDATE_RUN_RE, (run) =>
      isOpaqueId(run) || namesCredential(run) ? " " : run
    );
  });
}
