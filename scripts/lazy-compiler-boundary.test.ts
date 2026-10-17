import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { scanForbiddenModules, walkEagerGraph } from "./import-budget-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAIN_ENTRY = "plugins/builtin/sveltekit-builder/main/index.ts";

/**
 * The compiler is roughly 862 KiB minified and the source model exists to keep
 * it behind an `await import()`. Activation has a five-second window, so a
 * single stray top-level import on this entry's graph would cost that window
 * and slow every launch that loads the plugin — with no symptom but the delay.
 *
 * Source-level "is it written as `import()`" tests do not prove this. What
 * decides it is the bundler's own graph, and the only way to see that graph is
 * to build it, so this builds the real entry with the real externals and walks
 * what esbuild reports. `walkEagerGraph` stops at dynamic-import boundaries,
 * which is exactly the boundary being asserted.
 *
 * It lives beside `check-import-budget.mjs` rather than in the plugin because
 * it asks the same question of the same metafiles, with the same helpers — and
 * because the budget script's own entry is `electron/main.ts`, which cannot
 * reach the plugin's activation graph at all.
 */
describe("the SvelteKit builder's activation path", () => {
  it("reaches neither the Svelte compiler nor the source model eagerly", async () => {
    const result = await build({
      entryPoints: [MAIN_ENTRY],
      bundle: true,
      write: false,
      metafile: true,
      platform: "node",
      target: "node22",
      format: "esm",
      // Mirrors the native-module externals in `scripts/build-main.mjs`. Svelte
      // is deliberately NOT external here: if it were, this test could not see
      // it arrive and would pass for the wrong reason.
      external: ["electron", "@parcel/watcher", "node-pty", "better-sqlite3", "copytree"],
      absWorkingDir: ROOT,
      logLevel: "silent",
    });

    const eager = walkEagerGraph(result.metafile, MAIN_ENTRY);
    expect(eager.size).toBeGreaterThan(0);
    expect(scanForbiddenModules(eager)).toEqual([]);

    // Not a vacuous pass: both families ARE in this build, behind the dynamic
    // boundary. Asserted separately, because the two together would be
    // satisfied by the source model alone — and the source model is exactly
    // what stays when the compiler stops being bundled, which is the way this
    // test would quietly stop testing anything.
    const all = Object.keys(result.metafile.inputs);
    const behind = scanForbiddenModules(all);
    expect(behind.filter((m) => m.label === "Svelte compiler").length).toBeGreaterThan(0);
    expect(behind.filter((m) => m.label === "svelte-source-model").length).toBeGreaterThan(0);
  }, 60_000);
});

const PLUGIN = "plugins/builtin/sveltekit-builder/";
const ENTRY = `${PLUGIN}renderer/index.ts`;
const BUTTON = `${PLUGIN}renderer/SiteBuilderButton.tsx`;

/**
 * `src/registry/builtinPluginRenderers.ts` imports every builtin renderer entry
 * through an eager `import.meta.glob`, with no enabled/disabled gate — so this
 * entry's static import closure runs for every user on every project view,
 * whether or not anyone ever turns the builder on. It is kept to a registration
 * call and a toolbar button on purpose, which is why it hardcodes its ids
 * instead of importing `shared/protocol.ts` and its zod dependency.
 *
 * Nothing else pins that. The renderer budgets do not walk plugin entries, and
 * reading the source only proves how the imports are spelled, not what they
 * drag in — a re-export, a value import that used to be type-only, or a host
 * helper that quietly grew a zod dependency would widen this closure with no
 * symptom. So this builds the real entry and walks esbuild's own graph, which
 * stops at `dynamic-import` edges: exactly the boundary being asserted.
 *
 * Host `@/…` imports are resolved rather than externalised, because the cost of
 * an eager import is whatever it transitively pulls in, and externalising the
 * host would hide precisely that. React and the icon package stay external:
 * they are in the renderer's shared vendor chunk either way.
 *
 * This is an esbuild graph, not Vite's. The two agree on resolution here, but
 * esbuild leaves `import.meta.glob` alone where Vite expands it into static
 * imports, so eager plugin sources are separately checked for that spelling.
 *
 * Sibling of the activation-path check above, which asks the same question of
 * the plugin's main-process entry.
 */

