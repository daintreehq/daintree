import {
  compileTerminalLinkPattern,
  findTerminalLinkMatches,
  type TerminalLinkPatternMatch,
} from "@shared/utils/pluginTerminalLinks";

/** One plugin pattern to run, keyed by its matcher's `{instanceId}::{id}`. */
export interface TerminalLinkPatternSpec {
  key: string;
  pattern: string;
  ignoreCase: boolean;
}

export interface TerminalLinkMatchRequest {
  id: number;
  /** The hovered row's text, one code unit past the scan cap when the row is longer. */
  text: string;
  matchers: TerminalLinkPatternSpec[];
}

export type TerminalLinkMatchMessage =
  /** Sent before each pattern runs, so a scan that never returns can be blamed on it. */
  | { id: number; type: "start"; key: string }
  | {
      id: number;
      type: "done";
      matches: Record<string, TerminalLinkPatternMatch[]>;
      /** Patterns that finished, but slowly enough to switch off. */
      slowKeys: string[];
    };

/** A pattern whose scan of one row took longer than this is switched off for the session. */
export const SLOW_TERMINAL_LINK_MATCHER_MS = 50;

/**
 * The work the terminal-link worker does for one request: run each pattern
 * over the row, reporting each start and the results. Patterns compile once
 * per worker; one that fails the safety check never runs.
 */
export function createTerminalLinkMatchHandler(
  post: (message: TerminalLinkMatchMessage) => void,
  now: () => number = () => performance.now()
): (request: TerminalLinkMatchRequest) => void {
  const compiled = new Map<string, RegExp | null>();
  return (request) => {
    const matches: Record<string, TerminalLinkPatternMatch[]> = {};
    const slowKeys: string[] = [];
    for (const matcher of request.matchers) {
      const cacheKey = `${matcher.ignoreCase ? "i" : ""}/${matcher.pattern}`;
      let regex = compiled.get(cacheKey);
      if (regex === undefined) {
        regex = compileTerminalLinkPattern(matcher.pattern, matcher.ignoreCase);
        compiled.set(cacheKey, regex);
      }
      if (regex === null) continue;
      post({ id: request.id, type: "start", key: matcher.key });
      const started = now();
      matches[matcher.key] = findTerminalLinkMatches(regex, request.text);
      if (now() - started > SLOW_TERMINAL_LINK_MATCHER_MS) slowKeys.push(matcher.key);
    }
    post({ id: request.id, type: "done", matches, slowKeys });
  };
}
