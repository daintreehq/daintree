/**
 * Detect phonetically-similar substitutions a user made while manually editing
 * dictated text — the signal for learning custom dictionary words. When a user
 * dictates "zoo stand" and corrects it to "Zustand" before sending, the pair is
 * a phonetic correction we can offer as a suggested dictionary term.
 *
 * Pure functions, no dependencies — runs in the renderer at send time. The
 * `isLearnableTerm` filter mirrors the keyterm-validation rules in
 * `electron/services/voiceContextKeyterms.ts` (min length, blocklist, no pure
 * numbers); the constants are intentionally co-located because that module has
 * Electron-only imports and can't be loaded from the renderer.
 */

const MIN_TERM_LENGTH = 4;

// Shell commands, language keywords, and common English stop words that should
// never be suggested as dictionary terms even if they pass the phonetic gate.
// Kept in sync with the blocklist in `voiceContextKeyterms.ts`.
const BLOCKLIST = new Set([
  // Shell commands
  "bash",
  "brew",
  "curl",
  "echo",
  "exit",
  "export",
  "find",
  "grep",
  "kill",
  "less",
  "make",
  "mkdir",
  "more",
  "nano",
  "node",
  "npx",
  "pipe",
  "push",
  "ruby",
  "rust",
  "sass",
  "scss",
  "sudo",
  "tail",
  "test",
  "then",
  "tree",
  "wget",
  "yarn",
  "docker",
  // JS/TS keywords
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "else",
  "enum",
  "extends",
  "false",
  "finally",
  "from",
  "function",
  "import",
  "interface",
  "module",
  "null",
  "number",
  "object",
  "package",
  "private",
  "protected",
  "public",
  "require",
  "return",
  "static",
  "string",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "type",
  "typeof",
  "undefined",
  "void",
  "while",
  "with",
  "yield",
  // Common English stop words
  "about",
  "after",
  "also",
  "been",
  "before",
  "being",
  "between",
  "both",
  "came",
  "come",
  "could",
  "does",
  "done",
  "each",
  "even",
  "every",
  "first",
  "going",
  "good",
  "great",
  "have",
  "here",
  "into",
  "just",
  "know",
  "like",
  "line",
  "long",
  "look",
  "made",
  "many",
  "most",
  "much",
  "must",
  "name",
  "need",
  "next",
  "note",
  "only",
  "open",
  "over",
  "part",
  "same",
  "said",
  "should",
  "show",
  "some",
  "such",
  "take",
  "than",
  "that",
  "them",
  "there",
  "these",
  "they",
  "thing",
  "think",
  "those",
  "through",
  "time",
  "under",
  "upon",
  "used",
  "using",
  "very",
  "want",
  "well",
  "were",
  "what",
  "when",
  "where",
  "which",
  "will",
  "without",
  "work",
  "would",
  "your",
]);

/** A phonetic correction candidate: the user's corrected word plus the phrase it replaced. */
export interface CorrectionCandidate {
  /** The corrected term, in the user's original casing (e.g. "Zustand"). */
  word: string;
  /** The misheard phrase it replaced, for provenance (e.g. "zoo stand"). */
  original: string;
}

