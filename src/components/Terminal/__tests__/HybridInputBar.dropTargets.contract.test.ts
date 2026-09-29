// @vitest-environment node
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// The hybrid input's editor lives in one of two hosts: the compact bar, or the
// Expanded Editor dialog it is reparented into. A file drop only turns into an
// `@file` token because a React drop target wraps whichever host is showing —
// CodeMirror's own file handling is deliberately suppressed
// (`useEditorDomHandlers`, #11710) on the assumption that one does. The dialog
// shipped without one, so a drop there was claimed by that suppression and
// inserted nothing at all (#12570).
//
// What a drop inserts is covered by `useDragDrop.test.ts`, which drives the
// hook's handlers directly. What that suite cannot see is whether those
// handlers reach both hosts, and that is the half that drifted. Source
// enforcement rather than a rendering assertion is a cost call: standing up
// the whole bar, its stores and the dialog to dispatch one drop buys a single
// assertion.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const BAR_PATH = path.resolve(TEST_DIR, "../HybridInputBar.tsx");

/** Each drag prop a drop target needs, and the `useDragDrop` handler it must bind. */
const DROP_HANDLERS = {
  onDragEnter: "handleDragEnter",
  onDragOver: "handleDragOver",
  onDragLeave: "handleDragLeave",
  onDrop: "handleDrop",
} as const;

const OVERLAY_TAG = "FileDropOverlay";
const DIALOG_TAG = "AppDialog";

type JsxNode = ts.JsxElement | ts.JsxSelfClosingElement;

function parseBar(): ts.SourceFile {
  return ts.createSourceFile(
    BAR_PATH,
    fs.readFileSync(BAR_PATH, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX
  );
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function openingOf(node: JsxNode): ts.JsxOpeningLikeElement {
  return ts.isJsxElement(node) ? node.openingElement : node;
}

function tagOf(node: JsxNode, source: ts.SourceFile): string {
  return openingOf(node).tagName.getText(source);
}

function jsxNodes(root: ts.Node): JsxNode[] {
  const found: JsxNode[] = [];
  walk(root, (node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) found.push(node);
  });
  return found;
}

function attributeOf(node: JsxNode, name: string): ts.JsxAttribute | undefined {
  return openingOf(node).attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText() === name
  );
}

function expressionOf(attribute: ts.JsxAttribute | undefined): ts.Expression | undefined {
  const initializer = attribute?.initializer;
  if (!initializer || !ts.isJsxExpression(initializer)) return undefined;
  return initializer.expression;
}

/**
 * Whether the element's `ref` is `refName` itself, or a callback that stores
 * its node in `refName.current` — the two shapes the hosts use. Only the node
 * counts: a callback that merely clears some other ref is not bound to it.
 */
function refBinds(node: JsxNode, refName: string): boolean {
  const expression = expressionOf(attributeOf(node, "ref"));
  if (!expression) return false;
  if (ts.isIdentifier(expression)) return expression.text === refName;
  if (!ts.isArrowFunction(expression) && !ts.isFunctionExpression(expression)) return false;
  const param = expression.parameters[0]?.name;
  if (!param || !ts.isIdentifier(param)) return false;
  let assigns = false;
  walk(expression.body, (inner) => {
    if (
      ts.isBinaryExpression(inner) &&
      inner.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(inner.left) &&
      inner.left.name.text === "current" &&
      ts.isIdentifier(inner.left.expression) &&
      inner.left.expression.text === refName &&
      ts.isIdentifier(inner.right) &&
      inner.right.text === param.text
    ) {
      assigns = true;
    }
  });
  return assigns;
}

function elementWithRef(source: ts.SourceFile, refName: string): JsxNode {
  const matches = jsxNodes(source).filter((node) => refBinds(node, refName));
  // Guards the guard: a renamed ref would otherwise leave nothing to check.
  expect(matches, `elements bound to ${refName}`).toHaveLength(1);
  const [match] = matches;
  if (!match) throw new Error(`no element bound to ${refName}`);
  return match;
}

