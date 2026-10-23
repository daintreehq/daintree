import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// The terminal instance service loads on a view's first terminal (#14267). A
// static value import from any other source file — the accessor and the rest
// of src/services/terminal/ included, since boot imports them — puts the
// 4,800-line module, and the ~50 only it pulls in, back on every project
// view's boot closure. Everything goes through terminalInstanceServiceAccessor;
// type-only imports and dynamic `import()` are the allowed shapes. Tests,
// mocks and benches are exempt: they import the real module on purpose.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../../..");
const SRC_ROOT = path.join(REPO_ROOT, "src");
const BARREL = path.join(SRC_ROOT, "services/TerminalInstanceService");
const SERVICE = path.join(SRC_ROOT, "services/terminal/TerminalInstanceService");
const TARGETS = new Set([BARREL, SERVICE]);

const SOURCE_FILE = /\.tsx?$/;
const EXEMPT_FILE = /\.(test|spec|bench)\.tsx?$/;
const EXEMPT_DIRS = new Set(["node_modules", "__tests__", "__mocks__", "__bench__"]);
const STRIPPED_EXTENSION = /\.(tsx?|jsx?|mjs|cjs)$/;

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXEMPT_DIRS.has(entry.name)) sourceFiles(full, found);
    } else if (
      SOURCE_FILE.test(entry.name) &&
      !entry.name.endsWith(".d.ts") &&
      !EXEMPT_FILE.test(entry.name) &&
      // The service itself, and the barrel that is its one re-export and is
      // only ever imported dynamically or for types.
      !TARGETS.has(full.replace(STRIPPED_EXTENSION, ""))
    ) {
      found.push(full);
    }
  }
  return found;
}

function resolveSpecifier(fromFile: string, rawSpecifier: string): string | null {
  const specifier = rawSpecifier.replace(/[?#].*$/, "");
  let resolved: string;
  if (specifier.startsWith(".")) resolved = path.resolve(path.dirname(fromFile), specifier);
  else if (specifier.startsWith("@/")) resolved = path.resolve(SRC_ROOT, specifier.slice(2));
  else if (specifier.startsWith("/")) resolved = path.resolve(REPO_ROOT, specifier.slice(1));
  else return null;
  return resolved.replace(STRIPPED_EXTENSION, "");
}

// A named list whose every element is `type`-marked is erased; an empty one
// (`import {} from "x"`) still loads the module.
function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name) return false;
  const bindings = clause.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) return false;
  return bindings.elements.length > 0 && bindings.elements.every((el) => el.isTypeOnly);
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  if (!clause || !ts.isNamedExports(clause)) return false;
  return clause.elements.length > 0 && clause.elements.every((el) => el.isTypeOnly);
}

function staticServiceImports(fileName: string, sourceText: string): string[] {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const check = (node: ts.Node, moduleSpecifier: ts.Expression, typeOnly: boolean) => {
    if (typeOnly || !ts.isStringLiteral(moduleSpecifier)) return;
    const resolved = resolveSpecifier(fileName, moduleSpecifier.text);
    if (resolved === null || !TARGETS.has(resolved)) return;
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    found.push(`${path.relative(REPO_ROOT, fileName)}:${line} (${moduleSpecifier.text})`);
  };
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement)) {
      check(statement, statement.moduleSpecifier, isTypeOnlyImport(statement));
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      check(statement, statement.moduleSpecifier, isTypeOnlyExport(statement));
    } else if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference)
    ) {
      check(statement, statement.moduleReference.expression, statement.isTypeOnly);
    }
  }
  return found;
}

describe("terminal instance service imports", () => {
  it("has no static value import from any other source file", () => {
    const violations = sourceFiles(SRC_ROOT).flatMap((file) =>
      staticServiceImports(file, fs.readFileSync(file, "utf8"))
    );
    expect(violations).toEqual([]);
  });

  it("tells value imports from the allowed shapes", () => {
    const file = path.join(SRC_ROOT, "components/Example/Example.tsx");
    const scan = (source: string) => staticServiceImports(file, source);

    expect(
      scan('import { createTerminalPaintPlane } from "@/services/TerminalInstanceService";')
    ).toHaveLength(1);
    expect(scan('import "@/services/terminal/TerminalInstanceService";')).toHaveLength(1);
    expect(scan('import {} from "../../services/TerminalInstanceService";')).toHaveLength(1);
    expect(scan('import { type A, b } from "@/services/TerminalInstanceService";')).toHaveLength(1);
    expect(
      scan('export { createTerminalPaintPlane } from "@/services/TerminalInstanceService";')
    ).toHaveLength(1);

    expect(
      scan('import type { TerminalPaintPlane } from "@/services/TerminalInstanceService";')
    ).toEqual([]);
    expect(
      scan('import { type TerminalPaintPlane } from "../../services/TerminalInstanceService";')
    ).toEqual([]);
    expect(
      scan('export type { TerminalPaintPlane } from "@/services/TerminalInstanceService";')
    ).toEqual([]);
    expect(scan('const m = () => import("@/services/TerminalInstanceService");')).toEqual([]);
    expect(
      scan('import { peek } from "@/services/terminal/terminalInstanceServiceAccessor";')
    ).toEqual([]);
  });
});
