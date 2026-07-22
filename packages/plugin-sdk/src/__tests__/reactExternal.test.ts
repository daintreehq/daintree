import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { daintreePlugin } from "../../../plugin-vite/src/index.js";

const execFileAsync = promisify(execFile);

const here = fileURLToPath(new URL(".", import.meta.url));
const sdkDir = path.resolve(here, "../..");
const repoRoot = path.resolve(sdkDir, "../..");

/**
 * Strings that only appear in a real React implementation. React 19 ships both
 * in its development *and* production builds, so a bundle that inlined either
 * one trips these — which matters because `process.env.NODE_ENV` is undefined
 * in a browser panel bundle, making the development build the one that would
 * actually have shipped.
 */
const REACT_IMPLEMENTATION_MARKERS = [
  "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE",
  "react.transitional.element",
];

interface EsbuildMetafile {
  inputs: Record<string, unknown>;
  outputs: Record<string, { imports?: Array<{ path: string; external?: boolean }> }>;
}

let sdkOutDir: string;
let metafile: EsbuildMetafile;

/**
 * Build the SDK exactly as `npm run build` would — its own `tsup.config.ts`,
 * from its own directory. The `cwd` is load-bearing rather than incidental:
 * tsup derives its externals from the `package.json` at `process.cwd()` and
 * exposes no `cwd` option, so running this from the repo root would resolve the
 * *root* manifest, auto-externalize React from there, and pass even if
 * `packages/plugin-sdk/package.json` had lost its React peer entirely.
 *
 * Declarations are skipped (`--no-dts`) because this asserts on the JS bundle;
 * the dts pipeline is covered by the package's own build in CI.
 */
beforeAll(async () => {
  sdkOutDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-sdk-build-"));
  // Resolved rather than hard-coded to `<root>/node_modules/...` so a nested or
  // deduped install still finds the CLI next to tsup's own entry point.
  const tsupCli = path.join(
    path.dirname(createRequire(import.meta.url).resolve("tsup")),
    "cli-default.js"
  );
  await execFileAsync(
    process.execPath,
    [tsupCli, "--out-dir", sdkOutDir, "--metafile", "--no-dts", "--silent"],
    // Shorter than the hook budget below: a vitest hook timeout does not kill
    // the child, so without this a hung build outlives the hook and races the
    // afterAll cleanup.
    { cwd: sdkDir, timeout: 90_000 }
  );
  metafile = JSON.parse(
    await fs.readFile(path.join(sdkOutDir, "metafile-esm.json"), "utf8")
  ) as EsbuildMetafile;
}, 120_000);

afterAll(async () => {
  await fs.rm(sdkOutDir, { recursive: true, force: true }).catch(() => {});
});

describe("@daintreehq/plugin-sdk/react — React stays external", () => {
  it("pulls no React source into the SDK bundle", () => {
    const reactInputs = Object.keys(metafile.inputs).filter((input) =>
      /(^|[/\\])node_modules[/\\]react(-dom)?[/\\]/.test(input)
    );
    expect(reactInputs).toEqual([]);
  });

  it("bundles nothing from node_modules at all", () => {
    // Transitive and parser-free: every declared dependency is externalized, so
    // any npm package appearing as a build input means something reachable from
    // an entry — including through `shared/`, which the entries re-export —
    // pulled in an undeclared package and got inlined. React was the first such
    // case; this catches the next one without following imports by hand.
    const bundledPackages = Object.keys(metafile.inputs).filter((input) =>
      /(^|[/\\])node_modules[/\\]/.test(input)
    );
    expect(bundledPackages).toEqual([]);
  });

  it("emits react as an external import of the react entry", () => {
    const [, reactEntry] =
      Object.entries(metafile.outputs).find(([out]) => out.endsWith("react.js")) ?? [];
    expect(reactEntry, "tsup emitted no react.js entry").toBeDefined();

    const reactImports = (reactEntry?.imports ?? []).filter((i) => i.path === "react");
    expect(reactImports.length).toBeGreaterThan(0);
    // Every one of them must be external — a single bundled copy is the bug.
    expect(reactImports.every((i) => i.external === true)).toBe(true);
  });

  it("ships no React implementation in the emitted entry", async () => {
    const code = await fs.readFile(path.join(sdkOutDir, "react.js"), "utf8");
    for (const marker of REACT_IMPLEMENTATION_MARKERS) {
      expect(code).not.toContain(marker);
    }
  });
});

