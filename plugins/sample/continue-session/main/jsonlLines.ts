import { constants as fsConstants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

export interface JsonlLine {
  /** 1-based line number in the file. */
  readonly line: number;
  /** Byte offset of the line's first byte. */
  readonly byteOffset: number;
  readonly byteLength: number;
  /** The line's text, or `null` when it was longer than `maxLineBytes` and skipped unread. */
  readonly text: string | null;
}

export interface SessionSnapshot {
  readonly handle: FileHandle;
  /** The file's size when it was opened: nothing past it is read, so appends never shift the index. */
  readonly bytes: number;
  readonly dev: number;
  readonly ino: number;
}

const READ_CHUNK_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;

/**
 * Opens a session file the CLI is still writing, read-only. A symlink, a FIFO
 * or anything but a regular file is refused: the path came from an observation
 * of the CLI's own file, and nothing else is read in its place.
 */
export async function openSessionSnapshot(path: string): Promise<SessionSnapshot> {
  const flags =
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
  const handle = await open(path, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("The session path is not a regular file.");
    return { handle, bytes: stat.size, dev: stat.dev, ino: stat.ino };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * Every line of the snapshot, streamed. Memory stays bounded by the longest
 * line kept (`maxLineBytes`), however large the file: a session file can be
 * close to a gigabyte, and single records in it run to megabytes.
 */
export async function* readJsonlLines(
  snapshot: Pick<SessionSnapshot, "handle" | "bytes">,
  options: { maxLineBytes: number; signal?: AbortSignal }
): AsyncGenerator<JsonlLine> {
  const { handle, bytes } = snapshot;
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let position = 0;
  let line = 0;
  let lineStart = 0;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let oversized = false;

  const finishLine = (end: number): JsonlLine => {
    line += 1;
    const byteLength = end - lineStart;
    const text = oversized ? null : Buffer.concat(pending, pendingBytes).toString("utf8");
    const result: JsonlLine = { line, byteOffset: lineStart, byteLength, text };
    pending = [];
    pendingBytes = 0;
    oversized = false;
    lineStart = end + 1;
    return result;
  };

  const keep = (slice: Buffer): void => {
    if (oversized) return;
    if (pendingBytes + slice.length > options.maxLineBytes) {
      oversized = true;
      pending = [];
      pendingBytes = 0;
      return;
    }
    // Copied: `buffer` is reused by the next read.
    pending.push(Buffer.from(slice));
    pendingBytes += slice.length;
  };

  while (position < bytes) {
    options.signal?.throwIfAborted();
    const want = Math.min(READ_CHUNK_BYTES, bytes - position);
    const { bytesRead } = await handle.read(buffer, 0, want, position);
    if (bytesRead === 0) break;
    let cursor = 0;
    while (cursor < bytesRead) {
      const newline = buffer.indexOf(NEWLINE, cursor);
      if (newline === -1 || newline >= bytesRead) {
        keep(buffer.subarray(cursor, bytesRead));
        cursor = bytesRead;
        break;
      }
      keep(buffer.subarray(cursor, newline));
      const result = finishLine(position + newline);
      cursor = newline + 1;
      if (result.byteLength > 0) yield result;
    }
    position += bytesRead;
  }
  // A last line with no newline yet is one the CLI may still be writing; it is
  // offered like any other, and a caller that can't parse it skips it.
  if (pendingBytes > 0 || oversized) {
    const result = finishLine(position);
    if (result.byteLength > 0) yield result;
  }
}
