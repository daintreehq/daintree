import type { CompletionTrigger } from "@shared/types";
import { toWorktreeRelative } from "@shared/utils/path";

/**
 * One completion menu is open at a time, keyed by the trigger char that opened
 * it. `query` is the triggerless token text between the trigger and the caret;
 * `start`/`tokenEnd` bound the whole token in the document.
 */
export interface ActiveCompletionContext {
  triggerChar: CompletionTrigger;
  start: number;
  tokenEnd: number;
  query: string;
}

/** Narrow an arbitrary char to a declared trigger without an unsafe assertion. */
function activeTrigger(
  ch: string,
  activeTriggers: ReadonlySet<CompletionTrigger>
): CompletionTrigger | null {
  for (const trigger of activeTriggers) {
    if (trigger === ch) return trigger;
  }
  return null;
}

/**
 * Detect the completion token the caret sits in. The token is the
 * whitespace-delimited run containing the caret; it opens a menu only when its
 * FIRST char is an active trigger — a start-or-whitespace boundary that rejects
 * `email@x`, `a/b`, `http://…` while still allowing OTHER triggers inside the
 * token (the `/` in `@src/App.tsx`). A repeated instance of the SAME trigger in
 * the query rejects it (`//help`, `$$foo`, `@@x`, and slash-path `/usr/bin`).
 */
export function getActiveCompletionContext(
  text: string,
  caret: number,
  activeTriggers: ReadonlySet<CompletionTrigger>
): ActiveCompletionContext | null {
  if (caret < 0 || caret > text.length) return null;

  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
  // The caret must sit strictly past the trigger char (bare `@`/`/` opens only
  // once you've typed the trigger itself).
  if (start >= caret) return null;

  const triggerChar = activeTrigger(text[start]!, activeTriggers);
  if (triggerChar === null) return null;

  const query = text.slice(start + 1, caret);
  if (query.includes(triggerChar)) return null;

  let tokenEnd = caret;
  while (tokenEnd < text.length && !/\s/.test(text[tokenEnd]!)) tokenEnd++;

  return { triggerChar, start, tokenEnd, query };
}

/** Daintree's own `@` providers; each claims its prefix ahead of `@file`. */
export type DaintreeAtClaim = "terminal" | "selection" | "diff";

/**
 * Which Daintree `@` provider (if any) claims a query, in priority order
 * terminal > selection > diff. `@file` fuzzy search is the fallback when no
 * provider claims. Mirrors the old per-parser prefix gates exactly.
 */
export function getDaintreeAtClaim(query: string): DaintreeAtClaim | null {
  if (matchesTerminalPrefix(query)) return "terminal";
  if (matchesSelectionPrefix(query)) return "selection";
  if (matchesDiffPrefix(query)) return "diff";
  return null;
}

