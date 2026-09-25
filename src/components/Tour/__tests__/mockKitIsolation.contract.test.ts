import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// The mockup kit is headed for `@daintreehq/tour` and plugin scenes (#12764),
// so it must draw only from what it is handed. Everything it reaches — type
// imports included — has to stay inside the kit, the tour runtime it animates
// against, or a short list of packages. The app's own picture of itself lives
// in `daintreeMockKit.ts`, outside this boundary.

const TOUR_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOCKUP_DIR = path.join(TOUR_DIR, "mockup");

const ROOTS = [
  ...fs
    .readdirSync(MOCKUP_DIR)
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => path.join(MOCKUP_DIR, name)),
  path.join(TOUR_DIR, "scenes", "sceneParts.tsx"),
];

/** The player runtime the kit's timeline hooks read; it travels with the kit. */
const RUNTIME = new Set(
  ["useTourPlayer.ts", "TourPlayer.ts", "tourTypes.ts"].map((name) => path.join(TOUR_DIR, name))
);

const PACKAGES = new Set(["react", "lucide-react", "clsx", "tailwind-merge"]);

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
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      found.push(node.arguments[0].text);
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

function isInsideKit(file: string): boolean {
  return ROOTS.includes(file) || path.dirname(file) === MOCKUP_DIR || RUNTIME.has(file);
}

/** Offending `file -> specifier` edges across the kit's whole import closure. */
function violations(): { visited: Set<string>; offenders: string[] } {
  const visited = new Set<string>();
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
        if (resolved && isInsideKit(resolved)) pending.push(resolved);
        else offenders.push(`${rel} -> ${specifier}`);
      } else if (!PACKAGES.has(specifier)) {
        offenders.push(`${rel} -> ${specifier}`);
      }
    }
  }
  return { visited, offenders };
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
    ].join("\n");
    expect(specifiers(source, "fixture.ts")).toEqual([
      "@/a",
      "@shared/b",
      "./c",
      "@/d",
      "@/e",
      "@/f",
    ]);
  });

  it("imports nothing from the app", () => {
    const { visited, offenders } = violations();
    expect(visited.size).toBeGreaterThanOrEqual(ROOTS.length);
    expect(offenders).toEqual([]);
  });
});
