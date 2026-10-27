import { isAbsolute } from "node:path";
import type { PtyClient } from "./PtyClient.js";
import { getGitBranch } from "../utils/gitUtils.js";
import { logDebug } from "../utils/logger.js";
import {
  CURSOR_GAP,
  holdsCredential,
  holdsCredentialOrId,
  isSecretShaped,
  redactSecretShapedLines,
} from "./voiceKeytermSecrets.js";
import { deriveRepoNames, stripPackageScope } from "./voiceRepoKeyterms.js";
import { SEMANTIC_BUFFER_MAX_LINE_LENGTH, SEMANTIC_BUFFER_TRUNCATION_MARKER } from "./pty/types.js";
import {
  MAX_DICTIONARY_KEYTERMS,
  MAX_KEYTERMS,
  MAX_NAME_KEYTERMS,
} from "../../shared/config/voiceKeyterms.js";
import type { DictationNames, DictationWorktree } from "./voiceContextNames.js";
import type { VoiceKeytermSource, VoiceSentTerm } from "../../shared/types/voice.js";
import type { CorrectionWorktreeContext } from "../../shared/config/voiceCorrection.js";

const P = "[VoiceKeyterms]";

const TERMINAL_TIER_CAP = 30;
const PROJECT_TIER_CAP = 4;
// Fixed so repo-derived names (many dependencies, many packages) can't crowd out
// the branch and terminal tiers.
const REPO_TIER_CAP = 6;
const NAME_CATEGORY_CAP = 5;
// Slots of MAX_NAME_KEYTERMS the pane's own worktrees keep, so hosts and every
// other project can't crowd out the names the pane is working among.
const NAME_WORKTREE_RESERVE = 4;
const COMMAND_TIER_CAP = 12;
// Slots commands leave for the branch, so a long command list can't crowd out
// the worktree's own words. The branch's share of RESERVED_CONTEXT_KEYTERMS.
const BRANCH_RESERVED_SLOTS = 4;
// Deepgram nova-3 rejects any keyterm longer than 100 chars with an HTTP 400
// that fails the WebSocket upgrade, so cap every term at the source.
const MAX_KEYTERM_LENGTH = 100;
const ASSEMBLY_TIMEOUT_MS = 500;
const MIN_TERM_LENGTH = 4;
const MAX_KEYTERM_LINES = 200;
// A separator-joined identifier with more parts than this is a branch slug or a
// generated name, not something anyone says aloud.
const MAX_IDENTIFIER_PARTS = 4;
export const MAX_PROMPT_CHARS = 400;
// Cleanup takes the repository's names whole, ranked as derived, so the
// dependencies at the tail are the ones a long list loses.
const MAX_CORRECTION_REPOSITORY_NAMES = 60;
const MAX_CORRECTION_NAME_LENGTH = 60;
const MAX_WORKTREE_TITLE_LENGTH = 200;
// Quotes and separators would break the quoted list a name is sent in, and
// one holding them is no package or folder anyone says aloud.
// eslint-disable-next-line no-control-regex
const UNSENDABLE_NAME_RE = /[\u0000-\u001f\u007f-\u009f"\\<>|]/;
// eslint-disable-next-line no-control-regex
const TITLE_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\s]+/g;
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

// OSC sequences (titles, hyperlinks, progress) open with ESC ] or the 8-bit
// OSC and run to BEL or either form of ST. Their payload isn't output, and
// left in place it splits whatever it sits inside.
// eslint-disable-next-line no-control-regex
const OSC_RE = /(?:\u001b\]|\u009d)[^\u0007\u001b\u009c\u009d]*(?:\u0007|\u001b\\|\u009c)/g;

