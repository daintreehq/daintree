import { stripAnsi } from "./AgentPatternDetector.js";
import { stripIdleTerminalSequences } from "./IdleSequenceFilter.js";

const ESC = 0x1b;
const BEL = 0x07;

/**
 * `min(UTF-8 length of stripAnsi(stripIdleTerminalSequences(data)), limit)`.
 * The byte-volume floor credits at most `limit` per chunk, so once text that
 * provably survives both filters reaches it, the multi-kilobyte cursor-addressed
 * repaints agent TUIs emit need not be stripped at all. Anything short of that
 * is stripped and counted as before. `withoutParticles` must be
 * `stripCosmeticParticles(data)`.
 */
export function filteredOutputBytesUpTo(
  data: string,
  withoutParticles: string,
  limit: number
): number {
  if (!data.includes("\x1b")) {
    return Math.min(Buffer.byteLength(data, "utf8"), limit);
  }
  if (survivingBytesLowerBound(withoutParticles, limit) >= limit) {
    return limit;
  }
  return Math.min(
    Buffer.byteLength(stripAnsi(stripIdleTerminalSequences(data, withoutParticles)), "utf8"),
    limit
  );
}

// Bytes SPLIT_SEQUENCE_TAIL can remove from the head of a chunk.
function inSplitTailClass(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x3b) || // 0-9 : ;
    code === 0x3f || // ?
    code === 0x5b || // [
    code === 0x6d || // m
    code === 0x48 || // H
    code === 0x4b || // K
    code === 0x4a // J
  );
}

// Second byte of a two-byte escape that stripAnsi removes after its CSI and
// OSC passes: keypad `=` `>`, save/restore `7` `8`, and the 7-bit C1 range
// `@`-`Z`, `\`, `^`. `[`, `]` and `_` open longer sequences and are handled
// apart.
function isShortEscapeFinal(code: number): boolean {
  return (
    code === 0x3d ||
    code === 0x3e ||
    code === 0x37 ||
    code === 0x38 ||
    (code >= 0x40 && code <= 0x5a) ||
    code === 0x5c ||
    code === 0x5e
  );
}

function isCharsetDesignation(code: number): boolean {
  return code === 0x41 || code === 0x42 || (code >= 0x30 && code <= 0x32);
}

/**
 * A lower bound on the UTF-8 length of what the idle-sequence filter and
 * stripAnsi leave of `text` (already free of cosmetic particles), stopping
 * once it reaches `limit`. Counts only characters proven to survive:
 *
 * - Every pattern either filter removes is a contiguous run that starts with
 *   ESC, except SPLIT_SEQUENCE_TAIL, anchored to the start. A character whose
 *   predecessor survives every pass therefore survives too unless it is
 *   itself an ESC, so a run that starts with a survivor lasts to the next ESC.
 * - A run starts at a non-ASCII character outside any OSC (only OSC payloads
 *   hold non-ASCII), or right after a sequence that is removed whole: a
 *   complete CSI, a terminated OSC, or a recognised short escape. Deletions
 *   make neighbours adjacent, so a sequence that could pair with text across
 *   one (a lone ESC, an unfinished CSI, `ESC (` without its designator, an
 *   APC that the Kitty filter removes) or an OSC opened inside another stops
 *   the count: everything after it falls back to the exact strip.
 * - A character in SPLIT_SEQUENCE_TAIL's class starts a run only once a
 *   survivor precedes it, which keeps it out of the anchored tail.
 * - A surrogate pair counts 4 bytes; a lone surrogate counts nothing, because
 *   a deletion can pair it with another.
 */
export function survivingBytesLowerBound(text: string, limit: number): number {
  let bytes = 0;
  let surviving = false;
  let afterRemoved = true;
  let sawSurvivor = false;
  let oscOpen = false;
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === ESC) {
      surviving = false;
      afterRemoved = false;
      const next = text.charCodeAt(i + 1);
      if (next === 0x5b) {
        let j = i + 2;
        while (j < text.length && text.charCodeAt(j) >= 0x30 && text.charCodeAt(j) <= 0x3f) j++;
        while (j < text.length && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x2f) j++;
        const final = text.charCodeAt(j);
        if (!(final >= 0x40 && final <= 0x7e)) return bytes;
        i = j + 1;
        afterRemoved = !oscOpen;
        continue;
      }
      if (next === 0x5d) {
        if (oscOpen) return bytes;
        oscOpen = true;
        i += 2;
        continue;
      }
      if (oscOpen) {
        if (next !== 0x5c) return bytes;
        oscOpen = false;
        afterRemoved = true;
        i += 2;
        continue;
      }
      if (isShortEscapeFinal(next)) {
        afterRemoved = true;
        i += 2;
        continue;
      }
      if ((next === 0x28 || next === 0x29) && isCharsetDesignation(text.charCodeAt(i + 2))) {
        afterRemoved = true;
        i += 3;
        continue;
      }
      return bytes;
    }

    if (oscOpen) {
      if (code === BEL) {
        oscOpen = false;
        afterRemoved = true;
      }
      i++;
      continue;
    }

    if (
      !surviving &&
      !(code >= 0x80 || (afterRemoved && (sawSurvivor || !inSplitTailClass(code))))
    ) {
      afterRemoved = false;
      i++;
      continue;
    }

    surviving = true;
    sawSurvivor = true;
    afterRemoved = false;
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        i++;
      }
    } else if (code < 0xdc00 || code > 0xdfff) {
      bytes += 3;
    }
    if (bytes >= limit) return bytes;
    i++;
  }
  return bytes;
}
