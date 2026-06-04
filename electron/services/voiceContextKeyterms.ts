import { GitService } from "./GitService.js";
import type { PtyClient } from "./PtyClient.js";
import { logDebug } from "../utils/logger.js";

const P = "[VoiceKeyterms]";

const MAX_KEYTERMS = 50;
const TERMINAL_TIER_CAP = 30;
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
    const key = term.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    result.push(term);
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

  // Gather dynamic context in parallel with a timeout.
  // Branch tokens run first (Priority 3), then terminal identifiers (Priority 4).
  // We await sequentially to preserve priority ordering for the dedup/cap logic.
  if (projectPath) {
    let branchTimer: NodeJS.Timeout | undefined;
    try {
      const timeoutPromise = new Promise<null>((resolve) => {
        branchTimer = setTimeout(() => resolve(null), ASSEMBLY_TIMEOUT_MS);
        branchTimer.unref();
      });
      const branchName = await Promise.race([getBranchName(projectPath), timeoutPromise]);
      if (branchName) {
        for (const token of tokenizeBranchName(branchName)) {
          add(token);
        }
      }
    } catch {
      logDebug(`${P} Branch name lookup failed`);
    } finally {
      if (branchTimer) clearTimeout(branchTimer);
    }
  }

  if (ptyClient) {
    let linesTimer: NodeJS.Timeout | undefined;
    try {
      const timeoutPromise = new Promise<string[]>((resolve) => {
        linesTimer = setTimeout(() => resolve([]), ASSEMBLY_TIMEOUT_MS);
        linesTimer.unref();
      });
      const lines = await Promise.race([getTerminalLines(ptyClient), timeoutPromise]);
      const identifiers = extractTerminalIdentifiers(lines);
      // Terminal terms are ranked best-first; bound the tier independently so
      // dictionary/project/branch terms always keep headroom under MAX_KEYTERMS.
      let terminalAdded = 0;
      for (const id of identifiers) {
        if (terminalAdded >= TERMINAL_TIER_CAP) break;
        if (add(id)) terminalAdded++;
      }
    } catch {
      logDebug(`${P} Terminal identifier extraction failed`);
    } finally {
      if (linesTimer) clearTimeout(linesTimer);
    }
  }

  logDebug(`${P} Assembled ${result.length} keyterms`, {
    custom: customDictionary.length,
    total: result.length,
  });

  return result;
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
