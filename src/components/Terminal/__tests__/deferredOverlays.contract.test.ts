import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseStaticImports,
  posix,
  resolveRelative,
} from "../../../../scripts/lib/static-import-graph.mjs";

/**
 * Surfaces a restored session never shows, each loaded only once its state is
 * active (#17035): by a gate that keeps whatever must run without them (fleet
 * raw-input registration, the import listeners, artifact detection) and reaches
 * the UI through `import()` alone. One static import anywhere puts the module
 * back in whatever chunk that importer lives in, so this scans every renderer
 * source, not only today's hosts. Tests are left out: they import the UI
 * directly on purpose.
 */
const DEFERRED = [
  "src/components/Decisions/DecisionsInboxDialog.tsx",
  "src/components/Fleet/FleetArmingRibbon.tsx",
  "src/components/Config/ImportConfigDialog.tsx",
  "src/components/Terminal/ContentGridEmptyState.tsx",
  "src/components/Terminal/ArtifactOverlay.tsx",
  "src/components/Terminal/TerminalSearchBar.tsx",
  "src/components/Terminal/UpdateCwdDialog.tsx",
];

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SRC = join(ROOT, "src");

const isTest = (file: string) => /(^|\/)__tests__\/|\.(test|spec|bench)\.tsx?$/.test(file);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.[mc]?[jt]sx?$/.test(entry.name) && !/\.d\.[mc]?ts$/.test(entry.name) ? [full] : [];
  });
}

/** `@/x` is `src/x`; anything else bare is a package and can't be one of these. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (specifier.startsWith("@/")) {
    return resolveRelative(join(SRC, "index.ts"), `./${specifier.slice(2)}`) || null;
  }
  if (specifier.startsWith(".")) return resolveRelative(fromFile, specifier) || null;
  return null;
}

/** The deferred modules `text` (the source of `file`) imports statically. */
function deferredEdges(file: string, text: string): string[] {
  const { specifiers, parseErrors } = parseStaticImports(text, file);
  expect(parseErrors, file).toEqual([]);
  return specifiers.flatMap((specifier) => {
    const target = resolveSpecifier(file, specifier);
    const key = target === null ? null : posix(relative(ROOT, target));
    return key !== null && DEFERRED.includes(key) ? [key] : [];
  });
}

/** Every source file that statically imports a deferred module, keyed by that module. */
function staticImporters(includeTests: boolean): Record<string, string[]> {
  const names = DEFERRED.map((file) => basename(file).replace(/\.tsx$/, ""));
  const found: Record<string, string[]> = Object.fromEntries(DEFERRED.map((file) => [file, []]));
  for (const file of sources(SRC)) {
    const rel = posix(relative(ROOT, file));
    if (!includeTests && isTest(rel)) continue;
    const text = readFileSync(file, "utf8");
    // A specifier that reaches one of these names it; skip parsing the rest.
    if (!names.some((name) => text.includes(name))) continue;
    for (const key of deferredEdges(file, text)) found[key]!.push(rel);
  }
  return found;
}

describe("overlays a restored session never shows (#17035)", () => {
  it("are reached from renderer code only through import()", () => {
    expect(staticImporters(false)).toEqual(Object.fromEntries(DEFERRED.map((file) => [file, []])));
  });

  it("counts aliased imports and re-exports as edges, and type-only or dynamic imports not", () => {
    const host = join(SRC, "components/Layout/AppLayout.tsx");
    const source = [
      'import { FleetArmingRibbon } from "@/components/Fleet/FleetArmingRibbon";',
      'export { ArtifactOverlay } from "../Terminal/ArtifactOverlay";',
      'import type { TerminalSearchTarget } from "@/components/Terminal/TerminalSearchBar";',
      'const later = () => import("@/components/Terminal/UpdateCwdDialog");',
    ].join("\n");

    expect(deferredEdges(host, source)).toEqual([
      "src/components/Fleet/FleetArmingRibbon.tsx",
      "src/components/Terminal/ArtifactOverlay.tsx",
    ]);
  });

  it("would be caught: each one's own suite imports it statically", () => {
    // Not a vacuous pass: the same scan, tests included, sees every module.
    for (const [file, importers] of Object.entries(staticImporters(true))) {
      expect(importers.filter(isTest), file).not.toEqual([]);
    }
  });
});
