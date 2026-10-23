import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// `definitions/*.impl.ts` modules hold action run bodies that load on first
// dispatch, so they stay off the boot closure. A static value import from any
// source file silently puts one back on it, and the only other signal is a
// budget script that isn't CI-gated. Type-only imports and dynamic `import()`
// are the two allowed shapes. Test files are exempt: they import and mock the
// run bodies on purpose.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../../..");
const SRC_ROOT = path.join(REPO_ROOT, "src");
const DEFINITIONS_DIR = path.join(SRC_ROOT, "services/actions/definitions");

const IMPL_FILE = /\.impl\.tsx?$/;
const SOURCE_FILE = /\.tsx?$/;
const TEST_FILE = /\.(test|spec)\.tsx?$/;
const EXEMPT_DIRS = new Set(["node_modules", "__tests__", "__mocks__"]);
const STRIPPED_EXTENSION = /\.(tsx?|jsx?|mjs|cjs)$/;

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXEMPT_DIRS.has(entry.name)) sourceFiles(full, found);
    } else if (
      SOURCE_FILE.test(entry.name) &&
      !entry.name.endsWith(".d.ts") &&
      !TEST_FILE.test(entry.name)
    ) {
      found.push(full);
    }
  }
  return found;
}

/** Each `.impl` module's absolute path without its extension. */
function implTargets(): Set<string> {
  return new Set(
    fs
      .readdirSync(DEFINITIONS_DIR)
      .filter((name) => IMPL_FILE.test(name))
      .map((name) => path.join(DEFINITIONS_DIR, name).replace(STRIPPED_EXTENSION, ""))
  );
}

function resolveSpecifier(fromFile: string, specifier: string): string | null {
  let resolved: string;
  if (specifier.startsWith(".")) resolved = path.resolve(path.dirname(fromFile), specifier);
  else if (specifier.startsWith("@/")) resolved = path.join(SRC_ROOT, specifier.slice(2));
  else return null;
  return resolved.replace(STRIPPED_EXTENSION, "");
}

// Without `verbatimModuleSyntax`, a named list whose every element is
// `type`-marked is erased, so it never loads the module. An empty list is not
// erased: `import {} from "x"` still loads it.
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

type Violation = { file: string; line: number; specifier: string };

function findStaticImplImports(
  fileName: string,
  sourceText: string,
  targets: ReadonlySet<string>
): Violation[] {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, kind);
  const violations: Violation[] = [];

  const check = (node: ts.Node, moduleSpecifier: ts.Expression, typeOnly: boolean) => {
    if (typeOnly || !ts.isStringLiteral(moduleSpecifier)) return;
    const resolved = resolveSpecifier(fileName, moduleSpecifier.text);
    if (resolved === null || !targets.has(resolved)) return;
    violations.push({
      file: path.relative(REPO_ROOT, fileName),
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      specifier: moduleSpecifier.text,
    });
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
  return violations;
}

