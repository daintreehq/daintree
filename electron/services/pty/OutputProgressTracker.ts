import { UNIVERSAL_PATTERN_CONFIG } from "./AgentPatternDetector.js";
import { hashStrings } from "./SustainedChangeTracker.js";

/**
 * How long after a resize a viewport change is treated as reflow rather than
 * output. Covers the mirror's own rewrap plus the full repaint a TUI agent
 * sends back after SIGWINCH.
 *
 * Output that genuinely lands inside the window is absorbed with the reflow,
 * which can leave the timestamp at the change before the resize until the next
 * one arrives. Telling the two apart needs wrap-aware comparison across the
 * geometry change; reporting every resize as progress would be worse, since a
 * pane being dragged would keep a frozen agent looking busy.
 */
export const OUTPUT_PROGRESS_RESIZE_QUIET_MS = 1000;

/**
 * Trailing delay before the in-thread path samples the viewport for output
 * progress — the same cadence the worker's viewport digest runs at, so both
 * backends observe a burst at the same granularity.
 *
 * It also sets how late a progress timestamp runs: a change is stamped when it
 * is sampled, nominally within this interval of the output that caused it, and
 * later still if the mirror or the worker is behind. That is why a submission's
 * `outputChangeAfterWriteAt` ignores changes stamped within one interval of the
 * Enter (#12478).
 */
export const OUTPUT_PROGRESS_SAMPLE_MS = 200;

// Rows that exist only to animate while a turn runs. The primary working
// patterns all require an interrupt hint ("esc to interrupt", "esc to cancel"),
// which is what makes them safe to drop outright — the looser spinner-and-verb
// fallback also matches real tool rows like "● Running tests in a.ts".
const STATUS_LINE_PATTERNS: readonly RegExp[] = [
  ...UNIVERSAL_PATTERN_CONFIG.primaryPatterns,
  // Aider's knight-rider bar: the block moves every frame and carries no hint.
  /^\s*[░█]{2,}\s+Waiting for\b/,
];

// Spinner frames, masked rather than dropped so every frame of a hintless
// spinner row normalises the same: braille, Claude's star cycle (which passes
// through `·` and `*`), quarter circles and Kimi's moon phases.
const SPINNER_GLYPHS = /[⠀-⣿·*✢✳✶✻✽✼✾◐◓◑◒\u{1F311}-\u{1F318}]/gu;

// Agents put their tickers in parentheses — "(12s)", "(2m 39s · ↓ 1.2k
// tokens)" — so counters are only masked there, and a whole elapsed run
// collapses to one placeholder so "59s" → "1m 0s" reads as unchanged. Numbers
// in ordinary output are left alone. A span left open at either edge of a row
// counts too: a narrow pane wraps "(2m 39s · esc to interrupt)" across rows,
// and neither half then holds a full hint or a closed pair.
const PARENTHESIZED = /\([^()]*(?:\)|$)|^[^()]*\)/g;
const COUNTER_SPANS =
  /(?<![\w.])(?:\d+(?:\.\d+)?\s?(?:ms|[hms])(?![a-z])(?:\s?\d+(?:\.\d+)?\s?(?:ms|[hms])(?![a-z]))*|\d+(?:[.,]\d+)?\s?k?\s?tokens?\b)/giu;

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
    // Spacing goes first: footers re-pad as a counter inside them changes
    // width, and a right-aligned row shifts its leading padding the same way.
    const masked = line
      .replace(/\s+/g, " ")
      .trim()
      .replace(SPINNER_GLYPHS, "~")
      .replace(PARENTHESIZED, (span) => span.replace(COUNTER_SPANS, "#"));
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
 * viewport with recognised status rows dropped and spinner and ticker churn
 * masked, and a frame that differs only in those reads as unchanged.
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
