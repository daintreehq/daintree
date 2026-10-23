import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { PUBLISH_WORKSPACES, classifySubpath, exportTargets } from "./packages-consumer-smoke.mjs";

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
});