/** Strip a leading quote so `@"src` searches for `src` (matches old queryForSearch). */
export function fileSearchQuery(query: string): string {
  return query.replace(/^['"]/, "");
}

export type DiffContextType = "unstaged" | "staged" | "head";

const DIFF_TOKEN_MAP: Record<string, DiffContextType> = {
  diff: "unstaged",
  "diff:staged": "staged",
  "diff:head": "head",
};

const DIFF_PREFIXES = [
  "diff",
  "diff:",
  "diff:s",
  "diff:st",
  "diff:sta",
  "diff:stag",
  "diff:stage",
  "diff:staged",
  "diff:h",
  "diff:he",
  "diff:hea",
  "diff:head",
];

/** A query claims the diff provider when it prefixes any diff token (bare `@` too). */
export function matchesDiffPrefix(query: string): boolean {
  return DIFF_PREFIXES.some((p) => p.startsWith(query) || query === p);
}

export interface AtDiffToken {
  start: number;
  end: number;
  diffType: DiffContextType;
}

export function getAllAtDiffTokens(text: string): AtDiffToken[] {
  const tokens: AtDiffToken[] = [];
  let i = 0;

  while (i < text.length) {
    if (text[i] !== "@") {
      i++;
      continue;
    }

    if (i > 0 && !/\s/.test(text[i - 1]!)) {
      i++;
      continue;
    }

    const atStart = i;
    i++;

    const tokenStart = i;
    while (i < text.length && !/\s/.test(text[i]!)) {
      i++;
    }

    const token = text.slice(tokenStart, i);
    const diffType = DIFF_TOKEN_MAP[token];
    if (diffType) {
      tokens.push({ start: atStart, end: i, diffType });
    }
  }

  return tokens;
}

// --- @terminal context ---

const TERMINAL_PREFIXES = ["term", "termi", "termin", "termina", "terminal"];

/** `@terminal` claims from four chars in (so `@te` still falls to file search). */
export function matchesTerminalPrefix(query: string): boolean {
  if (query.length < 4) return false;
  return TERMINAL_PREFIXES.some((p) => p.startsWith(query) || query === p);
}

export interface AtTerminalToken {
  start: number;
  end: number;
}

export function getAllAtTerminalTokens(text: string): AtTerminalToken[] {
  const tokens: AtTerminalToken[] = [];
  let i = 0;

  while (i < text.length) {
    if (text[i] !== "@") {
      i++;
      continue;
    }

    if (i > 0 && !/\s/.test(text[i - 1]!)) {
      i++;
      continue;
    }

    const atStart = i;
    i++;

    const tokenStart = i;
    while (i < text.length && !/\s/.test(text[i]!)) {
      i++;
    }

    const token = text.slice(tokenStart, i);
    if (token === "terminal") {
      tokens.push({ start: atStart, end: i });
    }
  }

  return tokens;
}

// --- @selection context ---

const SELECTION_PREFIXES = ["sele", "selec", "select", "selecti", "selectio", "selection"];

/** `@selection` claims from four chars in, same as `@terminal`. */
export function matchesSelectionPrefix(query: string): boolean {
  if (query.length < 4) return false;
  return SELECTION_PREFIXES.some((p) => p.startsWith(query) || query === p);
}

export interface AtSelectionToken {
  start: number;
  end: number;
}

export function getAllAtSelectionTokens(text: string): AtSelectionToken[] {
  const tokens: AtSelectionToken[] = [];
  let i = 0;

  while (i < text.length) {
    if (text[i] !== "@") {
      i++;
      continue;
    }

    if (i > 0 && !/\s/.test(text[i - 1]!)) {
      i++;
      continue;
    }

    const atStart = i;
    i++;

    const tokenStart = i;
    while (i < text.length && !/\s/.test(text[i]!)) {
      i++;
    }

    const token = text.slice(tokenStart, i);
    if (token === "selection") {
      tokens.push({ start: atStart, end: i });
    }
  }

  return tokens;
}

// --- @file token ---

/**
 * Paths that, spelled bare, are Daintree's own `@` tokens rather than files.
 * `fileChip` uses this to refuse them a file chip; the formatter uses it to
 * avoid ever producing one for a real file.
 */
export const RESERVED_AT_TOKEN_PATHS = new Set([
  "diff",
  "diff:staged",
  "diff:head",
  "terminal",
  "selection",
]);

export function formatAtFileToken(file: string): string {
  // A relative path can land exactly on one of those reserved tokens — a file
  // named `terminal` sitting at the cwd root relativizes to `terminal`, and
  // `@terminal` is resolved on send as "paste the terminal buffer here", so
  // the reference silently becomes something else entirely. `./` keeps it a
  // path to every reader without changing what it points at.
  const path = RESERVED_AT_TOKEN_PATHS.has(file) ? `./${file}` : file;
  const needsQuotes = /\s/.test(path);
  return `@${needsQuotes ? `"${path}"` : path}`;
}

/**
 * The `@file` token for a path the OS handed us absolute — drop and paste, as
 * opposed to autocomplete, whose file search already returns cwd-relative hits.
 * Relative is the form the agent can actually use: it costs no tokens on a
 * prefix the agent already knows, survives a prompt being replayed in another
 * worktree, and is what a fleet broadcast needs to mean the sibling worktree's
 * copy of the file rather than this one's.
 *
 * `toWorktreeRelative` is the whole policy: it hands back the original path
 * untouched when the file sits outside `cwd` (or when `cwd` is empty), so an
 * out-of-tree drop keeps the absolute form that is the only thing that resolves
 * for it.
 */
export function formatAtFileTokenForCwd(file: string, cwd: string): string {
  return formatAtFileToken(toWorktreeRelative(file, cwd));
}

export interface SlashCommandToken {
  start: number;
  end: number;
  command: string;
}

export function getLeadingSlashCommand(text: string): SlashCommandToken | null {
  if (!text.startsWith("/")) return null;

  const whitespaceMatch = text.slice(1).match(/\s/);
  const tokenEnd = whitespaceMatch ? whitespaceMatch.index! + 1 : text.length;

  if (tokenEnd <= 1) return null;

  return {
    start: 0,
    end: tokenEnd,
    command: text.slice(0, tokenEnd),
  };
}

export function getAllSlashCommandTokens(text: string): SlashCommandToken[] {
  const tokens: SlashCommandToken[] = [];
  let i = 0;

  while (i < text.length) {
    if (text[i] !== "/") {
      i++;
      continue;
    }

    if (i > 0 && !/\s/.test(text[i - 1]!)) {
      i++;
      continue;
    }

    const slashStart = i;
    i++; // Move past /

    // Reject consecutive slashes (e.g. //help, ///foo)
    if (i < text.length && text[i] === "/") {
      continue;
    }

    // Scan forward for token end (first whitespace or end of string)
    while (i < text.length && !/\s/.test(text[i]!)) {
      i++;
    }

    // Must have at least one character after /
    if (i > slashStart + 1) {
      tokens.push({
        start: slashStart,
        end: i,
        command: text.slice(slashStart, i),
      });
    }
  }

  return tokens;
}

export interface AtFileToken {
  start: number;
  end: number;
  path: string;
  isQuoted: boolean;
}

export function getAllAtFileTokens(text: string): AtFileToken[] {
  const tokens: AtFileToken[] = [];
  let i = 0;

  while (i < text.length) {
    if (text[i] !== "@") {
      i++;
      continue;
    }

    // Check that @ is at start or preceded by whitespace or common delimiters
    if (i > 0 && !/[\s([{]/.test(text[i - 1]!)) {
      i++;
      continue;
    }

    const atStart = i;
    i++; // Move past @

    if (i >= text.length) break;

    // Check for quoted path
    const quoteChar = text[i];
    if (quoteChar === '"' || quoteChar === "'") {
      i++; // Move past opening quote
      const pathStart = i;
      // Find closing quote, stopping at newlines to prevent multi-line paths
      while (i < text.length && text[i] !== quoteChar && text[i] !== "\n" && text[i] !== "\r") {
        // Support backslash-escaped quotes
        if (text[i] === "\\" && i + 1 < text.length && text[i + 1] === quoteChar) {
          i += 2; // Skip escaped quote
          continue;
        }
        i++;
      }
      // Only create token if we found the closing quote (not newline or end)
      if (i < text.length && text[i] === quoteChar) {
        const path = text.slice(pathStart, i);
        i++; // Move past closing quote
        if (path.length > 0) {
          // Unescape any escaped quotes in the path
          const unescapedPath = path.replace(new RegExp(`\\\\${quoteChar}`, "g"), quoteChar);
          tokens.push({ start: atStart, end: i, path: unescapedPath, isQuoted: true });
        }
      }
      // If unterminated quote, skip it and continue scanning from next position
    } else {
      // Unquoted path - read until whitespace or common delimiters
      const pathStart = i;
      while (
        i < text.length &&
        !/[\s,;:)}\]]/.test(text[i]!) &&
        text[i] !== "\n" &&
        text[i] !== "\r"
      ) {
        i++;
      }
      let path = text.slice(pathStart, i);
      // Trim trailing punctuation that's likely not part of the path
      path = path.replace(/[.,;:!?]+$/, "");
      if (path.length > 0) {
        const actualEnd = atStart + 1 + path.length;
        tokens.push({ start: atStart, end: actualEnd, path, isQuoted: false });
      }
    }
  }

  return tokens;
}
