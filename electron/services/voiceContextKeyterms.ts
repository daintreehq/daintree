import { GitService } from "./GitService.js";
import type { PtyClient } from "./PtyClient.js";
import { logDebug } from "../utils/logger.js";

const P = "[VoiceKeyterms]";

const MAX_KEYTERMS = 50;
const TERMINAL_TIER_CAP = 30;
// Deepgram nova-3 rejects any keyterm longer than 100 chars with an HTTP 400
// that fails the WebSocket upgrade, so cap every term at the source.
const MAX_KEYTERM_LENGTH = 100;
const ASSEMBLY_TIMEOUT_MS = 500;
const MIN_TERM_LENGTH = 4;
const MAX_KEYTERM_LINES = 200;
const MAX_PROMPT_CHARS = 400;
const KEYTERM_PROMPT_PREFIX = "Keywords: ";
const KEYTERM_PROMPT_SEPARATOR = ", ";

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
  "export",
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
  "from",
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
  "make",
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
  "then",
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
  "while",
  "will",
  "with",
  "without",
  "work",
  "would",
  "your",
]);

// Matches ANSI escape sequences
// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g;

// Matches identifiers: camelCase, PascalCase, snake_case, kebab-case (with internal separators)
const IDENTIFIER_RE = /\b[a-zA-Z][a-zA-Z0-9]*(?:[-_][a-zA-Z0-9]+)+\b/g;

// Matches camelCase/PascalCase words (at least two humps)
const CAMEL_RE = /\b[a-z]+(?:[A-Z][a-z0-9]+)+\b|\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g;

export interface KeytermAssemblyOpts {
  customDictionary: string[];
  projectName?: string;
  projectPath?: string;
  ptyClient?: PtyClient;
}

function isValidTerm(term: string): boolean {
  if (term.length < MIN_TERM_LENGTH) return false;
  if (/^\d+$/.test(term)) return false;
  if (BLOCKLIST.has(term.toLowerCase())) return false;
  return true;
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

export function tokenizeBranchName(branchName: string): string[] {
  const parts = branchName.split(/[/\-_.]+/);
  return parts.filter(isValidTerm);
}

export function tokenizeProjectName(name: string): string[] {
  // Split on whitespace, hyphens, underscores
  const parts = name.split(/[\s\-_]+/);
  // Also split camelCase and PascalCase
  const expanded: string[] = [];
  for (const part of parts) {
    const camelParts = part
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/\s+/);
    expanded.push(...camelParts);
  }
  return expanded.filter(isValidTerm);
}

interface TermScore {
  canonical: string;
  // Number of distinct lines the term appears on (frequency signal).
  lineCount: number;
  // Index of the most recent line the term appeared on (recency signal).
  lastLineIndex: number;
}

// Ranks terminal-derived identifiers by a deterministic composite score so the
// strongest candidates are emitted first. The score is a pure function of the
// input lines: `lineCount * (lastLineIndex + 1)`, combining how often a term
// recurs (distinct-line frequency) with how recently it appeared (line index as
// the recency proxy). Rarity is handled by the existing blocklist + length
// filter in `isValidTerm`. Ties break on canonical form ascending for stable,
// cross-platform ordering. No clocks, no floats, no external state.
export function extractTerminalIdentifiers(lines: string[]): string[] {
  const scores = new Map<string, TermScore>();

  lines.forEach((line, lineIndex) => {
    // Guard against malformed IPC payloads delivering non-string lines, which
    // would otherwise throw in stripAnsi and drop the entire terminal tier.
    if (typeof line !== "string") return;
    const clean = stripAnsi(line);
    // Count each term at most once per line so same-line repeats don't inflate
    // frequency (e.g. a log line spamming one identifier).
    const seenThisLine = new Set<string>();

    const record = (term: string): void => {
      if (!isValidTerm(term)) return;
      const key = term.toLowerCase();
      if (seenThisLine.has(key)) return;
      seenThisLine.add(key);
      const existing = scores.get(key);
      if (existing) {
        existing.lineCount += 1;
        existing.lastLineIndex = lineIndex;
      } else {
        scores.set(key, { canonical: term, lineCount: 1, lastLineIndex: lineIndex });
      }
    };

    // Extract compound identifiers (snake_case, kebab-case)
    for (const match of clean.matchAll(IDENTIFIER_RE)) record(match[0]);
    // Extract camelCase/PascalCase identifiers
    for (const match of clean.matchAll(CAMEL_RE)) record(match[0]);
  });

  return Array.from(scores.values())
    .sort((a, b) => {
      const scoreA = a.lineCount * (a.lastLineIndex + 1);
      const scoreB = b.lineCount * (b.lastLineIndex + 1);
      if (scoreB !== scoreA) return scoreB - scoreA;
      // Codepoint comparison (not localeCompare) keeps ties deterministic
      // regardless of host locale.
      if (a.canonical < b.canonical) return -1;
      if (a.canonical > b.canonical) return 1;
      return 0;
    })
    .map((entry) => entry.canonical);
}

