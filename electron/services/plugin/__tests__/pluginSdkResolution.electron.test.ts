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
import { pluginSdkRuntimeBuildConfig } from "../../../../scripts/lib/plugin-sdk-runtime.mjs";

/**
 * The SDK fallback in the runtime it ships in. `pluginSdkResolution.test.ts`
 * covers the hook's behaviour under the repo's Node; this runs the real worker
 * bootstrap under the Electron binary's embedded Node, where `registerHooks` is
 * an API that has not reached stable, so an Electron bump that changes or drops
 * it fails here instead of in a user's zero-build plugin.
 *
 * ELECTRON_RUN_AS_NODE rather than a `utilityProcess`: the unit shards have no
 * display to start Electron's main process on, and the loader under test is the
 * same embedded Node either way.
 */

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

interface Refusal {
  code: string;
  message: string;
}

interface ProbeReport {
  electron: string | null;
  node: string;
  registerHooks: string;
  loadError?: string;
  plugin?: {
    resolved: Record<string, string>;
    required: { parseJsonl: unknown; sameInstance: boolean };
    values: Record<string, unknown>;
    refused: Record<string, Refusal | null>;
  };
}

// The process entry: notes the runtime before anything can fail to link, then
// starts the worker the way PluginDevWorkerHost forks it.
const PROBE_ENTRY = `
import * as nodeModule from "node:module";
const report = {
  electron: process.versions.electron ?? null,
  node: process.versions.node,
  registerHooks: typeof nodeModule.registerHooks,
};
globalThis.__sdkProbeReport = report;
try {
  await import("./plugin-dev-worker-bootstrap.js");
} catch (error) {
  report.loadError = String(error?.stack ?? error);
}
process.stdout.write(JSON.stringify(report));
`;

// Stands in for plugin-dev-worker.js, which the bootstrap imports once the
// hook is installed: loads the plugin bundle the way the worker does.
const WORKER_STUB = `
const report = globalThis.__sdkProbeReport;
const plugin = await import(process.env.SDK_PROBE_PLUGIN_URL);
report.plugin = await plugin.probe();
`;

// A zero-build plugin: hand-written ESM importing every served entry, plus
// require() of one from CommonJS, with nothing installed.
const PLUGIN_INDEX = `
import { createRequire } from "node:module";
import { PLUGIN_PROCESS_STREAM_CHANNEL } from "@daintreehq/plugin-sdk";
import { getFileTypeCategory } from "@daintreehq/plugin-sdk/files";
import { parseFrontmatter, updateFrontmatter, parseJsonl } from "@daintreehq/plugin-sdk/data";
import { OPERATION_TERMINAL_STATES } from "@daintreehq/plugin-sdk/operations";
import legacy from "./legacy.cjs";

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
  const required = require("@daintreehq/plugin-sdk/data");
  return {
    resolved: Object.fromEntries(SERVED.map((specifier) => [specifier, import.meta.resolve(specifier)])),
    required: {
      parseJsonl: legacy.parseJsonl('{"a":1}\\n').records,
      sameInstance: legacy.parseJsonl === parseJsonl && required.parseJsonl === parseJsonl,
    },
    values: {
      channel: typeof PLUGIN_PROCESS_STREAM_CHANNEL,
      category: typeof getFileTypeCategory("README.md"),
      frontmatter: parseFrontmatter(updateFrontmatter("---\\nstage: lead\\n---\\n", { stage: "won" })).data,
      terminal: OPERATION_TERMINAL_STATES,
    },
    refused,
  };
}
`;

const PLUGIN_LEGACY = `
const { parseJsonl } = require("@daintreehq/plugin-sdk/data");
module.exports = { parseJsonl };
`;

