import { scrubSecrets } from "../../shared/utils/secretScrubber.js";

// Keyterms leave the machine with the audio (for Deepgram, in the WebSocket
// URL's query string), so anything shaped like a credential is dropped. These
// checks are deliberately looser than `scrubSecrets`, whose exact-length
// formats miss a truncated or unfamiliar key: a false positive here only costs
// one recognition hint.

const CREDENTIAL_PREFIX_RE =
  /^(?:gh[oprsu]_|github_pat_|gl(?:pat|dt|ptt|rt)-|sk-|(?:sk|rk|pk)_(?:live|test)_|whsec_|xox[abeoprs]-|xapp-|npm_|hf_|gsk_|r8_|do[opr]_v1_|lin_api_|ntn_|pplx-|xai-|A[SKB]IA|AIza|eyJ)[A-Za-z0-9_\-+/=]{12,}$/;

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
// credential after one of these, or inside an env-var name.
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
const HEX_ID_RE = /^[0-9a-f]{8,}$/i;
const DIGIT_RUN_RE = /[0-9]+/g;

// Below this a random-looking run is indistinguishable from an abbreviation.
const MIN_RANDOM_LENGTH = 16;
// Identifiers average 4+ chars per word; random base62 averages under 2. Both
// thresholds were calibrated against ~150k identifiers from this repo's own
// source, which they reject one of while catching ~97-99% of random base62.
const MAX_RANDOM_CHARS_PER_WORD = 3;
const MIN_RANDOM_DIGIT_RUNS = 3;

// Commit SHAs, UUIDs and hex-encoded keys. Requiring a digit spares words that
// happen to use only a-f ("deadbeef", "facade").
function isHexId(value: string): boolean {
  return HEX_ID_RE.test(value) && /[0-9]/.test(value);
}

function looksRandom(value: string): boolean {
  if (value.length < MIN_RANDOM_LENGTH) return false;
  const words = value.match(WORD_RE)?.length ?? 1;
  if (value.length / words < MAX_RANDOM_CHARS_PER_WORD) return true;
  return (value.match(DIGIT_RUN_RE)?.length ?? 0) >= MIN_RANDOM_DIGIT_RUNS;
}

function namesCredential(term: string, segments: string[]): boolean {
  const words = segments.flatMap((segment) => segment.match(WORD_RE) ?? []);
  const isEnvVar = ENV_VAR_RE.test(term);
  return words.some((word, i) => {
    const lower = word.toLowerCase();
    if (CREDENTIAL_WORDS.has(lower)) return true;
    if (lower !== "key" && lower !== "keys") return false;
    return isEnvVar || (i > 0 && KEY_QUALIFIERS.has(words[i - 1].toLowerCase()));
  });
}

/**
 * Whether `term` looks like a credential, a credential's name, or an opaque ID:
 * a known token prefix, a name such as `OPENAI_API_KEY`, a hex run (SHA, UUID),
 * or a run of high-entropy characters.
 */
export function isSecretShaped(term: string): boolean {
  if (CREDENTIAL_PREFIX_RE.test(term)) return true;
  const segments = term.split(SEGMENT_SEPARATOR_RE).filter(Boolean);
  if (segments.some((segment) => isHexId(segment) || looksRandom(segment))) return true;
  if (segments.length > 1) {
    // A base64url body splits into short pieces that each pass on their own.
    const body = segments.join("");
    if (isHexId(body) || looksRandom(body)) return true;
  }
  return namesCredential(term, segments);
}

// Every character a credential body uses, so a whole key is judged as one run
// and no camelCase-looking slice of it survives to be matched on its own.
const CANDIDATE_RUN_RE = /[A-Za-z0-9_\-+/=]+/g;

/**
 * Blanks known secret formats and every secret-shaped run out of a line of
 * terminal output, before any identifier is extracted from it.
 */
export function redactSecretShapedText(text: string): string {
  return scrubSecrets(text).replace(CANDIDATE_RUN_RE, (run) => (isSecretShaped(run) ? " " : run));
}
