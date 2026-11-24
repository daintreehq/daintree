import { beforeAll, describe, expect, it } from "vitest";
import { builtinModules } from "node:module";
import { build, type Metafile } from "esbuild";
import { mainEsmConfig } from "./build-main.mjs";
import { walkEagerGraph } from "./import-budget-lib.mjs";

const BOOTSTRAP = "electron/bootstrap.ts";
const APP_BOOT = "electron/boot/appBoot.ts";
const RELAY = "electron/remote/host/attachStdioCli.ts";
const ASKPASS = "electron/remote/client/sshAskpassCli.ts";

/**
 * bootstrap.ts turns on the V8 compile cache, so everything it imports
 * statically is parsed without it on every launch, and the `--attach-stdio`
 * bridge (a process that only carries bytes) loads that same graph plus its
 * own module (#17022). Both stay on Node built-ins, Electron and a few pure
 * helpers; the boot proper is behind `import("./boot/appBoot.js")`.
 *
 * This runs the production build's own config without writing it and reads
 * both graphs esbuild reports: the source graph, which stops at
 * `dynamic-import` edges, and the emitted chunks, where splitting could still
 * put boot code in a chunk the entry loads.
 */
const BOOT_MODULES = [
  APP_BOOT,
  "electron/main.ts",
  "electron/setup/environment.ts",
  "electron/store.ts",
  "electron/boot/migrations/index.ts",
  "electron/services/CrashLoopGuardService.ts",
  "electron/services/GpuCrashMonitorService.ts",
  "electron/services/gpuDisabledFlag.ts",
  "electron/utils/gpuDetection.ts",
  "electron/ipc/channels.ts",
];

const PACKAGES = {
  zod: /node_modules\/zod\//,
  conf: /node_modules\/conf\//,
  semver: /node_modules\/semver\//,
};

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

/** A module from a package, or a namespaced stub standing in for one. */
const isPackageCode = (file: string) => file.includes("node_modules/") || file.includes(":");

/** What may be imported from outside the bundle before the cache is on. */
const isAllowedExternal = (specifier: string) =>
  specifier === "electron" || BUILTINS.has(specifier);

function forbidden(files: Iterable<string>): string[] {
  return [...files].filter((file) => BOOT_MODULES.includes(file) || isPackageCode(file)).sort();
}

/** The chunk holding `source`'s code. */
function chunkOf(metafile: Metafile, source: string): string {
  const chunks = Object.entries(metafile.outputs)
    .filter(([, output]) => (output.inputs[source]?.bytesInOutput ?? 0) > 0)
    .map(([chunk]) => chunk);
  expect(chunks, `the chunk holding ${source}`).toHaveLength(1);
  return chunks[0];
}

/** `chunk` and every chunk it loads through static imports. */
function staticChunks(metafile: Metafile, chunk: string): Set<string> {
  const seen = new Set<string>();
  const stack = [chunk];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const edge of metafile.outputs[current]?.imports ?? []) {
      if (!edge.external && edge.kind === "import-statement") stack.push(edge.path);
    }
  }
  return seen;
}

function emittedInputs(metafile: Metafile, chunks: Iterable<string>): string[] {
  return [...chunks].flatMap((chunk) =>
    Object.entries(metafile.outputs[chunk].inputs)
      .filter(([, input]) => input.bytesInOutput > 0)
      .map(([file]) => file)
  );
}

const isEagerExternal = (edge: { external?: boolean; kind: string }) =>
  Boolean(edge.external) && (edge.kind === "import-statement" || edge.kind === "require-call");

/** Packages left to Node's resolver (natives) that `sources` or `chunks` load eagerly. */
function disallowedExternals(
  metafile: Metafile,
  sources: Iterable<string>,
  chunks: Iterable<string>
): string[] {
  const specifiers = [
    ...[...sources].flatMap((file) => metafile.inputs[file]?.imports ?? []),
    ...[...chunks].flatMap((chunk) => metafile.outputs[chunk].imports),
  ]
    .filter(isEagerExternal)
    .map((edge) => edge.path);
  return [...new Set(specifiers)].filter((specifier) => !isAllowedExternal(specifier)).sort();
}

