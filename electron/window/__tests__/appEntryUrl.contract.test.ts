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
// its source. Only loadRenderer's own statements count: a call nested in a
// callback runs at some other time, or never.

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

function isIdentifierNamed(node: ts.Node | undefined, name: string): node is ts.Identifier {
  return node !== undefined && ts.isIdentifier(node) && node.text === name;
}

function identifiersIn(root: ts.Node): string[] {
  return collect(root, ts.isIdentifier).map((identifier) => identifier.text);
}

function loadRendererStatements(): readonly ts.Statement[] {
  const declarations = collect(
    parse("window/createWindow.ts"),
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) && isIdentifierNamed(node.name, "loadRenderer")
  );
  expect(declarations).toHaveLength(1);
  const initializer = declarations[0].initializer;
  expect(initializer && ts.isArrowFunction(initializer) && ts.isBlock(initializer.body)).toBe(true);
  return ((initializer as ts.ArrowFunction).body as ts.Block).statements;
}

function directCalls(
  statements: readonly ts.Statement[],
  match: (call: ts.CallExpression) => boolean
): Array<{ index: number; call: ts.CallExpression }> {
  return statements.flatMap((statement, index) =>
    ts.isExpressionStatement(statement) &&
    ts.isCallExpression(statement.expression) &&
    match(statement.expression)
      ? [{ index, call: statement.expression }]
      : []
  );
}

function directDeclaration(
  statements: readonly ts.Statement[],
  name: string
): ts.VariableDeclaration | undefined {
  for (const statement of statements) {
    // Only a const holds the same value at the record and at the load.
    if (!ts.isVariableStatement(statement)) continue;
    if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    const found = statement.declarationList.declarations.find((declaration) =>
      isIdentifierNamed(declaration.name, name)
    );
    if (found) return found;
  }
  return undefined;
}

describe("the startup view's entry URL", () => {
  it("is recorded on the app view, then loaded, as the same project-scoped URL", () => {
    const statements = loadRendererStatements();

    const records = directCalls(statements, (call) =>
      isIdentifierNamed(call.expression, "recordAppEntryUrl")
    );
    const loads = directCalls(
      statements,
      (call) =>
        ts.isPropertyAccessExpression(call.expression) &&
        call.expression.name.text === "loadURL" &&
        isIdentifierNamed(call.expression.expression, "appWebContents")
    );
    expect(records).toHaveLength(1);
    expect(loads).toHaveLength(1);
    const [record] = records;
    const [load] = loads;
    expect(record.index).toBeLessThan(load.index);

    expect(isIdentifierNamed(record.call.arguments[0], "appWebContents")).toBe(true);
    const recorded = record.call.arguments[1];
    expect(recorded && ts.isIdentifier(recorded)).toBe(true);
    const urlName = (recorded as ts.Identifier).text;
    expect(isIdentifierNamed(load.call.arguments[0], urlName)).toBe(true);

    // The URL is built from a sibling declaration that carries the project id.
    const url = directDeclaration(statements, urlName)?.initializer;
    expect(url).toBeDefined();
    const carriesProject = identifiersIn(url!).some((name) => {
      const part = directDeclaration(statements, name)?.initializer;
      return part !== undefined && identifiersIn(part).includes("projectId");
    });
    expect(carriesProject).toBe(true);
  });
});
