/**
 * The parts of dictated text that must survive any rewrite byte for byte:
 * code, @-references, URLs, flags and paths. Shared so the correction guard
 * in main and the heard-as rules on both sides of IPC skip the same text.
 */

export type SpanKind = "code" | "ref" | "url" | "flag" | "path";

export interface ProtectedSpan {
  kind: SpanKind;
  text: string;
  start: number;
  end: number;
}

// Order matters: earlier alternatives claim their text first, so a path inside
// backticks or an @-reference is one span, not two. An @-reference in quotes
// (a path with spaces) runs to its closing quote. Each alternative may only
// start at the beginning of a run (the lookbehinds), which keeps the scan
// linear on long unspaced text such as CJK or a pasted blob.
const PROTECTED_SPAN_RE = new RegExp(
  [
    "(?<code>```[\\s\\S]*?```|`[^`\\n]+`)",
    '(?<ref>(?<![\\w@])@(?:"(?:\\\\.|[^"\\\\\\n])+"|[^\\s`]+))',
    "(?<url>(?<![\\w+.-])[a-z][a-z0-9+.-]*:\\/\\/[^\\s`]+)",
    "(?<flag>(?<![\\w-])--?[A-Za-z][^\\s`=,;]*(?:=[^\\s`,;]+)?)",
    "(?<path>(?<![\\p{L}\\p{N}_.~:%+-])[\\p{L}\\p{N}_.~:%+-]*[/\\\\][^\\s`,;，。、；：！？]*)",
    "(?<dotfile>(?<![\\w.-])\\.[A-Za-z][\\w.-]*)",
    "(?<dotted>(?<![\\w.-])[\\w-]+(?:\\.[\\w-]+)+)",
  ].join("|"),
  "gu"
);
// The last part of a dotted word must look like a file extension ("index.ts",
// "Node.js"), and abbreviations made of single letters ("e.g", "a.m") don't count.
const FILE_EXTENSION_RE = /^[A-Za-z][A-Za-z0-9]{0,7}$/u;
const SINGLE_LETTER_PARTS_RE = /^\w(?:\.\w)+$/u;

const PROSE_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?"]);
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
const OPENERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const QUOTES = new Set(["'", '"']);

function countBy(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

/** Strips prose punctuation and unbalanced brackets or quotes from the ends of a span. */
function trimProsePunctuation(span: string): string {
  const counts = countBy([...span]);
  const count = (char: string) => counts.get(char) ?? 0;
  let start = 0;
  let end = span.length;
  while (end > start) {
    const last = span[end - 1]!;
    const opener = CLOSERS[last];
    const unbalanced =
      PROSE_PUNCTUATION.has(last) ||
      (opener !== undefined && count(opener) < count(last)) ||
      (QUOTES.has(last) && count(last) % 2 === 1);
    if (!unbalanced) break;
    counts.set(last, count(last) - 1);
    end--;
  }
  while (start < end) {
    const first = span[start]!;
    const closer = OPENERS[first];
    const unbalanced =
      (closer !== undefined && count(first) > count(closer)) ||
      (QUOTES.has(first) && count(first) % 2 === 1);
    if (!unbalanced) break;
    counts.set(first, count(first) - 1);
    start++;
  }
  return span.slice(start, end);
}

function isFileName(token: string): boolean {
  const extension = token.slice(token.lastIndexOf(".") + 1);
  return FILE_EXTENSION_RE.test(extension) && !SINGLE_LETTER_PARTS_RE.test(token);
}

export function scanProtectedSpans(text: string): ProtectedSpan[] {
  const spans: ProtectedSpan[] = [];
  for (const match of text.matchAll(PROTECTED_SPAN_RE)) {
    const groups = match.groups ?? {};
    const start = match.index;
    const end = start + match[0].length;
    if (groups.code !== undefined) {
      spans.push({ kind: "code", text: match[0], start, end });
      continue;
    }
    const kind: SpanKind | null =
      groups.ref !== undefined
        ? "ref"
        : groups.url !== undefined
          ? "url"
          : groups.flag !== undefined
            ? "flag"
            : groups.path !== undefined || groups.dotfile !== undefined
              ? "path"
              : isFileName(match[0])
                ? "path"
                : null;
    if (!kind) continue;
    const trimmed = trimProsePunctuation(match[0]);
    if (!/[\p{L}\p{N}]/u.test(trimmed)) continue;
    const offset = match[0].indexOf(trimmed);
    spans.push({
      kind,
      text: trimmed,
      start: start + offset,
      end: start + offset + trimmed.length,
    });
  }
  return spans;
}

export interface ProtectedRange {
  start: number;
  end: number;
}

/** Character ranges of the protected spans in `text`, for edits that must skip them. */
export function findProtectedRanges(text: string): ProtectedRange[] {
  return scanProtectedSpans(text).map(({ start, end }) => ({ start, end }));
}
