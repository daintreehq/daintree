/**
 * Bounds on a clean copy asking the host for a Claude Code reply as it was
 * written (#15527). Past either, the copy goes ahead with the text rebuilt
 * from the screen.
 */

/** The longest selection sent to be found; a longer one is copied as drawn. */
export const REPLY_SPAN_SELECTION_MAX_CHARS = 256 * 1024;

/** How long the host looks before giving up. */
export const REPLY_SPAN_HOST_TIMEOUT_MS = 600;

/** How long the copy waits for it, a little past the host's own limit for the round trip. */
export const REPLY_SPAN_WAIT_MS = 800;
