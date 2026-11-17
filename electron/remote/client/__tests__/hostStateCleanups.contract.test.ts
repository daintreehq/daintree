import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// initClient.ts boots the whole remote client and can't be imported by a unit
// test, so a forgotten host's cleanups and their wiring are read from its
// source; the services' own tests cover what each step clears.

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../initClient.ts");
const source = ts.createSourceFile(
  SOURCE,
  fs.readFileSync(SOURCE, "utf8"),
  ts.ScriptTarget.Latest,
  true
);

function find<T extends ts.Node>(root: ts.Node, test: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node) => {
    if (test(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function cleanups(): ts.ArrayLiteralExpression {
  const [declaration] = find(
    source,
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "HOST_STATE_CLEANUPS"
  );
  const initializer = declaration?.initializer;
  expect(initializer && ts.isArrayLiteralExpression(initializer)).toBe(true);
  return initializer as ts.ArrayLiteralExpression;
}

function cleanupSteps(): ts.ObjectLiteralExpression[] {
  return cleanups().elements.filter(ts.isObjectLiteralExpression);
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

function isGetRemoteService(node: ts.Expression, service: string): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "getRemoteService" &&
    node.arguments.length === 1 &&
    ts.isStringLiteral(node.arguments[0]!) &&
    node.arguments[0].text === service
  );
}

/**
 * Cleanup entries whose `run` is `(hostId) => getRemoteService("<service>")?.forgetHost(hostId)`:
 * called with the host being cleared, and its promise handed back for forgetHostState to await.
 */
function entriesForgettingOn(service: string): ts.ObjectLiteralExpression[] {
  return cleanupSteps().filter((element) => {
    const run = element.properties.find(
      (property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === "run"
    );
    const fn = run?.initializer;
    if (!fn || !ts.isArrowFunction(fn) || fn.parameters.length !== 1) return false;
    const param = fn.parameters[0]!.name;
    const call = fn.body;
    if (!ts.isIdentifier(param) || !ts.isCallExpression(call)) return false;
    const callee = call.expression;
    return (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "forgetHost" &&
      isGetRemoteService(callee.expression, service) &&
      call.arguments.length === 1 &&
      ts.isIdentifier(call.arguments[0]!) &&
      call.arguments[0].text === param.text
    );
  });
}

/** Whether the hook's own body awaits `forgetHostState(<its descriptor>.id, HOST_STATE_CLEANUPS)`. */
function hookClears(hook: ts.PropertyAssignment): boolean {
  const fn = hook.initializer;
  if (!ts.isArrowFunction(fn) || fn.parameters.length !== 1 || !ts.isBlock(fn.body)) return false;
  const param = fn.parameters[0]!.name;
  if (!ts.isIdentifier(param)) return false;
  return fn.body.statements.some((statement) => {
    if (!ts.isExpressionStatement(statement)) return false;
    const awaited = statement.expression;
    if (!ts.isAwaitExpression(awaited) || !ts.isCallExpression(awaited.expression)) return false;
    const call = awaited.expression;
    const [hostId, list] = call.arguments;
    return (
      ts.isIdentifier(call.expression) &&
      call.expression.text === "forgetHostState" &&
      hostId !== undefined &&
      ts.isPropertyAccessExpression(hostId) &&
      ts.isIdentifier(hostId.expression) &&
      hostId.expression.text === param.text &&
      hostId.name.text === "id" &&
      list !== undefined &&
      ts.isIdentifier(list) &&
      list.text === "HOST_STATE_CLEANUPS"
    );
  });
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

// Re-pointing a host keeps its id, so the port forwards, preview origins and
// assistant credential kept for the old machine are cleared by id, not by the
// host list.
describe("what a removed or re-pointed host leaves behind (#17207)", () => {
  it("includes its port forwards and preview origins", () => {
    expect(entriesForgettingOn("portForwards")).toHaveLength(1);
  });

  it("includes its assistant sender credential", () => {
    expect(entriesForgettingOn("hostControlLinkClient")).toHaveLength(1);
  });

  it("is cleared by both removing and re-pointing the host", () => {
    const hooks = find(
      source,
      (node): node is ts.PropertyAssignment =>
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        (node.name.text === "onForget" || node.name.text === "onRetarget")
    );
    expect(
      hooks
        .filter(hookClears)
        .map((hook) => (hook.name as ts.Identifier).text)
        .sort()
    ).toEqual(["onForget", "onRetarget"]);
  });
});
