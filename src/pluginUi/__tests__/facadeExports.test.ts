// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as pluginUi from "@daintreehq/plugin-ui";

const ROOT = path.resolve(__dirname, "../../..");

/**
 * The `@daintreehq/plugin-ui` entry of `HOST_FACADE_REQUIRED_EXPORTS`, read
 * from source: the config is not importable from a test, and the host build
 * holds the facade to this list exactly.
 */
function facadeRequiredExports(): string[] {
  const config = readFileSync(path.join(ROOT, "vite.config.ts"), "utf-8");
  const table = config.slice(config.indexOf("const HOST_FACADE_REQUIRED_EXPORTS"));
  const entry = /"@daintreehq\/plugin-ui":\s*\[([^\]]*)\]/.exec(table);
  if (!entry) throw new Error("no @daintreehq/plugin-ui entry in HOST_FACADE_REQUIRED_EXPORTS");
  return [...entry[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

/** Value exports (`export const` / `export function`) the published typings declare. */
function declaredValueExports(): string[] {
  const dts = readFileSync(path.join(ROOT, "packages/plugin-sdk/plugin-ui.d.ts"), "utf-8");
  const names = [
    ...dts.matchAll(/^\s*export\s+(?:declare\s+)?(?:const|function)\s+([A-Za-z_$][\w$]*)/gm),
  ].map((match) => match[1]!);
  return [...new Set(names)];
}

const sorted = (names: readonly string[]): string[] => [...names].sort();

describe("@daintreehq/plugin-ui facade exports", () => {
  it("lists each required export once", () => {
    const required = facadeRequiredExports();
    expect(new Set(required).size).toBe(required.length);
  });

  it("requires exactly the value exports the published typings declare", () => {
    expect(sorted(facadeRequiredExports())).toEqual(sorted(declaredValueExports()));
  });

  it("requires exactly the facade module's runtime exports", () => {
    expect(sorted(facadeRequiredExports())).toEqual(sorted(Object.keys(pluginUi)));
  });
});
