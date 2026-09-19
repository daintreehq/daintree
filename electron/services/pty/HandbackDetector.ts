import {
  HANDBACK_MESSAGE_MAX_CHARS,
  HANDBACK_SUMMARY_PLACEHOLDER,
  type TerminalHandback,
} from "../../../shared/types/handback.js";
import { handbackEndMarker, handbackStartMarker } from "../../../shared/utils/handback.js";
import { stripAnsiCodes } from "../../../shared/utils/artifactParser.js";
import type { HandbackRequest } from "./HandbackTracker.js";
import { SEMANTIC_BUFFER_TRUNCATION_MARKER } from "./types.js";

/**
 * Finds a handback marker for one minted code in recent terminal text (#12488).
 *
 * Precision over recall, like `CheckResultDetector`: a `null` return means "no
 * complete marker for this code in the window", never "the agent is still
 * working". What makes a hit trustworthy is mostly the caller — the code is
 * fresh per submission and only looked for at a settle out of `working` — so
 * this only has to reject the shapes that can carry the right code:
 *
 * - the echoed instruction, whose capture carries the `<summary>` placeholder;
 * - a marker still streaming, which has no closing `END-<code>` yet;
 * - an opening marker the agent mentioned and never closed, which is skipped
 *   in favour of the next opening marker rather than swallowing it;
 * - a capture spanning a line the semantic buffer cut short, whose missing
 *   bytes could have held the placeholder.
 */

/**
 * Leading glyphs a TUI paints on a wrapped continuation row: indentation, box
 * drawing and block elements, and the bullets and quote gutters Claude Code and
 * Codex put beside messages. `-` and `*` are deliberately absent — a wrapped
 * row can legitimately start with either.
 */
const CONTINUATION_GUTTER_RE = /^[\s\u2500-\u259f\u23bf\u23fa|>›❯•●◦·]+/u;

/** Right-hand borders and cell padding at the end of any row. */
const TRAILING_BORDER_RE = /[\s\u2500-\u259f|]+$/u;

/**
 * Stands in for cells a raw stream moved past without writing. A private-use
 * character, which agent output has no reason to contain.
 */
const RAW_CELLS_SKIPPED = "\u{E000}";

export interface HandbackMatch {
  /** Captured text, normalized; `null` for a bare handback. */
  message: string | null;
  /** True when `message` was cut at {@link HANDBACK_MESSAGE_MAX_CHARS}. */
  truncated: boolean;
}

function normalizeCapture(raw: string): string {
  const rows = raw.replace(/^\s*:/, "").split("\n");
  const cleaned = rows.map((row, index) => {
    const withoutBorder = row.replace(TRAILING_BORDER_RE, "");
    return index === 0 ? withoutBorder : withoutBorder.replace(CONTINUATION_GUTTER_RE, "");
  });
  return cleaned.join(" ").replace(/\s+/g, " ").trim();
}

// Anything a TUI can paint around the placeholder when it echoes the prompt:
// whitespace, box drawing, block elements and gutter glyphs. Not `>` — that
// closes the placeholder itself.
const ECHO_NOISE_RE = /[\s\u2500-\u259f\u23bf\u23fa|›❯•●◦·]+/gu;

/**
 * The echoed instruction, recognised by its placeholder. Containment rather
 * than equality: a raw stream painted by cursor addressing can interleave a
 * gutter or status glyph with the echo, and no real summary carries the
 * literal placeholder.
 */
function isEchoedInstruction(text: string): boolean {
  return text.replace(ECHO_NOISE_RE, "").includes(HANDBACK_SUMMARY_PLACEHOLDER);
}

/**
 * A row that ends in a hyphen straight after a letter or digit, and the next
 * row's gutter. Codex wraps with `textwrap`'s hyphen splitter, so a marker near
 * the right edge can land as `DAINTREE-DONE-` / `k7f3qa:` on two rows; joining
 * the halves back lets the literal search see it. Claude Code wraps only at
 * whitespace.
 */
const HYPHEN_ROW_BREAK_RE =
  /(?<=[A-Za-z0-9])-[ \t\u2500-\u259f|]*\r?\n[ \t\u2500-\u259f\u23bf\u23fa|>›❯•●◦·]*/gu;

function capMessage(message: string): HandbackMatch {
  if (message.length === 0) return { message: null, truncated: false };
  if (message.length <= HANDBACK_MESSAGE_MAX_CHARS) return { message, truncated: false };
  let end = HANDBACK_MESSAGE_MAX_CHARS;
  // Never leave half a surrogate pair at the cut.
  const last = message.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { message: message.slice(0, end), truncated: true };
}

