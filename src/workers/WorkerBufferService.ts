/**
 * Pure buffer-management helpers for the semantic analysis worker.
 *
 * The worker keeps a sliding-window analysis buffer per terminal. A plain
 * tail trim evicts the opening fence of a code block (or the start of a
 * patch) whose body exceeds the window, so the closing half can never match
 * and the artifact is silently lost (#9999). The trim here anchors to the
 * start of any still-open structure and only falls back to the plain tail
 * once the hard cap is exceeded.
 */

export const MAX_ANALYSIS_BUFFER_SIZE = 5000; // 5KB sliding window per terminal
export const MAX_ANALYSIS_BUFFER_HARD_CAP = 1_000_000; // Ceiling while a fence/patch is still open

/**
 * Append a cleaned (ANSI-stripped) chunk to the analysis buffer.
 * Normalizes CRLF so the line-anchored fence/patch detection in
 * trimAnalysisBuffer behaves on Windows PTY output. Only the incoming chunk
 * is normalized — `previous` is this function's own prior output, so it
 * contains no CR-before-LF except a possible trailing CR run from a pair
 * split across chunk boundaries, which the boundary check collapses. Keeps
 * the append O(chunk) instead of O(buffer) at 50Hz during agent output.
 */
export function appendToAnalysisBuffer(previous: string, cleanData: string): string {
  const chunk = cleanData.replace(/\r+\n/g, "\n");
  if (chunk.startsWith("\n") && previous.endsWith("\r")) {
    return previous.replace(/\r+$/, "") + chunk;
  }
  return previous + chunk;
}

/**
 * Trim the analysis buffer to the sliding window without evicting the start
 * of a still-open code fence or unified-diff patch. If retaining the open
 * structure would exceed MAX_ANALYSIS_BUFFER_HARD_CAP (e.g. a fence that is
 * never closed), fall back to the plain tail trim so memory stays bounded —
 * that block is lost, which is the pre-#9999 behavior.
 */
export function trimAnalysisBuffer(buffer: string): string {
  if (buffer.length <= MAX_ANALYSIS_BUFFER_SIZE) {
    return buffer;
  }

  let trimStart = buffer.length - MAX_ANALYSIS_BUFFER_SIZE;

  const fences = findFenceLineStarts(buffer);
  const openFenceStart = fences.length % 2 === 1 ? fences[fences.length - 1]! : null;
  const patchStart = findOpenPatchStart(buffer);
  const anchor = Math.min(openFenceStart ?? Infinity, patchStart ?? Infinity);

  if (anchor < trimStart && buffer.length - anchor <= MAX_ANALYSIS_BUFFER_HARD_CAP) {
    trimStart = anchor;
  }

  // Invariant: the kept buffer must start outside any code block, so fences
  // alternate opener/closer by index and parity stays meaningful next round.
  // If the first fence the cut keeps is a closer (odd index), the cut landed
  // inside a closed block — advance past that stranded closer's line, else a
  // later round would misread it as an opener and over- or under-retain.
  const firstKeptFence = fences.findIndex((offset) => offset >= trimStart);
  if (firstKeptFence !== -1 && firstKeptFence % 2 === 1) {
    const lineEnd = buffer.indexOf("\n", fences[firstKeptFence]!);
    // A fence on the final, newline-less line may still be streaming; leave
    // it and fix up on a later round.
    if (lineEnd !== -1) {
      trimStart = lineEnd + 1;
    }
  }

  if (trimStart === 0) {
    return buffer;
  }

  // V8 backs .slice() with a SlicedString that keeps the parent alive; force
  // a flat copy so a multi-hundred-KB parent isn't retained behind a 5KB tail.
  return (" " + buffer.slice(trimStart)).slice(1);
}

/**
 * Find the start offsets of all line-start ``` fences (CommonMark allows up
 * to 3 leading spaces). Odd parity means the last fence opened a block that
 * has not closed yet. Block content containing line-start fences can flip
 * parity — a false positive only over-retains, bounded by the hard cap.
 */
function findFenceLineStarts(buffer: string): number[] {
  const fenceLine = /^[ \t]{0,3}```/gm;
  const starts: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = fenceLine.exec(buffer)) !== null) {
    starts.push(match.index);
  }
  return starts;
}

/**
 * Find the start offset of a unified-diff patch still in progress at the end
 * of the buffer, or null when no patch is open. Mirrors the extractPatches
 * state machine: a patch starts at a "diff " line (or a "---" line outside a
 * patch) and is terminated by the first non-patch-shaped line. The final line
 * never terminates a patch — it may still be mid-stream.
 */
function findOpenPatchStart(buffer: string): number | null {
  const lines = buffer.split("\n");
  let inPatch = false;
  let patchStart: number | null = null;
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const startsPatch = line.startsWith("diff ") || (!inPatch && line.startsWith("---"));
    if (startsPatch) {
      patchStart = offset;
      inPatch = true;
    } else if (inPatch && !isPatchContinuation(line) && i < lines.length - 1) {
      inPatch = false;
      patchStart = null;
    }
    offset += line.length + 1;
  }

  return inPatch ? patchStart : null;
}

function isPatchContinuation(line: string): boolean {
  return (
    line.startsWith("+") ||
    line.startsWith("-") ||
    line.startsWith("@@") ||
    line.startsWith(" ") ||
    line.trim() === ""
  );
}
