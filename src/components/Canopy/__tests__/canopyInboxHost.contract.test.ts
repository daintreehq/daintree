import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Canopy's inbox has one host, the Canopy window (#16581): no project window may
// mount it, so the only module that may load `CanopyView`, statically or lazily,
// is the window's root. A project window's Canopy is the offer to turn it on.
//
// KNOWN LIMITS (a regression guard, not a sound checker): a specifier built at
// runtime, or a re-export under another name, is outside this file's view.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(TEST_DIR, "../../..");
const INBOX = path.join(SRC, "components/Canopy/CanopyView");
const ONLY_HOST = path.join(SRC, "canopyWindow/CanopyWindowRoot.tsx");
// A drop means the walk went blind.
const MIN_FILES_SCANNED = 1000;

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "__preview__") continue;
      sourceFiles(full, found);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec|d)\.tsx?$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

function resolves(from: string, specifier: string): string | null {
  if (specifier.startsWith("@/")) return path.join(SRC, specifier.slice(2));
  if (specifier.startsWith(".")) return path.resolve(path.dirname(from), specifier);
  return null;
}

/** Every module specifier a file names: imports, re-exports and `import()` calls. */
function specifiers(file: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      found.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("Canopy's inbox host (#16581)", () => {
  it("is loaded by the Canopy window's root alone, never by a project window", () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThanOrEqual(MIN_FILES_SCANNED);
    const importers = files.filter((file) =>
      specifiers(file).some((specifier) => {
        const target = resolves(file, specifier);
        return target !== null && target.replace(/\.(js|tsx?)$/, "") === INBOX;
      })
    );
    expect(importers.map((file) => path.relative(SRC, file))).toEqual([
      path.relative(SRC, ONLY_HOST),
    ]);
  });
});
