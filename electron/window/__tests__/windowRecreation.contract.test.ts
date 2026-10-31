import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ELECTRON_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// An OOM rebuilds a window onto what it was showing (#15564), which holds only
// if main.ts's `createWindow` hands both crash handlers the same recreation and
// rebuilds through its captured workspace rather than its own arguments.
// main.ts can't be imported by a unit test, so the wiring is read from source;
// windowRecreation.test.ts drives the behaviour behind it.

const main = ts.createSourceFile(
  "main.ts",
  fs.readFileSync(path.join(ELECTRON_ROOT, "main.ts"), "utf8"),
  ts.ScriptTarget.Latest,
  true
);

function find<T extends ts.Node>(root: ts.Node, match: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node) => {
    if (match(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function isCallTo(node: ts.Node, name: string): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name
  );
}

function property(literal: ts.Node | undefined, name: string): ts.Expression | undefined {
  if (!literal || !ts.isObjectLiteralExpression(literal)) return undefined;
  const found = literal.properties.find(
    (prop): prop is ts.PropertyAssignment =>
      ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === name
  );
  return found?.initializer;
}

const [recreationDecl] = find(
  main,
  (node): node is ts.VariableDeclaration =>
    ts.isVariableDeclaration(node) &&
    node.initializer !== undefined &&
    isCallTo(node.initializer, "createWindowRecreation")
);
const recreationName =
  recreationDecl && ts.isIdentifier(recreationDecl.name) ? recreationDecl.name.text : "";
const recreationArgs = (recreationDecl?.initializer as ts.CallExpression | undefined)?.arguments[0];

describe("main.ts OOM recreation wiring (#15564)", () => {
  it("builds one recreation per window", () => {
    expect(
      find(main, (node): node is ts.CallExpression => isCallTo(node, "createWindowRecreation"))
    ).toHaveLength(1);
    expect(recreationName).not.toBe("");
  });

  it("hands both crash handlers that recreation's prepare", () => {
    const handed = find(
      main,
      (node): node is ts.PropertyAssignment =>
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "prepareWindowRecreation"
    );

    expect(handed).toHaveLength(2);
    for (const prop of handed) {
      expect(ts.isPropertyAccessExpression(prop.initializer)).toBe(true);
      const access = prop.initializer as ts.PropertyAccessExpression;
      expect(access.expression.getText()).toBe(recreationName);
      expect(access.name.text).toBe("prepare");
    }
  });

  it("rebuilds through the captured workspace, never the window's own arguments", () => {
    const rebuild = property(recreationArgs, "createWindow");
    expect(rebuild && ts.isArrowFunction(rebuild)).toBe(true);
    const fn = rebuild as ts.ArrowFunction;
    const params = fn.parameters.map((param) => param.name.getText());
    expect(params).toHaveLength(2);

    expect(ts.isCallExpression(fn.body) && isCallTo(fn.body, "createWindow")).toBe(true);
    const args = (fn.body as ts.CallExpression).arguments.map((arg) => arg.getText());
    expect(args).toEqual(["undefined", params[0], params[1]]);
  });

  it("reads the window id from the registration, not from a launch argument", () => {
    const getWindowId = property(recreationArgs, "getWindowId");
    expect(getWindowId && ts.isArrowFunction(getWindowId)).toBe(true);
    const body = (getWindowId as ts.ArrowFunction).body;
    expect(ts.isPropertyAccessExpression(body) && body.name.text === "windowId").toBe(true);

    const registered = find(
      main,
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === (body as ts.PropertyAccessExpression).expression.getText()
    );
    expect(
      registered.some((decl) => decl.initializer?.getText().startsWith("windowRegistry.register("))
    ).toBe(true);
  });

  it("skips the closing window's manifest save while it is being rebuilt, and lets the replacement's record go on close", () => {
    const saves = find(
      main,
      (node): node is ts.CallExpression =>
        isCallTo(node, "saveOpenWindowsNow") && node.arguments[0]?.getText() === "closedWindowId"
    );
    expect(saves).toHaveLength(1);

    // The save sits in the then-branch of `if (!<recreation>.isRecreating())`,
    // braces or not.
    let branch: ts.Node = saves[0]!;
    while (!ts.isIfStatement(branch.parent)) branch = branch.parent;
    const guard = branch.parent as ts.IfStatement;
    expect(guard.thenStatement).toBe(branch);
    const condition = guard.expression;
    expect(
      ts.isPrefixUnaryExpression(condition) &&
        condition.operator === ts.SyntaxKind.ExclamationToken &&
        ts.isCallExpression(condition.operand) &&
        ts.isPropertyAccessExpression(condition.operand.expression) &&
        condition.operand.expression.expression.getText() === recreationName &&
        condition.operand.expression.name.text === "isRecreating"
    ).toBe(true);

    // ...inside the window's `closed` listener.
    let listener: ts.Node = guard;
    while (!ts.isArrowFunction(listener)) listener = listener.parent;
    const subscription = listener.parent;
    expect(
      ts.isCallExpression(subscription) &&
        ts.isPropertyAccessExpression(subscription.expression) &&
        subscription.expression.name.text === "on" &&
        subscription.arguments[0] !== undefined &&
        ts.isStringLiteral(subscription.arguments[0]) &&
        subscription.arguments[0].text === "closed" &&
        subscription.arguments[1] === listener
    ).toBe(true);

    const clears = find(
      listener,
      (node): node is ts.CallExpression =>
        isCallTo(node, "clearPendingWindowRecreation") &&
        node.arguments[0]?.getText() === "closedWindowId"
    );
    expect(clears).toHaveLength(1);
  });
});
