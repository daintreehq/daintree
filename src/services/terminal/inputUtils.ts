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

export function isNonKeyboardInput(data: string): boolean {
  // Mouse sequences
  if (data.startsWith("\x1b[M")) return true;
  if (data.startsWith("\x1b[<")) return true;
  if (URXVT_MOUSE_RE.test(data)) return true;

  // Focus reports
  if (data === "\x1b[I" || data === "\x1b[O") return true;

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
