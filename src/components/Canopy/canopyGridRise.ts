/** What placing the grid reads of xterm's active buffer. */
export interface ShownBuffer {
  readonly viewportY: number;
  readonly baseY: number;
  readonly cursorY: number;
  getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined;
}

/**
 * The lowest row of the shown screen that a pane too short for it has to keep:
 * the last with text on it, or the cursor's when it is shown and nothing below
 * it has text; -1 for a blank screen. A fresh agent draws only its top rows,
 * and the empty ones under them say nothing. A hidden cursor marks nothing the
 * user can see, and one below a screen scrolled back into history isn't on it.
 */
export function lastKeptRow(buffer: ShownBuffer, rows: number, cursorShown: boolean): number {
  const cursorRow = buffer.baseY + buffer.cursorY - buffer.viewportY;
  const floor = cursorShown && cursorRow >= 0 && cursorRow < rows ? cursorRow : -1;
  for (let row = rows - 1; row > floor; row--) {
    if (buffer.getLine(buffer.viewportY + row)?.translateToString(true).trim()) return row;
  }
  return floor;
}

/** The grid as its renderer last laid it out, in CSS px. */
export interface GridGeometry {
  gridHeight: number;
  rowHeight: number;
}

/**
 * How far, in px, a grid taller than its pane rises out of the pane's top so
 * the pane's last row is the grid's last kept one: not at all for a grid that
 * fits, or whose kept rows fit from the top, and never past the grid's bottom.
 */
export function gridRise(
  { gridHeight, rowHeight }: GridGeometry,
  available: number,
  keptRow: number
): number {
  if (!(rowHeight > 0) || !Number.isFinite(gridHeight) || !(available > 0)) return 0;
  const overflow = gridHeight - available;
  // A pixel over is the pane's rounding, not a grid too tall for it.
  if (overflow <= 1) return 0;
  const bottom = Math.min(gridHeight, (keptRow + 1) * rowHeight);
  return Math.min(overflow, Math.max(0, bottom - available));
}
