import { parse, type ParserPlugin } from "@babel/parser";
import type { SourceLocation } from "../../../../../../shared/elementPicker/coordinates.js";

/**
 * What a React source file says at a position, read from its syntax alone:
 * the JSX element written there, or the component whose body holds it. The
 * file is parsed, never run or resolved, so an import, an alias or a config
 * is nothing this ever has to understand.
 *
 * Positions are a source map's: 1-based lines and 0-based UTF-16 columns,
 * which is also how Babel numbers its nodes.
 */

interface Position {
  line: number;
  column: number;
}

interface AstNode {
  type: string;
  loc?: { start: Position; end: Position } | null;
  [key: string]: unknown;
}

export interface JsxElement {
  /** The tag as written: `div`, `svg:rect`, `Card`, `ui.Card`. */
  name: string;
  /** A tag React passes as a string, which becomes a host element; anything else names a component. */
  intrinsic: boolean;
  location: SourceLocation;
}

export interface ParsedSource {
  /** The JSX element that starts exactly at `position`, if one does. */
  jsxAt(position: Position): JsxElement | null;
  /**
   * The declaration of the component whose own body makes the call at
   * `position`, if a call is made there and it is in a function.
   */
  definitionAt(position: Position): SourceLocation | null;
}

/** Keys that hold no syntax, or point back up the tree. */
const SKIPPED_KEYS = new Set([
  "loc",
  "start",
  "end",
  "extra",
  "range",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "comments",
  "tokens",
]);

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ObjectMethod",
  "ClassMethod",
  "ClassPrivateMethod",
]);

/** Expressions that pass a component through unchanged as far as where it is written goes. */
const TRANSPARENT_TYPES = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "ParenthesizedExpression",
]);

function pluginsFor(path: string): ParserPlugin[] | null {
  const extension = /\.([a-z]+)$/i.exec(path)?.[1]?.toLowerCase();
  switch (extension) {
    case "tsx":
      return ["typescript", "jsx", "decorators-legacy"];
    case "ts":
    case "mts":
    case "cts":
      return ["typescript", "decorators-legacy"];
    case "jsx":
    case "js":
    case "mjs":
    case "cjs":
      return ["jsx", "decorators-legacy"];
    default:
      return null;
  }
}

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";
}

function children(node: AstNode): AstNode[] {
  const out: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (SKIPPED_KEYS.has(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) out.push(item);
    } else if (isNode(value)) {
      out.push(value);
    }
  }
  return out;
}

function before(a: Position, b: Position): boolean {
  return a.line < b.line || (a.line === b.line && a.column < b.column);
}

function contains(node: AstNode, position: Position): boolean {
  const loc = node.loc;
  return !!loc && !before(position, loc.start) && before(position, loc.end);
}

function locationOf(node: AstNode): SourceLocation | null {
  const loc = node.loc;
  if (!loc) return null;
  return {
    lineBase: 1,
    columnBase: 0,
    columnUnit: "utf16",
    line: loc.start.line,
    column: loc.start.column,
    end: { line: loc.end.line, column: loc.end.column },
  };
}

function tagName(name: unknown): string | null {
  if (!isNode(name)) return null;
  switch (name.type) {
    case "JSXIdentifier":
      return typeof name.name === "string" ? name.name : null;
    case "JSXNamespacedName": {
      const namespace = tagName(name.namespace);
      const local = tagName(name.name);
      return namespace === null || local === null ? null : `${namespace}:${local}`;
    }
    case "JSXMemberExpression": {
      const object = tagName(name.object);
      const property = tagName(name.property);
      return object === null || property === null ? null : `${object}.${property}`;
    }
    default:
      return null;
  }
}

/** React's own JSX transform passes a lowercase identifier or a namespaced name as a string. */
function isIntrinsic(name: unknown): boolean {
  if (!isNode(name)) return false;
  if (name.type === "JSXNamespacedName") return true;
  return name.type === "JSXIdentifier" && typeof name.name === "string" && /^[a-z]/.test(name.name);
}

function startsAt(node: unknown, position: Position): boolean {
  const start = isNode(node) ? node.loc?.start : undefined;
  return !!start && start.line === position.line && start.column === position.column;
}

/** Whether `position` lies from the end of the object a method is called on to the start of its name. */
function atMethod(callee: unknown, position: Position): boolean {
  if (!isNode(callee) || !/MemberExpression$/.test(callee.type)) return false;
  const from = isNode(callee.object) ? callee.object.loc?.end : undefined;
  const to = isNode(callee.property) ? callee.property.loc?.start : undefined;
  return !!from && !!to && !before(position, from) && !before(to, position);
}

