import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAIN_BUNDLE_EXTERNAL,
  VUE_ENV_SWITCH_FILTER,
  mainBundlePlugins,
  mainBundleStubsPlugin,
} from "./main-bundle.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function bundle(contents, plugins = [mainBundleStubsPlugin()], resolveDir = root) {
  const result = await build({
    stdin: { contents, resolveDir, loader: "js" },
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: MAIN_BUNDLE_EXTERNAL,
    plugins,
    absWorkingDir: root,
    logLevel: "silent",
  });
  const inputs = Object.keys(result.metafile.inputs).map((p) => p.split(path.sep).join("/"));
  return { inputs, code: result.outputFiles[0].text };
}

async function run(code) {
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

describe("mainBundleStubsPlugin", () => {
  it("keeps only the English zod locale and English error messages", async () => {
    const { inputs, code } = await bundle(
      `import { z } from "zod";
       export const locales = Object.keys(z.locales);
       export const coreLocales = Object.keys(z.core.locales);
       export const message = z.string().safeParse(1).error.issues[0].message;`
    );

    expect(inputs.some((p) => p.includes("zod/v4/locales/de.js"))).toBe(false);
    expect(inputs.some((p) => p.includes("zod/v4/locales/en.js"))).toBe(true);
    const mod = await run(code);
    expect(mod.locales).toEqual(["en"]);
    expect(mod.coreLocales).toEqual(["en"]);
    expect(mod.message).toBe("Invalid input: expected string, received number");
  });

  it("drops ajv from conf but still lets a store without a schema work", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "main-bundle-conf-"));
    try {
      const { inputs, code } = await bundle(
        `import Conf from "conf";
         const cwd = ${JSON.stringify(cwd)};
         const store = new Conf({ cwd, projectName: "t", defaults: { a: 1 } });
         store.set("b", 2);
         export const snapshot = store.store;
         export const schemaErrors = ["schema", "ajvOptions", "rootSchema"].map((option) => {
           try { new Conf({ cwd, projectName: "t", [option]: {} }); return null; }
           catch (e) { return e.message; }
         });`
      );

      expect(inputs.some((p) => p.includes("node_modules/ajv/"))).toBe(false);
      expect(inputs.some((p) => p.includes("node_modules/ajv-formats/"))).toBe(false);
      const mod = await run(code);
      expect(mod.snapshot).toEqual({ a: 1, b: 2 });
      for (const message of mod.schemaErrors) {
        expect(message).toMatch(/stubbed out of the main bundle/);
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("leaves ajv intact for every other importer", async () => {
    const { inputs } = await bundle(
      `import { Ajv2020 } from "ajv/dist/2020.js";
       import addFormats from "ajv-formats";
       export { Ajv2020, addFormats };`
    );

    expect(inputs.some((p) => p.includes("node_modules/ajv/dist/2020.js"))).toBe(true);
    expect(inputs.some((p) => p.includes("node_modules/ajv-formats/"))).toBe(true);
  });
});

const VUE_SWITCHED = ["compiler-core", "compiler-dom", "shared"];

/** Which of each switched Vue package's builds a bundle carries, wherever the install resolves from. */
function vueBuilds(inputs) {
  return inputs
    .filter((p) => /\/@vue\/[^/]+\/dist\//.test(p))
    .map((p) => p.slice(p.lastIndexOf("/@vue/") + 1))
    .sort();
}

describe("vueProductionCompilerPlugin", () => {
  const source = `import { parse } from "@vue/compiler-dom";
    const [root] = parse("<div><MyButton v-if='ok' /></div>").children;
    export const tags = root.children.map((node) => [node.tag, node.tagType]);
    export const env = () => process.env.NODE_ENV;`;

  it("bundles only the production build of Vue's compiler, nested packages included", async () => {
    const { inputs, code } = await bundle(source, mainBundlePlugins({ isProd: true }));

    expect(vueBuilds(inputs)).toEqual(
      VUE_SWITCHED.map((pkg) => `@vue/${pkg}/dist/${pkg}.cjs.prod.js`)
    );
    const mod = await run(code);
    expect(mod.tags).toEqual([["MyButton", 1]]);
    // Only Vue's own switch is folded: anything else still reads NODE_ENV when it runs.
    expect(process.env.NODE_ENV).not.toBe("production");
    expect(mod.env()).toBe(process.env.NODE_ENV);
  });

  it("leaves a development bundle both of Vue's builds, as before", async () => {
    const { inputs } = await bundle(source, mainBundlePlugins({ isProd: false }));

    expect(vueBuilds(inputs)).toEqual(
      VUE_SWITCHED.flatMap((pkg) => [
        `@vue/${pkg}/dist/${pkg}.cjs.js`,
        `@vue/${pkg}/dist/${pkg}.cjs.prod.js`,
      ])
    );
  });

  it("matches only the entry files that switch, on either path separator", () => {
    for (const pkg of VUE_SWITCHED) {
      expect(VUE_ENV_SWITCH_FILTER.test(`/repo/node_modules/@vue/${pkg}/index.js`)).toBe(true);
      expect(
        VUE_ENV_SWITCH_FILTER.test(
          `C:\\repo\\node_modules\\@vue\\compiler-dom\\node_modules\\@vue\\${pkg}\\index.js`
        )
      ).toBe(true);
      expect(VUE_ENV_SWITCH_FILTER.test(`/repo/node_modules/@vue/${pkg}/dist/${pkg}.cjs.js`)).toBe(
        false
      );
    }
    for (const other of [
      "/repo/node_modules/@vue/compiler-sfc/index.js",
      "/repo/node_modules/@vue/shared-utils/index.js",
      "/repo/node_modules/vue/index.js",
      "/repo/src/@vue/shared/index.js",
    ]) {
      expect(VUE_ENV_SWITCH_FILTER.test(other), other).toBe(false);
    }
  });

  it("fails the build when a switched entry file no longer reads NODE_ENV", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "main-bundle-vue-"));
    try {
      const pkg = path.join(dir, "node_modules/@vue/shared");
      fs.mkdirSync(pkg, { recursive: true });
      fs.writeFileSync(
        path.join(pkg, "package.json"),
        JSON.stringify({ name: "@vue/shared", main: "index.js" })
      );
      fs.writeFileSync(
        path.join(pkg, "index.js"),
        "module.exports = require('./dist/shared.cjs.js');"
      );

      await expect(
        bundle(`import "@vue/shared";`, mainBundlePlugins({ isProd: true }), dir)
      ).rejects.toThrow(/no longer switches on process\.env\.NODE_ENV/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
