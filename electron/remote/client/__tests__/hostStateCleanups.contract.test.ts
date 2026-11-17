import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// initClient.ts boots the whole remote client and can't be imported by a unit
// test, so the order of a forgotten host's cleanups is read from its source.

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../initClient.ts");

function cleanupSteps(): { name: string; node: ts.ObjectLiteralExpression }[] {
  const source = ts.createSourceFile(
    FILE,
    fs.readFileSync(FILE, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  let list: ts.ArrayLiteralExpression | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "HOST_STATE_CLEANUPS" &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      list = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return (list?.elements ?? []).filter(ts.isObjectLiteralExpression).map((node) => {
    const name = node.properties.find(
      (p): p is ts.PropertyAssignment =>
        ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "name"
    );
    return {
      name: name && ts.isStringLiteral(name.initializer) ? name.initializer.text : "",
      node,
    };
  });
}

function calls(root: ts.Node, method: string): boolean {
  if (
    ts.isCallExpression(root) &&
    ts.isPropertyAccessExpression(root.expression) &&
    root.expression.name.text === method
  ) {
    return true;
  }
  return ts.forEachChild(root, (child) => calls(child, method) || undefined) ?? false;
}

describe("a forgotten host's cleanups", () => {
  it("drop its load history before its views hear it was forgotten", () => {
    const steps = cleanupSteps();
    const history = steps.findIndex((step) => calls(step.node, "forgetHistory"));
    const told = steps.findIndex((step) => step.node.getText().includes('type: "host-forgotten"'));

    expect(history).toBeGreaterThanOrEqual(0);
    expect(told).toBeGreaterThanOrEqual(0);
    // A re-pointed host keeps its id, and a view that reads the old history
    // after the event would show it under the new machine.
    expect(history).toBeLessThan(told);
  });
});
