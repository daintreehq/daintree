import { UNIVERSAL_PATTERN_CONFIG } from "./AgentPatternDetector.js";
import { hashStrings } from "./SustainedChangeTracker.js";

/**
 * How long after a resize a viewport change is treated as reflow rather than
 * output. Covers the mirror's own rewrap plus the full repaint a TUI agent
 * sends back after SIGWINCH.
 */
export const OUTPUT_PROGRESS_RESIZE_QUIET_MS = 1000;

// Every agent's working footer ("✻ Thinking… (2m 39s · esc to interrupt)",
// "⠏ Pondering (esc to cancel, 14s)") animates for as long as the turn runs,
// so a line matching one carries no evidence that anything else moved.
const STATUS_LINE_PATTERNS: readonly RegExp[] = [
  ...UNIVERSAL_PATTERN_CONFIG.primaryPatterns,
  ...(UNIVERSAL_PATTERN_CONFIG.fallbackPatterns ?? []),
];

// Spinner frames for agents whose indicator does not match a status pattern:
// braille, Claude's star cycle, quarter circles and Kimi's moon phases.
const SPINNER_GLYPHS = /[⠀-⣿·*✢✳✶✻✽✼✾◐◓◑◒\u{1F311}-\u{1F318}]/gu;

// Elapsed-time and token counters tick on their own inside tool rows too
// ("⎿ Running… (12s)"), so they are masked wherever they appear.
const COUNTER_SPANS = /\d+(?:[.,]\d+)?\s*k?\s*tokens?\b|\d+(?:\.\d+)?\s?(?:ms|[hms])(?![a-z])/giu;

const EMPTY_FINGERPRINT = hashStrings([]);

function isStatusLine(line: string): boolean {
  return STATUS_LINE_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(line);
  });
}

export function normalizeProgressLines(lines: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const line of lines) {
    if (isStatusLine(line)) continue;
    const masked = line
      .replace(SPINNER_GLYPHS, "~")
      .replace(COUNTER_SPANS, "#")
      .replace(/\s+/g, " ")
      .trim();
    if (masked !== "") normalized.push(masked);
  }
  return normalized;
}

/**
 * Tells a real change to a terminal's visible content apart from its working
 * indicator redrawing (#12428).
 *
 * The activity monitor cannot answer this: while a status-line rewrite is
 * recent it classifies the whole viewport change as indicator activity, and an
 * agent's spinner is always recent while it works. So the tracker compares the
 * viewport with recognised status lines dropped and counters masked, and a
 * frame that differs only in those reads as unchanged.
 *
 * It is an observation, not a verdict — long reasoning leaves the screen just
 * as still as a wedged turn does.
 */
export class OutputProgressTracker {
  private fingerprint = EMPTY_FINGERPRINT;
  private quietUntil = 0;

  /** Returns true when `lines` changed the visible content since the last call. */
  observe(lines: readonly string[], now: number): boolean {
    const next = hashStrings(normalizeProgressLines(lines));
    if (next === this.fingerprint) return false;
    this.fingerprint = next;
    // Re-baseline on reflow without reporting it as output.
    return now >= this.quietUntil;
  }

  noteResize(now: number): void {
    this.quietUntil = now + OUTPUT_PROGRESS_RESIZE_QUIET_MS;
  }
}
