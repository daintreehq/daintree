import type { Definition, SourceRange } from "../shared/model.js";

/**
 * Reads the two editable surfaces of one element — its class attribute and its
 * literal text — out of a source excerpt, as absolute offsets main can apply.
 *
 * Main owns source truth and re-checks every range it is handed against the
 * file at `expectedRevision`, so a wrong answer here costs a refused edit, not
 * a wrong write. What this must never do is guess: anything it cannot read
 * unambiguously comes back as a named shape the panel explains instead of
 * editing.
 */

export type ClassShape =
  | { kind: "static"; range: SourceRange; tokens: string[] }
  /** Holds `{…}`, or appears more than once — not a plain token list. */
  | { kind: "dynamic" }
  | { kind: "absent" };

export type TextShapeReason =
  "no-content" | "nested-markup" | "expression" | "entity" | "empty" | "multiline";

export type TextShape =
  | { kind: "literal"; range: SourceRange; text: string; leading: string; trailing: string }
  | { kind: "none"; reason: TextShapeReason };

export interface ElementShape {
  classes: ClassShape;
  text: TextShape;
}

export interface SourceExcerpt {
  text: string;
  firstLine: number;
  revision: string;
}

export type LocateResult =
  | { status: "ok"; shape: ElementShape }
  | { status: "revision-mismatch" }
  | { status: "unreadable" };

interface Attribute {
  name: string;
  kind: "none" | "quoted" | "unquoted" | "expression" | "brace";
  valueStart: number;
  valueEnd: number;
}

interface StartTag {
  attributes: Attribute[];
  end: number;
  selfClosing: boolean;
}

export function locateElementSource(excerpt: SourceExcerpt, definition: Definition): LocateResult {
  if (excerpt.revision !== definition.revision) return { status: "revision-mismatch" };

  const lineIndex = definition.location.line - excerpt.firstLine;
  if (lineIndex < 0) return { status: "unreadable" };
  let lineStart = 0;
  for (let i = 0; i < lineIndex; i++) {
    const next = excerpt.text.indexOf("\n", lineStart);
    if (next === -1) return { status: "unreadable" };
    lineStart = next + 1;
  }
  // Absolute offset of the excerpt's first character, derived from the one
  // place both coordinate systems name the same byte: the element's start.
  const base = definition.range.start - (lineStart + definition.location.column);
  if (base < 0) return { status: "unreadable" };

  const start = definition.range.start - base;
  const end = definition.range.end - base;
  if (end > excerpt.text.length || end <= start) return { status: "unreadable" };
  const element = excerpt.text.slice(start, end);
  if (!startsWithTag(element, definition.tagName)) return { status: "unreadable" };

  const tag = scanStartTag(element);
  if (!tag) return { status: "unreadable" };

  return {
    status: "ok",
    shape: {
      classes: readClasses(element, tag, definition.range.start),
      text: readText(element, tag, definition.tagName, definition.range.start),
    },
  };
}

function startsWithTag(element: string, tagName: string): boolean {
  if (!element.startsWith("<" + tagName)) return false;
  const after = element.charAt(tagName.length + 1);
  return after === "" || /[\s/>]/.test(after);
}

function readClasses(element: string, tag: StartTag, origin: number): ClassShape {
  const matches = tag.attributes.filter((attribute) => attribute.name === "class");
  if (matches.length === 0) return { kind: "absent" };
  const attribute = matches[0]!;
  if (matches.length > 1) return { kind: "dynamic" };
  if (attribute.kind !== "quoted" && attribute.kind !== "unquoted") return { kind: "dynamic" };
  const value = element.slice(attribute.valueStart, attribute.valueEnd);
  if (value.includes("{")) return { kind: "dynamic" };
  return {
    kind: "static",
    range: { start: origin + attribute.valueStart, end: origin + attribute.valueEnd },
    tokens: value.split(/\s+/).filter((token) => token.length > 0),
  };
}

function readText(element: string, tag: StartTag, tagName: string, origin: number): TextShape {
  if (tag.selfClosing || tag.end >= element.length) return { kind: "none", reason: "no-content" };
  const close = new RegExp(`</\\s*${escapeRegExp(tagName)}\\s*>$`).exec(element);
  if (!close) return { kind: "none", reason: "nested-markup" };
  const inner = element.slice(tag.end, close.index);
  if (inner.includes("<")) return { kind: "none", reason: "nested-markup" };
  if (inner.includes("{")) return { kind: "none", reason: "expression" };
  if (inner.includes("&")) return { kind: "none", reason: "entity" };
  const text = inner.trim();
  if (text.length === 0) return { kind: "none", reason: "empty" };
  if (text.includes("\n")) return { kind: "none", reason: "multiline" };
  const leading = inner.slice(0, inner.indexOf(text));
  const trailing = inner.slice(leading.length + text.length);
  return {
    kind: "literal",
    range: { start: origin + tag.end, end: origin + close.index },
    text,
    leading,
    trailing,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Index just past a balanced `{…}` starting at `from`, skipping string literals,
 * or -1. A `/` or a backtick fails closed: telling a regex or division from a
 * comment, or following a template's own `${}`, needs a real JavaScript lexer,
 * and a misread brace would put every later range in the wrong place.
 */
function skipBraces(src: string, from: number): number {
  let depth = 0;
  let i = from;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "/" || ch === "`") return -1;
    if (ch === '"' || ch === "'") {
      i++;
      while (i < src.length && src[i] !== ch) i += src[i] === "\\" ? 2 : 1;
      if (i >= src.length) return -1;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

function scanStartTag(src: string): StartTag | null {
  let i = 1;
  while (i < src.length && /[\w:.-]/.test(src[i]!)) i++;
  const attributes: Attribute[] = [];
  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i]!)) i++;
    const ch = src[i];
    if (ch === undefined) return null;
    if (ch === ">") return { attributes, end: i + 1, selfClosing: false };
    if (ch === "/" && src[i + 1] === ">") return { attributes, end: i + 2, selfClosing: true };
    if (ch === "{") {
      const after = skipBraces(src, i);
      if (after === -1) return null;
      attributes.push({ name: src.slice(i, after), kind: "brace", valueStart: i, valueEnd: after });
      i = after;
      continue;
    }
    const nameStart = i;
    while (i < src.length && !/[\s=>]/.test(src[i]!) && !(src[i] === "/" && src[i + 1] === ">")) {
      i++;
    }
    const name = src.slice(nameStart, i);
    if (name.length === 0) return null;
    while (i < src.length && /\s/.test(src[i]!)) i++;
    if (src[i] !== "=") {
      attributes.push({ name, kind: "none", valueStart: i, valueEnd: i });
      continue;
    }
    i++;
    while (i < src.length && /\s/.test(src[i]!)) i++;
    const quote = src[i];
    if (quote === '"' || quote === "'") {
      const valueStart = i + 1;
      i = valueStart;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "{") {
          const after = skipBraces(src, i);
          if (after === -1) return null;
          i = after;
        } else {
          i++;
        }
      }
      if (i >= src.length) return null;
      attributes.push({ name, kind: "quoted", valueStart, valueEnd: i });
      i++;
    } else if (quote === "{") {
      const after = skipBraces(src, i);
      if (after === -1) return null;
      attributes.push({ name, kind: "expression", valueStart: i, valueEnd: after });
      i = after;
    } else {
      const valueStart = i;
      while (i < src.length && !/[\s>]/.test(src[i]!) && !(src[i] === "/" && src[i + 1] === ">")) {
        i++;
      }
      attributes.push({ name, kind: "unquoted", valueStart, valueEnd: i });
    }
  }
  return null;
}
