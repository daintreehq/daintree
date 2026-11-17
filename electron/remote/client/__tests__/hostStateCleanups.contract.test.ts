import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// initClient.ts boots the whole remote client and can't be imported by a unit
// test, so the order of a forgotten host's cleanups is read from its source.

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../initClient.ts");

function findCleanups(node: ts.Node): ts.ArrayLiteralExpression | undefined {
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === "HOST_STATE_CLEANUPS" &&
    node.initializer &&
    ts.isArrayLiteralExpression(node.initializer)
  ) {
    return node.initializer;
  }
  return ts.forEachChild(node, findCleanups);
}

function cleanupSteps(): ts.ObjectLiteralExpression[] {
  const source = ts.createSourceFile(
    FILE,
    fs.readFileSync(FILE, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const steps: ts.ObjectLiteralExpression[] = [];
  for (const element of findCleanups(source)?.elements ?? []) {
    if (ts.isObjectLiteralExpression(element)) steps.push(element);
  }
  return steps;
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
    const history = steps.findIndex((step) => calls(step, "forgetHistory"));
    const told = steps.findIndex((step) => step.getText().includes('type: "host-forgotten"'));

    expect(history).toBeGreaterThanOrEqual(0);
    expect(told).toBeGreaterThanOrEqual(0);
    // A re-pointed host keeps its id, and a view that reads the old history
    // after the event would show it under the new machine.
    expect(history).toBeLessThan(told);
  });
});
