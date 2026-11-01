import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { HOST_SERVED_SDK_ENTRIES } from "../pluginSdkResolution.js";
import { minimalWorkerEnv } from "../../../utils/minimalSpawnEnv.js";
import { pluginSdkRuntimeBuildConfig } from "../../../../scripts/lib/plugin-sdk-runtime.mjs";

/**
 * The SDK fallback in the runtime it ships in. `pluginSdkResolution.test.ts`
 * covers the hook's behaviour under the repo's Node; this runs the real worker
 * bootstrap under the Electron binary's embedded Node, where `registerHooks` has
 * not reached stable, so an Electron bump that changes or drops it fails here
 * instead of in a user's zero-build plugin.
 *
 * ELECTRON_RUN_AS_NODE rather than a `utilityProcess`: the unit shards have no
 * display to start Electron's main process on, and the loader under test is the
 * same embedded Node either way. CI provisions the binary before the unit run
 * (`scripts/ci/verify-electron-install.mjs`); Electron's npm package only
 * downloads it on first use.
 */

const execFileAsync = promisify(execFile);
const nodeRequire = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const RUNTIME_MARK = "SDK_PROBE_RUNTIME ";
const RESULT_MARK = "SDK_PROBE_RESULT ";

interface Runtime {
  electron: string | null;
  node: string;
  registerHooks: string;
}

interface Refusal {
  code: string;
  message: string;
}

interface Result {
  loadError?: string;
  plugin?: {
    resolved: Record<string, string>;
    required: { records: unknown; sameInstance: boolean };
    values: Record<string, unknown>;
    refused: Record<string, Refusal | null>;
  };
}

// The process entry. It reports the runtime before importing anything that
// could fail to link, then hands over to the bootstrap.
const PROBE_ENTRY = `
import * as nodeModule from "node:module";
process.stdout.write(${JSON.stringify(RUNTIME_MARK)} + JSON.stringify({
  electron: process.versions.electron ?? null,
  node: process.versions.node,
  registerHooks: typeof nodeModule.registerHooks,
}) + "\\n");
const result = {};
globalThis.__sdkProbeResult = result;
try {
  await import("./plugin-dev-worker-bootstrap.js");
} catch (error) {
  result.loadError = String(error?.stack ?? error);
}
process.stdout.write(${JSON.stringify(RESULT_MARK)} + JSON.stringify(result) + "\\n");
`;

// Stands in for plugin-dev-worker.js, which the bootstrap imports once the hook
// is installed, and loads the plugin bundle the way the worker does.
const WORKER_STUB = `
const plugin = await import(process.env.SDK_PROBE_PLUGIN_URL);
globalThis.__sdkProbeResult.plugin = await plugin.probe();
`;

// A zero-build plugin: hand-written ESM importing every served entry, with
// nothing installed. The CommonJS module comes first, so its require() is the
// one that evaluates the data entry.
const PLUGIN_INDEX = `
import legacy from "./legacy.cjs";
import { createRequire } from "node:module";
import { PLUGIN_PROCESS_STREAM_CHANNEL } from "@daintreehq/plugin-sdk";
import { getFileTypeCategory } from "@daintreehq/plugin-sdk/files";
import { parseFrontmatter, updateFrontmatter, parseJsonl } from "@daintreehq/plugin-sdk/data";
import { createOperationManager, OperationError } from "@daintreehq/plugin-sdk/operations";

const require = createRequire(import.meta.url);
const SERVED = ${JSON.stringify(Object.keys(HOST_SERVED_SDK_ENTRIES))};

export async function probe() {
  const refused = {};
  for (const entry of ["react", "testing"]) {
    try {
      await import("@daintreehq/plugin-sdk/" + entry);
      refused[entry] = null;
    } catch (error) {
      refused[entry] = { code: error.code, message: error.message };
    }
  }
  return {
    resolved: Object.fromEntries(SERVED.map((specifier) => [specifier, import.meta.resolve(specifier)])),
    required: {
      records: legacy.parseJsonl('{"a":1}\\n').records,
      sameInstance:
        legacy.parseJsonl === parseJsonl &&
        require("@daintreehq/plugin-sdk/data").parseJsonl === parseJsonl,
    },
    values: {
      channel: typeof PLUGIN_PROCESS_STREAM_CHANNEL,
      category: typeof getFileTypeCategory("README.md"),
      frontmatter: parseFrontmatter(updateFrontmatter("---\\nstage: lead\\n---\\n", { stage: "won" })).data,
      operations: typeof createOperationManager,
      retryable: new OperationError("X", "x", { retryable: false }).retryable,
    },
    refused,
  };
}
`;

const PLUGIN_LEGACY = `
const { parseJsonl } = require("@daintreehq/plugin-sdk/data");
module.exports = { parseJsonl };
`;

function readRecord<T>(stdout: string, mark: string): T | undefined {
  const line = stdout.split("\n").find((candidate) => candidate.startsWith(mark));
  if (!line) return undefined;
  try {
    return JSON.parse(line.slice(mark.length)) as T;
  } catch {
    return undefined;
  }
}

