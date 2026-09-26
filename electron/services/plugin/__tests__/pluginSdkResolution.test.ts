import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createPluginSdkResolveHook, HOST_SERVED_SDK_ENTRIES } from "../pluginSdkResolution.js";
import { pluginSdkRuntimeBuildConfig } from "../../../../scripts/lib/plugin-sdk-runtime.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const hookModule = path.join(repoRoot, "electron/services/plugin/pluginSdkResolution.ts");

function moduleNotFound(specifier: string): Error {
  return Object.assign(new Error(`Cannot find package '${specifier}'`), {
    code: "ERR_MODULE_NOT_FOUND",
  });
}

describe("createPluginSdkResolveHook", () => {
  const sdkDir = path.join(os.tmpdir(), "host-sdk");
  const hook = createPluginSdkResolveHook(sdkDir);
  const context = { conditions: ["node", "import"], importAttributes: {}, parentURL: undefined };

  it("serves the runtime entries when the plugin has no SDK of its own", () => {
    for (const [specifier, file] of Object.entries(HOST_SERVED_SDK_ENTRIES)) {
      const result = hook(specifier, context, () => {
        throw moduleNotFound(specifier);
      });
      expect(result).toEqual({
        url: pathToFileURL(path.join(sdkDir, file)).href,
        format: "module",
        shortCircuit: true,
      });
    }
  });

  it("keeps the plugin's own SDK when normal resolution finds one", () => {
    const own = { url: "file:///plugin/node_modules/@daintreehq/plugin-sdk/dist/data.js" };
    expect(hook("@daintreehq/plugin-sdk/data", context, () => own)).toBe(own);
  });

  it("falls back when the plugin's own SDK predates the entry", () => {
    const result = hook("@daintreehq/plugin-sdk/data", context, () => {
      throw Object.assign(new Error("not exported"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
    });
    expect(result.url).toBe(pathToFileURL(path.join(sdkDir, "data.js")).href);
  });

  it("surfaces any other resolution failure unchanged", () => {
    const broken = Object.assign(new Error("bad package.json"), {
      code: "ERR_INVALID_PACKAGE_CONFIG",
    });
    expect(() =>
      hook("@daintreehq/plugin-sdk", context, () => {
        throw broken;
      })
    ).toThrow(broken);
  });

  it("refuses the view-only and test-only entries by name", () => {
    for (const [specifier, reason] of [
      ["@daintreehq/plugin-sdk/react", /panel views/],
      ["@daintreehq/plugin-sdk/testing", /mock host/],
      ["@daintreehq/plugin-sdk/nope", /serves only/],
    ] as const) {
      let caught: unknown;
      try {
        hook(specifier, context, () => {
          throw moduleNotFound(specifier);
        });
      } catch (error) {
        caught = error;
      }
      expect((caught as { code?: string }).code).toBe("ERR_MODULE_NOT_FOUND");
      expect((caught as Error).message).toMatch(reason);
      expect((caught as Error).message).toContain(specifier);
    }
  });

  it("passes every other specifier straight through", () => {
    const next = { url: "node:fs" };
    expect(hook("node:fs", context, () => next)).toBe(next);
    expect(hook("@daintreehq/plugin-sdk-extra", context, () => next)).toBe(next);
  });
});

/**
 * The whole chain in a real Node process: the SDK copy the app build emits,
 * the hook installed the way the worker bootstrap installs it, and a
 * zero-build plugin outside any node_modules tree importing the data entry.
 */
describe("a zero-build plugin importing the SDK", () => {
  let tmp: string;
  let sdkDir: string;

  beforeAll(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "daintree-sdk-resolve-")));
    sdkDir = path.join(tmp, "app/plugin-sdk");
    await build({
      ...pluginSdkRuntimeBuildConfig({ absWorkingDir: repoRoot }),
      outdir: sdkDir,
      logLevel: "silent",
    });
    // The worker's own bundles sit under a `"type": "module"` package; so does
    // this copy, as it does in dist-electron.
    await fs.writeFile(path.join(tmp, "app/package.json"), '{"type":"module"}');
  }, 60_000);

  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function runPlugin(pluginDir: string, source: string, file = "index.mjs"): Promise<string> {
    await fs.mkdir(path.join(pluginDir, "dist"), { recursive: true });
    const entry = path.join(pluginDir, "dist", file);
    await fs.writeFile(entry, source);
    const script = [
      `import { installPluginSdkResolution } from ${JSON.stringify(pathToFileURL(hookModule).href)};`,
      `installPluginSdkResolution(${JSON.stringify(sdkDir)});`,
      `const mod = await import(${JSON.stringify(pathToFileURL(entry).href)});`,
      `console.log(JSON.stringify(await mod.probe()));`,
    ].join("\n");
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--no-warnings", "--input-type=module", "-e", script],
      { cwd: tmp, timeout: 30_000 }
    );
    return stdout.trim();
  }

  it("resolves @daintreehq/plugin-sdk/data to the app's copy", async () => {
    const out = await runPlugin(
      path.join(tmp, "project/.daintree/plugins/acme.crm"),
      [
        'import { parseFrontmatter, updateFrontmatter, contentRevision } from "@daintreehq/plugin-sdk/data";',
        'import { PLUGIN_PROCESS_STREAM_CHANNEL } from "@daintreehq/plugin-sdk";',
        'import { getFileTypeCategory } from "@daintreehq/plugin-sdk/files";',
        "export async function probe() {",
        '  const text = updateFrontmatter("---\\nstage: lead # s\\n---\\nbody\\n", { stage: "won" });',
        "  return {",
        "    text,",
        "    data: parseFrontmatter(text).data,",
        '    revision: await contentRevision(""),',
        "    channel: typeof PLUGIN_PROCESS_STREAM_CHANNEL,",
        '    category: typeof getFileTypeCategory("README.md"),',
        "  };",
        "}",
      ].join("\n")
    );
    expect(JSON.parse(out)).toEqual({
      text: "---\nstage: won # s\n---\nbody\n",
      data: { stage: "won" },
      revision: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      channel: "string",
      category: "string",
    });
  }, 30_000);

  it("prefers an SDK the plugin installed itself", async () => {
    const pluginDir = path.join(tmp, "project/.daintree/plugins/acme.own");
    const ownSdk = path.join(pluginDir, "node_modules/@daintreehq/plugin-sdk");
    await fs.mkdir(ownSdk, { recursive: true });
    await fs.writeFile(
      path.join(ownSdk, "package.json"),
      JSON.stringify({
        name: "@daintreehq/plugin-sdk",
        type: "module",
        exports: { "./data": "./data.js" },
      })
    );
    await fs.writeFile(path.join(ownSdk, "data.js"), 'export const whose = "plugin";\n');
    const out = await runPlugin(
      pluginDir,
      'import { whose } from "@daintreehq/plugin-sdk/data";\nexport const probe = () => whose;\n'
    );
    expect(JSON.parse(out)).toBe("plugin");
  }, 30_000);

  it("falls back for an entry the plugin's own, older SDK does not export", async () => {
    const pluginDir = path.join(tmp, "project/.daintree/plugins/acme.old");
    const ownSdk = path.join(pluginDir, "node_modules/@daintreehq/plugin-sdk");
    await fs.mkdir(ownSdk, { recursive: true });
    await fs.writeFile(
      path.join(ownSdk, "package.json"),
      JSON.stringify({
        name: "@daintreehq/plugin-sdk",
        type: "module",
        exports: { "./files": "./files.js" },
      })
    );
    await fs.writeFile(path.join(ownSdk, "files.js"), 'export const whose = "plugin";\n');
    const out = await runPlugin(
      pluginDir,
      [
        'import { whose } from "@daintreehq/plugin-sdk/files";',
        'import { parseJsonl } from "@daintreehq/plugin-sdk/data";',
        "export const probe = () => [whose, parseJsonl('{\"a\":1}\\n').records];",
      ].join("\n")
    );
    expect(JSON.parse(out)).toEqual(["plugin", [{ a: 1 }]]);
  }, 30_000);

  it("serves require() from a CommonJS worker and from createRequire", async () => {
    const cjs = await runPlugin(
      path.join(tmp, "project/.daintree/plugins/acme.cjs"),
      [
        'const { parseJsonl } = require("@daintreehq/plugin-sdk/data");',
        "exports.probe = () => parseJsonl('{\"a\":1}\\n').records;",
      ].join("\n"),
      "index.cjs"
    );
    expect(JSON.parse(cjs)).toEqual([{ a: 1 }]);

    const created = await runPlugin(
      path.join(tmp, "project/.daintree/plugins/acme.create-require"),
      [
        'import { createRequire } from "node:module";',
        "const require = createRequire(import.meta.url);",
        'const { updateFrontmatter } = require("@daintreehq/plugin-sdk/data");',
        'export const probe = () => updateFrontmatter("---\\na: 1\\n---\\n", { a: 2 });',
      ].join("\n")
    );
    expect(JSON.parse(created)).toBe("---\na: 2\n---\n");
  }, 30_000);

  it.each([
    ["react", /is not served because it is for panel views/],
    ["testing", /is not served because it is a test-time mock host/],
    ["nope", /serves only .* to plugin workers\. To use it/],
  ])(
    "fails an import of the %s entry with the reason",
    async (entry, reason) => {
      await expect(
        runPlugin(
          path.join(tmp, `project/.daintree/plugins/acme.refused-${entry}`),
          `import "@daintreehq/plugin-sdk/${entry}";\nexport const probe = () => null;\n`
        )
      ).rejects.toThrow(reason);
    },
    30_000
  );
});