async function getBranchName(projectPath: string): Promise<string | null> {
  try {
    const git = new GitService(projectPath);
    const branches = await git.listBranches();
    const current = branches.find((b) => b.current);
    return current?.name ?? null;
  } catch {
    logDebug(`${P} Failed to get branch name`);
    return null;
  }
}

async function getTerminalLines(ptyClient: PtyClient): Promise<string[]> {
  try {
    const snapshots = await ptyClient.getAllTerminalSnapshots();
    const allLines: string[] = [];
    for (const snap of snapshots) {
      allLines.push(...snap.lines);
    }
    return allLines.slice(-MAX_KEYTERM_LINES);
  } catch {
    logDebug(`${P} Failed to get terminal snapshots`);
    return [];
  }
}

export async function assembleKeyterms(opts: KeytermAssemblyOpts): Promise<string[]> {
  const { customDictionary, projectName, projectPath, ptyClient } = opts;
  const seen = new Set<string>();
  const result: string[] = [];

  function add(term: string): boolean {
    if (result.length >= MAX_KEYTERMS) return false;
    const capped = capTermLength(term, MAX_KEYTERM_LENGTH);
    const key = capped.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    result.push(capped);
    return true;
  }

  // Priority 1: User custom dictionary (highest priority)
  for (const term of customDictionary) {
    const trimmed = term.trim();
    if (trimmed.length >= 2 && !/^\d+$/.test(trimmed)) {
      add(trimmed);
    }
  }

  // Priority 2: Project name tokens
  if (projectName) {
    const trimmed = projectName.trim();
    if (trimmed.length >= 2 && !/^\d+$/.test(trimmed)) {
      add(trimmed);
    }
    for (const token of tokenizeProjectName(projectName)) {
      add(token);
    }
  }

  // Gather dynamic context concurrently, each read guarded by its own timeout.
  // Both reads fire at once so leading speech isn't delayed; results are merged
  // in priority order afterward (branch tokens = Priority 3, terminal = Priority 4).
  const branchPromise = projectPath
    ? (async (): Promise<string | null> => {
        let branchTimer: NodeJS.Timeout | undefined;
        try {
          const timeoutPromise = new Promise<null>((resolve) => {
            branchTimer = setTimeout(() => resolve(null), ASSEMBLY_TIMEOUT_MS);
            branchTimer.unref();
          });
          return await Promise.race([getBranchName(projectPath), timeoutPromise]);
        } catch {
          logDebug(`${P} Branch name lookup failed`);
          return null;
        } finally {
          if (branchTimer) clearTimeout(branchTimer);
        }
      })()
    : Promise.resolve(null);

  const linesPromise = ptyClient
    ? (async (): Promise<string[]> => {
        let linesTimer: NodeJS.Timeout | undefined;
        try {
          const timeoutPromise = new Promise<string[]>((resolve) => {
            linesTimer = setTimeout(() => resolve([]), ASSEMBLY_TIMEOUT_MS);
            linesTimer.unref();
          });
          return await Promise.race([getTerminalLines(ptyClient), timeoutPromise]);
        } catch {
          logDebug(`${P} Terminal identifier extraction failed`);
          return [];
        } finally {
          if (linesTimer) clearTimeout(linesTimer);
        }
      })()
    : Promise.resolve<string[]>([]);

  const [branchName, lines] = await Promise.all([branchPromise, linesPromise]);

  // Priority 3: Branch name tokens
  if (branchName) {
    for (const token of tokenizeBranchName(branchName)) {
      add(token);
    }
  }

  // Priority 4: Terminal identifiers. Lines were fetched in parallel above.
  // Terminal terms are ranked best-first; bound the tier independently so
  // dictionary/project/branch terms always keep headroom under MAX_KEYTERMS.
  let terminalAdded = 0;
  for (const id of extractTerminalIdentifiers(lines)) {
    if (terminalAdded >= TERMINAL_TIER_CAP) break;
    if (add(id)) terminalAdded++;
  }

  logDebug(`${P} Assembled ${result.length} keyterms`, {
    custom: customDictionary.length,
    total: result.length,
  });

  return result;
}

