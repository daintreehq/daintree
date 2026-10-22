import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Metafile } from "esbuild";
import { MAIN_EXTERNAL } from "./main-build-entries.mjs";
import { scanForbiddenModules, walkEagerGraph } from "./import-budget-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST_DIR = "electron/services/elementPicker/";
const WORKER_DIR = `${HOST_DIR}worker/`;
const RESOLVERS_DIR = `${WORKER_DIR}resolvers/`;
const BOOTSTRAP = `${HOST_DIR}host-bootstrap.ts`;
const HOST_ENTRY = `${HOST_DIR}host.ts`;

/**
 * Element Picker resolvers carry parsers, compilers and source-map decoders,
 * and an ESM import that has loaded never unloads. So they run in a host
 * process main forks on demand and retires when idle, and the claims below are
 * what make that worth anything: main never evaluates the host's code, and the
 * host evaluates a framework's resolver only when a request names it.
 *
 * As in `lazy-compiler-boundary.test.ts`, the bundler's graph is the evidence;
 * how an import is spelled proves nothing about what it drags in.
 */

// Natives only: a framework package left external would be invisible here,
// and its absence from the eager set would mean nothing.
const NATIVE_EXTERNAL = ["electron", "@parcel/watcher", "node-pty", "better-sqlite3", "copytree"];

/** What a resolver must reach only through main: no file, process or network module at all. */
const AUTHORITY_MODULES = new Set(
  [
    "fs",
    "fs/promises",
    "net",
    "http",
    "https",
    "http2",
    "tls",
    "dgram",
    "dns",
    "child_process",
    "worker_threads",
  ].flatMap((name) => [name, `node:${name}`])
);

async function metafileOf(entry: string, external: string[]): Promise<Metafile> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    target: "node22",
    format: "esm",
    external,
    define: {
      "process.env.SENTRY_DSN": JSON.stringify(""),
      __DAINTREE_REMOTE_HOSTS__: "false",
      __DAINTREE_REMOTE_HOST_ROLE__: "false",
      __DAINTREE_BUILD_COMMIT__: JSON.stringify("test"),
    },
    absWorkingDir: ROOT,
    logLevel: "silent",
  });
  return result.metafile;
}

function authorityImports(metafile: Metafile): string[] {
  return Object.entries(metafile.inputs)
    .flatMap(([file, input]) =>
      input.imports
        .filter((edge) => edge.external && AUTHORITY_MODULES.has(edge.path))
        .map((edge) => `${file} -> ${edge.path}`)
    )
    .sort();
}

const isHostProcessCode = (file: string) =>
  file.startsWith(WORKER_DIR) || file === BOOTSTRAP || file === HOST_ENTRY;

describe("the Element Picker host boundary", () => {
  it("keeps the host process's code out of main, eagerly or lazily", async () => {
    const metafile = await metafileOf("electron/main.ts", MAIN_EXTERNAL);
    // Without splitting every dynamic import is inlined, so this is everything
    // main can ever evaluate.
    const reachable = Object.keys(metafile.inputs);
    expect(reachable.filter(isHostProcessCode)).toEqual([]);
    expect(
      [...walkEagerGraph(metafile, "electron/main.ts")].filter((f) => f.startsWith(HOST_DIR))
    ).toEqual([]);

    // Not a vacuous pass: main does reach the service, behind its shutdown
    // hook's dynamic import.
    expect(reachable).toContain(`${HOST_DIR}index.ts`);
    expect(reachable).toContain(`${HOST_DIR}ElementPickerHost.ts`);
  }, 120_000);

  it("loads the service only when it is first asked for", async () => {
    const entry = `${HOST_DIR}index.ts`;
    const metafile = await metafileOf(entry, NATIVE_EXTERNAL);
    const eager = [...walkEagerGraph(metafile, entry)];
    expect(eager).toContain(entry);
    expect(eager).not.toContain(`${HOST_DIR}ElementPickerHost.ts`);
    expect(Object.keys(metafile.inputs).filter(isHostProcessCode)).toEqual([]);
    expect(scanForbiddenModules(Object.keys(metafile.inputs))).toEqual([]);
    // The service itself holds main's file authority; the scanner below must see it.
    expect(authorityImports(metafile)).toContain(`${HOST_DIR}sourceAccess.ts -> node:fs/promises`);
  }, 60_000);

  it("gives the host process no resolver eagerly and no file or network module", async () => {
    const metafile = await metafileOf(BOOTSTRAP, NATIVE_EXTERNAL);
    const reachable = Object.keys(metafile.inputs);
    expect(reachable).toContain(`${WORKER_DIR}runtime.ts`);
    expect(reachable).toContain(`${WORKER_DIR}resolverRegistry.ts`);

    const eager = [...walkEagerGraph(metafile, BOOTSTRAP), ...walkEagerGraph(metafile, HOST_ENTRY)];
    expect(eager.filter((file) => file.startsWith(RESOLVERS_DIR))).toEqual([]);
    expect(scanForbiddenModules(eager)).toEqual([]);
    // Bytes come from main; nothing the host runs can open a file or a socket itself.
    expect(authorityImports(metafile)).toEqual([]);
    // Nor reach main-side services, which would bring their authority with them.
    expect(
      reachable.filter((file) => file.startsWith("electron/") && !file.startsWith(HOST_DIR))
    ).toEqual(["electron/utils/bootstrapErrorGuard.ts"]);
  }, 60_000);
});