// A whole CSI sequence: parameter bytes, intermediate bytes, final byte. The
// final byte can be missing at the end of a line the stream hasn't finished.
// eslint-disable-next-line no-control-regex
const CSI_RE = /(?:\u001b\[|\u009b)([0-?]*)([ -/]*)([@-~]|$)/g;

// CSI finals that move the cursor: up, down, forward and back, next and
// previous line, column, position, tab stops, the relative and absolute row
// and column forms, `u` restoring a saved position, and `r` setting a scroll
// region, which homes it. A private form moves nothing (`CSI > 1 u` sets the
// keyboard protocol) unless it sets or resets one of CURSOR_MODES.
const CSI_CURSOR_MOVES = new Set("ABCDEFGHIZ`adefru");
const CSI_PRIVATE_RE = /^[<=>?]/;

// Private modes whose set or reset moves the cursor: origin mode homes it, and
// the alternate screen modes switch screens or restore it (setting 1048 only
// saves it). The modes that bracket every frame (synchronized output, cursor
// visibility) move nothing, and text streamed across frames runs on.
const CURSOR_MODES = new Set([6, 47, 1047, 1048, 1049]);
const SAVE_CURSOR_MODE = 1048;

// The other cursor moves: restoring a saved position, index, next line and
// reverse index (7-bit and C1), a full reset, and backspace.
// eslint-disable-next-line no-control-regex
const OTHER_CURSOR_MOVE_RE = /\u001b[8DEMc]|[\u0008\u0084\u0085\u008d]/g;

// Any other escape sequence: ESC, intermediate bytes, final byte (character
// sets, saving the cursor, keypad modes).
// eslint-disable-next-line no-control-regex
const ESC_RE = /\u001b[ -/]*(?:[0-~]|$)/g;

// Matches identifiers: camelCase, PascalCase, snake_case, kebab-case (with internal separators)
const IDENTIFIER_RE = /\b[a-zA-Z][a-zA-Z0-9]*(?:[-_][a-zA-Z0-9]+)+\b/g;

// Matches camelCase/PascalCase words (at least two humps)
const CAMEL_RE = /\b[a-z]+(?:[A-Z][a-z0-9]+)+\b|\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g;

export interface KeytermAssemblyOpts {
  customDictionary: string[];
  /**
   * The target project's vocabulary, oldest first. It takes the dictionary
   * budget before the global list. Read alongside the terminal's context, so a
   * slow read falls back to none rather than delaying the start.
   */
  projectDictionary?: string[] | Promise<string[]>;
  /** Name of the project that owns the target terminal. */
  projectName?: string;
  /** Root of the project's repository; its names are derived per session and never stored. */
  projectPath?: string;
  /**
   * The terminal being dictated into: the only source of terminal terms, and
   * its worktree the only source of the branch.
   */
  terminalId?: string;
  ptyClient?: PtyClient;
  /**
   * Host, project and worktree names, sent whole: they are spoken as Daintree
   * spells them. Read alongside the terminal's context under the same budget,
   * so slow names fall back to none rather than delaying the start.
   */
  names?: DictationNames | Promise<DictationNames>;
  /**
   * The target's command names, most likely first. The read bounds itself;
   * a rejection just leaves the tier empty.
   */
  commandTerms?: Promise<readonly string[]>;
  /**
   * The repository, branch and terminal reads, already made: where the pane
   * lives for a host's, or by the caller so cleanup is given the same ones.
   * Given, nothing is read here: `projectPath`, `terminalId` and `ptyClient`
   * are ignored.
   */
  paneReads?: PaneKeytermReads | Promise<PaneKeytermReads>;
}

/** What the reads of a pane's own repository, worktree and terminal gave. */
export interface PaneKeytermReads {
  /** Names read from the repository, untokenized. */
  repoNames: string[];
  branchName: string | null;
  /** Identifiers from the terminal's output, screened and ranked best-first. */
  terminalTerms: string[];
}

export const NO_PANE_KEYTERM_READS: PaneKeytermReads = {
  repoNames: [],
  branchName: null,
  terminalTerms: [],
};

function isValidTerm(term: string): boolean {
  if (term.length < MIN_TERM_LENGTH) return false;
  if (/^\d+$/.test(term)) return false;
  if (BLOCKLIST.has(term.toLowerCase())) return false;
  if (isSecretShaped(term)) return false;
  return true;
}

function csiMovesCursor(params: string, intermediates: string, final: string): boolean {
  if (intermediates !== "") return false;
  if (params.startsWith("?") && (final === "h" || final === "l")) {
    // Numeric, as the terminal parses them: `?06h` is origin mode.
    return params
      .slice(1)
      .split(";")
      .map(Number)
      .some((mode) => CURSOR_MODES.has(mode) && (mode !== SAVE_CURSOR_MODE || final === "l"));
  }
  return !CSI_PRIVATE_RE.test(params) && CSI_CURSOR_MOVES.has(final);
}

// The text with its escapes removed and each cursor move marked as a gap.
function terminalText(text: string): string {
  // The marker the semantic buffer puts on a line it cut opens with bytes a
  // sequence the cut left unfinished would take for its own. A cut line is the
  // buffer's line length plus the marker, so cutting back to that length drops
  // only the marker, and a shorter line that ends in the same text keeps it.
  const body = text.endsWith(SEMANTIC_BUFFER_TRUNCATION_MARKER)
    ? text.slice(0, SEMANTIC_BUFFER_MAX_LINE_LENGTH)
    : text;
  return body
    .replace(OSC_RE, "")
    .replace(CSI_RE, (_sequence, params: string, intermediates: string, final: string) =>
      csiMovesCursor(params, intermediates, final) ? CURSOR_GAP : ""
    )
    .replace(OTHER_CURSOR_MOVE_RE, CURSOR_GAP)
    .replace(ESC_RE, "");
}

/**
 * Terminal lines as plain text, redacted, one per line given.
 *
 * The raw stream paints a gap with a cursor move as often as with a space:
 * Claude Code advances the cursor between words, and a repaint jumps over the
 * cells it leaves alone. So each move reads as a space, or `Sonnet 5` glues
 * into `Sonnet5` and a repaint's fragments join into words the screen never
 * showed. Redaction also judges the lines with the moves closed up.
 */
export function readTerminalLines(lines: readonly string[], strict = false): string[] {
  // Guard against malformed IPC payloads delivering non-string lines, which
  // would otherwise throw here and drop the whole read.
  return redactSecretShapedLines(
    lines.map((line) => (typeof line === "string" ? terminalText(line) : "")),
    strict
  );
}

export function tokenizeBranchName(branchName: string): string[] {
  // A path component holding a credential or an ID goes whole, before it can
  // be split into pieces that each look harmless.
  const components = branchName.split("/").filter((component) => !holdsCredentialOrId(component));
  return components.flatMap((component) => component.split(/[-_.]+/)).filter(isValidTerm);
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
  const cleanLines = readTerminalLines(lines);

  cleanLines.forEach((clean, lineIndex) => {
    // Count each term at most once per line so same-line repeats don't inflate
    // frequency (e.g. a log line spamming one identifier).
    const seenThisLine = new Set<string>();

    const record = (term: string): void => {
      if (!isValidTerm(term)) return;
      if (term.split(/[-_]/).length > MAX_IDENTIFIER_PARTS) return;
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

// The worktree the terminal is filed under, whose id is its path; a move
// updates it while the spawn cwd stays put. A terminal outside any worktree
// falls back to its cwd.
async function getTerminalBranch(
  ptyClient: PtyClient,
  terminalId: string,
  budgetMs: number
): Promise<string | null> {
  const startedAt = performance.now();
  try {
    const terminal = await ptyClient.getTerminalAsync(terminalId);
    if (!terminal) return null;
    const path = terminal.worktreeId ?? terminal.cwd;
    if (typeof path !== "string" || !isAbsolute(path)) return null;
    // Git's own timeout is what's left of the shared budget, so it rarely
    // outlives the wait (resolving the git binary isn't counted).
    const remaining = Math.ceil(budgetMs - (performance.now() - startedAt));
    if (remaining <= 0) return null;
    return await getGitBranch(path, { timeout: remaining });
  } catch {
    logDebug(`${P} Failed to get branch name`);
    return null;
  }
}

async function getTerminalLines(ptyClient: PtyClient, terminalId: string): Promise<string[]> {
  try {
    const snapshot = await ptyClient.getTerminalSnapshot(terminalId);
    return Array.isArray(snapshot?.lines) ? snapshot.lines.slice(-MAX_KEYTERM_LINES) : [];
  } catch {
    logDebug(`${P} Failed to get terminal snapshot`);
    return [];
  }
}

// Bounds one dynamic read so leading speech isn't held up; a slow or failed
// read yields `fallback`. The read itself isn't cancelled.
export async function withinBudget<T>(
  read: Promise<T>,
  fallback: T,
  readName: string,
  budgetMs: number = ASSEMBLY_TIMEOUT_MS
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), budgetMs);
      timer.unref();
    });
    return await Promise.race([read, timeout]);
  } catch {
    logDebug(`${P} ${readName} failed`);
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The repository's names, the branch of the terminal's worktree and the
 * identifiers in its output, each read bounded by `budgetMs`. A slow or
 * failed read gives none. Terminal identifiers are screened here, so the raw
 * output never leaves the reader.
 */
export async function readPaneKeytermReads(
  opts: { projectPath?: string; terminalId?: string; ptyClient?: PtyClient },
  budgetMs: number = ASSEMBLY_TIMEOUT_MS
): Promise<PaneKeytermReads> {
  const { projectPath, terminalId, ptyClient } = opts;
  const [repoNames, branchName, lines] = await Promise.all([
    projectPath && isAbsolute(projectPath)
      ? withinBudget(
          deriveRepoNames(projectPath, performance.now() + budgetMs).then((repo) => repo.names),
          [] as string[],
          "Repository name derivation",
          budgetMs
        )
      : [],
    ptyClient && terminalId
      ? withinBudget(
          getTerminalBranch(ptyClient, terminalId, budgetMs),
          null,
          "Branch name lookup",
          budgetMs
        )
      : null,
    ptyClient && terminalId
      ? withinBudget(
          getTerminalLines(ptyClient, terminalId),
          [],
          "Terminal identifier extraction",
          budgetMs
        )
      : [],
  ]);
  return { repoNames, branchName, terminalTerms: extractTerminalIdentifiers(lines) };
}

/**
 * The host, project and worktree names that may leave the machine: trimmed,
 * deduplicated, screened for credentials and IDs, at most NAME_CATEGORY_CAP of
 * each kind and MAX_NAME_KEYTERMS in all, each within the per-term length. The
 * worktrees keep NAME_WORKTREE_RESERVE of those slots against hosts and projects.
 * The keyterms and the correction prompt both take this list, so neither sends
 * a name the other wouldn't.
 */
export function screenDictationNames(names: DictationNames): DictationNames {
  const seen = new Set<string>();
  const screen = (list: readonly unknown[] | undefined, room: number, taken: Set<string>) => {
    const kept: string[] = [];
    for (const raw of Array.isArray(list) ? list : []) {
      if (kept.length >= Math.min(NAME_CATEGORY_CAP, room)) break;
      if (typeof raw !== "string") continue;
      const name = raw.trim();
      if (name.length < 2 || /^\d+$/.test(name)) continue;
      if (holdsCredentialOrId(name) || isSecretShaped(name)) continue;
      const capped = capTermLength(name, MAX_KEYTERM_LENGTH);
      const key = capped.toLowerCase();
      if (taken.has(key)) continue;
      taken.add(key);
      kept.push(capped);
    }
    return kept;
  };
  const reserve = Math.min(
    NAME_WORKTREE_RESERVE,
    screen(names.worktrees, NAME_WORKTREE_RESERVE, new Set()).length
  );
  const hosts = screen(names.hosts, MAX_NAME_KEYTERMS - reserve, seen);
  const projects = screen(names.projects, MAX_NAME_KEYTERMS - reserve - hosts.length, seen);
  const worktrees = screen(
    names.worktrees,
    MAX_NAME_KEYTERMS - hosts.length - projects.length,
    seen
  );
  return { hosts, projects, worktrees };
}

/**
 * The repository's names as cleanup is given them: whole rather than split into
 * keyterm tokens, since cleanup needs their spelling, with the publishing scope
 * dropped (`@scope/pkg` is said as "pkg"), screened like the keyterms, in the
 * order they were derived, at most MAX_CORRECTION_REPOSITORY_NAMES.
 */
export function screenCorrectionRepositoryNames(names: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of names) {
    if (kept.length >= MAX_CORRECTION_REPOSITORY_NAMES) break;
    if (typeof raw !== "string" || holdsCredentialOrId(raw)) continue;
    const name = stripPackageScope(raw.trim());
    if (name.length < 2 || name.length > MAX_CORRECTION_NAME_LENGTH || /^\d+$/.test(name)) continue;
    if (UNSENDABLE_NAME_RE.test(name) || isSecretShaped(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(name);
  }
  return kept;
}

// One line of a person's writing, sent as written: never one holding a
// credential, and never anything that could pass for the prompt's own tags.
function screenWorktreeTitle(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  const title = raw.replace(TITLE_CONTROL_RE, " ").trim().replace(/</g, "‹").replace(/>/g, "›");
  if (!title || holdsCredential(title, true)) return null;
  return title.length > MAX_WORKTREE_TITLE_LENGTH
    ? `${title.slice(0, MAX_WORKTREE_TITLE_LENGTH - 1).trimEnd()}…`
    : title;
}

/**
 * The worktree as cleanup is given it: its name, screened as the workspace
 * names are, and its issue and pull request titles, issue first. The title
 * read off the branch name stands in only when neither has been fetched; a
 * fetched one the screen drops leaves no title rather than a guessed one.
 */
export function screenDictationWorktree(
  worktree: DictationWorktree | null
): CorrectionWorktreeContext | null {
  if (!worktree) return null;
  const [name] = screenDictationNames({
    hosts: [],
    projects: [],
    worktrees: [worktree.name],
  }).worktrees;
  if (!name) return null;
  const fetched = [worktree.issueTitle, worktree.prTitle].filter(Boolean);
  const titles: string[] = [];
  for (const raw of fetched.length > 0 ? fetched : [worktree.branchDerivedTitle]) {
    const title = screenWorktreeTitle(raw);
    if (title && !titles.some((kept) => kept.toLowerCase() === title.toLowerCase())) {
      titles.push(title);
    }
  }
  return { name, titles };
}

export async function assembleKeyterms(opts: KeytermAssemblyOpts): Promise<string[]> {
  return (await assembleTaggedKeyterms(opts)).map((entry) => entry.term);
}

/** The same list as `assembleKeyterms`, each term tagged with the tier that won it. */
export async function assembleTaggedKeyterms(opts: KeytermAssemblyOpts): Promise<VoiceSentTerm[]> {
  const { customDictionary, projectName, commandTerms } = opts;
  const seen = new Set<string>();
  const result: VoiceSentTerm[] = [];
  let source: VoiceKeytermSource = "projectDictionary";

  function add(term: string): boolean {
    if (result.length >= MAX_KEYTERMS) return false;
    const capped = capTermLength(term, MAX_KEYTERM_LENGTH);
    const key = capped.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    result.push({ term: capped, source });
    return true;
  }

  // Gather dynamic context concurrently, each read guarded by its own timeout.
  // The reads fire at once so leading speech isn't delayed; results are merged
  // in priority order afterward.
  const [projectDictionary, paneReads, gatheredNames, commands] = await Promise.all([
    withinBudget(Promise.resolve(opts.projectDictionary ?? []), [], "Project vocabulary read"),
    opts.paneReads
      ? withinBudget(Promise.resolve(opts.paneReads), NO_PANE_KEYTERM_READS, "Pane reads")
      : readPaneKeytermReads(opts),
    withinBudget(Promise.resolve(opts.names ?? null), null, "Names read"),
    commandTerms
      ? commandTerms.catch((): readonly string[] => {
          logDebug(`${P} Command lookup failed`);
          return [];
        })
      : [],
  ]);
  const { repoNames, branchName, terminalTerms } = paneReads;

  // Priority 1: The project's vocabulary, then the user's own dictionary, each
  // newest first, because a term is usually added right after recognition
  // failed on it. Both share one budget, capped below MAX_KEYTERMS so project,
  // repository, workspace-name, command and branch terms keep their reserved
  // slots. These are hand-entered, so they skip the secret filter the derived
  // tiers go through.
  let dictionaryAdded = 0;
  for (const [list, listSource] of [
    [projectDictionary, "projectDictionary"],
    [customDictionary, "dictionary"],
  ] as const) {
    source = listSource;
    for (let i = list.length - 1; i >= 0; i--) {
      if (dictionaryAdded >= MAX_DICTIONARY_KEYTERMS) break;
      const trimmed = list[i]!.trim();
      if (trimmed.length >= 2 && !/^\d+$/.test(trimmed) && add(trimmed)) {
        dictionaryAdded++;
      }
    }
  }

  source = "project";
  // Priority 2: Project name tokens. Bounded so a long project name can't use
  // every reserved slot and leave none for branch tokens.
  if (projectName && !holdsCredentialOrId(projectName)) {
    let projectAdded = 0;
    const addProject = (term: string): void => {
      if (projectAdded >= PROJECT_TIER_CAP) return;
      if (add(term)) projectAdded++;
    };
    const trimmed = projectName.trim();
    if (trimmed.length >= 2 && !/^\d+$/.test(trimmed) && !isSecretShaped(trimmed)) {
      addProject(trimmed);
    }
    for (const token of tokenizeProjectName(projectName)) {
      addProject(token);
    }
  }

  source = "repository";
  // Priority 3: Repository names. Ahead of the branch, whose slug is mostly
  // plain words, but bounded by its own cap.
  let repoAdded = 0;
  for (const name of repoNames) {
    if (repoAdded >= REPO_TIER_CAP) break;
    for (const token of tokenizeProjectName(stripPackageScope(name))) {
      if (repoAdded >= REPO_TIER_CAP) break;
      if (add(token)) repoAdded++;
    }
  }

  source = "names";
  // Priority 4: Host, project and worktree names the user points at ("run this
  // on Studio 1"), kept whole, never tokenized. Every terminal gets the hosts,
  // the other projects and its project's worktrees. Screened and
  // capped, and ahead of the branch, whose token count is unbounded, so their
  // reserved slots can't be taken.
  if (gatheredNames) {
    const { hosts, projects, worktrees } = screenDictationNames(gatheredNames);
    for (const name of [...hosts, ...projects, ...worktrees]) add(name);
  }

  source = "commands";
  // Priority 5: The target's commands, ahead of the branch but leaving it room.
  // The dictionaries, project, repository and workspace names were added
  // first, so these never displace them.
  const branchTokens = branchName ? tokenizeBranchName(branchName) : [];
  const commandRoom =
    MAX_KEYTERMS - result.length - Math.min(BRANCH_RESERVED_SLOTS, branchTokens.length);
  let commandsAdded = 0;
  for (const term of commands) {
    if (commandsAdded >= Math.min(COMMAND_TIER_CAP, commandRoom)) break;
    if (typeof term !== "string" || isSecretShaped(term)) continue;
    const trimmed = term.trim();
    if (trimmed.length >= 3 && add(trimmed)) commandsAdded++;
  }

  source = "branch";
  // Priority 6: Branch name tokens
  for (const token of branchTokens) {
    add(token);
  }

  source = "terminal";
  // Priority 7: Terminal identifiers, ranked best-first. Bound the tier
  // independently so dictionary/project/branch terms always keep headroom
  // under MAX_KEYTERMS. Screened again, since a host's reads arrive prepared.
  let terminalAdded = 0;
  for (const id of terminalTerms) {
    if (terminalAdded >= TERMINAL_TIER_CAP) break;
    if (typeof id !== "string" || !isValidTerm(id)) continue;
    if (add(id)) terminalAdded++;
  }

  logDebug(`${P} Assembled ${result.length} keyterms`, {
    custom: customDictionary.length,
    project: projectDictionary.length,
    commands: commandsAdded,
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

// An unpaired surrogate is corrupted input (a term already truncated mid-emoji
// upstream, or a mangled terminal read), not a meaningful character. It has no
// valid UTF-8 encoding, so it's dropped like any other unsendable term rather
// than repaired into a different word.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

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
    if (LONE_SURROGATE.test(trimmed)) continue;

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
