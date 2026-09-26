import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// The built-in scenes are written against `@daintreehq/tour`'s public surface
// alone, which is the guarantee a plugin's tour can do anything Daintree's
// does. Everything a scene imports — type imports included — has to be another
// scene, React, Lucide, or a public entry of the package. The package's own
// boundary is checked in `packages/tour`, so edges into it are allowed but not
// followed. What the host hands the scenes (its agents, glyphs and shortcuts)
// arrives through the kit's contexts, from `TourDialog.tsx`.

const TOUR_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCENES_DIR = path.join(TOUR_DIR, "scenes");

const ROOTS = fs
  .readdirSync(SCENES_DIR)
  .filter((name) => /\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name))
  .map((name) => path.join(SCENES_DIR, name));

/** The package's public entries; a boundary, not walked. */
const PUBLIC_ENTRIES = new Set([
  "@daintreehq/tour",
  "@daintreehq/tour/react",
  "@daintreehq/tour/kit",
  "@daintreehq/tour/mock-app",
]);

const PACKAGES = new Set(["react", "lucide-react"]);

/** Stands in for a module reference no scanner can resolve, e.g. `import(\`@/${x}\`)`. */
const DYNAMIC = "<non-literal module reference>";

function specifiers(source: string, fileName: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      found.push(node.argument.literal.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const expr = node.moduleReference.expression;
      found.push(ts.isStringLiteralLike(expr) ? expr.text : DYNAMIC);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const arg = node.arguments[0];
      found.push(arg && ts.isStringLiteralLike(arg) ? arg.text : DYNAMIC);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function resolveRelative(specifier: string, from: string): string | null {
  const base = path.resolve(path.dirname(from), specifier);
  return (
    ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]
      .map((ext) => base + ext)
      .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null
  );
}

/** Offending `file -> specifier` edges across the scenes' whole import closure. */
function violations(): { reached: Set<string>; offenders: string[] } {
  const visited = new Set<string>();
  const reached = new Set<string>();
  const offenders: string[] = [];
  const pending = [...ROOTS];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const rel = path.relative(TOUR_DIR, file);
    for (const specifier of specifiers(fs.readFileSync(file, "utf8"), file)) {
      if (specifier.startsWith(".")) {
        const resolved = resolveRelative(specifier, file);
        if (resolved && ROOTS.includes(resolved)) pending.push(resolved);
        else offenders.push(`${rel} -> ${specifier}`);
      } else if (PUBLIC_ENTRIES.has(specifier)) {
        reached.add(specifier);
      } else if (!PACKAGES.has(specifier)) {
        offenders.push(`${rel} -> ${specifier}`);
      }
    }
  }
  return { reached, offenders };
}

describe("built-in scene isolation", () => {
  it("finds the scenes", () => {
    const names = ROOTS.map((file) => path.relative(TOUR_DIR, file).split(path.sep).join("/"));
    expect(names).toEqual(
      expect.arrayContaining(["scenes/WelcomeScene.tsx", "scenes/PaletteScene.tsx"])
    );
    expect(names.length).toBeGreaterThanOrEqual(14);
  });

  it("reads every kind of module reference", () => {
    const source = [
      'import a from "@/a";',
      'import type { B } from "@shared/b";',
      'export { c } from "./c";',
      'type D = import("@/d").D;',
      'const e = import("@/e");',
      'const f = require("@/f");',
      'import g = require("@/g");',
      "const h = import(`@/${name}`);",
      "const i = require(name);",
    ].join("\n");
    expect(specifiers(source, "fixture.ts")).toEqual([
      "@/a",
      "@shared/b",
      "./c",
      "@/d",
      "@/e",
      "@/f",
      "@/g",
      DYNAMIC,
      DYNAMIC,
    ]);
  });

  it("imports nothing from the app", () => {
    const { reached, offenders } = violations();
    expect(offenders).toEqual([]);
    // The walk really read the scenes' imports: they draw with both halves of the kit.
    expect([...reached]).toEqual(
      expect.arrayContaining(["@daintreehq/tour/kit", "@daintreehq/tour/mock-app"])
    );
  });
});
