import type { CompletionTrigger } from "@shared/types";
import { toWorktreeRelative } from "@shared/utils/path";
import {
  AGENT_CONTEXT_FENCE_INFO,
  agentContextBlockRanges,
  backtickFenceFor,
  closingFenceForOpenBlock,
} from "@shared/utils/agentContextDrag";

/**
 * Drop the context tokens that sit inside a plugin's handoff block. The block
 * is quoted material — a card that mentions `@diff` reaches the agent as
 * written, not as the user's diff — so it neither shows a chip nor expands on
 * submit. Only handoff blocks: a token the user types in a fence of their own
 * still expands, as it always has.
 */
function outsideHandoffBlocks<T extends { start: number }>(text: string, tokens: T[]): T[] {
  if (tokens.length === 0 || !text.includes(AGENT_CONTEXT_FENCE_INFO)) return tokens;
  const ranges = agentContextBlockRanges(text);
  return tokens.filter(
    (token) => !ranges.some(([from, to]) => token.start >= from && token.start < to)
  );
}

/**
 * A context token's expansion as a fenced block, tagged `info`. The fence is
 * longer than any backtick run in `content`, so a selection, terminal buffer or
 * diff that carries its own fence cannot close the block early and leave the
 * rest of the prompt inside an unintended one.
 */
export function fenceTokenExpansion(content: string, info = ""): string {
  const fence = backtickFenceFor(content);
  return `${fence}${info}\n${content}\n${fence}`;
}

/** One context token's expansion, spliced over `[start, end)` of the draft. */
export interface TokenExpansion {
  start: number;
  end: number;
  replacement: string;
}

/**
 * The draft as submitted: every expansion spliced in, with each handoff block
 * still a block. A handoff opener carries an info string, so it can never
 * close a fence — whatever is left open above it, by an expansion or by the
 * user's own editing, would swallow the opener and let the block's closing
 * fence end the stray one instead, turning the rest of the quoted payload into
 * ordinary prompt text. So each block starts only after any fence the text
 * before it leaves open is closed on its own line, judged on the expanded
 * text, which is what the agent reads.
 *
 * Expansions never fall inside a handoff block — the token readers leave those
 * out — and any that did would be dropped rather than spliced into quoted text.
 */
export function resolveTokenExpansions(
  text: string,
  expansions: readonly TokenExpansion[]
): string {
  const sorted = [...expansions].sort((a, b) => a.start - b.start);
  const blocks = text.includes(AGENT_CONTEXT_FENCE_INFO) ? agentContextBlockRanges(text) : [];
  let out = "";
  let cursor = 0;
  let next = 0;
  const copyUpTo = (limit: number) => {
    while (next < sorted.length && sorted[next]!.start < limit) {
      const expansion = sorted[next++]!;
      if (expansion.start < cursor) continue;
      out += text.slice(cursor, expansion.start) + expansion.replacement;
      cursor = expansion.end;
    }
    if (cursor < limit) out += text.slice(cursor, limit);
    cursor = Math.max(cursor, limit);
  };
  for (const [from, to] of blocks) {
    copyUpTo(from);
    const closer = closingFenceForOpenBlock(out);
    if (closer !== null) out += `${out.length === 0 || out.endsWith("\n") ? "" : "\n"}${closer}\n`;
    out += text.slice(Math.max(cursor, from), to);
    cursor = to;
    while (next < sorted.length && sorted[next]!.start < to) next++;
  }
  copyUpTo(text.length);
  return out;
}

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

  return outsideHandoffBlocks(text, tokens);
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

  return outsideHandoffBlocks(text, tokens);
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

  return outsideHandoffBlocks(text, tokens);
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

/**
 * What an unquoted token cannot survive: `getAllAtFileTokens` ends one at any
 * of these and then trims trailing sentence punctuation. A path carrying one
 * has to be quoted or it reads back short — `@./diff:staged` would parse as
 * `./diff`, leaving `:staged` loose in the document and the chip covering only
 * part of the reference.
 *
 * A quote char is here for the opposite reason: the scanner treats a quote
 * *immediately after the `@`* as opening a quoted path, so a file named
 * `'notes.txt` at the cwd root emits `@'notes.txt`, whose closing quote never
 * arrives and whose token is dropped whole. Relativizing is what can promote a
 * name to the token's first character, so quoting quote-bearing paths is what
 * keeps that reachable case parseable.
 */
const NEEDS_QUOTED_AT_TOKEN = /['"]|[\s,;:)}\]]|[.,;:!?]$/;

export function formatAtFileToken(file: string): string {
  // A relative path can land exactly on one of the reserved tokens — a file
  // named `terminal` sitting at the cwd root relativizes to `terminal`, and
  // `@terminal` is resolved on send as "paste the terminal buffer here", so
  // the reference silently becomes something else entirely. `./` keeps it a
  // path to every reader without changing what it points at.
  const path = RESERVED_AT_TOKEN_PATHS.has(file) ? `./${file}` : file;
  if (!NEEDS_QUOTED_AT_TOKEN.test(path)) return `@${path}`;
  // Wrapping in `"` makes an embedded `"` the token's own terminator, so it has
  // to be escaped. `\"` is the one escape `getAllAtFileTokens` already skips
  // while hunting the closing quote and already unescapes on the way out.
  return `@"${path.replace(/"/g, '\\"')}"`;
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