describe("lazy action .impl modules", () => {
  const targets = implTargets();

  it("keeps compiler settings that erase inline type-only imports", () => {
    const { config, error } = ts.readConfigFile(
      path.join(REPO_ROOT, "tsconfig.json"),
      ts.sys.readFile
    );
    expect(error).toBeUndefined();
    // With verbatimModuleSyntax on, `import { type X } from "./x.impl"` keeps a
    // bare `import "./x.impl"` and the matcher's type-only rule is wrong.
    expect(config.compilerOptions?.verbatimModuleSyntax).not.toBe(true);
  });

  it("finds the .impl modules it guards", () => {
    expect(targets.size).toBeGreaterThan(0);
    for (const target of targets) {
      expect(path.dirname(target)).toBe(DEFINITIONS_DIR);
    }
  });

  it("no non-test source under src/ statically imports an .impl module", () => {
    const files = sourceFiles(SRC_ROOT);
    // A collapse here means the walk went blind, not that the tree is clean.
    expect(files.length).toBeGreaterThan(1000);
    expect(files.some((f) => f.includes(`${path.sep}__tests__${path.sep}`))).toBe(false);

    const violations: Violation[] = [];
    let typeOnlyReferences = 0;
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      if (!text.includes(".impl")) continue;
      violations.push(...findStaticImplImports(file, text, targets));
      if (/import type [^;]*\.impl"/.test(text)) typeOnlyReferences++;
    }

    // The metadata modules reference their run bodies by type, so the scan
    // must reach them for the guard to mean anything.
    expect(typeOnlyReferences).toBeGreaterThan(0);
    expect(
      violations.map((v) => `${v.file}:${v.line} imports "${v.specifier}"`),
      "Load .impl modules with `await import()`, or import them with `import type`"
    ).toEqual([]);
  });

  describe("matcher", () => {
    const fromFile = path.join(DEFINITIONS_DIR, "fixtureActions.ts");
    const fixtureTargets = new Set([path.join(DEFINITIONS_DIR, "gitActions.impl")]);
    const flagged = (source: string, file = fromFile) =>
      findStaticImplImports(file, source, fixtureTargets).map((v) => v.specifier);

    it.each([
      ["named value import", 'import { gitActionRuns } from "./gitActions.impl";'],
      ["default import", 'import runs from "./gitActions.impl";'],
      ["namespace import", 'import * as impl from "./gitActions.impl";'],
      ["side-effect import", 'import "./gitActions.impl";'],
      [
        "mixed type and value",
        'import { type GitActionRunId, gitActionRuns } from "./gitActions.impl";',
      ],
      ["default alongside type", 'import runs, { type GitActionRunId } from "./gitActions.impl";'],
      ["empty named list", 'import {} from "./gitActions.impl";'],
      ["value re-export", 'export { gitActionRuns } from "./gitActions.impl";'],
      ["star re-export", 'export * from "./gitActions.impl";'],
      ["namespace re-export", 'export * as impl from "./gitActions.impl";'],
      ["import-equals require", 'import impl = require("./gitActions.impl");'],
      ["explicit extension", 'import { gitActionRuns } from "./gitActions.impl.ts";'],
      [
        "@/ alias",
        'import { gitActionRuns } from "@/services/actions/definitions/gitActions.impl";',
      ],
      [
        "multiline import",
        'import {\n  gitActionRuns,\n  // a comment\n} from "./gitActions.impl";',
      ],
    ])("flags a %s", (_label, source) => {
      expect(flagged(source)).toHaveLength(1);
    });

    it("flags a relative import from another directory", () => {
      const file = path.join(SRC_ROOT, "components/Fixture/Fixture.tsx");
      const source =
        'import { gitActionRuns } from "../../services/actions/definitions/gitActions.impl";\nexport const A = <T,>(x: T) => <div>{String(x)}</div>;';
      expect(flagged(source, file)).toEqual(["../../services/actions/definitions/gitActions.impl"]);
    });

    it.each([
      ["import type", 'import type { GitActionRunId } from "./gitActions.impl";'],
      ["all-inline type import", 'import { type GitActionRunId } from "./gitActions.impl";'],
      ["type re-export", 'export type { GitActionRunId } from "./gitActions.impl";'],
      ["inline type re-export", 'export { type GitActionRunId } from "./gitActions.impl";'],
      ["type star re-export", 'export type * from "./gitActions.impl";'],
      [
        "dynamic import",
        'export async function run() {\n  const { gitActionRuns } = await import("./gitActions.impl");\n  return gitActionRuns;\n}',
      ],
      ["commented-out import", '// import { gitActionRuns } from "./gitActions.impl";'],
      [
        "import text in a string",
        "const s = 'import { gitActionRuns } from \"./gitActions.impl\"';",
      ],
      ["sibling non-impl module", 'import { registerGitActions } from "./gitActions";'],
      ["package import", 'import { x } from "gitActions.impl";'],
    ])("allows a %s", (_label, source) => {
      expect(flagged(source)).toEqual([]);
    });

    it("matches every discovered .impl module, not a fixed list", () => {
      const futureTargets = new Set([...targets, path.join(DEFINITIONS_DIR, "futureActions.impl")]);
      const source = 'import { futureActionRuns } from "./futureActions.impl";';
      expect(findStaticImplImports(fromFile, source, futureTargets)).toHaveLength(1);
      expect(findStaticImplImports(fromFile, source, targets)).toEqual([]);
    });

    it("exempts test files from the source walk", () => {
      expect(TEST_FILE.test("gitActions.lazyRun.test.ts")).toBe(true);
      expect(TEST_FILE.test("Panel.spec.tsx")).toBe(true);
      expect(TEST_FILE.test("gitActions.impl.ts")).toBe(false);
    });
  });
});