/**
 * Whether `node` is a call a stack frame can stand at. V8 places a frame at
 * the call it was making, and a map takes that back to a JSX element's `<`,
 * to the callee, or to the property a method is called through: its name, or
 * the `.` before it, where a compiled call's map can put it. Anywhere else is
 * a position from some other version of the file.
 */
function isCallAt(node: AstNode, position: Position): boolean {
  switch (node.type) {
    case "JSXElement":
      return startsAt(node, position);
    case "NewExpression":
      return startsAt(node, position) || startsAt(node.callee, position);
    case "TaggedTemplateExpression":
      return startsAt(node.tag, position);
    case "CallExpression":
    case "OptionalCallExpression":
      return startsAt(node.callee, position) || atMethod(node.callee, position);
    default:
      return false;
  }
}

/**
 * Where the component a function belongs to is declared: up through the
 * class whose `render` it is, the `memo(…)`, `forwardRef(…)` or other call
 * wrapping it, the variable it is assigned to and the `export` in front.
 */
function declarationOf(path: AstNode[], index: number): AstNode {
  let at = index;
  let node = path[at]!;
  if (node.type === "ClassMethod" || node.type === "ClassPrivateMethod") {
    const owner = path[at - 2];
    if (
      path[at - 1]?.type === "ClassBody" &&
      owner &&
      /^Class(Declaration|Expression)$/.test(owner.type)
    ) {
      at -= 2;
      node = owner;
    }
  }
  for (let parentIndex = at - 1; parentIndex >= 0; parentIndex -= 1) {
    const parent = path[parentIndex]!;
    const wraps =
      TRANSPARENT_TYPES.has(parent.type) ||
      (parent.type === "CallExpression" &&
        Array.isArray(parent.arguments) &&
        parent.arguments.includes(node)) ||
      (parent.type === "VariableDeclarator" && parent.init === node) ||
      (parent.type === "VariableDeclaration" &&
        Array.isArray(parent.declarations) &&
        parent.declarations.length === 1) ||
      parent.type === "ExportNamedDeclaration" ||
      parent.type === "ExportDefaultDeclaration";
    if (!wraps) break;
    node = parent;
  }
  return node;
}

class Parsed implements ParsedSource {
  private elements: Map<string, JsxElement> | null = null;

  constructor(private readonly program: AstNode) {}

  jsxAt(position: Position): JsxElement | null {
    this.elements ??= this.indexElements();
    return this.elements.get(`${position.line}:${position.column}`) ?? null;
  }

  definitionAt(position: Position): SourceLocation | null {
    const path: AstNode[] = [];
    for (let node: AstNode | undefined = this.program; node;) {
      path.push(node);
      node = children(node).find((child) => contains(child, position));
    }
    // The function making the call, not one the call is of: an IIFE's own
    // body is below the call, and starts where the call does.
    let call = path.length - 1;
    while (call >= 0 && !isCallAt(path[call]!, position)) call -= 1;
    for (let index = call - 1; index >= 0; index -= 1) {
      if (FUNCTION_TYPES.has(path[index]!.type)) return locationOf(declarationOf(path, index));
    }
    return null;
  }

  private indexElements(): Map<string, JsxElement> {
    const elements = new Map<string, JsxElement>();
    const pending: AstNode[] = [this.program];
    while (pending.length > 0) {
      const node = pending.pop()!;
      if (node.type === "JSXElement" && node.loc && isNode(node.openingElement)) {
        const name = tagName(node.openingElement.name);
        const location = locationOf(node);
        if (name !== null && location !== null) {
          elements.set(`${location.line}:${location.column}`, {
            name,
            intrinsic: isIntrinsic(node.openingElement.name),
            location,
          });
        }
      }
      // One at a time: a program of a few hundred thousand statements is past what a spread passes.
      for (const child of children(node)) pending.push(child);
    }
    return elements;
  }
}

/** Null when the extension is not a JavaScript or TypeScript module, or the file does not parse. */
export function parseSource(path: string, text: string): ParsedSource | null {
  const plugins = pluginsFor(path);
  if (plugins === null) return null;
  try {
    const file = parse(text, {
      sourceType: path.toLowerCase().endsWith(".cjs") ? "script" : "module",
      plugins,
      attachComment: false,
    }) as unknown as AstNode;
    return isNode(file.program) ? new Parsed(file.program) : null;
  } catch {
    return null;
  }
}
