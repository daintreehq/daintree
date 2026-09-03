import { stripAnsiCodes } from "../../../shared/utils/artifactParser.js";

/**
 * Which occurrence to take when the scanned text holds several matches, and
 * whether end-of-input counts as a token boundary.
 *
 * `first` belongs to a buffer that is already scoped to the moment of capture
 * (the graceful teardown's post-quit buffer): the earliest match there is the
 * agent's own hint by construction. `last` belongs to a rolling, purpose-
 * agnostic buffer, where an earlier match is far more likely to be
 * conversational text than the hint we are after.
 *
 * `eof` is only correct where no more bytes can arrive — the agent's PTY has
 * exited. Anywhere else the trailing character is what proves the capture group
 * finished consuming its token rather than being cut off mid-arrival.
 */
export interface SessionIdMatchOptions {
  occurrence: "first" | "last";
  boundary: "stream" | "eof";
  /** Restrict the scan to the last N non-blank logical lines. */
  tailLines?: number;
}

/**
 * `needs-boundary` is deliberately distinct from `none`: a caller that is still
 * listening should keep waiting rather than conclude the agent printed nothing,
 * and the graceful teardown additionally uses it to stop escalating.
 */
export type SessionIdMatch =
  { kind: "none" } | { kind: "needs-boundary" } | { kind: "match"; sessionId: string };

export type SessionIdMatcher = (raw: string, options: SessionIdMatchOptions) => SessionIdMatch;

/**
 * Walk back over `lines` non-blank logical lines and return that suffix. Blank
 * lines don't count against the budget but stay in the returned window, and the
 * text's own trailing newline (or lack of one) is preserved — the boundary
 * check below reads the window's end as the whole text's end, which only holds
 * because this returns a true suffix.
 */
function tailWindow(text: string, lines: number): string {
  let idx = text.length;
  let counted = 0;
  while (idx > 0) {
    const newline = text.lastIndexOf("\n", idx - 1);
    const lineStart = newline + 1;
    if (text.slice(lineStart, idx).trim().length > 0) {
      counted += 1;
      if (counted === lines) return text.slice(lineStart);
    }
    if (newline < 0) break;
    idx = newline;
  }
  return text;
}

/**
 * Compile an agent's `sessionIdPattern` into a reusable matcher, or `null` when
 * the agent declares none. Every call site strips ANSI the same way and applies
 * the same truncation guard, so the policy lives here rather than being
 * re-derived at each boundary.
 */
export function createSessionIdMatcher(patternSource: string | undefined): SessionIdMatcher | null {
  if (!patternSource) return null;
  const pattern = new RegExp(patternSource, "g");

  return (raw, options) => {
    const stripped = stripAnsiCodes(raw);
    const text = options.tailLines ? tailWindow(stripped, options.tailLines) : stripped;

    pattern.lastIndex = 0;
    let chosen: RegExpExecArray | null = null;
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      // A zero-width match leaves `lastIndex` where it was; nudge it so the
      // scan can't spin. Real session-id patterns can't match empty, so this
      // only guards against a malformed one in agent config.
      if (match[0].length === 0) pattern.lastIndex += 1;
      if (options.occurrence === "first") {
        chosen = match;
        break;
      }
      if (match[1]) chosen = match;
    }
    if (!chosen?.[1]) return { kind: "none" };

    // Every `sessionIdPattern` ends in a greedy `[\w-]+`. A match that runs to
    // the very end of the text may still be consuming a token that is
    // mid-arrival — Gemini's 36-char UUID has been captured as "fc1c3a37-2294-4"
    // this way, leaving restore to hand the agent an invalid identifier. Wait
    // for one trailing character that confirms the token ended. A match that is
    // provisional is never traded for an older complete one: the newest hint is
    // the session the user is actually leaving.
    if (options.boundary === "stream" && chosen.index + chosen[0].length >= text.length) {
      return { kind: "needs-boundary" };
    }
    return { kind: "match", sessionId: chosen[1] };
  };
}
