// How an authority snapshot lands on the main-thread mirror terminal: one
// atomic, in-band VT payload. Synchronized output (DEC private mode 2026,
// which xterm honors) brackets the clear+rewrite so the renderer never paints
// the intermediate blank frame — a cadence tick is a single visually-atomic
// repaint, not a flicker.

export const SYNC_OUTPUT_START = "\x1b[?2026h";
export const SYNC_OUTPUT_END = "\x1b[?2026l";
// Clear scrollback (3J), screen (2J), and home the cursor — the serialize
// addon emits content assuming a clean terminal.
export const CLEAR_ALL = "\x1b[3J\x1b[2J\x1b[H";

export function buildMirrorApplyPayload(serialized: string): string {
  return `${SYNC_OUTPUT_START}${CLEAR_ALL}${serialized}${SYNC_OUTPUT_END}`;
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
