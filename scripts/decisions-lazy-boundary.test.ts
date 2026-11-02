import { beforeAll, describe, expect, it } from "vitest";
import { build, type Metafile } from "esbuild";
import { mainEsmConfig } from "./build-main.mjs";
import {
  FORBIDDEN_EAGER_PATTERNS,
  scanForbiddenModules,
  walkEagerGraph,
} from "./import-budget-lib.mjs";

/** What runs at startup: the bootstrap, then main, which it loads. */
const STARTUP_ENTRIES = ["electron/bootstrap.ts", "electron/main.ts"];
const STATUS_READ_HOST = "electron/ipc/handlers/deviceAnswer.ts";
const LIBRARIES = [
  "decisions-protocol",
  "decisions-crypto",
  "decisions-client",
  "decisions-model",
] as const;

/**
 * Decisions costs nothing while it is off (#16001): the startup graph reaches
 * none of its service or libraries, which load only through the dynamic
 * import its boot task makes once the setting reads as on. The import budget
 * script that would notice otherwise runs on demand, not in CI, so this runs
 * the production build's own config without writing it and reads esbuild's
 * graph, which stops at `dynamic-import` edges: exactly the boundary being
 * asserted.
 *
 * It also proves the other half: the libraries are bundled (not left external
 * for the ASAR's `node_modules`, which drops them), and their code lands only
 * in chunks loaded on demand.
 */

const isDecisions = (file: string) =>
  scanForbiddenModules([file], FORBIDDEN_EAGER_PATTERNS).some(({ label }) => label === "Decisions");

const libraryOf = (file: string) =>
  /node_modules\/@daintreehq\/(decisions-[a-z]+)\//.exec(file)?.[1] ?? null;

/** Every output chunk evaluated at startup: the startup entries' chunks and whatever they import statically. */
function startupChunks(metafile: Metafile): Set<string> {
  const entryChunks = Object.entries(metafile.outputs)
    .filter(([, output]) => output.entryPoint && STARTUP_ENTRIES.includes(output.entryPoint))
    .map(([chunk]) => chunk);
  expect(entryChunks, "the startup entries' chunks").toHaveLength(STARTUP_ENTRIES.length);
  const seen = new Set<string>();
  const stack = [...entryChunks];
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
      ...mainEsmConfig({ production: true }),
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    metafile = result.metafile;
    eager = new Set(STARTUP_ENTRIES.flatMap((entry) => [...walkEagerGraph(metafile, entry)]));
  }, 180_000);

  it("builds the service and every library into main, so their absence below means something", () => {
    const inputs = Object.keys(metafile.inputs);
    for (const file of [
      "electron/services/decisions/index.ts",
      "electron/services/decisions/DecisionsService.ts",
      "electron/services/decisions/libraries.ts",
      "electron/services/decisions/decisionsSettings.ts",
      "electron/services/decisions/openLocalStore.ts",
      "electron/services/decisions/daintreeLocalStore.ts",
      "electron/services/decisions/relayCheck.ts",
      "electron/services/decisions/relayIdentity.ts",
      "electron/services/decisions/relayConnection.ts",
      "electron/services/decisions/relayTransport.ts",
      "electron/services/decisions/pairing.ts",
      "electron/services/decisions/recoveryKit.ts",
      "electron/services/decisions/keyRotation.ts",
      "electron/services/decisions/keyStore.ts",
      "electron/services/decisions/localData.ts",
      "electron/services/decisions/dataExport.ts",
      "electron/services/decisions/relayData.ts",
      "electron/services/decisions/workflowGates.ts",
      "electron/services/decisions/mcpRoute.ts",
      "electron/services/decisions/paneAccess.ts",
      "electron/services/decisions/questionBridge.ts",
      "electron/services/decisions/questionFeed.ts",
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

  it("reaches no Decisions module from the startup graph", () => {
    for (const entry of STARTUP_ENTRIES) expect(eager.has(entry), entry).toBe(true);
    expect([...eager].filter(isDecisions)).toEqual([]);
  });

  it("adds no module of its own to the startup graph", () => {
    // The status read is declared in a handler module startup loads anyway.
    expect(eager.has(STATUS_READ_HOST)).toBe(true);
    // Repo sources only: a package is the library check's to judge, and a
    // namespaced stub's key can carry an absolute path naming any checkout.
    const ownSources = [...eager].filter(
      (file) => !file.includes(":") && !file.includes("node_modules/")
    );
    expect(ownSources.filter((file) => /decisions/i.test(file))).toEqual([]);
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

  it("emits Decisions code only into chunks loaded on demand", () => {
    const leaked = [...startupChunks(metafile)].flatMap((chunk) =>
      Object.entries(metafile.outputs[chunk].inputs)
        .filter(([file, input]) => isDecisions(file) && input.bytesInOutput > 0)
        .map(([file]) => `${chunk}: ${file}`)
    );
    expect(leaked).toEqual([]);
  });
});
