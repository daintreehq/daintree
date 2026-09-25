import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// The mockup kit is headed for `@daintreehq/tour` and plugin scenes (#12764),
// so it must draw only from what it is handed. Everything it imports — type
// imports included — has to stay inside the kit, reach the tour runtime its
// timeline hooks read, or name a short list of packages. The runtime is the
// engine #12764 extracts and is checked there, so edges into it are allowed
// but not followed. The app's own picture of itself lives in
// `daintreeMockKit.ts`, outside this boundary.

const TOUR_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOCKUP_DIR = path.join(TOUR_DIR, "mockup");

function kitSources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") kitSources(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const ROOTS = [...kitSources(MOCKUP_DIR), path.join(TOUR_DIR, "scenes", "sceneParts.tsx")];

/** The player runtime the kit's timeline hooks read; a boundary, not walked. */
const RUNTIME = new Set(["@daintreehq/tour", "@daintreehq/tour/react"]);

const PACKAGES = new Set(["react", "lucide-react", "clsx", "tailwind-merge"]);

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

/** Offending `file -> specifier` edges across the kit's whole import closure. */
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
      } else if (RUNTIME.has(specifier)) {
        reached.add(specifier);
      } else if (!PACKAGES.has(specifier)) {
        offenders.push(`${rel} -> ${specifier}`);
      }
    }
  }
  return { reached, offenders };
}

describe("mockup kit isolation", () => {
  it("finds the kit's sources", () => {
    const names = ROOTS.map((file) => path.relative(TOUR_DIR, file));
    expect(names).toEqual(
      expect.arrayContaining([
        "mockup/TourMock.tsx",
        "mockup/MockApp.tsx",
        "mockup/MockKitContext.ts",
        "mockup/MockCIGlyph.tsx",
        "scenes/sceneParts.tsx",
      ])
    );
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
    // The walk really followed the kit's edges: its timeline hooks come from the runtime.
    expect([...reached]).toContain("@daintreehq/tour/react");
  });
});