/** Lowercase a token and strip everything that isn't a letter or digit. */
function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Strip leading/trailing punctuation while preserving internal casing and dots (e.g. "Vue.js"). */
function stripEdgePunctuation(token: string): string {
  return token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/** Whether a normalized token is worth suggesting as a dictionary term. */
export function isLearnableTerm(normalized: string): boolean {
  if (normalized.length < MIN_TERM_LENGTH) return false;
  if (/^\d+$/.test(normalized)) return false;
  if (BLOCKLIST.has(normalized)) return false;
  return true;
}

const SOUNDEX_CODES: Record<string, string> = {
  B: "1",
  F: "1",
  P: "1",
  V: "1",
  C: "2",
  G: "2",
  J: "2",
  K: "2",
  Q: "2",
  S: "2",
  X: "2",
  Z: "2",
  D: "3",
  T: "3",
  L: "4",
  M: "5",
  N: "5",
  R: "6",
};

/** Classic Soundex encoding (letter + 3 digits). Empty string for non-alpha input. */
export function soundex(value: string): string {
  const letters = value.toUpperCase().replace(/[^A-Z]/g, "");
  if (!letters) return "";

  const first = letters[0]!;
  let result = first;
  let prev = SOUNDEX_CODES[first] ?? "";

  for (let i = 1; i < letters.length && result.length < 4; i++) {
    const ch = letters[i]!;
    const code = SOUNDEX_CODES[ch] ?? "";
    if (code && code !== prev) {
      result += code;
    }
    // H and W are transparent — they don't reset the previous code, so a digit
    // separated only by H/W is still treated as a repeat. Vowels reset it.
    if (ch !== "H" && ch !== "W") {
      prev = code;
    }
  }

  return (result + "000").slice(0, 4);
}

/** Levenshtein edit distance between two strings. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }

  return prev[b.length]!;
}

/** Similarity ratio in [0, 1]: 1 = identical, 0 = no shared characters. */
export function levenshteinRatio(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

/**
 * Whether two leading sounds are compatible: the same letter, or two consonants
 * that share a Soundex code (so c≡k, s≡z). Mishearings rarely change the
 * leading sound, but they routinely swap homophonic consonants.
 */
function firstSoundCompatible(a: string, b: string): boolean {
  if (a[0] === b[0]) return true;
  const ca = SOUNDEX_CODES[a[0]!.toUpperCase()];
  const cb = SOUNDEX_CODES[b[0]!.toUpperCase()];
  return !!ca && ca === cb;
}

/**
 * Whether two normalized forms are close enough to be a mishearing rather than
 * an unrelated rewrite. Requires a compatible leading sound plus either an
 * exact Soundex match or a high edit ratio.
 */
function isPhoneticallySimilar(a: string, b: string): boolean {
  if (!a || !b || a === b) return false;
  if (!firstSoundCompatible(a, b)) return false;
  if (soundex(a) === soundex(b)) return true;
  return levenshteinRatio(a, b) >= 0.4;
}

/** Split text into whitespace-delimited tokens. */
function tokenize(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * Align two token sequences via LCS and return the substituted runs — maximal
 * spans where one side's tokens were replaced by the other's. Pure insertions
 * and deletions (one side empty) are included so callers can filter them out.
 */
function diffRuns(before: string[], after: string[]): Array<{ before: string[]; after: string[] }> {
  const a = before.map(normalizeToken);
  const b = after.map(normalizeToken);
  const m = a.length;
  const n = b.length;

  // dp[i][j] = LCS length of a[i..] and b[j..]
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const runs: Array<{ before: string[]; after: string[] }> = [];
  let curBefore: string[] = [];
  let curAfter: string[] = [];
  const flush = () => {
    if (curBefore.length || curAfter.length) {
      runs.push({ before: curBefore, after: curAfter });
      curBefore = [];
      curAfter = [];
    }
  };

  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      curBefore.push(before[i]!);
      i++;
    } else {
      curAfter.push(after[j]!);
      j++;
    }
  }
  while (i < m) curBefore.push(before[i++]!);
  while (j < n) curAfter.push(after[j++]!);
  flush();

  return runs;
}

/**
 * Find phonetically-similar substitutions between a baseline transcription and
 * the user's edited text. Returns the corrected terms (deduped, case
 * preserved) the user likely wants in their dictionary.
 *
 * Handles 1:1, many:1 ("zoo stand" → "Zustand"), and 1:many substitutions by
 * comparing the concatenated forms of each substituted run.
 */
export function findCorrectionCandidates(baseline: string, edited: string): CorrectionCandidate[] {
  if (!baseline.trim() || !edited.trim()) return [];

  const runs = diffRuns(tokenize(baseline), tokenize(edited));
  const out: CorrectionCandidate[] = [];
  const seen = new Set<string>();

  for (const run of runs) {
    // Only substitutions (both sides non-empty) are corrections; pure
    // insertions or deletions carry no misheard→fixed pairing.
    if (run.before.length === 0 || run.after.length === 0) continue;
    // Only clean consolidating substitutions (1:1 or many:1). A multi-token
    // corrected run is ambiguous — it usually means the user appended unrelated
    // words after the dictated term — so skip it rather than suggest noise.
    if (run.after.length !== 1) continue;

    const token = run.after[0]!;
    const beforeJoined = run.before.map(normalizeToken).join("");
    const normalized = normalizeToken(token);
    if (!isPhoneticallySimilar(beforeJoined, normalized)) continue;
    if (!isLearnableTerm(normalized)) continue;
    if (seen.has(normalized)) continue;

    seen.add(normalized);
    out.push({ word: stripEdgePunctuation(token), original: run.before.join(" ") });
  }

  return out;
}
