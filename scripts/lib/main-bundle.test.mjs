import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAIN_BUNDLE_EXTERNAL, mainBundleStubsPlugin } from "./main-bundle.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function bundle(contents) {
  const result = await build({
    stdin: { contents, resolveDir: root, loader: "js" },
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: MAIN_BUNDLE_EXTERNAL,
    plugins: [mainBundleStubsPlugin()],
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
