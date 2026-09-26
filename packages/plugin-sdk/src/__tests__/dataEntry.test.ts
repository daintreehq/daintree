import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as dataEntry from "../data.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("@daintreehq/plugin-sdk/data", () => {
  it("resolves every export the barrel promises", () => {
    for (const name of [
      "parseFrontmatter",
      "stringifyFrontmatter",
      "updateFrontmatter",
      "FrontmatterError",
      "parseJsonl",
      "stringifyJsonlLine",
      "contentRevision",
      "editFile",
    ] as const) {
      expect(typeof dataEntry[name], `${name} should be a function`).toBe("function");
    }
  });

  it("is declared everywhere the subpath has to be listed", () => {
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf-8")) as {
      exports: Record<string, unknown>;
      dependencies?: Record<string, string>;
    };
    expect(manifest.exports["./data"]).toEqual({
      types: "./dist/data.d.ts",
      import: "./dist/data.js",
      default: "./dist/data.js",
    });
    expect(manifest.dependencies?.yaml).toBeDefined();

    const tsup = readFileSync(path.join(packageRoot, "tsup.config.ts"), "utf-8");
    expect(tsup).toContain('data: "src/data.ts"');

    const gate = readFileSync(
      path.join(packageRoot, "../../scripts/ci/check-api-surface.mjs"),
      "utf-8"
    );
    expect(gate).toContain('name: "./data"');
  });

  it("imports no Node builtin, so a panel view can use it too", () => {
    const dir = path.join(packageRoot, "src/data");
    const sources = [
      path.join(packageRoot, "src/data.ts"),
      ...readdirSync(dir).map((name) => path.join(dir, name)),
    ];
    for (const file of sources) {
      const source = readFileSync(file, "utf-8");
      expect(source, path.relative(packageRoot, file)).not.toMatch(/from\s+["']node:/);
    }
  });
});
