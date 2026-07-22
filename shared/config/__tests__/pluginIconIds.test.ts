import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PLUGIN_ICON_IDS, isPluginIconId } from "../pluginIconIds";

const MODULE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "pluginIconIds.ts"
);

describe("pluginIconIds", () => {
  it("stays free of renderer imports so the main-process bundle can't pull in React", () => {
    // `electron/` imports `shared/config/*` freely and `scripts/build-main.mjs`
    // bundles main without externalizing `lucide-react`, so a component import
    // here would land React in the Node-side output.
    const source = readFileSync(MODULE_PATH, "utf8");
    const importLines = source
      .split("\n")
      .filter((line) => /^\s*import\b/.test(line) || /\brequire\(/.test(line));

    expect(importLines).toEqual([]);
  });

  it("accepts every advertised id and rejects unrecognized ones", () => {
    for (const id of PLUGIN_ICON_IDS) {
      expect(isPluginIconId(id)).toBe(true);
    }

    expect(isPluginIconId("definitely-not-an-icon")).toBe(false);
    expect(isPluginIconId("")).toBe(false);
    // A near-miss on a real id must not pass — membership is exact, not fuzzy.
    expect(isPluginIconId("Terminal")).toBe(false);
  });

  it("advertises each id exactly once", () => {
    expect(new Set(PLUGIN_ICON_IDS).size).toBe(PLUGIN_ICON_IDS.length);
  });
});
