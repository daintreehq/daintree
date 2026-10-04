import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const ELECTRON_ROOT = path.join(REPO_ROOT, "electron");

// A PtyClient constructed without `deferStart` forks its own pty-host on the
// spot. #13164: a lazy module singleton in PtyClient.ts was reached by the
// subagent services, so every launch forked a second, empty host that never
// got a terminal. The one real client is built in perWindowInit and published
// through `window/serviceRefs.ts`; everything else reads it from there.
const ALLOWED_CONSTRUCTION_SITES = ["electron/window/perWindowInit.ts"];

function collectSources(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSources(full, out);
    } else if (
      /\.(ts|tsx|mts|cts)$/.test(entry.name) &&
      !/\.(test|spec)\.[cm]?tsx?$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
}

function isPtyClientModule(specifier: ts.Expression): boolean {
  return ts.isStringLiteral(specifier) && /(^|\/)PtyClient(\.js)?$/.test(specifier.text);
}

function constructsPtyClient(file: string): boolean {
  const text = fs.readFileSync(file, "utf8");
  if (!text.includes("PtyClient")) return false;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

  // Follow renames: `import { PtyClient as Pty }` and `import * as pty` both
  // reach the constructor without the literal `new PtyClient`.
  const classNames = new Set(["PtyClient"]);
  const namespaces = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !isPtyClientModule(statement.moduleSpecifier)) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    } else {
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === "PtyClient") {
          classNames.add(element.name.text);
        }
      }
    }
  }

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isNewExpression(node)) {
      const callee = node.expression;
      if (
        (ts.isIdentifier(callee) && classNames.has(callee.text)) ||
        (ts.isPropertyAccessExpression(callee) &&
          callee.name.text === "PtyClient" &&
          ts.isIdentifier(callee.expression) &&
          namespaces.has(callee.expression.text))
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("PtyClient construction contract", () => {
  it("is only constructed by perWindowInit", () => {
    const files: string[] = [];
    collectSources(ELECTRON_ROOT, files);
    const sites = files
      .filter(constructsPtyClient)
      .map((file) => path.relative(REPO_ROOT, file).split(path.sep).join("/"))
      .sort();
    expect(sites).toEqual(ALLOWED_CONSTRUCTION_SITES);
  });
});
