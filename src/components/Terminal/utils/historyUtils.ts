import { Terminal } from "@xterm/xterm";
import { SerializeAddon } from "@xterm/addon-serialize";
import { escapeHtml, linkifyHtml } from "./htmlUtils";

export const HISTORY_JUMP_BACK_PERSIST_MS = 100;
export const HISTORY_JUMP_BACK_PERSIST_FRAMES = 2;

export interface HistoryState {
  lines: string[];
  htmlLines: string[];
  windowStart: number;
  windowEnd: number;
  takenAt: number;
}

/**
 * Parse xterm's serializeAsHTML output to extract individual row HTML.
 * The output format is:
 * <html><body><!--StartFragment--><pre>
 * <div style='...'>
 *   <div><span>row content</span></div>
 *   ...
 * </div>
 * </pre><!--EndFragment--></body></html>
 */
function parseXtermHtmlRows(html: string): string[] {
  // Extract the inner content div (contains all rows)
  const contentMatch = html.match(/<div style='[^']*'>([\s\S]*?)<\/div>\s*<\/pre>/);
  if (!contentMatch) return [];

  const innerHtml = contentMatch[1];

  // Extract each row's inner HTML (everything inside each <div>...</div>)
  const rowRegex = /<div>(<span[\s\S]*?<\/span>)<\/div>/g;
  const rows: string[] = [];
  let match;

  while ((match = rowRegex.exec(innerHtml)) !== null) {
    // Get the span content and apply linkification
    let rowHtml = match[1];
    rowHtml = linkifyHtml(rowHtml);
    rows.push(rowHtml || " ");
  }

  return rows;
}

export function extractSnapshot(
  term: Terminal,
  serializeAddon: SerializeAddon | null,
  maxLines: number,
  skipBottomLines: number = 0
): HistoryState {
  const buffer = term.buffer.active;
  const total = buffer.length;
  const cols = term.cols;

  const effectiveEnd = Math.max(0, total - skipBottomLines);
  const count = Math.min(maxLines, effectiveEnd);
  const start = Math.max(0, effectiveEnd - count);

  // Extract plain text lines for diff comparison
  const lines: string[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const line = buffer.getLine(start + i);
    lines[i] = line ? line.translateToString(true, 0, cols) : "";
  }

  let htmlLines: string[];
  if (serializeAddon) {
    try {
      // Use serializeAsHTML for pixel-perfect xterm rendering
      // This uses xterm's internal theme colors and cell-by-cell rendering
      const fullHtml = serializeAddon.serializeAsHTML({
        scrollback: count,
        onlySelection: false,
        includeGlobalBackground: false,
      });

      htmlLines = parseXtermHtmlRows(fullHtml);

      // Handle skipBottomLines by removing rows from the end
      if (skipBottomLines > 0 && htmlLines.length > skipBottomLines) {
        htmlLines = htmlLines.slice(0, -skipBottomLines);
      }

      // Ensure we have the right number of rows, pad with empty if needed
      while (htmlLines.length < count) {
        htmlLines.push(" ");
      }

      // Trim to maxLines if we got more
      if (htmlLines.length > count) {
        htmlLines = htmlLines.slice(htmlLines.length - count);
      }
    } catch {
      htmlLines = lines.map((l) => escapeHtml(l) || " ");
    }
  } else {
    htmlLines = lines.map((l) => escapeHtml(l) || " ");
  }

  return {
    lines,
    htmlLines,
    windowStart: start,
    windowEnd: effectiveEnd,
    takenAt: performance.now(),
  };
}

export function computeTrimmedTopCount(
  oldState: HistoryState | null,
  newState: HistoryState
): number {
  if (!oldState) return 0;

  const primaryTrimmed = Math.max(0, newState.windowStart - oldState.windowStart);
  if (primaryTrimmed > 0) return primaryTrimmed;

  const oldLines = oldState.lines;
  const newLines = newState.lines;

  if (oldLines.length === 0 || newLines.length === 0) return 0;

  const probeLen = Math.min(20, oldLines.length, newLines.length);
  const maxShift = Math.min(500, oldLines.length - probeLen);

  const probeStart = Math.max(0, oldLines.length - probeLen - 50);
  const probe = oldLines.slice(probeStart, probeStart + probeLen);

  for (let shift = 0; shift <= maxShift; shift++) {
    const searchIdx = probeStart - shift;
    if (searchIdx < 0) break;

    let match = true;
    for (let i = 0; i < probeLen && searchIdx + i < newLines.length; i++) {
      if (newLines[searchIdx + i] !== probe[i]) {
        match = false;
        break;
      }
    }
    if (match) return shift;
  }

  return 0;
}

export function shouldAcceptSnapshot(
  now: number,
  lastOutputAt: number,
  oldLines: string[],
  newLines: string[],
  settleMs: number
): boolean {
  if (now - lastOutputAt >= settleMs) return true;

  const checkCount = Math.min(40, oldLines.length, newLines.length);
  let changedLines = 0;

  for (let i = 1; i <= checkCount; i++) {
    const oldIdx = oldLines.length - i;
    const newIdx = newLines.length - i;
    if (oldIdx < 0 || newIdx < 0) break;

    if (oldLines[oldIdx] !== newLines[newIdx]) {
      changedLines++;
      if (changedLines > 5) return false;
    }
  }

  return true;
}

export function checkJumpBackPersistence(
  newWindowStart: number,
  lastAcceptedWindowStart: number | null,
  pendingJumpBack: { windowStart: number; firstSeenAt: number; stableFrames: number } | null,
  now: number
): {
  accept: boolean;
  newPendingState: { windowStart: number; firstSeenAt: number; stableFrames: number } | null;
} {
  if (lastAcceptedWindowStart === null) {
    return { accept: true, newPendingState: null };
  }

  if (newWindowStart >= lastAcceptedWindowStart) {
    return { accept: true, newPendingState: null };
  }

  const sameCandidate = pendingJumpBack && pendingJumpBack.windowStart === newWindowStart;

  let newPending: { windowStart: number; firstSeenAt: number; stableFrames: number };
  if (sameCandidate) {
    newPending = {
      ...pendingJumpBack,
      stableFrames: pendingJumpBack.stableFrames + 1,
    };
  } else {
    newPending = {
      windowStart: newWindowStart,
      firstSeenAt: now,
      stableFrames: 1,
    };
  }

  const elapsed = now - newPending.firstSeenAt;
  const shouldAccept =
    elapsed >= HISTORY_JUMP_BACK_PERSIST_MS ||
    newPending.stableFrames >= HISTORY_JUMP_BACK_PERSIST_FRAMES;

  if (shouldAccept) {
    return { accept: true, newPendingState: null };
  }

  return { accept: false, newPendingState: newPending };
}
