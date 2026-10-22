import {
  TERMINAL_LINK_SCAN_MAX_CHARS,
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
      /** Patterns to switch off: they finished too slowly, or threw. */
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
      try {
        // Every match in the scan window, not the row cap's worth: the cap
        // counts links kept after overlaps are settled across plugins, and a
        // match another plugin's overlaps would never count against it.
        matches[matcher.key] = findTerminalLinkMatches(
          regex,
          request.text,
          TERMINAL_LINK_SCAN_MAX_CHARS
        );
      } catch {
        // One pattern failing costs that pattern, not every plugin's.
        slowKeys.push(matcher.key);
        continue;
      }
      if (now() - started > SLOW_TERMINAL_LINK_MATCHER_MS) slowKeys.push(matcher.key);
    }
    post({ id: request.id, type: "done", matches, slowKeys });
  };
}
