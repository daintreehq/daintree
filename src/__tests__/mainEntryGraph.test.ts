import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseStaticImports,
  posix,
  resolveRelative,
} from "../../scripts/lib/static-import-graph.mjs";
import { PROJECT_SHELL_SOURCE } from "@shared/config/projectShell";

/**
 * `src/main.tsx` is the renderer entry for every window role, so whatever it
 * reaches by static import evaluates in a plugin surface host and the Canopy
 * window as well as a project view (#17030). The project-only bootstrap lives
 * in the project shell, which the entry loads for a project view alone.
 *
 * The walk follows the source graph the dev server evaluates: `@/` and
 * `@shared/` aliases included, `import()` never, type-only imports never. A
 * production build can prune further through the `sideEffects` allowlist, so a
 * module this walk never reaches is never evaluated in either.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const SRC = join(REPO, "src");
const SHARED = join(REPO, "shared");

const PROJECT_ONLY = [
  "src/panels/registry.tsx",
  "src/store/rendererStoreOrchestrator.ts",
  "src/contexts/WorktreeStoreContext.tsx",
  PROJECT_SHELL_SOURCE,
];

function resolveSpecifier(fromFile: string, specifier: string): string | false | null {
  // The one package alias vite.config.ts points into the app source; the
  // others resolve into `packages/`, which never imports the app.
  if (specifier === "@daintreehq/plugin-ui") return resolveRelative(join(SRC, "_"), "./pluginUi");
  if (specifier.startsWith("@/")) return resolveRelative(join(SRC, "_"), `./${specifier.slice(2)}`);
  if (specifier.startsWith("@shared/")) {
    return resolveRelative(join(SHARED, "_"), `./${specifier.slice("@shared/".length)}`);
  }
  if (specifier.startsWith(".")) return resolveRelative(fromFile, specifier);
  return false;
}

function eagerClosure(entry: string): { files: Set<string>; problems: string[] } {
  const files = new Set<string>();
  const problems: string[] = [];
  const queue = [join(REPO, entry)];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (files.has(file)) continue;
    files.add(file);
    if (!/\.(ts|tsx|mts|cts)$/.test(file)) continue;
    const { specifiers, parseErrors } = parseStaticImports(readFileSync(file, "utf8"), file);
    for (const error of parseErrors) problems.push(`${posix(relative(REPO, file))}: ${error}`);
    for (const specifier of specifiers) {
      const resolved = resolveSpecifier(file, specifier);
      if (resolved === false) continue;
      if (resolved === null) {
        problems.push(`${posix(relative(REPO, file))} imports ${specifier}, which doesn't resolve`);
        continue;
      }
      queue.push(resolved);
    }
  }
  return {
    files: new Set([...files].map((file) => posix(relative(REPO, file)))),
    problems,
  };
}

describe("window roles evaluate only their own bootstrap", () => {
  it.each([
    "src/main.tsx",
    "src/surfaceHost/SurfaceHostRoot.tsx",
    "src/canopyWindow/CanopyWindowRoot.tsx",
  ])("%s reaches no project-only module", (entry) => {
    const { files, problems } = eagerClosure(entry);
    expect(problems).toEqual([]);
    expect(PROJECT_ONLY.filter((file) => files.has(file))).toEqual([]);
  });

  it("follows the package alias that points into the app source", () => {
    expect(posix(relative(REPO, String(resolveSpecifier(SRC, "@daintreehq/plugin-ui"))))).toBe(
      "src/pluginUi/index.ts"
    );
  });

  it("the project shell reaches every project-only module", () => {
    // Proves the walk follows aliases far enough to see these modules at all,
    // so the assertions above cannot pass by walking blind.
    const { files, problems } = eagerClosure(PROJECT_SHELL_SOURCE);
    expect(problems).toEqual([]);
    expect(PROJECT_ONLY.filter((file) => !files.has(file))).toEqual([]);
  });
});
