// Paste-jacking defence: strip characters that can either auto-execute when
// pasted into a shell (LF/CR/ESC and other C0/C1 controls) or visually
// disguise the real payload (zero-width and Bidi format controls). Shell
// metacharacters (`|`, `;`, `&`, backtick) are intentionally preserved —
// `curl … | bash` pipes are legitimate command syntax we render verbatim.
//
// Ranges covered:
//   \x00-\x1f  C0 controls (NUL, LF, CR, ESC, TAB, …)
//   \x7f       DEL
//   \x80-\x9f  C1 controls
//   U+200B-U+200F: ZWSP, ZWNJ, ZWJ, LRM, RLM
//   U+202A-U+202E: Bidi embedding/override (including RIGHT-TO-LEFT OVERRIDE)
//   U+2066-U+2069: Bidi isolate marks
//   U+FEFF: BOM / zero-width no-break space
// eslint-disable-next-line no-control-regex, no-irregular-whitespace
const PASTE_JACK_RE = /[\x00-\x1f\x7f-\x9f​-‏‪-‮⁦-⁩﻿]/g;

export function sanitizeForClipboard(text: string): string {
  return text.replace(PASTE_JACK_RE, "");
}
