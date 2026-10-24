import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as barrel from "../plugin.js";
import * as fileEditors from "../plugin/fileEditors.js";
import * as instanceKeys from "../plugin/instanceKeys.js";
import * as projectApplication from "../plugin/projectApplication.js";
import * as projectSurfaces from "../plugin/projectSurfaces.js";

const moduleDir = path.resolve(__dirname, "../plugin");

describe("shared/types/plugin domain modules", () => {
  it("never import back through the plugin.ts barrel", () => {
    for (const file of readdirSync(moduleDir).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(path.join(moduleDir, file), "utf8");
      const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
      for (const specifier of specifiers) {
        expect(specifier, `${file} imports ${specifier}`).not.toMatch(/^\.\.\/plugin(\.js)?$/);
      }
    }
  });

  it.each([
    ["fileEditors", fileEditors],
    ["instanceKeys", instanceKeys],
    ["projectApplication", projectApplication],
    ["projectSurfaces", projectSurfaces],
  ])("re-exports every runtime export of %s from the barrel", (_name, module) => {
    for (const [key, value] of Object.entries(module)) {
      expect(barrel[key as keyof typeof barrel], key).toBe(value);
    }
  });
});
