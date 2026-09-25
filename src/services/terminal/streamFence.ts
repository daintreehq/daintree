// Offsets are UTF-8 bytes in a terminal's renderer-bound output stream. The
// host stamps each delivered chunk with its end offset and each live snapshot
// with the offset it covers up to (SnapshotContinuation.streamOffset), which is
// what lets a restore drop the chunks that were delivered but are already in
// the snapshot it just wrote (#12791).

export interface StreamRange {
  start: number;
  end: number;
  // The pane's stream epoch at receipt (ManagedTerminal.streamEpoch).
  epoch: number;
}

interface StreamCursor {
  streamEpoch?: number;
  lastStreamEnd?: number;
  streamFence?: { offset: number; epoch: number };
}

/**
 * Place a just-received chunk in its pane's stream. Offsets only ever grow
 * within one host process, so a chunk that starts behind the last one means
 * the process behind this id was replaced: the epoch moves on and any fence
 * from the old stream is dropped.
 */
export function receiveStreamChunk(
  cursor: StreamCursor,
  data: string | Uint8Array,
  streamEnd: number | undefined
): StreamRange | undefined {
  if (streamEnd === undefined) return undefined;
  const start = streamEnd - utf8Length(data);
  if (cursor.lastStreamEnd !== undefined && start < cursor.lastStreamEnd) {
    cursor.streamEpoch = (cursor.streamEpoch ?? 0) + 1;
    cursor.streamFence = undefined;
  }
  cursor.lastStreamEnd = streamEnd;
  return { start, end: streamEnd, epoch: cursor.streamEpoch ?? 0 };
}

/**
 * The part of a chunk a committed fence has not already painted: all of it,
 * none of it (`""`), or the suffix past the fence. The first chunk that
 * reaches past the fence retires it.
 */
export function stripCoveredOutput(
  cursor: StreamCursor,
  data: string | Uint8Array,
  range: StreamRange | undefined
): string | Uint8Array {
  const fence = cursor.streamFence;
  if (!fence || !range || range.epoch !== fence.epoch) return data;
  if (range.start >= fence.offset) {
    cursor.streamFence = undefined;
    return data;
  }
  if (range.end <= fence.offset) return "";
  cursor.streamFence = undefined;
  return dropLeadingBytes(data, fence.offset - range.start);
}

export function utf8Length(data: string | Uint8Array): number {
  if (typeof data !== "string") return data.byteLength;
  let bytes = 0;
  for (let i = 0; i < data.length; i++) {
    const code = data.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
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
    else if (code >= 0xd800 && code <= 0xdbff) {
      consumed += 4;
      i++;
    } else consumed += 3;
    i++;
  }
  return data.slice(i);
}
