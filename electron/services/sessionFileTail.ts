/**
 * Reading an agent's own append-only session file from its end: complete
 * lines, newest first, through a descriptor the caller has already verified,
 * and never past a byte ceiling. Shared by the Claude Code transcript and
 * Codex rollout readers.
 */

import type { FileHandle } from "fs/promises";

export async function readFully(handle: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      position + offset
    );
    // The file shrank under the read. Both CLIs only append, so this is a
    // rewrite nobody can account for, and the bytes already read may not
    // belong to the file that is there now.
    if (bytesRead === 0) throw new Error("Session file shrank while it was being read");
    offset += bytesRead;
  }
}

export interface ScanState {
  /** The last line had no newline yet — something was mid-write. */
  partialTail: boolean;
  capReached: boolean;
}

/**
 * Complete lines, newest first, as raw bytes.
 *
 * Nothing is decoded until a whole line has been assembled, so a multi-byte
 * character split across two reads is never cut in half. Pieces of a line whose
 * start has not been reached yet are kept apart and joined once, rather than
 * re-concatenated on every step back through a long one.
 */
export async function* linesFromEnd(
  handle: FileHandle,
  size: number,
  state: ScanState,
  options: { chunkBytes: number; maxScanBytes: number; signal?: AbortSignal }
): AsyncGenerator<Buffer> {
  let position = size;
  let scanned = 0;
  let pending: Buffer[] = [];
  let atTail = true;

  const emit = (line: Buffer): Buffer | null => {
    if (!atTail) return line;
    atTail = false;
    if (line.length > 0) state.partialTail = true;
    return null;
  };

  while (position > 0) {
    options.signal?.throwIfAborted();
    if (scanned >= options.maxScanBytes) {
      state.capReached = true;
      return;
    }
    const length = Math.min(options.chunkBytes, position, options.maxScanBytes - scanned);
    position -= length;
    const chunk = Buffer.allocUnsafe(length);
    await readFully(handle, chunk, position);
    scanned += length;

    let end = chunk.length;
    let newline = chunk.lastIndexOf(0x0a, end - 1);
    if (newline === -1) {
      pending.unshift(chunk);
      continue;
    }
    while (newline !== -1) {
      const head = chunk.subarray(newline + 1, end);
      const line = emit(pending.length > 0 ? Buffer.concat([head, ...pending]) : head);
      pending = [];
      if (line) yield line;
      end = newline;
      newline = end > 0 ? chunk.lastIndexOf(0x0a, end - 1) : -1;
    }
    if (end > 0) pending = [chunk.subarray(0, end)];
  }

  const first = emit(Buffer.concat(pending));
  if (first) yield first;
}
