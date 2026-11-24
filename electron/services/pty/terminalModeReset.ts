import { PARSER_GROUND } from "../../../shared/utils/terminalPartialEscapeTail.js";

/**
 * The input modes a full-screen program can leave switched on when it dies
 * without cleaning up, put back by Daintree's own output (#17328). It goes to
 * the pane and its headless mirror as one stream, never to the process: the
 * mirror is what a remount or restore repaints from, and its serialize would
 * write a mode back if only the pane had dropped it.
 *
 * - CAN first, as every payload Daintree writes into a live parser leads: a
 *   program killed mid-sequence leaves the parser inside it, and an unfinished
 *   OSC would otherwise be dispatched by the next ESC.
 * - DECSC then `?1049l` leaves the alternate screen only when the pane is on
 *   it. xterm keeps a saved cursor per buffer, so on the normal screen the
 *   switch is a no-op and the restore lands on the position just saved; on the
 *   alternate screen it restores the cursor `?1049h` saved on the way in. Two
 *   cases come back slightly off, accepted over a parser hook in every xterm
 *   that reads this stream: a cursor waiting to wrap at the right margin is
 *   pulled back onto the last cell, and an alternate screen entered with
 *   `?47h`/`?1047h`, which save nothing, returns to the last DECSC instead.
 * - DECSTR clears application cursor keys and keypad, bracketed paste, focus
 *   reporting, origin mode, the Kitty keyboard state, attributes and the scroll
 *   region, and leaves scrollback alone. It doesn't clear the charset and modes
 *   a saved cursor carries, so a second DECSC saves the reset state for a later
 *   DECRC to return to.
 * - Mouse tracking and its encodings live outside DECSTR's reach; 2026 goes off
 *   through its own reset so a frame held for a dead program's synchronized
 *   update is painted now rather than after xterm's timeout.
 */
export const TERMINAL_MODE_RESET =
  PARSER_GROUND + "\x1b7\x1b[?1049l\x1b[!p\x1b7\x1b[?9;1000;1002;1003;1006;1016;2026l";
