/**
 * Pagination and UTF-8 windowing for agent-facing reads (#11531).
 *
 * These run inside action `run()` bodies, which are the only enforcement point —
 * `resultSchema` is advertised documentation and never parses a result.
 *
 * TextEncoder/TextDecoder rather than Buffer: the action definitions are renderer
 * code, and the renderer runs with `nodeIntegration: false`.
 */

const encoder = new TextEncoder();
// ignoreBOM keeps a leading U+FEFF as content: the default decoder strips it,
// which would silently drop the BOM from the first window of a BOM'd file's diff
// and break reconstruction.
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

export interface Page<T> {
  items: T[];
  total: number;
  hasMore: boolean;
  /** Offset to pass next, or null when this page reached the end. */
  nextOffset: number | null;
}

export function paginate<T>(items: readonly T[], offset: number, limit: number): Page<T> {
  const total = items.length;
  const start = Math.min(Math.max(Math.trunc(offset) || 0, 0), total);
  const size = Math.max(Math.trunc(limit) || 1, 1);
  const end = Math.min(start + size, total);
  return {
    items: items.slice(start, end),
    total,
    hasMore: end < total,
    nextOffset: end < total ? end : null,
  };
}

/** True when `byte` is a UTF-8 continuation byte (0b10xxxxxx) — i.e. mid-character. */
function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

export interface Utf8Window {
  content: string;
  /** Byte offset this window actually starts at (advances past a split character). */
  offset: number;
  totalBytes: number;
  /** True when content remains beyond this window. */
  truncated: boolean;
  nextOffset: number | null;
}

/**
 * Slice `[offset, offset + maxBytes)` without splitting a multi-byte character.
 *
 * The end is walked back to a character boundary, except when that would return
 * an empty window — a caller looping on `nextOffset` must always make progress,
 * so an oversized leading character is emitted whole rather than never at all.
 */
export function sliceUtf8Window(text: string, offset: number, maxBytes: number): Utf8Window {
  const bytes = encoder.encode(text);
  const totalBytes = bytes.length;
  const size = Math.max(Math.trunc(maxBytes) || 1, 1);
  // 0 is never a continuation byte, so an out-of-range index reads as a boundary.
  const byteAt = (index: number): number => bytes[index] ?? 0;

  let start = Math.min(Math.max(Math.trunc(offset) || 0, 0), totalBytes);
  while (start < totalBytes && isContinuation(byteAt(start))) start++;

  let end = Math.min(start + size, totalBytes);
  while (end > start && end < totalBytes && isContinuation(byteAt(end))) end--;
  if (end === start && start < totalBytes) {
    end = start + 1;
    while (end < totalBytes && isContinuation(byteAt(end))) end++;
  }

  return {
    content: decoder.decode(bytes.subarray(start, end)),
    offset: start,
    totalBytes,
    truncated: end < totalBytes,
    nextOffset: end < totalBytes ? end : null,
  };
}

export interface TruncatedText {
  text: string;
  truncated: boolean;
}

/** Cut `text` to at most `maxBytes`, never splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): TruncatedText {
  if (encoder.encode(text).length <= maxBytes) return { text, truncated: false };
  return { text: sliceUtf8Window(text, 0, maxBytes).content, truncated: true };
}

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).length;
}
