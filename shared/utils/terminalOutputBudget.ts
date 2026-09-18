/**
 * Byte budgeting for the MCP terminal-read surfaces (#12450).
 *
 * The transport caps every response at `MCP_RESPONSE_TEXT_MAX_BYTES` by keeping
 * the head of the serialized text. For a tail read that is exactly backwards —
 * it keeps the oldest part of the tail, leaves JSON that will not parse, and
 * drops `structuredContent` — so each terminal-read producer fits its tails
 * under the cap first and reports the cut through its own `truncated` field.
 *
 * Everything is measured in the bytes the transport will actually send: the
 * JSON-escaped UTF-8 form, where an ESC costs six bytes and a quote two.
 */
import { utf8ByteLength } from "./boundedOutput.js";
import type { TerminalStatusEntry } from "../types/terminalStatus.js";

/** A tail as `tailCapturedOutput` returns it. */
export interface CapturedTail {
  content: string;
  lineCount: number;
  truncated: boolean;
}

/** Bytes `text` adds to a compact JSON document as a string value, quotes excluded. */
export function jsonStringBytes(text: string): number {
  return utf8ByteLength(JSON.stringify(text)) - 2;
}

/** A kept `\n` between two lines, as it appears inside a JSON string. */
const LINE_SEPARATOR_BYTES = 2;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * `index`, moved past the low half of a surrogate pair. Starting there would
 * ship an orphan the serializer escapes to six bytes of nothing.
 */
function codePointStart(line: string, index: number): number {
  return index > 0 &&
    isLowSurrogate(line.charCodeAt(index)) &&
    isHighSurrogate(line.charCodeAt(index - 1))
    ? index + 1
    : index;
}

/**
 * The longest suffix of `line` whose JSON cost fits `maxBytes`. Probing only
 * code-point starts keeps the cost monotonic in the start — an orphaned low
 * surrogate costs more than the whole pair — so a binary search finds it.
 */
function suffixWithinJsonBytes(line: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let lo = 0;
  let hi = line.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (jsonStringBytes(line.slice(codePointStart(line, mid))) <= maxBytes) hi = mid;
    else lo = mid + 1;
  }
  return line.slice(codePointStart(line, lo));
}

/**
 * Keep the newest lines of `tail` whose JSON cost fits `maxBytes`.
 *
 * Whole lines only, newest first, stopping at the first one that does not fit —
 * skipping it to reach an older, shorter line would present a gap as contiguous
 * output. When even the newest line is too long, its trailing part is kept and
 * counted as one line. `lineCount` stays "lines returned"; `truncated` can only
 * go from false to true.
 */
export function fitTailToJsonBytes(tail: CapturedTail, maxBytes: number): CapturedTail {
  if (jsonStringBytes(tail.content) <= maxBytes) return tail;
  const lines = tail.content.split("\n");
  let used = 0;
  let first = lines.length;
  while (first > 0) {
    const separator = first < lines.length ? LINE_SEPARATOR_BYTES : 0;
    const cost = jsonStringBytes(lines[first - 1]!) + separator;
    if (used + cost > maxBytes) break;
    used += cost;
    first -= 1;
  }
  if (first === lines.length) {
    const partial = suffixWithinJsonBytes(lines[lines.length - 1]!, maxBytes);
    return { content: partial, lineCount: partial.length > 0 ? 1 : 0, truncated: true };
  }
  const kept = lines.slice(first);
  return { content: kept.join("\n"), lineCount: kept.length, truncated: true };
}

/**
 * Fit a single-terminal read so its whole compact JSON stays within `maxBytes`.
 *
 * The envelope is measured with the tail's current `lineCount` and `truncated`;
 * fitting can only shrink the first and turn `false` into the shorter `true`, so
 * the measurement is an upper bound and the result needs no second pass.
 */
export function fitTerminalOutputResult<T extends CapturedTail>(result: T, maxBytes: number): T {
  const envelopeBytes = utf8ByteLength(JSON.stringify({ ...result, content: "" }));
  const contentBudget = maxBytes - envelopeBytes;
  if (jsonStringBytes(result.content) <= contentBudget) return result;
  return { ...result, ...fitTailToJsonBytes(result, Math.max(0, contentBudget)) };
}

/**
 * Split `total` bytes across tails costing `costs`, max-min fair: no tail gets
 * more than it needs, and what a short tail leaves unused goes to the longer
 * ones. Ties break by position, so the split never depends on fetch order.
 */
function allocateFairly(costs: readonly number[], total: number): number[] {
  const allowances = costs.map(() => 0);
  const order = costs
    .map((_, index) => index)
    .filter((index) => costs[index]! > 0)
    .sort((a, b) => costs[a]! - costs[b]! || a - b);
  let remaining = Math.max(0, total);
  order.forEach((index, position) => {
    const share = Math.floor(remaining / (order.length - position));
    const allowance = Math.min(costs[index]!, share);
    allowances[index] = allowance;
    remaining -= allowance;
  });
  return allowances;
}

/**
 * Fit every entry's `recentOutput` so a status snapshot's compact JSON stays
 * within `maxBytes`.
 *
 * Terminals share one response, so the bytes left after every other field are
 * split fairly between their tails and each keeps its own newest lines. Lines
 * are never ranked across terminals — nothing orders one pane's output against
 * another's. When the status fields alone overrun the cap every tail comes back
 * empty and flagged, and the transport cap handles the rest as before.
 */
export function boundTerminalStatusOutput<T extends { terminals: TerminalStatusEntry[] }>(
  result: T,
  maxBytes: number
): T {
  if (utf8ByteLength(JSON.stringify(result)) <= maxBytes) return result;

  const tails = result.terminals.map((entry) =>
    typeof entry.recentOutput === "string" ? entry.recentOutput : null
  );
  // Measured with `false`, the longer spelling, so a flag that flips to `true`
  // when its tail is cut can only shrink the total.
  const skeleton = {
    ...result,
    terminals: result.terminals.map((entry, index) =>
      tails[index] === null
        ? entry
        : {
            ...entry,
            recentOutput: "",
            recentOutputTruncated: entry.recentOutputTruncated ?? false,
          }
    ),
  };
  const available = maxBytes - utf8ByteLength(JSON.stringify(skeleton));
  const costs = tails.map((tail) => (tail === null ? 0 : jsonStringBytes(tail)));
  const allowances = allocateFairly(costs, available);

  return {
    ...result,
    terminals: result.terminals.map((entry, index) => {
      const tail = tails[index];
      if (tail === null || costs[index]! <= allowances[index]!) return entry;
      const fitted = fitTailToJsonBytes(
        { content: tail, lineCount: 0, truncated: entry.recentOutputTruncated ?? false },
        allowances[index]!
      );
      return { ...entry, recentOutput: fitted.content, recentOutputTruncated: fitted.truncated };
    }),
  };
}