function isDropTarget(node: JsxNode): boolean {
  return Object.keys(DROP_HANDLERS).some((prop) => attributeOf(node, prop) !== undefined);
}

/**
 * The first element from the host outwards that handles any drag event. It
 * starts at the host itself, so a handler there or on anything between it and
 * the intended target is what gets checked — and fails as incomplete — rather
 * than being skipped while it intercepts the drop.
 */
function nearestDropTargetAround(node: JsxNode): JsxNode | undefined {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (
      (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current)) &&
      isDropTarget(current)
    ) {
      return current;
    }
  }
  return undefined;
}

function isWithin(node: ts.Node, ancestor: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

/**
 * Drag props not bound by name to the matching hook handler. Spreads are
 * rejected outright: their contents are invisible here, so one could override
 * a handler, or stand in for a dropped one, and keep this suite green.
 */
function unboundHandlers(node: JsxNode): string[] {
  if (openingOf(node).attributes.properties.some(ts.isJsxSpreadAttribute)) return ["{...spread}"];
  return Object.entries(DROP_HANDLERS)
    .filter(([prop, handler]) => {
      const expression = expressionOf(attributeOf(node, prop));
      return !expression || !ts.isIdentifier(expression) || expression.text !== handler;
    })
    .map(([prop]) => prop);
}

function overlaysWithin(node: JsxNode, source: ts.SourceFile): JsxNode[] {
  return jsxNodes(node).filter((inner) => tagOf(inner, source) === OVERLAY_TAG);
}

describe("HybridInputBar drop targets (#12570)", () => {
  it("takes every drop handler from a single useDragDrop call", () => {
    const source = parseBar();
    const calls: ts.CallExpression[] = [];
    walk(source, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "useDragDrop"
      ) {
        calls.push(node);
      }
    });

    // Two instances would each keep their own drag depth and hover state, and
    // the hosts would disagree about whether a drag is in progress.
    expect(calls).toHaveLength(1);
    const declaration = calls[0]?.parent;
    if (
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !ts.isObjectBindingPattern(declaration.name)
    ) {
      throw new Error("useDragDrop's result is not destructured into its handlers");
    }
    const bound = declaration.name.elements.flatMap((element) =>
      !element.propertyName && ts.isIdentifier(element.name) ? [element.name.text] : []
    );
    expect(bound).toEqual(expect.arrayContaining(Object.values(DROP_HANDLERS)));
  });

  // An agent-context drop drafts into a named pane; without the id the hook has
  // no draft to write and refuses every such drag, silently, in both hosts.
  it("tells useDragDrop whose draft an agent-context drop lands in", () => {
    const source = parseBar();
    let args: string[] = [];
    walk(source, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "useDragDrop"
      ) {
        args = node.arguments.map((arg) => arg.getText(source));
      }
    });
    expect(args[3]).toBe("terminalId");
  });

  it("wraps the compact editor host in a complete drop target", () => {
    const source = parseBar();
    const target = elementWithRef(source, "inputShellRef");

    expect(nearestDropTargetAround(elementWithRef(source, "compactEditorHostRef"))).toBe(target);
    expect(unboundHandlers(target)).toEqual([]);
    expect(overlaysWithin(target, source)).toHaveLength(1);
  });

  it("wraps the Expanded Editor host in a complete drop target inside the dialog", () => {
    const source = parseBar();
    const host = elementWithRef(source, "modalEditorHostRef");
    const target = nearestDropTargetAround(host);

    expect(target, "a drop target around the modal editor host").toBeDefined();
    if (!target) return;
    expect(unboundHandlers(target)).toEqual([]);

    const dialogs = jsxNodes(source).filter((node) => tagOf(node, source) === DIALOG_TAG);
    expect(dialogs.some((dialog) => isWithin(target, dialog))).toBe(true);

    // The host is the dialog's scroll container. An overlay inside it would
    // scroll away with a long draft instead of covering the visible editor.
    const overlays = overlaysWithin(target, source);
    expect(overlays).toHaveLength(1);
    expect(overlays.filter((overlay) => isWithin(overlay, host))).toEqual([]);
  });
});
