// Offsets are UTF-8 bytes in a terminal's renderer-bound output stream. The
// host stamps each delivered chunk with its end offset and each live snapshot
// with the offset it covers up to (SnapshotContinuation.streamOffset), which is
// what lets a restore drop the chunks that were delivered but are already in
// the snapshot it just wrote (#12791).

export interface StreamRange {
  start: number;
  end: number;
}

// A zero-length write still runs its callback in order. It must not be "":
// xterm's WriteBuffer.flushSync drains with `while (chunk = queue.shift())`,
// so an empty string ends the drain and the entries queued behind it are
// discarded along with their callbacks.
const NOTHING_TO_PAINT = new Uint8Array(0);

/**
 * Where a received chunk sits in its terminal's stream. The host keeps
 * offsets growing across respawns at the same id, so the range alone places
 * the chunk; no per-pane cursor is needed.
 */
export function streamRangeOf(
  data: string | Uint8Array,
  streamEnd: number | undefined
): StreamRange | undefined {
  if (streamEnd === undefined) return undefined;
  return { start: streamEnd - utf8Length(data), end: streamEnd };
}

/**
 * The part of a chunk a committed fence has not already painted: all of it,
 * none of it, or the suffix past the fence. The fence stays armed, because a
 * chunk delivered on the other transport can arrive after later output.
 */
export function stripCoveredOutput(
  fence: number | undefined,
  data: string | Uint8Array,
  range: StreamRange | undefined
): string | Uint8Array {
  if (fence === undefined || !range || range.start >= fence) return data;
  if (range.end <= fence) return NOTHING_TO_PAINT;
  return dropLeadingBytes(data, fence - range.start);
}

// A lone surrogate encodes as U+FFFD (3 bytes) on the host, so only a real
// pair counts as 4.
function isSurrogatePair(data: string, i: number): boolean {
  const code = data.charCodeAt(i);
  if (code < 0xd800 || code > 0xdbff) return false;
  const next = data.charCodeAt(i + 1);
  return next >= 0xdc00 && next <= 0xdfff;
}

export function utf8Length(data: string | Uint8Array): number {
  if (typeof data !== "string") return data.byteLength;
  let bytes = 0;
  for (let i = 0; i < data.length; i++) {
    const code = data.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (isSurrogatePair(data, i)) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Drop the first `bytes` UTF-8 bytes. Callers only cut at a chunk boundary the
 * host produced, which is always a character boundary.
 */
export function dropLeadingBytes(data: string, bytes: number): string;
export function dropLeadingBytes(data: Uint8Array, bytes: number): Uint8Array;
export function dropLeadingBytes(data: string | Uint8Array, bytes: number): string | Uint8Array;
export function dropLeadingBytes(data: string | Uint8Array, bytes: number): string | Uint8Array {
  if (bytes <= 0) return data;
  if (typeof data !== "string") return data.subarray(bytes);
  let consumed = 0;
  let i = 0;
  while (i < data.length && consumed < bytes) {
    const code = data.charCodeAt(i);
    if (code < 0x80) consumed += 1;
    else if (code < 0x800) consumed += 2;
    else if (isSurrogatePair(data, i)) {
      consumed += 4;
      i++;
    } else consumed += 3;
    i++;
  }
  return data.slice(i);
}
