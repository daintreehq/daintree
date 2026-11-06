import { describe, expect, it } from "vitest";
import { rolldown, type OutputOptions } from "rolldown";
import { build } from "vite";
import { xtermMinifyIdentifiersGuardPlugin } from "./xtermMinifyGuard.js";

async function compile(minify: OutputOptions["minify"]) {
  const bundle = await rolldown({
    input: "fixture",
    plugins: [
      xtermMinifyIdentifiersGuardPlugin(),
      {
        name: "parser-closure-fixture",
        resolveId: () => "\0fixture",
        load: () =>
          "export function modeClosure(inputMode) { return function readMode() { return inputMode + 1; }; }",
      },
    ],
  });
  try {
    const result = await bundle.generate({ format: "esm", minify });
    const chunk = result.output.find((entry) => entry.type === "chunk");
    if (!chunk) throw new Error("No JavaScript output");
    return chunk.code;
  } finally {
    await bundle.close();
  }
}

describe("xterm's output minifier protection", () => {
  it("refuses a Vite minifier that bypasses the output protection", async () => {
    await expect(
      build({
        configFile: false,
        plugins: [xtermMinifyIdentifiersGuardPlugin()],
        build: { write: false, minify: "terser" },
      })
    ).rejects.toThrow("The xterm identifier protection requires Oxc");
  });

  it("preserves a parser closure's parameter through the real minifier", async () => {
    const code = await compile({ mangle: false });
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
    );
    expect(module.modeClosure(41)()).toBe(42);
    expect(String(module.modeClosure)).toContain("inputMode");
  });

  it.each([true, { mangle: true }, { compress: true }])(
    "rejects an output that can rewrite identifiers: %j",
    async (minify) => {
      await expect(compile(minify)).rejects.toThrow("Identifier mangling must be disabled");
    }
  );

  it.each([false, "dce-only"] as const)("accepts an unminified probe build: %s", async (minify) => {
    const code = await compile(minify);
    expect(code).toContain("inputMode");
  });
});
