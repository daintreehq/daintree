import {
  HANDBACK_MESSAGE_MAX_CHARS,
  HANDBACK_SUMMARY_PLACEHOLDER,
  type TerminalHandback,
} from "../../../shared/types/handback.js";
import { handbackEndMarker, handbackStartMarker } from "../../../shared/utils/handback.js";
import { stripAnsiCodes } from "../../../shared/utils/artifactParser.js";
import type { HandbackRequest } from "./HandbackTracker.js";

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
 *   in favour of the next opening marker rather than swallowing it.
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
function isEchoedInstruction(message: string): boolean {
  return message.replace(ECHO_NOISE_RE, "").includes(HANDBACK_SUMMARY_PLACEHOLDER);
}

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
 */
export function detectHandback(text: string, code: string): HandbackMatch | null {
  if (!text) return null;
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
    const message = normalizeCapture(capture);
    if (isEchoedInstruction(message)) continue;
    return capMessage(message);
  }
  return null;
}

// Cursor-forward (CUF). TUIs — Claude Code pervasively — paint the gap between
// words by moving the cursor rather than writing a space, so stripping it as a
// plain escape would run the words of a message together.
// eslint-disable-next-line no-control-regex -- intentional ESC in the CSI form
const CURSOR_FORWARD_RE = /\x1b\[\d*C/g;

/** The raw semantic buffer as plain text, cursor-forward gaps kept as spaces. */
export function rawHandbackText(semanticBuffer: readonly string[]): string {
  return stripAnsiCodes(semanticBuffer.join("\n").replace(CURSOR_FORWARD_RE, " "));
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
export function findHandback(
  texts: ReadonlyArray<() => string>,
  requests: readonly HandbackRequest[],
  observedAt: number
): HandbackHit | undefined {
  if (requests.length === 0) return undefined;
  for (const read of texts) {
    const text = read();
    if (!text) continue;
    // Latest request first: it is the one the agent is answering.
    for (const request of [...requests].reverse()) {
      const match = detectHandback(text, request.code);
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
