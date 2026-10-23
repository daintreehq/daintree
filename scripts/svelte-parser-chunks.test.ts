import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, type BuildOptions, type Metafile } from "esbuild";
import { MAIN_EXTERNAL, mainEsmEntryPoints } from "./main-build-entries.mjs";
import { mainBundleStubsPlugin } from "./lib/main-bundle.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PICKER_HOST_ENTRIES = [
  "electron/services/elementPicker/host-bootstrap.ts",
  "electron/services/elementPicker/host.ts",
];
const BUILDER_ENTRY = "plugins/builtin/sveltekit-builder/main/index.ts";

/** Wherever the install resolves from: a worktree's node_modules can be a link to another checkout's. */
const COMPILER = "node_modules/svelte/src/compiler/";
const isCompiler = (file: string) => file.includes(COMPILER);
const PARSER = `${COMPILER}phases/1-parse/index.js`;

/**
 * The entry module of each pass behind `compile`, `compileModule`, `migrate`,
 * `print` and `preprocess`. Their directories are not forbidden wholesale: a
 * few constants in them really are used by the parser and stay.
 */
const UNUSED_PASSES = [
  "phases/2-analyze/index.js",
  "phases/3-transform/index.js",
  "phases/3-transform/client/transform-client.js",
  "phases/3-transform/server/transform-server.js",
  "migrate/index.js",
  "print/index.js",
  "preprocess/index.js",
].map((file) => `${COMPILER}${file}`);

/** The parser alone measured 496,465 bytes; the whole namespace was 878,500. */
const PARSER_CHUNK_CEILING = 600_000;

/**
 * Both the Element Picker host and the SvelteKit builder parse Svelte through
 * the source model's `loadParse()`, and all they ever call is `parse`. The
 * graph tests beside this one prove the compiler stays behind a dynamic import;
 * they cannot see how much of it ships, because a module tree-shaken to
 * nothing still appears in the input graph. That is decided by the emitted
 * chunks, so this builds the production ESM run the way `build-main.mjs` does
 * — every entry, one splitting run, minified — and reads `metafile.outputs`.
 *
 * The source model resolves to this checkout's `dist/`, which install builds:
 * the package's own bundle is what decides whether `svelte/compiler` sits
 * behind its `import()`, so its source would prove less.
 */
const PRODUCTION: BuildOptions = {
  bundle: true,
  write: false,
  metafile: true,
  minify: true,
  platform: "node",
  target: "node22",
  format: "esm",
  splitting: true,
  outdir: "dist-electron",
  outbase: ".",
  chunkNames: "electron/chunks/[name]-[hash]",
  absWorkingDir: ROOT,
  logLevel: "silent",
};

let production: Promise<Metafile> | null = null;

function buildProduction(): Promise<Metafile> {
  production ??= build({
    ...PRODUCTION,
    entryPoints: mainEsmEntryPoints(ROOT),
    external: MAIN_EXTERNAL,
    plugins: [mainBundleStubsPlugin()],
    alias: { "@daintreehq/svelte-source-model": "./packages/svelte-source-model/dist/index.js" },
    define: {
      "process.env.SENTRY_DSN": JSON.stringify(""),
      __DAINTREE_REMOTE_HOSTS__: "false",
      __DAINTREE_REMOTE_HOST_ROLE__: "false",
      __DAINTREE_BUILD_COMMIT__: JSON.stringify("test"),
    },
  }).then((result) => result.metafile);
  return production;
}

function emitted(metafile: Metafile, test: (file: string) => boolean): string[] {
  return Object.entries(metafile.outputs)
    .filter(([, output]) =>
      Object.entries(output.inputs).some(([file, input]) => input.bytesInOutput > 0 && test(file))
    )
    .map(([file]) => file);
}

function entryOutput(metafile: Metafile, entry: string): string {
  const found = Object.entries(metafile.outputs).find(([, output]) => output.entryPoint === entry);
  if (!found) throw new Error(`no output for ${entry}`);
  return found[0];
}

/** Output files an entry loads, following dynamic imports only when asked to. */
function outputClosure(metafile: Metafile, from: string, dynamic: boolean): Set<string> {
  const seen = new Set<string>();
  const pending = [from];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const edge of metafile.outputs[file]?.imports ?? []) {
      if (edge.external) continue;
      if (edge.kind === "dynamic-import" && !dynamic) continue;
      pending.push(edge.path);
    }
  }
  return seen;
}

describe("the Svelte parser in the production main build", () => {
  it("ships once, in one chunk under the parser's ceiling", async () => {
    const metafile = await buildProduction();

    // One output holds every emitted byte of the compiler: a second would mean
    // a consumer reached a different copy, or a shared chunk split it.
    const chunks = emitted(metafile, isCompiler);
    expect(chunks).toHaveLength(1);
    // Not a vacuous pass: that chunk is the parser.
    expect(emitted(metafile, (file) => file.endsWith(PARSER))).toEqual(chunks);
    expect(metafile.outputs[chunks[0]].bytes).toBeLessThan(PARSER_CHUNK_CEILING);
  }, 120_000);

  it("leaves out the compile, migrate, print and preprocess passes", async () => {
    const metafile = await buildProduction();

    // Still in the input graph, because `svelte/compiler`'s index imports them
    // all. Were one renamed, the check below would go blind; this fails first.
    const inputs = Object.keys(metafile.inputs);
    for (const pass of UNUSED_PASSES) {
      expect(
        inputs.filter((file) => file.endsWith(pass)),
        pass
      ).toHaveLength(1);
    }
    expect(emitted(metafile, (file) => UNUSED_PASSES.some((pass) => file.endsWith(pass)))).toEqual(
      []
    );
  }, 120_000);

  it("loads only behind a dynamic import, from one chunk both consumers share", async () => {
    const metafile = await buildProduction();
    const [chunk] = emitted(metafile, isCompiler);

    // Over the emitted chunk graph, not the module graph: splitting can hoist a
    // module into a shared chunk an entry imports statically.
    for (const entry of mainEsmEntryPoints(ROOT)) {
      expect(outputClosure(metafile, entryOutput(metafile, entry), false), entry).not.toContain(
        chunk
      );
    }

    const fromPicker = PICKER_HOST_ENTRIES.some((entry) =>
      outputClosure(metafile, entryOutput(metafile, entry), true).has(chunk)
    );
    expect(fromPicker).toBe(true);
    expect(outputClosure(metafile, entryOutput(metafile, BUILDER_ENTRY), true)).toContain(chunk);
  }, 120_000);

  it("would see the passes return under a namespace import", async () => {
    // The regression this guards against, built on purpose: `import()` of the
    // whole compiler keeps every export, so each pass emits code here.
    const result = await build({
      ...PRODUCTION,
      stdin: {
        contents: `export const load = () => import("svelte/compiler");`,
        resolveDir: ROOT,
        loader: "js",
      },
    });
    for (const pass of UNUSED_PASSES) {
      expect(
        emitted(result.metafile, (file) => file.endsWith(pass)),
        pass
      ).toHaveLength(1);
    }
  }, 60_000);
});
