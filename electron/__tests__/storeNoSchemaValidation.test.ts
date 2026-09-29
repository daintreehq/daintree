import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * The main bundle stubs out conf's ajv / ajv-formats imports
 * (`scripts/lib/main-bundle.mjs`), so an electron-store constructed with a
 * validator option would throw at startup in production while passing every
 * unit test that runs against the real conf. These pins keep the stub safe.
 */

const ROOT = path.resolve(__dirname, "../..");
const STORE_MODULES = ["electron-store", "conf"];
const VALIDATOR_OPTIONS = ["schema", "migrations", "ajvOptions", "rootSchema"];

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

function where(source: ts.SourceFile, node: ts.Node): string {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${path.relative(ROOT, source.fileName)}:${line + 1}`;
}

function findDeclaration(source: ts.SourceFile, name: string): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function resolveObjectLiteral(
  source: ts.SourceFile,
  expr: ts.Expression
): ts.ObjectLiteralExpression {
  if (ts.isObjectLiteralExpression(expr)) return expr;
  if (
    ts.isAsExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isParenthesizedExpression(expr)
  ) {
    return resolveObjectLiteral(source, expr.expression);
  }
  if (ts.isIdentifier(expr)) {
    const decls = findDeclaration(source, expr.text);
    // A name declared twice could resolve to the wrong scope; refuse rather than guess.
    if (decls.length === 1) {
      const decl = decls[0];
      if (ts.isVariableDeclaration(decl) && decl.initializer) {
        return resolveObjectLiteral(source, decl.initializer);
      }
      if (ts.isParameter(decl)) {
        if (decl.initializer) return resolveObjectLiteral(source, decl.initializer);
        if (decl.type && ts.isTypeQueryNode(decl.type) && ts.isIdentifier(decl.type.exprName)) {
          return resolveObjectLiteral(source, decl.type.exprName);
        }
      }
    }
  }
  throw new Error(
    `${where(source, expr)}: store options must be an object literal (or a uniquely named const/param) this guard can read — got \`${expr.getText(source)}\``
  );
}

function optionKeys(source: ts.SourceFile, literal: ts.ObjectLiteralExpression): string[] {
  const keys: string[] = [];
  for (const prop of literal.properties) {
    if (ts.isSpreadAssignment(prop)) {
      keys.push(...optionKeys(source, resolveObjectLiteral(source, prop.expression)));
    } else if (prop.name && ts.isComputedPropertyName(prop.name)) {
      throw new Error(`${where(source, prop)}: computed store option keys are not allowed`);
    } else if (prop.name) {
      keys.push(prop.name.getText(source).replace(/^["']|["']$/g, ""));
    }
  }
  return keys;
}

interface StoreUsage {
  constructions: ts.NewExpression[];
  unsupported: string[];
}

function isStoreModule(node: ts.Node | undefined): boolean {
  return !!node && ts.isStringLiteralLike(node) && STORE_MODULES.includes(node.text);
}

function storeUsage(source: ts.SourceFile): StoreUsage {
  const bindings = new Set<string>();
  const unsupported: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !isStoreModule(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (clause.name) bindings.add(clause.name.text);
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        if (!element.isTypeOnly) bindings.add(element.name.text);
      }
    } else if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      unsupported.push(`${where(source, statement)}: namespace import of a store module`);
    }
  }
  const constructions: ts.NewExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      bindings.has(node.expression.text)
    ) {
      constructions.push(node);
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      isStoreModule(node.arguments[0])
    ) {
      unsupported.push(`${where(source, node)}: dynamic import/require of a store module`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { constructions, unsupported };
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|tsx|mts|cts)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const usages = ["electron", "shared", "plugins/builtin"]
  .flatMap((dir) => listSourceFiles(path.join(ROOT, dir)))
  .map((file) => ({ file, source: parse(file) }))
  .map(({ file, source }) => ({
    file: path.relative(ROOT, file).split(path.sep).join("/"),
    source,
    ...storeUsage(source),
  }));

describe("electron-store validator options stay unused", () => {
  it("constructs stores only through a plain import in electron/store.ts", () => {
    expect(usages.flatMap((usage) => usage.unsupported)).toEqual([]);
    expect(
      usages.filter((usage) => usage.constructions.length > 0).map((usage) => usage.file)
    ).toEqual(["electron/store.ts"]);
  });

  it("never passes schema, migrations, ajvOptions or rootSchema to a store", () => {
    const { source, constructions } = usages.find((usage) => usage.file === "electron/store.ts")!;

    expect(constructions).toHaveLength(3);
    for (const node of constructions) {
      const arg = node.arguments?.[0];
      if (!arg) throw new Error(`${where(source, node)}: store constructed without options`);
      const keys = optionKeys(source, resolveObjectLiteral(source, arg));
      expect(keys, where(source, node)).toContain("defaults");
      expect(
        keys.filter((key) => VALIDATOR_OPTIONS.includes(key)),
        where(source, node)
      ).toEqual([]);
    }
  });
});
