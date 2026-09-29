import { transformSync, type Loader } from "esbuild";

/** One string literal or template-literal quasi, by its content range in the scanned text. */
export interface StringSegment {
  start: number;
  end: number;
  text: string;
  template: boolean;
  /** Template quasi that follows a `${…}` — its first token is a fragment. */
  exprBefore: boolean;
  /** Template quasi that runs into a `${…}` — its last token is a fragment. */
  exprAfter: boolean;
}

export interface ScannedSource {
  /** The text with comments blanked. Offsets are unchanged. */
  code: string;
  /** Comments, string contents and regex bodies blanked, so brackets balance and names are real. */
  masked: string;
  strings: StringSegment[];
}

const KEYWORDS_BEFORE_REGEX = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
  "instanceof",
]);

function regexAllowed(prev: string): boolean {
  if (prev === "") return true;
  if (/^[A-Za-z_$0-9]/.test(prev)) return KEYWORDS_BEFORE_REGEX.has(prev);
  return !(prev === ")" || prev === "]" || prev === "}" || prev === "a");
}

function blank(source: string, ranges: Array<[number, number]>): string {
  if (ranges.length === 0) return source;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let out = "";
  let cursor = 0;
  for (const [start, end] of sorted) {
    if (end <= cursor) continue;
    const from = Math.max(start, cursor);
    out += source.slice(cursor, from);
    out += source.slice(from, end).replace(/[^\n]/g, " ");
    cursor = end;
  }
  return out + source.slice(cursor);
}

/**
 * A single-pass JS scanner that tells code from comments, strings, template
 * quasis and regex literals. It runs over esbuild's output rather than the
 * author's TSX, because JSX text (`<p>Don't</p>`) is not lexable as JavaScript
 * and would desynchronise every quote after it.
 */
export function scanSource(src: string): ScannedSource {
  const comments: Array<[number, number]> = [];
  const contents: Array<[number, number]> = [];
  const strings: StringSegment[] = [];
  const stack: Array<"brace" | "template"> = [];
  const n = src.length;
  let prev = "";
  let i = 0;

  const scanTemplate = (from: number, exprBefore: boolean): number => {
    let j = from;
    while (j < n) {
      const c = src[j];
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === "`" || (c === "$" && src[j + 1] === "{")) {
        const exprAfter = c === "$";
        strings.push({
          start: from,
          end: j,
          text: src.slice(from, j),
          template: true,
          exprBefore,
          exprAfter,
        });
        contents.push([from, j]);
        if (exprAfter) {
          stack.push("template");
          prev = "{";
          return j + 2;
        }
        prev = "a";
        return j + 1;
      }
      j++;
    }
    strings.push({
      start: from,
      end: n,
      text: src.slice(from),
      template: true,
      exprBefore,
      exprAfter: false,
    });
    contents.push([from, n]);
    return n;
  };

  while (i < n) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      const stop = end < 0 ? n : end;
      comments.push([i, stop]);
      i = stop;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      comments.push([i, stop]);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") {
        if (src[j] === "\\") j++;
        j++;
      }
      const end = Math.min(j, n);
      strings.push({
        start: i + 1,
        end,
        text: src.slice(i + 1, end),
        template: false,
        exprBefore: false,
        exprAfter: false,
      });
      contents.push([i + 1, end]);
      prev = "a";
      i = end + 1;
      continue;
    }
    if (c === "`") {
      i = scanTemplate(i + 1, false);
      continue;
    }
    if (c === "{") {
      stack.push("brace");
      prev = "{";
      i++;
      continue;
    }
    if (c === "}") {
      if (stack.pop() === "template") {
        i = scanTemplate(i + 1, true);
        continue;
      }
      prev = "}";
      i++;
      continue;
    }
    if (c === "/" && regexAllowed(prev)) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== "\n") {
        const r = src[j];
        if (r === "\\") {
          j += 2;
          continue;
        }
        if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) break;
        j++;
      }
      contents.push([i + 1, Math.min(j, n)]);
      j++;
      while (j < n && /[a-z]/i.test(src[j]!)) j++;
      prev = "a";
      i = j;
      continue;
    }
    if (/[A-Za-z_$0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z_$0-9]/.test(src[j]!)) j++;
      prev = src.slice(i, j);
      i = j;
      continue;
    }
    // `x++ / y` divides: a postfix operator ends an expression like a value does.
    if ((c === "+" || c === "-") && next === c) {
      prev = "a";
      i += 2;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }

  return { code: blank(src, comments), masked: blank(src, [...comments, ...contents]), strings };
}

const OPENERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/** Index of the bracket closing the one at `open` in masked text, or -1. */
export function matchClose(masked: string, open: number): number {
  const stack: string[] = [];
  for (let i = open; i < masked.length; i++) {
    const c = masked[i]!;
    if (c in OPENERS) stack.push(OPENERS[c]!);
    else if (c === ")" || c === "]" || c === "}") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** Top-level argument ranges between `open` (a `(`) and its closer. */
export function splitArgs(masked: string, open: number): Array<[number, number]> {
  const close = matchClose(masked, open);
  if (close < 0) return [];
  const args: Array<[number, number]> = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < close; i++) {
    const c = masked[i]!;
    if (c in OPENERS) depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      args.push([start, i]);
      start = i + 1;
    }
  }
  if (masked.slice(start, close).trim().length > 0) args.push([start, close]);
  return args;
}

/** End of the expression starting at `from`: the next top-level `,`, `;` or unmatched closer. */
export function expressionEnd(masked: string, from: number): number {
  let depth = 0;
  for (let i = from; i < masked.length; i++) {
    const c = masked[i]!;
    if (c in OPENERS) depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return i;
      depth--;
    } else if ((c === "," || c === ";") && depth === 0) return i;
  }
  return masked.length;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Generated line → sorted `[generatedColumn, originalLine]` pairs, from a v3 `mappings` string. */
function decodeMappings(mappings: string): Array<Array<[number, number]>> {
  const lines: Array<Array<[number, number]>> = [];
  let srcLine = 0;
  for (const lineText of mappings.split(";")) {
    const segments: Array<[number, number]> = [];
    let genCol = 0;
    for (const segment of lineText.split(",")) {
      if (!segment) continue;
      const values: number[] = [];
      let value = 0;
      let shift = 0;
      for (const ch of segment) {
        const digit = BASE64.indexOf(ch);
        if (digit < 0) break;
        value += (digit & 31) << shift;
        if (digit & 32) {
          shift += 5;
        } else {
          values.push(value & 1 ? -(value >>> 1) : value >>> 1);
          value = 0;
          shift = 0;
        }
      }
      genCol += values[0] ?? 0;
      if (values.length >= 4) {
        srcLine += values[2]!;
        segments.push([genCol, srcLine]);
      }
    }
    lines.push(segments);
  }
  return lines;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function locate(starts: number[], offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, column: offset - starts[lo]! };
}

export interface PreparedSource extends ScannedSource {
  /** 1-based line in the author's file for an offset into `code`/`masked`. */
  lineAt(offset: number): number;
  /** Set when esbuild refused the file; the raw text was scanned instead. */
  parseError?: string;
}

const LOADERS: Record<string, Loader> = {
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".jsx": "jsx",
  ".js": "jsx",
  ".mjs": "jsx",
  ".cjs": "jsx",
};

function identity(text: string): (offset: number) => number {
  const starts = lineStarts(text);
  return (offset) => locate(starts, offset).line + 1;
}

/**
 * Strip types and lower JSX to calls with esbuild, then scan the result. JSX
 * becomes `jsx("button", {…})` — the same shape a zero-build view writes as
 * `createElement("button", {…})` — so one set of rules reads both.
 */
export function prepareScript(raw: string, extension: string): PreparedSource {
  const loader = LOADERS[extension];
  if (!loader) return { ...scanSource(raw), lineAt: identity(raw) };
  try {
    const result = transformSync(raw, {
      loader,
      jsx: "automatic",
      format: "esm",
      target: "esnext",
      sourcemap: "external",
      legalComments: "none",
      logLevel: "silent",
    });
    const map = JSON.parse(result.map) as { mappings: string };
    const decoded = decodeMappings(map.mappings);
    const starts = lineStarts(result.code);
    const lineAt = (offset: number): number => {
      const { line, column } = locate(starts, offset);
      for (let l = line; l >= 0; l--) {
        const segments = decoded[l];
        if (!segments || segments.length === 0) continue;
        let best: number | null = null;
        for (const [col, src] of segments) {
          if (l === line && col > column) break;
          best = src;
        }
        if (best !== null) return best + 1;
      }
      return 1;
    };
    return { ...scanSource(result.code), lineAt };
  } catch (err) {
    const message = (err as { errors?: Array<{ text?: string }> }).errors?.[0]?.text;
    return {
      ...scanSource(raw),
      lineAt: identity(raw),
      parseError: message ?? (err as Error).message,
    };
  }
}

/** CSS: only comments need blanking. */
export function prepareStyle(raw: string): PreparedSource {
  const comments: Array<[number, number]> = [];
  for (const match of raw.matchAll(/\/\*[\s\S]*?(?:\*\/|$)/g)) {
    comments.push([match.index, match.index + match[0].length]);
  }
  const code = blank(raw, comments);
  return { code, masked: code, strings: [], lineAt: identity(raw) };
}

/** Generated output is read as-is: only whole-file signatures are looked for in it. */
export function prepareRaw(raw: string): PreparedSource {
  return { code: raw, masked: raw, strings: [], lineAt: identity(raw) };
}
