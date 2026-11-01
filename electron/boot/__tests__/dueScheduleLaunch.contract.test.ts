import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ELECTRON_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// A launch with `--run-due-schedules` starts windowless on every platform
// (#15992), Windows included, and before its backend starts the lifecycle has
// what it needs to hear the end of the user's session. main.ts can't be
// imported by a unit test, so the wiring is read from source;
// appLifecycle.test.ts drives the behaviour behind it.

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

function calls(root: ts.Node, name: string): ts.CallExpression[] {
  return find(
    root,
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === name) ||
        (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === name))
  );
}

function mentions(root: ts.Node, name: string): boolean {
  return (
    find(root, (node): node is ts.Identifier => ts.isIdentifier(node) && node.text === name)
      .length > 0
  );
}

const [launchDecl] = find(
  main,
  (node): node is ts.VariableDeclaration =>
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === "dueScheduleLaunch"
);

describe("main.ts due-schedule launch wiring (#15992)", () => {
  it("starts windowless for the flag on every platform, apart from the Host-mode gates", () => {
    const init = launchDecl?.initializer;
    expect(init && calls(init, "isDueScheduleCheckRequested")).toHaveLength(1);
    for (const gate of ["platform", "isRemoteHostSupported", "isEitherRemoteRoleSupported"]) {
      expect(mentions(init!, gate), gate).toBe(false);
    }
  });

  it("never exits a launch with the flag before starting", () => {
    for (const exit of calls(main, "exit")) {
      expect(mentions(exit, "isDueScheduleCheckRequested")).toBe(false);
    }
    expect(main.text).not.toContain("DUE_SCHEDULES_UNSUPPORTED_EXIT_CODE");
  });

  it("readies the session-end stand-in before the windowless backend starts", () => {
    const [standIn] = calls(main, "onStartedWindowless");
    const [backend] = calls(main, "startHostRuntime");
    expect(standIn).toBeDefined();
    expect(backend).toBeDefined();
    expect(standIn!.getStart()).toBeLessThan(backend!.getStart());
  });

  it("hands the lifecycle the scheduled runs a closed last window waits on", () => {
    const [register] = calls(main, "registerAppLifecycleHandlers");
    const options = register?.arguments[0];
    const runs =
      options && ts.isObjectLiteralExpression(options)
        ? options.properties.find(
            (prop): prop is ts.PropertyAssignment =>
              ts.isPropertyAssignment(prop) &&
              ts.isIdentifier(prop.name) &&
              prop.name.text === "scheduledRuns"
          )
        : undefined;
    expect(runs).toBeDefined();
    for (const source of [
      "hasOpenScheduledRun",
      "onScheduledRunClosed",
      "whenScheduledRunNotificationsSent",
    ]) {
      expect(mentions(runs!, source), source).toBe(true);
    }
  });
});
