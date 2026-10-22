import type { SyntaxNode, Tree } from "@lezer/common";
import { parser } from "@lezer/javascript";
import type { SourceLocation } from "../../../../../../shared/elementPicker/coordinates.js";

/**
 * Reads what a jsx-source position points at in the file it names. A dev
 * transform records the `<` of each element it compiled, so a claim holds when
 * the file at that revision has an element starting exactly there: found in a
 * parse, not by matching text, since `<Card` in a comment, a string or a
 * template literal is no element at all.
 */

/** Which grammar a file is read with; null for a file JSX is never compiled from. */
export type Dialect = "jsx" | "jsx ts" | "ts";

export function dialectOf(path: string): Dialect | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".tsx")) return "jsx ts";
  if (/\.(?:jsx|js|mjs|cjs)$/.test(lower)) return "jsx";
  if (/\.(?:ts|mts|cts)$/.test(lower)) return "ts";
  return null;
}

const parsers = new Map<Dialect, typeof parser>();

export function parse(text: string, dialect: Dialect): Tree {
  let configured = parsers.get(dialect);
  if (configured === undefined) {
    configured = parser.configure({ dialect });
    parsers.set(dialect, configured);
  }
  return configured.parse(text);
}

/** Every line terminator a JavaScript parser counts, as the transforms that numbered the lines did. */
const LINE_BREAK = /\r\n?|[\n\u2028\u2029]/g;

/** One file's text with its line starts, as UTF-16 offsets. */
export class SourceText {
  readonly starts: number[] = [0];
  /** Where each line's text ends, before its terminator. */
  private readonly ends: number[] = [];

  constructor(readonly text: string) {
    for (const match of text.matchAll(LINE_BREAK)) {
      this.ends.push(match.index);
      this.starts.push(match.index + match[0].length);
    }
    this.ends.push(text.length);
  }

  /** The offset `location` names, or null when no character of the file is there. */
  offsetOf(location: SourceLocation): number | null {
    const line = location.line - location.lineBase;
    const column = location.column - location.columnBase;
    if (line < 0 || column < 0 || line >= this.starts.length) return null;
    const offset = this.starts[line]! + column;
    return offset < this.ends[line]! ? offset : null;
  }

  /** `offset` as a 1-based line and 1-based UTF-16 column, the convention jsx-source uses. */
  positionOf(offset: number): { line: number; column: number } {
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.starts[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    return { line: low + 1, column: offset - this.starts[low]! + 1 };
  }

  /** `from` to `to` as a location in the jsx-source convention, end exclusive. */
  rangeOf(from: number, to: number): SourceLocation {
    const start = this.positionOf(from);
    const end = this.positionOf(to);
    return {
      lineBase: 1,
      columnBase: 1,
      columnUnit: "utf16",
      line: start.line,
      column: start.column,
      end: { line: end.line, column: end.column },
    };
  }
}

export interface JsxTag {
  /** An intrinsic element (`div`, `svg:rect`) or a component (`Card`, `ui.Card`), as JSX itself decides. */
  kind: "intrinsic" | "component";
  /** The tag as the file spells it. */
  name: string;
  /** The whole element, from its `<` to the end of its closing tag. */
  from: number;
  to: number;
}

export type TagReading =
  | { status: "tag"; tag: JsxTag }
  /** Nothing that starts an element is at the offset. */
  | { status: "none" }
  /** An element starts there, but the parse recovered from an error inside it. */
  | { status: "broken" };

function hasError(node: SyntaxNode): boolean {
  if (node.type.isError) return true;
  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    if (hasError(child)) return true;
  }
  return false;
}

/** The element whose opening tag starts exactly at `offset`, if one does. */
export function tagAt(tree: Tree, text: string, offset: number): TagReading {
  let tag: SyntaxNode | null = null;
  for (
    let node: SyntaxNode | null = tree.resolveInner(offset, 1);
    node !== null && node.from === offset;
    node = node.parent
  ) {
    if (node.name === "JSXOpenTag" || node.name === "JSXSelfClosingTag") {
      tag = node;
      break;
    }
  }
  if (tag === null) return { status: "none" };
  const element = tag.parent;
  if (element === null || element.name !== "JSXElement" || hasError(element)) {
    return { status: "broken" };
  }
  // The opening `<` is the tag's first child; the name follows it.
  const name = tag.firstChild?.nextSibling ?? null;
  if (name === null) return { status: "broken" };
  const spelled = text.slice(name.from, name.to);
  switch (name.name) {
    case "JSXBuiltin":
    case "JSXNamespacedName":
      return {
        status: "tag",
        tag: { kind: "intrinsic", name: spelled, from: element.from, to: element.to },
      };
    case "JSXIdentifier":
    case "JSXMemberExpression":
      return {
        status: "tag",
        tag: { kind: "component", name: spelled, from: element.from, to: element.to },
      };
    default:
      return { status: "broken" };
  }
}

/**
 * Whether a tag the file spells is the element the page has. JSX passes an
 * intrinsic name through as written; an HTML document lowercases it, and an
 * SVG or custom element keeps its case.
 */
export function namesElement(spelled: string, localName: string): boolean {
  if (spelled === localName) return true;
  return localName === localName.toLowerCase() && spelled.toLowerCase() === localName;
}
