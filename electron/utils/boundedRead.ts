import type { FileHandle } from "fs/promises";

/**
 * Read at most `limit + 1` bytes from `handle`, sized from the opened file's
 * length so a small file never allocates the whole budget. Resolves `null`
 * when the file holds more than `limit` bytes — the extra byte is how that is
 * recognised without reading further. A stat taken before the read is only a
 * hint: a writer can grow the file after it, and this is what holds the cap.
 */
export async function readBoundedFromHandle(
  handle: FileHandle,
  sizeHint: number,
  limit: number,
  signal?: AbortSignal
): Promise<Buffer<ArrayBuffer> | null> {
  if (sizeHint > limit) return null;
  let buffer = Buffer.allocUnsafe(Math.min(limit, Math.max(0, sizeHint)) + 1);
  let filled = 0;
  for (;;) {
    signal?.throwIfAborted();
    if (filled === buffer.length) {
      // The file grew after it was opened; keep going up to the ceiling.
      if (buffer.length > limit) break;
      const grown = Buffer.allocUnsafe(Math.min(limit + 1, buffer.length * 2));
      buffer.copy(grown, 0, 0, filled);
      buffer = grown;
    }
    // position: null reads from the descriptor's offset, so a FIFO works too.
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, null);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  if (filled > limit) return null;
  return buffer.subarray(0, filled);
}
