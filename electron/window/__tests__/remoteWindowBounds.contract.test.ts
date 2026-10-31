import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ELECTRON_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// A window restored for a host's project opens on this machine's picker, so
// its project id never reaches window creation: the host's project has to be
// handed through main.ts and createWindow.ts by name, or the window opens at
// the last bounds any window saved (#15535). Neither file can be imported by
// a unit test, so the wiring is read from their source.

function parse(relativePath: string): ts.SourceFile {
  const file = path.join(ELECTRON_ROOT, relativePath);
  return ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

function callsTo(root: ts.Node, name: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function mentions(root: ts.Node, identifier: string): boolean {
  if (ts.isIdentifier(root) && root.text === identifier) return true;
  return ts.forEachChild(root, (child) => mentions(child, identifier) || undefined) ?? false;
}

describe("a restored host window's bounds", () => {
  it("are handed from main.ts to the window it sets up", () => {
    const [setup] = callsTo(parse("main.ts"), "setupBrowserWindow");
    const options = setup?.arguments[1];

    expect(options && ts.isObjectLiteralExpression(options)).toBe(true);
    const handed = (options as ts.ObjectLiteralExpression).properties.find(
      (property) =>
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === "remoteWorkspaceKey"
    ) as ts.PropertyAssignment | undefined;
    expect(handed && mentions(handed.initializer, "remoteWorkspaceKey")).toBe(true);
  });

  it("are looked up from the host's project when the window is created", () => {
    const [create] = callsTo(parse("window/createWindow.ts"), "createWindowWithState");
    const key = create?.arguments[1];

    expect(key && ts.isCallExpression(key) && ts.isIdentifier(key.expression)).toBe(true);
    expect(((key as ts.CallExpression).expression as ts.Identifier).text).toBe("resolveBoundsKey");
    expect(mentions(key!, "remoteWorkspaceKey")).toBe(true);
  });

  it("are dropped when their host is removed", () => {
    const source = parse("remote/client/initClient.ts");
    let cleanups: ts.Node | undefined;
    const visit = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "HOST_STATE_CLEANUPS"
      ) {
        cleanups = node.initializer;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    expect(cleanups && callsTo(cleanups, "pruneWindowStatesForHost")).toHaveLength(1);
  });
});
