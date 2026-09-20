import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `builtinPluginRenderers.ts` eagerly globs every built-in's
 * `renderer/index.ts(x)`, so whatever an entry reaches by *static* import ships
 * to every user — including users who never enable that plugin. This ratchets
 * the half of that graph a plugin owns: its own files.
 *
 * Scoped to plugin-local files deliberately. Host modules (`@/…`, `@shared/…`)
 * are a cut, not an edge, because every entry legitimately imports the registry
 * it registers into, and those reach most of the renderer — zod included, via
 * `shared/types/plugin.ts` and `ActionService`. A whole-graph rule flags all
 * four entries on day one, says nothing about the thing worth preventing, and
 * would ban the host-owned utilities entries are supposed to use.
 *
 * A dynamic `import()` is also a cut: deferring a heavy module behind one is
 * the fix this guard protects, not a violation of it. `import type` is erased
 * before a bundler sees it and is likewise not an edge.
 *
 * Scope: a source scan, not a bundler trace — the same trade
 * `builtinViewRegistrations.test.ts` documents. It proves what is written, not
 * what rolldown emits, and a specifier assembled at runtime is outside what a
 * regex can see. `markdown-editor` keeps a stricter local version of this check
 * in `renderer/__tests__/eagerGraph.test.ts`; the two walkers are deliberately
 * independent, so a plugin's own test never depends on host test internals.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILTIN_PLUGINS_DIR = resolve(HERE, "../../../plugins/builtin");

/** Packages a built-in's own eager files must not pull in. */
const DENIED = [/^zod(\/|$)/];

/** Comments first: an import quoted inside one is not an edge. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

/**
 * Every static specifier: `from "x"`, a side-effect `import "x"` and
 * `export … from "x"`. Matched across newlines, because a multi-line
 * `import { … } from "x"` is the common shape here and a newline-blind pattern
 * misses it silently, reporting a false clean.
 */
function staticSpecifiers(source: string): string[] {
  const body = stripComments(source);
  const out: string[] = [];
  for (const match of body.matchAll(
    /(?:^|[\n;])\s*(?:import|export)\b(?!\s+type\b)([^;]*?)from\s*["']([^"']+)["']/g
  )) {
    if (match[2]) out.push(match[2]);
  }
  for (const match of body.matchAll(/(?:^|[\n;])\s*import\s*["']([^"']+)["']/g)) {
    if (match[1]) out.push(match[1]);
  }
  return out;
}

/** Resolve a relative specifier to a real file, tolerating the repo's `.js` suffixes. */
function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier.replace(/\.js$/, ""));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Posix separators, so a failure reads the way the repo does on every platform. */
const posix = (path: string) => path.split(sep).join("/");

/** Bare specifiers reached from the entry through plugin-local files only. */
function eagerBareSpecifiers(entry: string, pluginRoot: string): Map<string, string[]> {
  const bare = new Map<string, string[]>();
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined) break;
    if (seen.has(file)) continue;
    seen.add(file);
    const specifiers = staticSpecifiers(readFileSync(file, "utf8"));
    bare.set(
      file,
      specifiers.filter((specifier) => !specifier.startsWith("."))
    );
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) continue;
      const resolved = resolveRelative(file, specifier);
      // An unresolvable relative import is a broken edge, not a silent pass.
      expect(resolved, `unresolvable import ${specifier} from ${posix(file)}`).not.toBeNull();
      if (resolved !== null && resolved.startsWith(pluginRoot + sep)) queue.push(resolved);
    }
  }
  return bare;
}

function builtinEntries(): Array<{ name: string; entry: string; root: string }> {
  return readdirSync(BUILTIN_PLUGINS_DIR, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .flatMap((item) => {
      const root = join(BUILTIN_PLUGINS_DIR, item.name);
      for (const ext of ["index.tsx", "index.ts"]) {
        const entry = join(root, "renderer", ext);
        if (existsSync(entry)) return [{ name: item.name, entry, root }];
      }
      return [];
    });
}

describe("built-in renderer entries keep heavy packages out of their eager graph", () => {
  const entries = builtinEntries();

  it("finds the built-in renderer entries", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries)(
    "$name reaches no denied package from its own eager files",
    ({ entry, root }) => {
      const offenders: string[] = [];
      for (const [file, specifiers] of eagerBareSpecifiers(entry, root)) {
        for (const specifier of specifiers) {
          if (DENIED.some((deny) => deny.test(specifier))) {
            offenders.push(`${posix(relative(BUILTIN_PLUGINS_DIR, file))} imports ${specifier}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    }
  );
});
