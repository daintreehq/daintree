import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Metafile } from "esbuild";
import { MAIN_EXTERNAL } from "./main-build-entries.mjs";
import { mainBundlePlugins } from "./lib/main-bundle.mjs";
import {
  EAGER_EDGE_KINDS,
  FORBIDDEN_EAGER_PATTERNS,
  scanForbiddenModules,
  walkEagerGraph,
} from "./import-budget-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = "electron/main.ts";
const ADAPTER = "electron/ipc/handlers/decisions.ts";
const LIBRARIES = [
  "decisions-protocol",
  "decisions-crypto",
  "decisions-client",
  "decisions-model",
] as const;

/**
 * Decisions costs nothing while it is off (#16001): main's startup graph
 * reaches none of its service or libraries, which load only through the
 * dynamic import its boot task makes once the setting reads as on. The import
 * budget script that would notice otherwise runs on demand, not in CI, so this
 * builds main as the production build does and reads esbuild's own graph,
 * which stops at `dynamic-import` edges: exactly the boundary being asserted.
 *
 * It also proves the other half: the libraries are bundled (not left external
 * for the ASAR's node_modules, which drops them), and their code lands only in
 * chunks main loads on demand.
 */

const isDecisions = (file: string) =>
  scanForbiddenModules([file], FORBIDDEN_EAGER_PATTERNS).some(({ label }) => label === "Decisions");

const libraryOf = (file: string) =>
  /node_modules\/@daintreehq\/(decisions-[a-z]+)\//.exec(file)?.[1] ?? null;

/** Main's static graph from `entry`, never passing through `skip`. */
function staticGraph(metafile: Metafile, entry: string, skip?: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file) || file === skip) continue;
    seen.add(file);
    for (const edge of metafile.inputs[file]?.imports ?? []) {
      if (!edge.external && EAGER_EDGE_KINDS.has(edge.kind)) stack.push(edge.path);
    }
  }
  return seen;
}

/** The output chunks main evaluates at startup: its entry chunk and every chunk statically imported from there. */
function startupChunks(metafile: Metafile): Set<string> {
  const entryChunk = Object.entries(metafile.outputs).find(
    ([, output]) => output.entryPoint === ENTRY
  )?.[0];
  expect(entryChunk, "main's entry chunk").toBeDefined();
  const seen = new Set<string>();
  const stack = [entryChunk!];
  while (stack.length > 0) {
    const chunk = stack.pop()!;
    if (seen.has(chunk)) continue;
    seen.add(chunk);
    for (const edge of metafile.outputs[chunk]?.imports ?? []) {
      if (!edge.external && edge.kind === "import-statement") stack.push(edge.path);
    }
  }
  return seen;
}

describe("Decisions lazy boundary", () => {
  let metafile: Metafile;
  let eager: Set<string>;

  beforeAll(async () => {
    const result = await build({
      entryPoints: [ENTRY],
      bundle: true,
      write: false,
      metafile: true,
      platform: "node",
      target: "node22",
      format: "esm",
      splitting: true,
      outdir: "dist-electron",
      outbase: ".",
      chunkNames: "electron/chunks/[name]-[hash]",
      external: MAIN_EXTERNAL,
      plugins: mainBundlePlugins({ isProd: true }),
      absWorkingDir: ROOT,
      logLevel: "silent",
      define: {
        "process.env.SENTRY_DSN": JSON.stringify(""),
        __DAINTREE_REMOTE_HOSTS__: "true",
        __DAINTREE_REMOTE_HOST_ROLE__: "true",
        __DAINTREE_BUILD_COMMIT__: JSON.stringify("test"),
      },
    });
    metafile = result.metafile;
    eager = walkEagerGraph(metafile, ENTRY);
  }, 120_000);

  it("builds the service and every library into main, so their absence below means something", () => {
    const inputs = Object.keys(metafile.inputs);
    for (const file of [
      "electron/services/decisions/index.ts",
      "electron/services/decisions/DecisionsService.ts",
      "electron/services/decisions/libraries.ts",
      "electron/services/decisions/decisionsSettings.ts",
    ]) {
      expect(inputs, file).toContain(file);
    }
    for (const library of LIBRARIES) {
      expect(
        inputs.some((file) => libraryOf(file) === library),
        library
      ).toBe(true);
    }
  });

  it("reaches no Decisions module from main's startup graph", () => {
    expect([...eager].filter(isDecisions)).toEqual([]);
  });

  it("keeps the IPC adapter as Decisions' only startup module, bringing nothing else with it", () => {
    expect(eager.has(ADAPTER)).toBe(true);
    const withoutAdapter = staticGraph(metafile, ENTRY, ADAPTER);
    const addedByAdapter = [...eager].filter((file) => !withoutAdapter.has(file));
    expect(addedByAdapter).toEqual([ADAPTER]);
  });

  it("bundles the code of every library instead of leaving it to node_modules", () => {
    const bytes = new Map<string, number>();
    for (const output of Object.values(metafile.outputs)) {
      for (const [file, input] of Object.entries(output.inputs)) {
        const library = libraryOf(file);
        if (library) bytes.set(library, (bytes.get(library) ?? 0) + input.bytesInOutput);
      }
    }
    for (const library of LIBRARIES) {
      expect(bytes.get(library) ?? 0, library).toBeGreaterThan(0);
    }

    const externalImports = Object.values(metafile.outputs).flatMap((output) =>
      output.imports.filter(
        (edge) => edge.external && edge.path.startsWith("@daintreehq/decisions")
      )
    );
    expect(externalImports).toEqual([]);
  });

  it("emits Decisions code only into chunks main loads on demand", () => {
    const startup = startupChunks(metafile);
    const leaked = [...startup].flatMap((chunk) =>
      Object.entries(metafile.outputs[chunk].inputs)
        .filter(([file, input]) => isDecisions(file) && input.bytesInOutput > 0)
        .map(([file]) => `${chunk}: ${file}`)
    );
    expect(leaked).toEqual([]);
  });
});
