import { Terminal } from "@xterm/xterm";

export interface XtermVisualMetrics {
  cellW: number;
  cellH: number;
  screenW: number;
  screenH: number;
  cols: number;
  rows: number;
}

export function readXtermVisualMetrics(term: Terminal): XtermVisualMetrics | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const core = (term as any)?._core;
  const dims = core?._renderService?.dimensions;

  const cssCellW = dims?.css?.cell?.width ?? dims?.actualCellWidth ?? dims?.cell?.width;
  const cssCellH = dims?.css?.cell?.height ?? dims?.actualCellHeight ?? dims?.cell?.height;

  const screenEl = term.element?.querySelector(".xterm-screen") as HTMLElement | null;
  if (!screenEl) return null;

  const rect = screenEl.getBoundingClientRect();
  const cols = term.cols || 0;
  const rows = term.rows || 0;
  if (rect.width <= 0 || rect.height <= 0 || cols <= 0 || rows <= 0) return null;

  const screenW = rect.width;
  const screenH = rect.height;

  const cellW = typeof cssCellW === "number" && cssCellW > 0 ? cssCellW : screenW / cols;
  const cellH = typeof cssCellH === "number" && cssCellH > 0 ? cssCellH : screenH / rows;

  return { cellW, cellH, screenW, screenH, cols, rows };
}

export function wheelDeltaToPx(e: WheelEvent, cellH: number, pageH: number): number {
  if (e.deltaMode === 1) return e.deltaY * cellH;
  if (e.deltaMode === 2) return e.deltaY * pageH;
  return e.deltaY;
}