describe("the worker SDK fallback under Electron's embedded Node", () => {
  let tmp: string;
  let sdkDir: string;
  let report: ProbeReport | undefined;
  let stderr = "";
  let runtime = "";

  beforeAll(async () => {
    // Resolved through Node, not Vitest, so it is the binary's path, never a
    // mock; it throws when the Electron download is missing, which fails the
    // suite rather than skipping it.
    const electronBinary = createRequire(import.meta.url)("electron") as string;
    const electronVersion = (
      createRequire(import.meta.url)("electron/package.json") as { version: string }
    ).version;

    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "daintree-sdk-electron-")));
    // Laid out like dist-electron: the bootstrap, the SDK copy beside it, and a
    // `"type": "module"` package above both.
    const appDir = path.join(tmp, "app/electron");
    sdkDir = path.join(appDir, "plugin-sdk");
    await build({
      ...pluginSdkRuntimeBuildConfig({ absWorkingDir: repoRoot }),
      outdir: sdkDir,
      logLevel: "silent",
    });
    await build({
      entryPoints: [path.join(repoRoot, "electron/plugin-dev-worker-bootstrap.ts")],
      absWorkingDir: repoRoot,
      outfile: path.join(appDir, "plugin-dev-worker-bootstrap.js"),
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      external: ["./plugin-dev-worker.js"],
      logLevel: "silent",
    });
    await fs.writeFile(path.join(tmp, "app/package.json"), '{"type":"module"}');
    await fs.writeFile(path.join(appDir, "probe.js"), PROBE_ENTRY);
    await fs.writeFile(path.join(appDir, "plugin-dev-worker.js"), WORKER_STUB);

    // Outside any node_modules tree, so nothing but the hook can serve the SDK.
    const pluginDist = path.join(tmp, "project/.daintree/plugins/acme.zero-build/dist");
    await fs.mkdir(pluginDist, { recursive: true });
    await fs.writeFile(path.join(pluginDist, "index.mjs"), PLUGIN_INDEX);
    await fs.writeFile(path.join(pluginDist, "legacy.cjs"), PLUGIN_LEGACY);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      DAINTREE_USER_DATA: tmp,
      SDK_PROBE_PLUGIN_URL: pathToFileURL(path.join(pluginDist, "index.mjs")).href,
    };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;

    let stdout = "";
    try {
      ({ stdout, stderr } = await execFileAsync(electronBinary, [path.join(appDir, "probe.js")], {
        cwd: path.dirname(pluginDist),
        env,
        timeout: 30_000,
      }));
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string; message: string };
      stdout = failed.stdout ?? "";
      stderr = failed.stderr ?? failed.message;
    }
    try {
      report = JSON.parse(stdout) as ProbeReport;
    } catch {
      report = undefined;
    }
    runtime = report
      ? `Electron ${report.electron ?? "(not Electron)"} with embedded Node ${report.node}`
      : `Electron ${electronVersion} (embedded Node unknown: the process printed no report)`;
  }, 60_000);

  afterAll(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  function loaded(): NonNullable<ProbeReport["plugin"]> {
    expect(report, `${runtime}; stderr:\n${stderr}`).toBeDefined();
    expect(report!.loadError, `${runtime} failed to load the plugin`).toBeUndefined();
    expect(report!.plugin, `${runtime}; stderr:\n${stderr}`).toBeDefined();
    return report!.plugin!;
  }

  it("runs in Electron's runtime with registerHooks installed by the bootstrap", () => {
    expect(report, `${runtime}; stderr:\n${stderr}`).toBeDefined();
    expect(report!.electron, `${runtime}: not the Electron binary`).toEqual(expect.any(String));
    expect(report!.registerHooks, `${runtime} has no module.registerHooks`).toBe("function");
    expect(stderr, `${runtime}: registerHooks threw in the bootstrap`).not.toContain(
      "SDK resolution fallback unavailable"
    );
  });

  it("serves every host-served entry from the app's copy to a plugin with no node_modules", () => {
    const plugin = loaded();
    expect(plugin.resolved, runtime).toEqual(
      Object.fromEntries(
        Object.entries(HOST_SERVED_SDK_ENTRIES).map(([specifier, file]) => [
          specifier,
          pathToFileURL(path.join(sdkDir, file)).href,
        ])
      )
    );
    expect(plugin.values, runtime).toEqual({
      channel: "string",
      category: "string",
      frontmatter: { stage: "won" },
      terminal: ["succeeded", "failed", "cancelled", "abandoned"],
    });
  });

  it("serves require() of an entry, from CommonJS and from createRequire", () => {
    const plugin = loaded();
    expect(plugin.required, runtime).toEqual({ parseJsonl: [{ a: 1 }], sameInstance: true });
  });

  it("refuses the /react and /testing entries by name", () => {
    const plugin = loaded();
    expect(plugin.refused.react, runtime).toEqual({
      code: "ERR_MODULE_NOT_FOUND",
      message: expect.stringContaining(
        "@daintreehq/plugin-sdk/react is not served because it is for panel views"
      ),
    });
    expect(plugin.refused.testing, runtime).toEqual({
      code: "ERR_MODULE_NOT_FOUND",
      message: expect.stringContaining(
        "@daintreehq/plugin-sdk/testing is not served because it is a test-time mock host"
      ),
    });
  });
});
