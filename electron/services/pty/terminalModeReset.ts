import { PARSER_GROUND } from "../../../shared/utils/terminalPartialEscapeTail.js";

/**
 * The input modes a full-screen program can leave switched on when it dies
 * without cleaning up, put back by Daintree's own output (#17328). It goes to
 * the pane and its headless mirror as one stream, never to the process: the
 * mirror is what a remount or restore repaints from, and its serialize would
 * write a mode back if only the pane had dropped it.
 *
 * - CAN first, as every payload Daintree writes into a live parser leads: a
 *   program killed mid-sequence leaves the parser inside it.
 * - DECSC then `?1049l` leaves the alternate screen only when the pane is on
 *   it. xterm keeps a saved cursor per buffer, so on the normal screen the
 *   switch is a no-op and the restore lands on the position just saved; on the
 *   alternate screen it returns to where the program entered it.
 * - DECSTR clears application cursor keys and keypad, bracketed paste, focus
 *   reporting, origin mode, the Kitty keyboard state, attributes and the scroll
 *   region, and leaves scrollback alone.
 * - Mouse tracking and its encodings live outside DECSTR's reach; 2026 goes off
 *   through its own reset so a frame held for a dead program's synchronized
 *   update is painted now rather than after xterm's timeout.
 */
export const TERMINAL_MODE_RESET =
  PARSER_GROUND + "\x1b7\x1b[?1049l\x1b[!p\x1b[?9;1000;1002;1003;1006;1016;2026l";