/**
 * The most recent complete, non-echo marker pair for `code` in `text`, which
 * must already be plain text (no ANSI) with rows separated by `\n`.
 *
 * `rendered` says the rows are the screen's own. Only then is a row break a
 * real wrap point, so only then are markers split at a hyphen rejoined — in a
 * raw stream a newline can sit between fragments painted anywhere.
 */
export function detectHandback(input: string, code: string, rendered = true): HandbackMatch | null {
  if (!input) return null;
  const text = rendered ? input.replace(HYPHEN_ROW_BREAK_RE, "-") : input;
  const start = handbackStartMarker(code);
  const end = handbackEndMarker(code);

  const captures: string[] = [];
  let cursor = text.indexOf(start);
  while (cursor !== -1) {
    const bodyStart = cursor + start.length;
    const closeAt = text.indexOf(end, bodyStart);
    if (closeAt === -1) break;
    const nextOpen = text.indexOf(start, bodyStart);
    if (nextOpen !== -1 && nextOpen < closeAt) {
      // Opened and never closed before the next opening marker.
      cursor = nextOpen;
      continue;
    }
    captures.push(text.slice(bodyStart, closeAt));
    cursor = text.indexOf(start, closeAt + end.length);
  }

  for (const capture of captures.reverse()) {
    // Bytes the capture never saw — cut by the semantic buffer, or cells a
    // repaint skipped over — could have held the placeholder.
    if (capture.includes(SEMANTIC_BUFFER_TRUNCATION_MARKER)) continue;
    if (capture.includes(RAW_CELLS_SKIPPED)) continue;
    const message = normalizeCapture(capture);
    // Checked on both forms: normalizing rejoins a placeholder wrapped across a
    // `>` gutter, while the raw capture keeps a `>` that closes the placeholder
    // at the start of a continuation row, which gutter stripping removes.
    if (isEchoedInstruction(capture) || isEchoedInstruction(message)) continue;
    return capMessage(message);
  }
  return null;
}

// Cursor movement: up/down/forward/back, next/previous line, column, row and
// absolute position.
// eslint-disable-next-line no-control-regex -- intentional ESC in the CSI form
const CURSOR_MOVE_RE = /\x1b\[(\d*)(?:;\d*)?([A-Gdf]|H)/g;

/**
 * The raw semantic buffer as plain text. A one-cell cursor-forward is kept as a
 * space — TUIs, Claude Code pervasively, paint the gap between words that way.
 * Any other movement means the stream skipped cells it had painted before, so
 * it becomes {@link RAW_CELLS_SKIPPED} and no capture spanning it is trusted:
 * a cell-diff repaint of the echoed instruction can leave out the unchanged
 * `<summary>` between two markers it does rewrite.
 */
export function rawHandbackText(semanticBuffer: readonly string[]): string {
  const moves = semanticBuffer
    .join("\n")
    .replace(CURSOR_MOVE_RE, (_sequence, count: string, op: string) =>
      op === "C" && Number(count || "1") <= 1 ? " " : RAW_CELLS_SKIPPED
    );
  return stripAnsiCodes(moves);
}

export interface HandbackHit {
  handback: TerminalHandback;
  code: string;
}

/**
 * Look for a marker for any of `requests` in the given texts, in order.
 *
 * Callers pass the rendered screen first: it is what the terminal actually
 * shows, so a TUI that paints by cursor addressing or cell diffs still reads
 * as text. The raw semantic buffer follows as the fallback for a screen that
 * has not caught up with the last chunk. Neither can manufacture a false hit —
 * the code is fresh — so reading both only adds recall.
 */
export interface HandbackTextSource {
  read: () => string;
  /** The rows are rendered screen rows, not a raw stream. */
  rendered: boolean;
}

export function findHandback(
  sources: readonly HandbackTextSource[],
  requests: readonly HandbackRequest[],
  observedAt: number
): HandbackHit | undefined {
  if (requests.length === 0) return undefined;
  for (const source of sources) {
    const text = source.read();
    if (!text) continue;
    // Latest request first: it is the one the agent is answering.
    for (const request of [...requests].reverse()) {
      const match = detectHandback(text, request.code, source.rendered);
      if (!match) continue;
      return {
        code: request.code,
        handback: {
          message: match.message,
          observedAt,
          ...(request.submissionToken !== undefined
            ? { submissionToken: request.submissionToken }
            : {}),
          truncated: match.truncated,
        },
      };
    }
  }
  return undefined;
}