describe("bootstrap compile-cache boundary", () => {
  let metafile: Metafile;
  let hostRoleEnabled: boolean;

  beforeAll(async () => {
    const config = mainEsmConfig({ production: true });
    hostRoleEnabled = config.define?.__DAINTREE_REMOTE_HOST_ROLE__ === "true";
    const result = await build({ ...config, write: false, metafile: true, logLevel: "silent" });
    metafile = result.metafile;
  }, 180_000);

  it("builds the boot and its packages into main, so their absence below means something", () => {
    const inputs = Object.keys(metafile.inputs);
    for (const file of BOOT_MODULES) expect(inputs, file).toContain(file);
    for (const [name, pattern] of Object.entries(PACKAGES)) {
      expect(
        inputs.some((file) => pattern.test(file)),
        name
      ).toBe(true);
    }
    const toBoot = metafile.inputs[BOOTSTRAP].imports.filter((edge) => edge.path === APP_BOOT);
    expect(toBoot.map((edge) => edge.kind)).toEqual(["dynamic-import"]);
  });

  it("imports nothing of the boot, and no package, before the compile cache is on", () => {
    const eager = walkEagerGraph(metafile, BOOTSTRAP);
    expect(eager.has(BOOTSTRAP)).toBe(true);
    expect(forbidden(eager)).toEqual([]);

    const chunks = staticChunks(metafile, chunkOf(metafile, BOOTSTRAP));
    expect(forbidden(emittedInputs(metafile, chunks))).toEqual([]);
    expect(disallowedExternals(metafile, eager, chunks)).toEqual([]);
  });

  it("enters the --attach-stdio relay without the boot or any package", () => {
    // Only a Windows build drops the Host role, and with it the relay; a
    // define stuck at false would otherwise skip everything below.
    const target = process.env.DAINTREE_BUILD_TARGET_PLATFORM || process.platform;
    expect(hostRoleEnabled).toBe(target !== "win32");
    if (!hostRoleEnabled) {
      expect(Object.hasOwn(metafile.inputs, RELAY)).toBe(false);
      return;
    }
    const toRelay = metafile.inputs[BOOTSTRAP].imports.filter((edge) => edge.path === RELAY);
    expect(toRelay.map((edge) => edge.kind)).toEqual(["dynamic-import"]);

    const eager = new Set([
      ...walkEagerGraph(metafile, BOOTSTRAP),
      ...walkEagerGraph(metafile, RELAY),
    ]);
    expect(eager.has(RELAY)).toBe(true);
    expect(forbidden(eager)).toEqual([]);

    const chunks = new Set([
      ...staticChunks(metafile, chunkOf(metafile, BOOTSTRAP)),
      ...staticChunks(metafile, chunkOf(metafile, RELAY)),
    ]);
    expect(forbidden(emittedInputs(metafile, chunks))).toEqual([]);
    expect(disallowedExternals(metafile, eager, chunks)).toEqual([]);
  });

  // ssh starts it once per prompt during a sign-in, and waits on it.
  it("enters the --ssh-askpass helper without the boot or any package", () => {
    const toHelper = metafile.inputs[BOOTSTRAP].imports.filter((edge) => edge.path === ASKPASS);
    expect(toHelper.map((edge) => edge.kind)).toEqual(["dynamic-import"]);

    const eager = new Set([
      ...walkEagerGraph(metafile, BOOTSTRAP),
      ...walkEagerGraph(metafile, ASKPASS),
    ]);
    expect(eager.has(ASKPASS)).toBe(true);
    expect(forbidden(eager)).toEqual([]);

    const chunks = new Set([
      ...staticChunks(metafile, chunkOf(metafile, BOOTSTRAP)),
      ...staticChunks(metafile, chunkOf(metafile, ASKPASS)),
    ]);
    expect(forbidden(emittedInputs(metafile, chunks))).toEqual([]);
    expect(disallowedExternals(metafile, eager, chunks)).toEqual([]);
  });
});