// Deliberately NOT external: every module named here must be visible in the
// build, or its absence from the eager set would mean nothing.
const LAZY_ONLY = [
  { label: "SiteBuilderSurfaces", test: (file: string) => file.includes("SiteBuilderSurfaces") },
  { label: "inspectorController", test: (file: string) => file.includes("inspectorController") },
  { label: "routeMatch", test: (file: string) => file.includes("shared/project/routeMatch") },
  { label: "protocol", test: (file: string) => file.endsWith(`${PLUGIN}shared/protocol.ts`) },
  { label: "zod", test: (file: string) => /(^|\/)node_modules\/zod(\/|$)/.test(file) },
];

// Both modes, because esbuild substitutes `"development"` for
// `process.env.NODE_ENV` by default on the browser platform and then drops the
// dead branch — a compiler import behind a production-only guard would vanish
// before it ever reached the metafile.
const MODES = ["development", "production"] as const;

const cached = new Map<string, ReturnType<typeof runBuild>>();

function runBuild(mode: (typeof MODES)[number]) {
  return build({
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    metafile: true,
    platform: "browser",
    target: "es2022",
    format: "esm",
    jsx: "automatic",
    external: ["react", "react-dom", "react/jsx-runtime", "lucide-react"],
    alias: { "@": path.join(ROOT, "src") },
    define: { "process.env.NODE_ENV": JSON.stringify(mode) },
    conditions: mode === "development" ? ["development"] : [],
    // Assets carry no imports; the graph, not the output, is what is read here.
    loader: { ".css": "empty", ".svg": "empty", ".png": "empty" },
    absWorkingDir: ROOT,
    logLevel: "silent",
  });
}

function buildRendererEntry(mode: (typeof MODES)[number]) {
  const existing = cached.get(mode);
  if (existing) return existing;
  const started = runBuild(mode);
  cached.set(mode, started);
  return started;
}

describe.each(MODES)("the SvelteKit builder's eager renderer entry (%s)", (mode) => {
  it("registers its tool without reaching the builder, the controller or zod", async () => {
    const { metafile } = await buildRendererEntry(mode);
    const eager = [...walkEagerGraph(metafile, ENTRY)];

    // The whole plugin-side allowance, stated as a set rather than a ceiling:
    // the entry and the button. A third eager plugin file is a decision, not a
    // refactor, and should have to be argued for here.
    expect(eager.filter((file) => file.includes(PLUGIN)).sort()).toEqual([BUTTON, ENTRY].sort());

    // Over the whole eager closure, host modules included: an eager import is
    // only as cheap as everything it reaches.
    expect(scanForbiddenModules(eager)).toEqual([]);
    expect(scanForbiddenModules(eager, LAZY_ONLY)).toEqual([]);

    // Esbuild passes `import.meta.glob` through untouched, so the graph above
    // cannot see one. Vite turns an eager glob into static imports.
    for (const file of eager.filter((candidate) => candidate.includes(PLUGIN))) {
      expect(fs.readFileSync(path.join(ROOT, file), "utf8"), file).not.toContain(
        "import.meta.glob"
      );
    }

    // Not a vacuous pass. Each lazy-only module IS in this build, behind the
    // dynamic boundary — asserted one family at a time, because as a group they
    // would be satisfied by whichever one survives a regression, and a matcher
    // that has stopped matching anything is the way this test would quietly
    // stop testing anything.
    const all = Object.keys(metafile.inputs);
    for (const pattern of LAZY_ONLY) {
      expect(all.filter(pattern.test), `${pattern.label} is not in the build at all`).not.toEqual(
        []
      );
    }
  }, 60_000);

  it("keeps the Svelte compiler and the source model out of the plugin's renderer entirely", async () => {
    const { metafile } = await buildRendererEntry(mode);

    // Stronger than the eager claim on purpose: the compiler and the source
    // model belong to the main process. Reaching them from any renderer chunk
    // of this plugin, lazy or not, means a module landed on the wrong side.
    const reachable = Object.keys(metafile.inputs);
    expect(scanForbiddenModules(reachable)).toEqual([]);
  }, 60_000);
});

// The shared patterns match nothing in this build, by design — so prove here
// that they are still capable of matching, rather than trusting an empty result
// from a matcher that may have rotted.
describe("the forbidden-module patterns this file relies on", () => {
  it("still match the paths they were written for", () => {
    expect(
      scanForbiddenModules([
        "node_modules/svelte/src/compiler/index.js",
        "packages/svelte-source-model/src/index.ts",
      ]).map((m) => m.label)
    ).toEqual(["Svelte compiler", "svelte-source-model"]);
  });
});
