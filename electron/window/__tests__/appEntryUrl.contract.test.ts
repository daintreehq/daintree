import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ELECTRON_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// The recovery page's reload restores the startup view's recorded entry URL
// (#16258), which carries its `?projectId=`. That only brings the project back
// if loadRenderer records the same URL it loads, before loading it.
// createWindow.ts can't be imported by a unit test, so the wiring is read from
// its source.

function parse(relativePath: string): ts.SourceFile {
  const file = path.join(ELECTRON_ROOT, relativePath);
  return ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

function collect<T extends ts.Node>(root: ts.Node, match: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node) => {
    if (match(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function mentions(root: ts.Node, identifier: string): boolean {
  if (ts.isIdentifier(root) && root.text === identifier) return true;
  return ts.forEachChild(root, (child) => mentions(child, identifier) || undefined) ?? false;
}

function isIdentifierNamed(node: ts.Node | undefined, name: string): boolean {
  return node !== undefined && ts.isIdentifier(node) && node.text === name;
}

function loadRendererBody(): ts.Node {
  const [declaration] = collect(
    parse("window/createWindow.ts"),
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) && isIdentifierNamed(node.name, "loadRenderer")
  );
  const initializer = declaration?.initializer;
  expect(initializer && ts.isArrowFunction(initializer)).toBe(true);
  return (initializer as ts.ArrowFunction).body;
}

describe("the startup view's entry URL", () => {
  it("is recorded on the app view, then loaded, as the same project-scoped URL", () => {
    const body = loadRendererBody();

    const records = collect(
      body,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) && isIdentifierNamed(node.expression, "recordAppEntryUrl")
    );
    const loads = collect(
      body,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "loadURL" &&
        isIdentifierNamed(node.expression.expression, "appWebContents")
    );
    expect(records).toHaveLength(1);
    expect(loads).toHaveLength(1);

    const [record] = records;
    const [load] = loads;
    expect(isIdentifierNamed(record.arguments[0], "appWebContents")).toBe(true);
    const recorded = record.arguments[1];
    const loaded = load.arguments[0];
    expect(recorded && ts.isIdentifier(recorded)).toBe(true);
    expect(isIdentifierNamed(loaded, (recorded as ts.Identifier).text)).toBe(true);
    expect(record.getStart()).toBeLessThan(load.getStart());

    const [urlDeclaration] = collect(
      body,
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) &&
        isIdentifierNamed(node.name, (recorded as ts.Identifier).text)
    );
    const [queryDeclaration] = collect(
      body,
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) && isIdentifierNamed(node.name, "qs")
    );
    expect(urlDeclaration?.initializer && mentions(urlDeclaration.initializer, "qs")).toBe(true);
    expect(
      queryDeclaration?.initializer && mentions(queryDeclaration.initializer, "projectId")
    ).toBe(true);
  });
});
