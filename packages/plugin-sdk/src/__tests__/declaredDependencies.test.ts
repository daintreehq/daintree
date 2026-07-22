import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const sdkDir = path.resolve(here, "../..");

/** Every `from "..."` / `import("...")` specifier in a source file. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  // Static `import ... from "x"` and `export ... from "x"`, plus bare
  // `import "x"` side-effect imports and dynamic `import("x")`.
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s+["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

/**
 * The npm package a specifier resolves to, or null when it isn't a package at
 * all (relative path, Node builtin, absolute). Scoped names keep two segments.
 */
function packageName(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return null;
  if (specifier.startsWith("node:")) return null;
  const segments = specifier.split("/");
  const name = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
  return name || null;
}

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      files.push(...(await sourceFiles(full)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Guards the invariant behind #11296: anything the SDK imports from an npm
 * package must be declared, because tsup externalizes exactly the declared
 * `dependencies` + `peerDependencies` and silently *inlines* everything else.
 * React was undeclared, so the whole runtime got bundled into `dist/react.js`
 * and panels shipped a second React copy.
 *
 * Scope is deliberately narrow: direct imports in this package's own `.ts`
 * sources, matched by regex rather than parsed. It's the fast, readable half of
 * the guard and it names the offending file. The exhaustive half — anything
 * bundled transitively, including through the `shared/` code the entries
 * re-export — is asserted against the real build's esbuild metafile in
 * `reactExternal.test.ts`, which needs no parser and cannot be fooled.
 */
describe("@daintreehq/plugin-sdk — every imported package is declared", () => {
  it("imports no npm package that is missing from dependencies or peerDependencies", async () => {
    const manifest = JSON.parse(
      await fs.readFile(path.join(sdkDir, "package.json"), "utf8")
    ) as Record<string, Record<string, string> | undefined>;
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);

    const files = await sourceFiles(path.join(sdkDir, "src"));
    expect(files.length).toBeGreaterThan(0);

    const undeclared = new Map<string, string[]>();
    for (const file of files) {
      const source = await fs.readFile(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        const pkg = packageName(specifier);
        if (!pkg || declared.has(pkg)) continue;
        const rel = path.relative(sdkDir, file);
        undeclared.set(pkg, [...(undeclared.get(pkg) ?? []), rel]);
      }
    }

    expect(
      Object.fromEntries(undeclared),
      "undeclared packages would be bundled into the SDK output"
    ).toEqual({});
  });
});
