import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, "../..");
const ENTRY = resolve(here, "../index.ts");

/** Comments are stripped first: an import quoted inside one is not an edge. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

/**
 * Every static specifier: `from "x"`, a side-effect `import "x"` and
 * `export … from "x"` alike. `import("x")` is deliberately absent — a dynamic
 * import is its own chunk, which is the whole point of the lazy view.
 */
function staticSpecifiers(source: string): string[] {
  const body = stripComments(source);
  const out: string[] = [];
  for (const match of body.matchAll(
    /(?:^|[\n;])\s*(?:import|export)\b[^;]*?from\s*["']([^"']+)["']/g
  )) {
    if (match[1]) out.push(match[1]);
  }
  for (const match of body.matchAll(/(?:^|[\n;])\s*import\s*["']([^"']+)["']/g)) {
    if (match[1]) out.push(match[1]);
  }
  return out;
}

function resolveLocal(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier.replace(/\.js$/, ""));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`unresolvable import ${specifier} from ${relative(pluginRoot, fromFile)}`);
}

/** Plugin-local files reached statically from the entry, with their bare imports. */
function eagerPluginGraph(): { files: string[]; bare: Map<string, string[]> } {
  const files: string[] = [];
  const bare = new Map<string, string[]>();
  const seen = new Set<string>();
  const queue = [ENTRY];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    files.push(file);
    const specifiers = staticSpecifiers(readFileSync(file, "utf8"));
    bare.set(
      file,
      specifiers.filter((specifier) => !specifier.startsWith("."))
    );
    for (const specifier of specifiers) {
      if (specifier.startsWith(".")) queue.push(resolveLocal(file, specifier));
    }
  }
  return { files, bare };
}

const reachedFiles = () => eagerPluginGraph().files.map((file) => relative(pluginRoot, file));

// The builtin renderer glob imports this entry eagerly for every user, so
// whatever it reaches statically lands in the first-render graph. zod is the
// expensive passenger: `shared/protocol.ts` pulls it in, which is why the
// zod-free half of the contract lives in `shared/ids.ts` (#12323). Host `@/…`
// modules are out of scope: this ratchets the plugin's own files.
describe("eager renderer entry graph", () => {
  it("never reaches zod", () => {
    const offenders = [...eagerPluginGraph().bare]
      .filter(([, specifiers]) => specifiers.some((specifier) => /^zod(\/|$)/.test(specifier)))
      .map(([file]) => relative(pluginRoot, file));
    expect(offenders).toEqual([]);
  });

  it("never reaches shared/protocol", () => {
    expect(reachedFiles()).not.toContain("shared/protocol.ts");
  });

  it("walks the files it is meant to walk", () => {
    expect(reachedFiles()).toContain("renderer/recoverDrafts.ts");
    expect(reachedFiles()).toContain("shared/ids.ts");
  });
});
