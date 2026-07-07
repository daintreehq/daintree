// How an authority snapshot lands on the main-thread mirror terminal: one
// atomic, in-band VT payload. Synchronized output (DEC private mode 2026,
// which xterm honors) brackets the clear+rewrite so the renderer never paints
// the intermediate blank frame — a cadence tick is a single visually-atomic
// repaint, not a flicker.

export const SYNC_OUTPUT_START = "\x1b[?2026h";
export const SYNC_OUTPUT_END = "\x1b[?2026l";
// The serialize addon emits content assuming a DEFAULT terminal: it only
// writes modes that are currently non-default on the source, never resets.
// So the mirror must be reset in-band before every apply, or state from the
// previous snapshot leaks (stuck in the alternate screen after the authority
// left it; stale bracketed paste / mouse tracking affecting input). RIS
// (ESC c) would do this in one sequence but also resets mode 2026, breaking
// the atomic bracket — so: DECSTR soft reset, exit the alternate screen,
// explicitly disable the stateful input modes DECSTR leaves alone.
export const MIRROR_RESET =
  "\x1b[!p\x1b[?1049l\x1b[?2004l\x1b[?9;1000;1001;1002;1003;1005;1006;1015l";
// Clear scrollback (3J), screen (2J), and home the cursor.
export const CLEAR_ALL = "\x1b[3J\x1b[2J\x1b[H";

export function buildMirrorApplyPayload(serialized: string): string {
  return `${SYNC_OUTPUT_START}${MIRROR_RESET}${CLEAR_ALL}${serialized}${SYNC_OUTPUT_END}`;
}

export interface MirrorTarget {
  write(data: string, callback?: () => void): void;
}

export function applySnapshotToMirror(
  mirror: MirrorTarget,
  serialized: string,
  callback?: () => void
): void {
  mirror.write(buildMirrorApplyPayload(serialized), callback);
}
