import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { build, type Metafile } from "esbuild";
import { MAIN_EXTERNAL, mainEsmEntryPoints } from "../main-build-entries.mjs";
import { mainBundlePlugins } from "../lib/main-bundle.mjs";
import { collectClosure } from "../first-render-closure-lib.mjs";

// Vue's template compiler picks its development or production build at
// runtime from `process.env.NODE_ENV`, so a Node bundle ships both unless
// scripts/lib/main-bundle.mjs folds the switch. This builds every main entry
// the way a production scripts/build-main.mjs run does, with the same plugins,
// and reads what it emits: one build of each Vue package, and that and Babel's
// parser still only in chunks a dynamic import reaches.
const root = path.resolve(__dirname, "../..");

const ENTRY_POINTS: string[] = mainEsmEntryPoints(root);
const VUE_RESOLVER = "electron/services/elementPicker/worker/resolvers/vue.ts";
const VUE_TEMPLATE = "electron/services/elementPicker/worker/resolvers/vue/template.ts";
const VUE_SWITCHED = ["compiler-core", "compiler-dom", "shared"];

const normalize = (file: string) => file.split(path.sep).join("/");
const isVueCompiler = (file: string) =>
  /\/node_modules\/@vue\/(compiler-core|compiler-dom|shared)\//.test(file);
const isJsParser = (file: string) => file.includes("/node_modules/@babel/parser/");

/** The builds of each switched Vue package an output set carries, wherever the install resolves from. */
function vueBuilds(inputs: string[]): string[] {
  return inputs
    .filter((file) => /\/@vue\/(compiler-core|compiler-dom|shared)\/dist\//.test(file))
    .map((file) => file.slice(file.lastIndexOf("/@vue/") + 1))
    .sort();
}

describe("the production main build's Vue compiler", () => {
  let metafile: Metafile;

  beforeAll(async () => {
    const result = await build({
      absWorkingDir: root,
      bundle: true,
      minify: true,
      platform: "node",
      target: "node22",
      external: MAIN_EXTERNAL,
      write: false,
      metafile: true,
      logLevel: "silent",
      define: {
        "process.env.SENTRY_DSN": JSON.stringify(""),
        __DAINTREE_REMOTE_HOSTS__: "true",
        __DAINTREE_REMOTE_HOST_ROLE__: "true",
        __DAINTREE_BUILD_COMMIT__: JSON.stringify("test"),
      },
      entryPoints: ENTRY_POINTS,
      format: "esm",
      splitting: true,
      outdir: "dist-electron",
      outbase: ".",
      chunkNames: "electron/chunks/[name]-[hash]",
      // Vitest runs with NODE_ENV=development, so production is named here.
      plugins: mainBundlePlugins({ isProd: true }),
    });
    metafile = result.metafile;
  }, 180_000);

  /** Outputs that carry bytes from a matching input, with how many. */
  function outputsCarrying(match: (file: string) => boolean): Map<string, number> {
    const carriers = new Map<string, number>();
    for (const [output, meta] of Object.entries(metafile.outputs)) {
      let bytes = 0;
      for (const [input, contribution] of Object.entries(meta.inputs)) {
        if (match(`/${normalize(input)}`)) bytes += contribution.bytesInOutput;
      }
      if (bytes > 0) carriers.set(output, bytes);
    }
    return carriers;
  }

  /** Every output reachable from the configured entries, through static imports alone or dynamic ones too. */
  function reachableOutputs(followDynamic: boolean): Set<string> {
    const entries = new Set(ENTRY_POINTS);
    const seeds = Object.entries(metafile.outputs)
      // A dynamic import's target is an entry of its own in a split build; only the configured ones seed.
      .filter(([, meta]) => meta.entryPoint && entries.has(normalize(meta.entryPoint)))
      .map(([output]) => output);
    expect(seeds).toHaveLength(ENTRY_POINTS.length);

    const edges = (meta: Metafile["outputs"][string], kind: string) =>
      meta.imports.filter((edge) => !edge.external && edge.kind === kind).map((edge) => edge.path);
    return collectClosure(seeds, {
      getNode: (output: string) => {
        const meta = metafile.outputs[output];
        if (!meta) throw new Error(`An import names ${output}, which the build did not emit`);
        return meta;
      },
      getStaticImports: (meta: Metafile["outputs"][string]) => edges(meta, "import-statement"),
      getDynamicImports: (meta: Metafile["outputs"][string]) => edges(meta, "dynamic-import"),
      followDynamic,
    });
  }

  it("bundles the registered Vue resolver and its template parser", () => {
    const inputs = Object.keys(metafile.inputs).map(normalize);
    expect(inputs).toContain(VUE_RESOLVER);
    expect(inputs).toContain(VUE_TEMPLATE);
  });

  it("carries only the production build of each Vue compiler package, nested ones included", () => {
    const inputs = Object.keys(metafile.inputs).map((file) => `/${normalize(file)}`);
    expect(vueBuilds(inputs)).toEqual(
      VUE_SWITCHED.map((pkg) => `@vue/${pkg}/dist/${pkg}.cjs.prod.js`)
    );
    // Parsed is not shipped: each production build has to reach an output.
    for (const pkg of VUE_SWITCHED) {
      expect(
        outputsCarrying((file) => file.endsWith(`/@vue/${pkg}/dist/${pkg}.cjs.prod.js`)).size,
        pkg
      ).toBeGreaterThan(0);
    }
  });

  it("loads the Vue compiler and Babel's parser only through a dynamic import", () => {
    const vue = outputsCarrying(isVueCompiler);
    const babel = outputsCarrying(isJsParser);
    expect(vue.size).toBeGreaterThan(0);
    expect(babel.size).toBeGreaterThan(0);

    const eager = reachableOutputs(false);
    expect([...vue.keys()].filter((output) => eager.has(output))).toEqual([]);
    expect([...babel.keys()].filter((output) => eager.has(output))).toEqual([]);

    // Not a vacuous pass: each is still reachable once dynamic imports are followed.
    const everything = reachableOutputs(true);
    expect([...vue.keys(), ...babel.keys()].filter((output) => !everything.has(output))).toEqual(
      []
    );

    for (const [output, vueBytes] of vue) {
      process.stdout.write(
        `[vue-compiler-bundle] ${output}: ${metafile.outputs[output].bytes} bytes, ${vueBytes} from Vue's compiler\n`
      );
    }
  });
});