/**
 * The consumer half of the contract. The SDK keeping React external only helps
 * if a plugin author's own build preserves that — so this builds a fixture
 * panel through the real `@daintreehq/plugin-vite` preset against the real SDK
 * output and checks React never lands in the final bundle. Together with the
 * assertions above this covers both sides of the duplicate-React hazard: the
 * host serves one React instance through its import map, and a second copy
 * reaching a panel is what produces `Invalid hook call` (#11296).
 */
describe("consumer panel build — React never reaches the bundle", () => {
  let fixtureDir: string;
  let chunk: { code: string; imports: string[]; modules: Record<string, unknown> };

  beforeAll(async () => {
    fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-panel-fixture-"));
    await fs.writeFile(
      path.join(fixtureDir, "panel.js"),
      // Importing the hook is the whole point — it is the SDK export with a
      // real React dependency behind it.
      'import { useHostChannel } from "@daintreehq/plugin-sdk/react";\nexport { useHostChannel };\n'
    );

    // A real node_modules layout rather than a `resolve.alias`. Two reasons:
    // it's what a plugin author actually has, and — the load-bearing one — the
    // SDK's own bare `react` import resolves relative to *the SDK's* location,
    // so an aliased copy sitting in a bare temp dir could never resolve React
    // at all. The build would then fail on an unresolved import instead of
    // bundling React, and the assertions below could never go red for the
    // reason they exist.
    const sdkPkgDir = path.join(fixtureDir, "node_modules/@daintreehq/plugin-sdk");
    await fs.mkdir(sdkPkgDir, { recursive: true });
    await fs.cp(sdkOutDir, path.join(sdkPkgDir, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(sdkPkgDir, "package.json"),
      JSON.stringify({
        name: "@daintreehq/plugin-sdk",
        version: "0.0.0-fixture",
        type: "module",
        exports: { "./react": "./dist/react.js" },
      })
    );
    // Real React, so a regression bundles the genuine runtime (markers and all)
    // rather than a stub that would slip past the marker assertions.
    await fs.symlink(
      path.join(repoRoot, "node_modules/react"),
      path.join(fixtureDir, "node_modules/react"),
      process.platform === "win32" ? "junction" : undefined
    );

    const result = await build({
      root: fixtureDir,
      logLevel: "silent",
      plugins: [daintreePlugin()],
      build: {
        lib: { entry: { panel: path.join(fixtureDir, "panel.js") }, formats: ["es"] },
        // Kept in memory: the assertions read the rollup output directly, so
        // nothing needs to touch disk.
        write: false,
        minify: false,
      },
    });

    // Vite 8 resolves `build()` to one bundle per build environment, so the
    // result is an array even for this single-target fixture. The `"output" in`
    // guard also discards the watcher arm of the return union.
    const bundles = Array.isArray(result) ? result : [result];
    const entry = bundles
      .flatMap((bundle) => ("output" in bundle ? bundle.output : []))
      .find((out) => out.type === "chunk" && out.isEntry);
    if (!entry || entry.type !== "chunk") throw new Error("fixture build emitted no entry chunk");
    chunk = { code: entry.code, imports: entry.imports, modules: entry.modules };
  }, 120_000);

  afterAll(async () => {
    await fs.rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
  });

  it("leaves react as a bare external import", () => {
    expect(chunk.imports).toContain("react");
  });

  it("bundles no module from the React package", () => {
    const reactModules = Object.keys(chunk.modules).filter((id) =>
      /(^|[/\\])node_modules[/\\]react(-dom)?[/\\]/.test(id)
    );
    expect(reactModules).toEqual([]);
  });

  it("ships no React implementation in the panel bundle", () => {
    for (const marker of REACT_IMPLEMENTATION_MARKERS) {
      expect(chunk.code).not.toContain(marker);
    }
  });
});
