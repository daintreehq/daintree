import { describe, expect, it } from "vitest";
import { build } from "vite";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { daintreePlugin, GUEST_ENTRY_GLOBAL } from "../index.js";

async function buildGuest(files: Record<string, string>, entry = "entry.js") {
  const root = await mkdtemp(path.join(tmpdir(), "daintree-guest-entry-"));
  try {
    await writeFile(path.join(root, "package.json"), '{"name":"guest-fixture"}');
    for (const [name, source] of Object.entries(files))
      await writeFile(path.join(root, name), source);
    const result = await build({
      configFile: false,
      root,
      logLevel: "silent",
      plugins: [daintreePlugin({ target: "guest" })],
      build: { write: false, lib: { entry: path.join(root, entry), fileName: () => "lit.js" } },
    });
    const outputs = Array.isArray(result) ? result : [result];
    return outputs.flatMap((output) => ("output" in output ? output.output : []));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("guest entry build target", () => {
  it("bundles dependencies into one IIFE whose default export is the factory", async () => {
    const files = await buildGuest({
      "dep.js": 'export const label = "from-dep";',
      "entry.js": 'import { label } from "./dep.js"; export default (id) => ({ id, label });',
    });
    expect(files).toHaveLength(1);
    const chunk = files[0];
    expect(chunk?.type).toBe("chunk");
    const code = (chunk as { code: string }).code;
    expect(code).not.toMatch(/^\s*(import|export)\s/m);
    const entry = new Function(`${code}\nreturn ${GUEST_ENTRY_GLOBAL};`)() as {
      default: (id: string) => unknown;
    };
    expect(entry.default("fixture.lit")).toEqual({ id: "fixture.lit", label: "from-dep" });
  });

  it("inlines a dynamic import instead of splitting a chunk", async () => {
    const files = await buildGuest({
      "lazy.js": "export const value = 1;",
      "entry.js": 'export default () => import("./lazy.js");',
    });
    expect(files).toHaveLength(1);
  });

  it("refuses a dependency it cannot bundle rather than leaving a bare import", async () => {
    await expect(
      buildGuest({ "entry.js": 'import "@fixture/missing-dependency"; export default () => ({});' })
    ).rejects.toThrow(/missing-dependency/);
  });

  it("refuses an emitted asset", async () => {
    await expect(
      buildGuest({
        "style.css": "body { color: red }",
        "entry.js": 'import "./style.css"; export default () => ({});',
      })
    ).rejects.toThrow(/exactly one JavaScript file/);
  });
});