// OpenAI's Realtime API rejects an entire `session.update` if any entry in
// `transcription.keywords` contains one of these characters, so a single bad
// keyterm would kill the whole dictation session. Terminal output is a rich
// source of `<`/`>` (shell redirects, JSX, diff markers), so this is a live
// hazard, not a theoretical one.
const OPENAI_FORBIDDEN_KEYWORD_CHARS = /[<>\r\n]/;

/**
 * Truncates to at most `maxLength` UTF-16 code units without splitting a
 * surrogate pair. A bare `slice` on "…99 chars…😀" leaves a lone high surrogate,
 * which serializes as a malformed `\ud83d` the server may reject or replace.
 */
function capTermLength(term: string, maxLength: number): string {
  if (term.length <= maxLength) return term;
  const cut = term.slice(0, maxLength);
  // A trailing high surrogate (D800-DBFF) means the pair was split — drop it.
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Sanitizes assembled keyterms for OpenAI's `transcription.keywords` array.
 *
 * Offending terms are DROPPED WHOLE rather than stripped: deleting `<` from
 * `<div>` yields `div`, a different literal that would bias transcription
 * toward a word the user never has on screen. A dropped term is simply absent;
 * a mangled one is silently wrong.
 *
 * The count and length bounds are Daintree's own conservative limits (shared
 * with the Deepgram path) — OpenAI documents neither, so we do not claim to
 * mirror an API limit here.
 *
 * Pure and non-mutating: the session keyterm snapshot is frozen for the
 * session's lifetime and reused across reconnects.
 */
export function sanitizeOpenAIKeywords(terms: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const term of terms) {
    if (out.length >= MAX_KEYTERMS) break;
    // Defensive: `keyterms` crosses an IPC boundary, so a malformed payload can
    // carry non-strings despite the declared type.
    if (typeof term !== "string") continue;

    const trimmed = term.trim();
    if (trimmed.length === 0) continue;
    if (OPENAI_FORBIDDEN_KEYWORD_CHARS.test(trimmed)) continue;

    const capped = capTermLength(trimmed, MAX_KEYTERM_LENGTH);
    // Dedup after trimming/capping so two terms that collapse to the same wire
    // value don't burn two slots.
    const key = capped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(capped);
  }

  return out;
}

export function formatKeytermPrompt(terms: string[], maxChars: number = MAX_PROMPT_CHARS): string {
  if (terms.length === 0) return "";

  let out = KEYTERM_PROMPT_PREFIX;
  let appended = 0;

  for (const term of terms) {
    if (term.trim().length === 0) continue;
    const candidate = appended === 0 ? out + term : out + KEYTERM_PROMPT_SEPARATOR + term;
    if (candidate.length > maxChars) continue;
    out = candidate;
    appended++;
  }

  return appended === 0 ? "" : out;
}
