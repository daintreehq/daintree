// eslint-disable-next-line no-control-regex
const URXVT_MOUSE_RE = /^\x1b\[\d+;\d+;\d+M/;

// CSI navigation: arrows, Home, End, and modified F1–F4 (with optional ;modifier param)
// eslint-disable-next-line no-control-regex
const CSI_NAV_RE = /^\x1b\[(1;\d+)?[ABCDHFPQRS]$/;

// Application-mode arrows, Home/End, F1–F4 (SS3 prefix, unmodified only)
// eslint-disable-next-line no-control-regex
const SS3_NAV_RE = /^\x1bO[ABCDHFPQRS]$/;

// Tilde-terminated navigation: Insert(2), Delete(3), PgUp(5), PgDn(6), F5–F12
// Includes optional ;modifier param. Excludes bracketed paste markers (200~, 201~)
// eslint-disable-next-line no-control-regex
const TILDE_NAV_RE = /^\x1b\[(2|3|5|6|15|17|18|19|20|21|23|24)(;\d+)?~$/;

// xterm answers application queries through the same onData event as typing.
// CPR/DSR/DA/window-report/DECRPM finals; `1;2R` doubles as Shift+F3, which
// CSI_NAV_RE already keeps out of prompt composition.
// eslint-disable-next-line no-control-regex
const CSI_REPORT_RE = /^\x1b\[[>?]?[\d;]*(?:[Rnct]|\$y)$/;

// String replies: OSC (colours, image-addon cell size), DCS (DECRQSS,
// XTVERSION), APC (Kitty graphics). The terminator is required so bare Alt+],
// Alt+Shift+P and Alt+_ stay typing, and the payload excludes control bytes so
// a multi-line raw paste that happens to be framed like one is not swallowed.
// eslint-disable-next-line no-control-regex
const STRING_REPLY_RE = /^\x1b(?:\]\d+;|P|_G)[^\x00-\x1f\x7f]*(?:\x07|\x1b\\)$/;

export function isNonKeyboardInput(data: string): boolean {
  // Mouse sequences
  if (data.startsWith("\x1b[M")) return true;
  if (data.startsWith("\x1b[<")) return true;
  if (URXVT_MOUSE_RE.test(data)) return true;

  // Focus reports
  if (data === "\x1b[I" || data === "\x1b[O") return true;

  // Private-mode CSI sequences (DEC private mode set/reset `?…h/l`, DSR
  // responses, the `?997` color-scheme report xterm emits in reply to a `?996n`
  // query). These are terminal-side control/report bytes that travel back
  // through onData but are never keyboard input — no keyboard protocol uses the
  // CSI `?` private prefix (Kitty is `CSI …u`, application-cursor is `SS3`).
  // Without this, a focus-triggered color-scheme reply (`\x1b[?997;1n`) was
  // misclassified as a keystroke and flipped a `waiting` agent to `directing`
  // on a plain click.
  if (data.startsWith("\x1b[?")) return true;

  // An agent TUI re-queries the terminal on focus-in and on resize, so without
  // this selecting a pane or switching back to its worktree read as typing —
  // and most replies are long enough to pick the 10s directing debounce.
  if (CSI_REPORT_RE.test(data)) return true;
  if (STRING_REPLY_RE.test(data)) return true;

  // Lone Escape
  if (data === "\x1b") return true;

  // Navigation / cursor sequences
  if (CSI_NAV_RE.test(data)) return true;
  if (SS3_NAV_RE.test(data)) return true;
  if (TILDE_NAV_RE.test(data)) return true;

  // C0 control characters that are not prompt editing (Ctrl+C, Ctrl+D, Ctrl+L, Ctrl+Z)
  if (data === "\x03" || data === "\x04" || data === "\x0c" || data === "\x1a") return true;

  return false;
}
