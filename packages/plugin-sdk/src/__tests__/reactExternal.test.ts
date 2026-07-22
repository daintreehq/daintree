import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, type RollupOutput } from "vite";
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
  await execFileAsync(
    process.execPath,
    [
      path.join(repoRoot, "node_modules/tsup/dist/cli-default.js"),
      "--out-dir",
      sdkOutDir,
      "--metafile",
      "--no-dts",
      "--silent",
    ],
    { cwd: sdkDir }
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

    const result = await build({
      root: fixtureDir,
      logLevel: "silent",
      plugins: [daintreePlugin()],
      resolve: {
        // Stand in for the workspace resolution a real plugin gets from its
        // own node_modules, pointed at the build produced above.
        alias: { "@daintreehq/plugin-sdk/react": path.join(sdkOutDir, "react.js") },
      },
      build: {
        lib: { entry: { panel: path.join(fixtureDir, "panel.js") }, formats: ["es"] },
        // Kept in memory: the assertions read the rollup output directly, so
        // nothing needs to touch disk.
        write: false,
        minify: false,
      },
    });

    // Vite 8 resolves `build()` to one RollupOutput per build environment, so
    // the result is an array even for this single-target fixture.
    const outputs = (Array.isArray(result) ? result : [result]) as RollupOutput[];
    const entry = outputs.flatMap((o) => o.output).find((o) => o.type === "chunk" && o.isEntry);
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
