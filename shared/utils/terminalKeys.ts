import { z } from "zod";
import { NotifyReplyLinesSchema } from "../types/terminalNotify.js";

/**
 * The named keys `terminal.sendKeys` writes and how it paces them, shared by
 * the renderer action and the host's viewless one (#13495) so a dialog is
 * answered the same way whichever side presses the keys.
 */
const SEND_KEY_NAMES = {
  Up: "\x1b[A",
  Down: "\x1b[B",
  Right: "\x1b[C",
  Left: "\x1b[D",
  Enter: "\r",
  Escape: "\x1b",
  Tab: "\t",
  Space: " ",
  Backspace: "\x7f",
} as const;

/**
 * Gap between keys: a TUI reading a burst as one chunk can take an arrow and
 * an Enter as a single unknown sequence.
 */
export const SEND_KEYS_GAP_MS = 80;

/** How long after the last key the screen is read back. */
export const SEND_KEYS_SETTLE_MS = 700;
export const SEND_KEYS_SCREEN_LINES = 12;
/** How much of the screen `choose` reads to find the option it names. */
export const CHOOSE_SCREEN_LINES = 40;

export function keySequence(key: string): string {
  return Object.hasOwn(SEND_KEY_NAMES, key)
    ? SEND_KEY_NAMES[key as keyof typeof SEND_KEY_NAMES]
    : key;
}

export const SendKeysArgsSchema = z.object({
  terminalId: z.string().min(1).describe("The terminal to press keys in."),
  choose: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "An option's label as shown; Daintree moves to it and presses Enter. Prefer it to `keys`."
    ),
  keys: z
    .array(z.string().regex(/^(Up|Down|Left|Right|Enter|Escape|Tab|Space|Backspace|[a-z0-9])$/))
    .min(1)
    .max(16)
    .optional()
    .describe(
      "Or up to 16 of: Up, Down, Left, Right, Enter, Escape, Tab, Space, Backspace, a-z, 0-9."
    ),
  // Acted on in main, like the send's: after answering a dialog, be told when
  // the agent finishes the turn it unblocked.
  notify: z
    .boolean()
    .optional()
    .describe("As on a send: hear, with its reply, when the turn these keys unblock ends."),
  replyLines: NotifyReplyLinesSchema,
});
