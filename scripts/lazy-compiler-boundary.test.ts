import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  ELEMENT_PICKER_FRAMEWORK_PATTERNS,
  scanForbiddenModules,
  walkEagerGraph,
} from "./import-budget-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PICKER = "src/panels/dev-preview/element-picker/";
const ENTRY = `${PICKER}elementPickerTool.ts`;
const BUTTON = `${PICKER}ElementPickerButton.tsx`;
const TOOL_ID = `${PICKER}toolId.ts`;

/**
 * Every dev preview's toolbar imports the Element Picker's tool definition, so
 * its static import closure runs for every user on every project view, whether
 * or not anyone ever switches the picker on. It is kept to the definition, the
 * toolbar button and the tool's id on purpose.
 *
 * Nothing else pins that. Reading the source only proves how the imports are
 * spelled, not what they drag in — a re-export, a value import that used to be
 * type-only, or a host helper that quietly grew a zod dependency would widen
 * this closure with no symptom. So this builds the real entry and walks
 * esbuild's own graph, which stops at `dynamic-import` edges: exactly the
 * boundary being asserted.
 *
 * Host `@/…` imports are resolved rather than externalised, because the cost of
 * an eager import is whatever it transitively pulls in, and externalising the
 * host would hide precisely that. React and the icon package stay external:
 * they are in the renderer's shared vendor chunk either way.
 *
 * This is an esbuild graph, not Vite's. The two agree on resolution here, but
 * esbuild leaves `import.meta.glob` alone where Vite expands it into static
 * imports, so eager plugin sources are separately checked for that spelling.
 */

// Deliberately NOT external: every module named here must be visible in the
// build, or its absence from the eager set would mean nothing.
const LAZY_ONLY = [
  {
    label: "ElementPickerSurfaces",
    test: (file: string) => file.includes("ElementPickerSurfaces"),
  },
  { label: "inspectorController", test: (file: string) => file.includes("inspectorController") },
  {
    label: "resolver schemas",
    test: (file: string) => file.endsWith("shared/elementPicker/resolver.ts"),
  },
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

describe.each(MODES)("the Element Picker's eager renderer entry (%s)", (mode) => {
  it("defines its tool without reaching the surfaces, the controller or zod", async () => {
    const { metafile } = await buildRendererEntry(mode);
    const eager = [...walkEagerGraph(metafile, ENTRY)];

    // The whole picker-side allowance, stated as a set rather than a ceiling:
    // the definition, the button and the id. A fourth eager picker file is a
    // decision, not a refactor, and should have to be argued for here.
    expect(eager.filter((file) => file.includes(PICKER)).sort()).toEqual(
      [BUTTON, ENTRY, TOOL_ID].sort()
    );

    // Over the whole eager closure, host modules included: an eager import is
    // only as cheap as everything it reaches.
    expect(scanForbiddenModules(eager)).toEqual([]);
    expect(scanForbiddenModules(eager, LAZY_ONLY)).toEqual([]);

    // Esbuild passes `import.meta.glob` through untouched, so the graph above
    // cannot see one. Vite turns an eager glob into static imports.
    for (const file of eager.filter((candidate) => candidate.includes(PICKER))) {
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

  it("keeps the Svelte compiler and the source model out of the picker's renderer entirely", async () => {
    const { metafile } = await buildRendererEntry(mode);

    // Stronger than the eager claim on purpose: the compiler and the source
    // model belong to the main process. Reaching them from any renderer chunk
    // of the picker, lazy or not, means a module landed on the wrong side.
    const reachable = Object.keys(metafile.inputs);
    expect(scanForbiddenModules(reachable)).toEqual([]);
    // Nor any parser or map decoder a resolver reads source with: the renderer
    // shows what the host concluded and never reads source itself.
    expect(scanForbiddenModules(reachable, ELEMENT_PICKER_FRAMEWORK_PATTERNS)).toEqual([]);
    // Nor the picker host's project adapters, which read the user's tree with
    // main's file authority: the renderer gets the route matcher from shared/.
    expect(reachable.filter((file) => file.startsWith("electron/services/elementPicker/"))).toEqual(
      []
    );
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
