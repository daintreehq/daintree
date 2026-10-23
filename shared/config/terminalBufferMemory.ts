/**
 * Bytes per xterm buffer cell: 3 uint32s (codepoint + fg attr + bg attr). xterm
 * stores every buffer line at the full terminal width whatever is on it, so
 * `lines × cols × XTERM_BYTES_PER_CELL` is the closed-form cell-storage
 * estimate. A floor, not a heap measurement: per-line objects, combined-char
 * and extended-attribute maps sit on top of it.
 */
export const XTERM_BYTES_PER_CELL = 12;

export function estimateTerminalBufferBytes(lines: number, cols: number): number {
  return lines * cols * XTERM_BYTES_PER_CELL;
}
