import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { scanForbiddenModules, walkEagerGraph } from "./import-budget-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = "plugins/builtin/sveltekit-builder/main/index.ts";

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
      entryPoints: [ENTRY],
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

    const eager = walkEagerGraph(result.metafile, ENTRY);
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
