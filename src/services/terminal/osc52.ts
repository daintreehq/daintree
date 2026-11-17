/**
 * OSC 52 clipboard writes (#17327), the pure half: what a sequence asks for,
 * whether the pane may have it, and how the notice describes the text.
 */
import type { ManagedTerminal } from "./types";

/**
 * How long after a real key press or click in a pane its programs may write
 * the clipboard. A yank in tmux, Neovim, Zellij or fzf prints the sequence
 * within a round trip, so a few seconds covers a slow SSH link while keeping
 * output that arrives unattended out.
 */
export const OSC52_GESTURE_WINDOW_MS = 3000;

/** No copy decodes past this; refused before decoding a larger payload. */
export const OSC52_MAX_TEXT_BYTES = 1024 * 1024;

/**
 * The clipboard write rides the IPC envelope's default 1 MiB budget, which
 * main measures as the UTF-8 bytes of `JSON.stringify(args)`, so escaping
 * counts: a copy that can't fit is refused here with a reason instead of
 * failing in transit.
 */
export const OSC52_MAX_ENVELOPE_BYTES = 1024 * 1024;

/**
 * Stamps a real key press or click in the pane, the only thing that opens its
 * OSC 52 window. Synthetic events never count, and nothing that writes to the
 * PTY on the user's behalf (the Assistant's sendKeys, fleet mirroring, a
 * composer send) comes through here.
 */
export function noteOsc52Gesture(
  managed: Pick<ManagedTerminal, "lastUserGestureAt">,
  event: Pick<Event, "isTrusted">
): void {
  if (!event.isTrusted) return;
  managed.lastUserGestureAt = performance.now();
}

export type Osc52Request =
  /** A read, a clear, a selection other than the clipboard, or a malformed one. */
  | { kind: "ignore" }
  | { kind: "write"; text: string }
  | { kind: "invalid"; reason: "too-large" | "malformed" };

const SELECTION_CHARS = /^[cpqs0-7]*$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * `data` is what xterm hands an OSC 52 handler: `Pc;Pd`, the selection list
 * and the base64 payload. An empty list means the default selection, which
 * here is the clipboard; `s` (the configurable selection) is too. Primary,
 * secondary and the cut buffers have no counterpart on macOS or Windows, so
 * a list naming only those is not a clipboard write.
 */
export function parseOsc52(data: string): Osc52Request {
  const sep = data.indexOf(";");
  if (sep === -1) return { kind: "ignore" };
  const selection = data.slice(0, sep);
  if (!SELECTION_CHARS.test(selection)) return { kind: "ignore" };
  if (selection !== "" && !/[cs]/.test(selection)) return { kind: "ignore" };

  const payload = data.slice(sep + 1).replace(/[\t\n\r ]/g, "");
  // A read is never answered, and a clear never empties the clipboard.
  if (payload === "?" || payload === "") return { kind: "ignore" };

  if (Math.floor((payload.length * 3) / 4) > OSC52_MAX_TEXT_BYTES + 2) {
    return { kind: "invalid", reason: "too-large" };
  }
  if (!BASE64.test(payload) || payload.length % 4 === 1) {
    return { kind: "invalid", reason: "malformed" };
  }
  if (payload.includes("=") && payload.length % 4 !== 0) {
    return { kind: "invalid", reason: "malformed" };
  }

  let binary: string;
  try {
    binary = atob(payload);
  } catch {
    return { kind: "invalid", reason: "malformed" };
  }
  if (binary.length > OSC52_MAX_TEXT_BYTES) return { kind: "invalid", reason: "too-large" };
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  let text: string;
  try {
    // Fatal, so bytes that aren't text never reach the clipboard as U+FFFD;
    // a leading BOM is kept, since the copy is written exactly as sent.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { kind: "invalid", reason: "malformed" };
  }
  if (text === "") return { kind: "ignore" };
  if (new TextEncoder().encode(JSON.stringify([text])).length > OSC52_MAX_ENVELOPE_BYTES) {
    return { kind: "invalid", reason: "too-large" };
  }
  return { kind: "write", text };
}

export type Osc52Verdict = "allow" | "not-focused" | "no-recent-input";

/**
 * Only the focused pane, and only shortly after the user pressed a key or
 * clicked in it. `lastGestureAt` and `now` are `performance.now()` readings.
 */
export function judgeOsc52Write(input: {
  focused: boolean;
  lastGestureAt: number | undefined;
  now: number;
}): Osc52Verdict {
  if (!input.focused) return "not-focused";
  const { lastGestureAt, now } = input;
  if (lastGestureAt === undefined) return "no-recent-input";
  const elapsed = now - lastGestureAt;
  if (elapsed < 0 || elapsed > OSC52_GESTURE_WINDOW_MS) return "no-recent-input";
  return "allow";
}

const PREVIEW_CODE_POINTS = 60;

// C0/C1 controls, and the invisible characters that reorder or hide text
// (bidi embeddings, overrides and isolates, zero-width marks, BOM).
const HIDDEN =
  // eslint-disable-next-line no-control-regex -- finding control characters is the point
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

/**
 * Text from the terminal made safe to show in a notice, at most `limit` code
 * points: line breaks as ↵, tabs as spaces, hidden characters as �, so
 * nothing in it can reorder or hide the rest.
 */
export function sanitizeForNotice(text: string, limit: number): string {
  let head = "";
  let count = 0;
  for (const char of text) {
    if (count === limit) return `${clean(head)}…`;
    head += char;
    count++;
  }
  return clean(head);
}

function clean(text: string): string {
  return text
    .replace(/\r\n|\r|\n/g, " ↵ ")
    .replace(/\t/g, " ")
    .replace(HIDDEN, "\uFFFD")
    .trim();
}

export interface Osc52TextSummary {
  /** The start of the text, safe to show: line breaks as ↵, hidden characters as �. */
  preview: string;
  /** Unicode code points, so an emoji counts once. */
  characters: number;
  lines: number;
}

/**
 * The notice shows the length and line count beside the start, because the
 * start alone can hide what follows.
 */
export function summarizeOsc52Text(text: string): Osc52TextSummary {
  let characters = 0;
  for (const _ of text) characters++;
  const breaks = text.match(/\r\n|\r|\n/g)?.length ?? 0;
  // A yanked line ends in a break; it is still one line.
  const lines = breaks + (/[\r\n]$/.test(text) ? 0 : 1);
  return { preview: sanitizeForNotice(text, PREVIEW_CODE_POINTS), characters, lines };
}
