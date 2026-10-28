import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  PUBLISH_WORKSPACES,
  classifySubpath,
  exportTargets,
  isInside,
  isolatedEnv,
  normalizeExports,
  tarballFilename,
  treeDifferences,
} from "./packages-consumer-smoke.mjs";

describe("packages-consumer-smoke", () => {
  it("smokes the same workspaces the release workflow publishes", () => {
    const workflow = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../.github/workflows/release-packages.yml"),
      "utf8"
    );
    const line = workflow.match(/^\s*PUBLISH_WORKSPACES:\s*(.+)$/m);
    expect(line?.[1].trim().split(/\s+/)).toEqual(PUBLISH_WORKSPACES);
  });

  it("collects every target with the conditions that lead to it", () => {
    expect(exportTargets({ types: "./a.d.ts", import: "./a.js" })).toEqual([
      { conditions: ["types"], target: "./a.d.ts" },
      { conditions: ["import"], target: "./a.js" },
    ]);
    expect(exportTargets("./style.css")).toEqual([{ conditions: [], target: "./style.css" }]);
  });

  it("imports a dist entry and type-checks it", () => {
    const info = classifySubpath("./data", {
      types: "./dist/data.d.ts",
      import: "./dist/data.js",
      default: "./dist/data.js",
    });
    expect(info).toMatchObject({ importable: true, typed: true });
  });

  it("only references a types-only entry", () => {
    expect(classifySubpath("./view-globals", { types: "./view-globals.d.ts" })).toMatchObject({
      importable: false,
      typed: true,
    });
  });

  it("never imports a browser bundle or a stylesheet in Node, but still checks they exist", () => {
    const browser = classifySubpath("./testing/plugin-ui", {
      types: "./testing-plugin-ui.d.ts",
      import: "./browser/plugin-ui.js",
    });
    expect(browser).toMatchObject({ importable: false, typed: true });
    expect(browser.targets).toEqual(["./testing-plugin-ui.d.ts", "./browser/plugin-ui.js"]);
    expect(classifySubpath("./testing/preview.css", "./browser/preview.css")).toMatchObject({
      importable: false,
      typed: false,
      targets: ["./browser/preview.css"],
    });
  });

  it("fails on an export shape it cannot exercise instead of skipping it", () => {
    expect(() => classifySubpath("./cjs", { require: "./dist/a.cjs" })).toThrow(/require/);
    expect(() =>
      classifySubpath("./either", { browser: "./browser/a.js", node: "./dist/a.js" })
    ).toThrow(/browser, node/);
    expect(() => classifySubpath("./*", "./dist/*.js")).toThrow(/wildcard/);
  });

  it("treats a bare declaration target as typed", () => {
    expect(classifySubpath("./types", "./dist/types.d.ts")).toMatchObject({
      importable: false,
      typed: true,
    });
  });

  it("expands exports shorthand to the root subpath", () => {
    expect(normalizeExports("./index.js")).toEqual({ ".": "./index.js" });
    expect(normalizeExports({ import: "./index.js" })).toEqual({ ".": { import: "./index.js" } });
    expect(normalizeExports({ ".": "./index.js" })).toEqual({ ".": "./index.js" });
    expect(normalizeExports(undefined)).toEqual({});
  });

  it("names tarballs the way npm pack writes them", () => {
    expect(tarballFilename("@daintreehq/plugin-sdk", "0.2.0")).toBe(
      "daintreehq-plugin-sdk-0.2.0.tgz"
    );
    expect(tarballFilename("daintree-plugin", "0.2.0")).toBe("daintree-plugin-0.2.0.tgz");
  });

  it("tells a child named like a parent reference from a real parent", () => {
    const root = path.resolve("/repo");
    expect(isInside(path.join(root, "..smoke"), root)).toBe(true);
    expect(isInside(root, root)).toBe(true);
    expect(isInside(path.resolve("/repo-other"), root)).toBe(false);
    expect(isInside(path.resolve("/"), root)).toBe(false);
  });

  it("keeps the repository's tools and workspace selection out of the consumer", () => {
    const root = path.resolve("/repo");
    const env = isolatedEnv(
      {
        PATH: [
          path.join(root, "node_modules/.bin"),
          "/usr/bin",
          path.join(root, "packages/x/node_modules/.bin"),
        ].join(path.delimiter),
        npm_config_workspace: "packages/plugin-sdk",
        NPM_CONFIG_WORKSPACES: "true",
        npm_config_registry: "https://registry.npmjs.org/",
      },
      root
    );
    expect(env.PATH).toBe("/usr/bin");
    expect(env).not.toHaveProperty("npm_config_workspace");
    expect(env).not.toHaveProperty("NPM_CONFIG_WORKSPACES");
    expect(env.npm_config_registry).toBe("https://registry.npmjs.org/");
  });

  it("names every file a rebuilt tree adds, drops or changes", () => {
    const shipped = new Map([
      ["index.js", Buffer.from("a")],
      ["home.js", Buffer.from("b")],
      ["gone.js", Buffer.from("c")],
    ]);
    const rebuilt = new Map([
      ["index.js", Buffer.from("a")],
      ["home.js", Buffer.from("B")],
      ["new.js", Buffer.from("d")],
    ]);
    expect(treeDifferences(shipped, rebuilt)).toEqual(["gone.js", "home.js", "new.js"]);
    expect(treeDifferences(shipped, new Map(shipped))).toEqual([]);
  });
});
