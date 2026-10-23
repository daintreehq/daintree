import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Metafile } from "esbuild";
import { MAIN_EXTERNAL } from "./main-build-entries.mjs";
import {
  ELEMENT_PICKER_FRAMEWORK_PATTERNS,
  scanForbiddenModules,
  walkEagerGraph,
} from "./import-budget-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST_DIR = "electron/services/elementPicker/";
const WORKER_DIR = `${HOST_DIR}worker/`;
const RESOLVERS_DIR = `${WORKER_DIR}resolvers/`;
const ADAPTERS_DIR = `${HOST_DIR}projectAdapters/`;
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

/** Wherever the install resolves from: a worktree's node_modules can be a link to another checkout's. */
const isSourceMapDecoder = (file: string) =>
  file.includes("node_modules/@jridgewell/trace-mapping/");
const isJsParser = (file: string) => file.includes("node_modules/@babel/parser/");
const isJsxParser = (file: string) => file.includes("node_modules/@lezer/");
const isVueCompiler = (file: string) => file.includes("node_modules/@vue/compiler-");

describe("the Element Picker host boundary", () => {
  it("keeps the host process's code out of main, eagerly or lazily", async () => {
    const metafile = await metafileOf("electron/main.ts", MAIN_EXTERNAL);
    // Without splitting every dynamic import is inlined, so this is everything
    // main can ever evaluate.
    const reachable = Object.keys(metafile.inputs);
    expect(reachable.filter(isHostProcessCode)).toEqual([]);
    expect(reachable.filter(isSourceMapDecoder)).toEqual([]);
    expect(reachable.filter(isJsParser)).toEqual([]);
    // Every family the picker brought, guest scripts included: main bundles
    // none of it even behind an import, since the host and the page load it.
    expect(scanForbiddenModules(reachable, ELEMENT_PICKER_FRAMEWORK_PATTERNS)).toEqual([]);
    expect(reachable.filter(isJsxParser)).toEqual([]);
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

  it("loads an adapter's code only for an app its registration detects", async () => {
    // The context service is small and comes with the host; of each registered
    // adapter only its registration does, which detects from a manifest.
    const service = `${HOST_DIR}ElementPickerHost.ts`;
    const hostGraph = await metafileOf(service, NATIVE_EXTERNAL);
    const eagerHost = [...walkEagerGraph(hostGraph, service)];
    expect(eagerHost).toContain(`${ADAPTERS_DIR}projectContext.ts`);
    expect(eagerHost.filter((file) => file.startsWith(`${ADAPTERS_DIR}sveltekit/`)).sort()).toEqual(
      [`${ADAPTERS_DIR}sveltekit/discovery.ts`, `${ADAPTERS_DIR}sveltekit/registration.ts`]
    );

    // Detection reads a manifest; the route parser and config readers wait for `load()`.
    const registration = `${ADAPTERS_DIR}sveltekit/registration.ts`;
    const adapterGraph = await metafileOf(registration, NATIVE_EXTERNAL);
    expect(
      [...walkEagerGraph(adapterGraph, registration)]
        .filter((file) => file.startsWith(`${ADAPTERS_DIR}sveltekit/`))
        .sort()
    ).toEqual([`${ADAPTERS_DIR}sveltekit/discovery.ts`, registration]);
    expect(Object.keys(adapterGraph.inputs)).toContain(`${ADAPTERS_DIR}sveltekit/routes.ts`);
  }, 60_000);

  it("gives the host process no resolver eagerly and no file or network module", async () => {
    const metafile = await metafileOf(BOOTSTRAP, NATIVE_EXTERNAL);
    const reachable = Object.keys(metafile.inputs);
    expect(reachable).toContain(`${WORKER_DIR}runtime.ts`);
    expect(reachable).toContain(`${WORKER_DIR}resolverRegistry.ts`);

    const eager = [...walkEagerGraph(metafile, BOOTSTRAP), ...walkEagerGraph(metafile, HOST_ENTRY)];
    expect(eager.filter((file) => file.startsWith(RESOLVERS_DIR))).toEqual([]);
    expect(scanForbiddenModules(eager)).toEqual([]);

    // Not a vacuous pass: the Svelte resolver, the source model and the
    // compiler are all in this build, each behind the registry's dynamic
    // import. Asserted apart, since the model alone would satisfy a joint check
    // once the compiler stopped being bundled.
    expect(reachable).toContain(`${RESOLVERS_DIR}svelte.ts`);
    const behind = scanForbiddenModules(reachable);
    expect(behind.filter((m) => m.label === "Svelte compiler").length).toBeGreaterThan(0);
    expect(behind.filter((m) => m.label === "svelte-source-model").length).toBeGreaterThan(0);
    // React's resolver and the parser it reads JSX with, likewise behind theirs.
    expect(reachable).toContain(`${RESOLVERS_DIR}react.ts`);
    expect(reachable.some(isJsParser)).toBe(true);
    expect(eager.filter(isJsParser)).toEqual([]);
    // And every other framework the registry lists, each with what it parses with.
    for (const framework of ["vue", "angular", "astro", "preact"]) {
      expect(reachable).toContain(`${RESOLVERS_DIR}${framework}.ts`);
    }
    expect(reachable.some(isVueCompiler)).toBe(true);
    expect(eager.filter(isVueCompiler)).toEqual([]);
    expect(reachable.some(isJsxParser)).toBe(true);
    expect(eager.filter(isJsxParser)).toEqual([]);
    // What makes main's empty scan above worth anything: the same patterns,
    // run over what the host can reach, find each family they name for it.
    expect(
      new Set(
        scanForbiddenModules(reachable, ELEMENT_PICKER_FRAMEWORK_PATTERNS).map((m) => m.label)
      )
    ).toEqual(
      new Set([
        "Element Picker host process",
        "Svelte compiler",
        "Svelte runtime",
        "svelte-source-model",
        "Vue template compiler",
        "Babel parser",
        "source-map decoder",
      ])
    );
    // Bytes come from main; nothing the host runs can open a file or a socket itself.
    expect(authorityImports(metafile)).toEqual([]);
    // Project adapters walk directories, which is main's authority, never the host's.
    expect(reachable.filter((file) => file.startsWith(ADAPTERS_DIR))).toEqual([]);
    // Nor reach main-side services, which would bring their authority with them.
    expect(
      reachable.filter((file) => file.startsWith("electron/") && !file.startsWith(HOST_DIR))
    ).toEqual(["electron/utils/bootstrapErrorGuard.ts"]);
  }, 60_000);

  it("keeps Vue's template parser behind the Vue resolver's first template check", async () => {
    // A step further than the registry's own: the resolver loads without it.
    const entry = `${RESOLVERS_DIR}vue.ts`;
    const metafile = await metafileOf(entry, NATIVE_EXTERNAL);
    const reachable = Object.keys(metafile.inputs);
    // Not a vacuous pass: the parser is in the build, behind its dynamic import.
    expect(reachable.some(isVueCompiler)).toBe(true);
    expect([...walkEagerGraph(metafile, entry)].filter(isVueCompiler)).toEqual([]);
    // Nothing of Svelte's comes with it, and no file or network access at all.
    expect(scanForbiddenModules(reachable)).toEqual([]);
    expect(authorityImports(metafile)).toEqual([]);
    expect(
      reachable.filter((file) => file.startsWith("electron/") && !file.startsWith(HOST_DIR))
    ).toEqual([]);
  }, 60_000);

  it("decodes source maps only in the host, loading the decoder when a frame is first mapped", async () => {
    const entry = `${WORKER_DIR}symbolication.ts`;
    const metafile = await metafileOf(entry, NATIVE_EXTERNAL);
    // Not a vacuous pass: the decoder is reachable, behind the dynamic import.
    expect(Object.keys(metafile.inputs).some(isSourceMapDecoder)).toBe(true);
    expect([...walkEagerGraph(metafile, entry)].filter(isSourceMapDecoder)).toEqual([]);
    // Maps arrive as bytes from main; the host fetches nothing itself.
    expect(authorityImports(metafile)).toEqual([]);
    expect(
      Object.keys(metafile.inputs).filter(
        (file) => file.startsWith("electron/") && !file.startsWith(HOST_DIR)
      )
    ).toEqual([]);
  }, 60_000);

  it("brings nothing of Svelte's with Angular's resolver, nor any file or network access", async () => {
    const metafile = await metafileOf(`${RESOLVERS_DIR}angular.ts`, NATIVE_EXTERNAL);
    const reachable = Object.keys(metafile.inputs);
    expect(scanForbiddenModules(reachable)).toEqual([]);
    expect(authorityImports(metafile)).toEqual([]);
    expect(
      reachable.filter((file) => file.startsWith("electron/") && !file.startsWith(HOST_DIR))
    ).toEqual([]);
  }, 60_000);

  it("brings nothing of Svelte's with Astro's resolver, nor any file or network access", async () => {
    // The registry walk shares one graph between every resolver; this one's own shows what Astro's brings.
    const entry = `${RESOLVERS_DIR}astro.ts`;
    const metafile = await metafileOf(entry, NATIVE_EXTERNAL);
    const reachable = Object.keys(metafile.inputs);
    expect(reachable).toContain(`${RESOLVERS_DIR}astroSource.ts`);
    expect(scanForbiddenModules(reachable)).toEqual([]);
    expect(authorityImports(metafile)).toEqual([]);
    expect(
      reachable.filter((file) => file.startsWith("electron/") && !file.startsWith(HOST_DIR))
    ).toEqual([]);
  }, 60_000);

  it("brings nothing of Svelte's with Preact's resolver, nor any file or network access", async () => {
    // Its parser comes with it, loaded when the registry first asks for Preact.
    const entry = `${RESOLVERS_DIR}preact.ts`;
    const metafile = await metafileOf(entry, NATIVE_EXTERNAL);
    const reachable = Object.keys(metafile.inputs);
    expect(reachable.some(isJsxParser)).toBe(true);
    expect(scanForbiddenModules(reachable)).toEqual([]);
    expect(authorityImports(metafile)).toEqual([]);
    expect(
      reachable.filter((file) => file.startsWith("electron/") && !file.startsWith(HOST_DIR))
    ).toEqual([]);
  }, 60_000);
});