describe("the worker SDK fallback under Electron's embedded Node", () => {
  const installedElectron = (nodeRequire("electron/package.json") as { version: string }).version;
  let tmp: string | undefined;
  let sdkDir = "";
  let runtimeRecord: Runtime | undefined;
  let result: Result | undefined;
  let exitFailure: string | undefined;
  let stderr = "";
  let runtime = "";

  beforeAll(async () => {
    // Resolved through Node rather than Vitest, so it is the binary's path and
    // never a mock. A binary that cannot be had throws here and fails the
    // suite instead of skipping it.
    const electronBinary = nodeRequire("electron") as string;

    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "daintree-sdk-electron-")));
    // Laid out like dist-electron: the bootstrap with the SDK copy beside it and
    // a `"type": "module"` package above both. The space is the one in
    // `C:\Program Files`, which the hook's file URLs have to survive.
    const appRoot = path.join(tmp, "Daintree App");
    const appDir = path.join(appRoot, "electron");
    sdkDir = path.join(appDir, "plugin-sdk");
    await build({
      ...pluginSdkRuntimeBuildConfig({ absWorkingDir: repoRoot }),
      outdir: sdkDir,
      logLevel: "silent",
    });
    // The real bootstrap with the options the main build bundles it under; only
    // the worker it hands over to is swapped for the stub.
    await build({
      entryPoints: [path.join(repoRoot, "electron/plugin-dev-worker-bootstrap.ts")],
      absWorkingDir: repoRoot,
      outfile: path.join(appDir, "plugin-dev-worker-bootstrap.js"),
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      external: ["./plugin-dev-worker.js"],
      banner: {
        js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
      },
      logLevel: "silent",
    });
    await fs.writeFile(path.join(appRoot, "package.json"), '{"type":"module"}');
    await fs.writeFile(path.join(appDir, "probe.js"), PROBE_ENTRY);
    await fs.writeFile(path.join(appDir, "plugin-dev-worker.js"), WORKER_STUB);

    // Outside any node_modules tree, so nothing but the hook can serve the SDK.
    const pluginDir = path.join(tmp, "My Project/.daintree/plugins/acme.zero-build");
    await fs.mkdir(path.join(pluginDir, "dist"), { recursive: true });
    await fs.writeFile(path.join(pluginDir, "dist/index.mjs"), PLUGIN_INDEX);
    await fs.writeFile(path.join(pluginDir, "dist/legacy.cjs"), PLUGIN_LEGACY);

    // The worker's own environment allowlist, so nothing inherited from the
    // test runner (NODE_OPTIONS, NODE_PATH) reaches the loader.
    const env = minimalWorkerEnv({
      ELECTRON_RUN_AS_NODE: "1",
      DAINTREE_USER_DATA: tmp,
      SDK_PROBE_PLUGIN_URL: pathToFileURL(path.join(pluginDir, "dist/index.mjs")).href,
    });

    let stdout = "";
    try {
      ({ stdout, stderr } = await execFileAsync(electronBinary, [path.join(appDir, "probe.js")], {
        cwd: pluginDir,
        env,
        timeout: 30_000,
        killSignal: "SIGKILL",
      }));
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string; message: string };
      stdout = failed.stdout ?? "";
      stderr = failed.stderr ?? "";
      exitFailure = failed.message;
    }
    runtimeRecord = readRecord<Runtime>(stdout, RUNTIME_MARK);
    result = readRecord<Result>(stdout, RESULT_MARK);
    runtime = runtimeRecord
      ? `Electron ${runtimeRecord.electron ?? "(not Electron)"} with embedded Node ${runtimeRecord.node}`
      : `Electron ${installedElectron} (embedded Node unknown: the process reported no runtime)`;
  }, 60_000);

  afterAll(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  });

  function plugin(): NonNullable<Result["plugin"]> {
    expect(result, `${runtime} never finished the probe; stderr:\n${stderr}`).toBeDefined();
    expect(result!.loadError, `${runtime} failed to load the plugin`).toBeUndefined();
    expect(result!.plugin, `${runtime} reported no plugin probe`).toBeDefined();
    return result!.plugin!;
  }

  it("runs the installed Electron's runtime, where the bootstrap installs registerHooks", () => {
    expect(runtimeRecord, `${runtime}; stderr:\n${stderr}`).toBeDefined();
    expect(runtimeRecord!.electron, `${runtime}: not the installed Electron binary`).toBe(
      installedElectron
    );
    expect(runtimeRecord!.registerHooks, `${runtime} has no module.registerHooks`).toBe("function");
    expect(stderr, `${runtime}: installing the hook threw in the bootstrap`).not.toContain(
      "SDK resolution fallback unavailable"
    );
    expect(
      exitFailure,
      `${runtime}: the worker process failed; stderr:\n${stderr}`
    ).toBeUndefined();
  });

  it("serves every host-served entry from the app's copy to a plugin with no node_modules", () => {
    const probe = plugin();
    expect(probe.resolved, runtime).toEqual(
      Object.fromEntries(
        Object.entries(HOST_SERVED_SDK_ENTRIES).map(([specifier, file]) => [
          specifier,
          pathToFileURL(path.join(sdkDir, file)).href,
        ])
      )
    );
    expect(probe.values, runtime).toEqual({
      channel: "string",
      category: "string",
      frontmatter: { stage: "won" },
      operations: "function",
      retryable: false,
    });
  });

  it("serves require() of an entry, from CommonJS and from createRequire", () => {
    expect(plugin().required, runtime).toEqual({ records: [{ a: 1 }], sameInstance: true });
  });

  it("refuses the /react and /testing entries by name", () => {
    const { refused } = plugin();
    expect(refused.react, runtime).toEqual({
      code: "ERR_MODULE_NOT_FOUND",
      message: expect.stringContaining(
        "@daintreehq/plugin-sdk/react is not served because it is for panel views"
      ),
    });
    expect(refused.testing, runtime).toEqual({
      code: "ERR_MODULE_NOT_FOUND",
      message: expect.stringContaining(
        "@daintreehq/plugin-sdk/testing is not served because it is a test-time mock host"
      ),
    });
  });
});
