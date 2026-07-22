import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PLUGIN_ICON_IDS, isPluginIconId } from "../pluginIconIds.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.join(HERE, "..", "pluginIconIds.ts");
const DOC_PATH = path.join(HERE, "..", "..", "..", "docs", "plugins", "contribution-points.md");

describe("pluginIconIds", () => {
  it("stays free of renderer imports so the main-process bundle can't pull in React", () => {
    // `electron/` imports `shared/config/*` freely and `scripts/build-main.mjs`
    // bundles main without externalizing `lucide-react`, so a component import
    // here would land React in the Node-side output.
    const source = readFileSync(MODULE_PATH, "utf8")
      // Strip comments first so prose mentioning `import` can't false-fail.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    // Static imports and side-effect imports, re-exports, dynamic import(),
    // and require() — the four ways a dependency can enter this module.
    const dependencyForms = [
      /^\s*import\s/m,
      /^\s*export\s[\s\S]*?\sfrom\s/m,
      /\bimport\s*\(/,
      /\brequire\s*\(/,
    ];

    for (const form of dependencyForms) {
      expect(source, `pluginIconIds.ts must stay dependency-free (matched ${form})`).not.toMatch(
        form
      );
    }
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

  it("matches the id list published to plugin authors", () => {
    // `docs/plugins/contribution-points.md` spells the ids out so authors don't
    // have to read TypeScript. That copy can drift silently — and an inaccurate
    // advertised list is the bug #11298 set out to fix — so pin them together.
    const doc = readFileSync(DOC_PATH, "utf8");
    const listLine = doc
      .split("\n")
      .find((line) => line.startsWith("`terminal`, `package`,") || line.includes("`monitor-play`"));

    expect(listLine, "icon id list not found in contribution-points.md").toBeDefined();
    const documented = [...listLine!.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]);

    expect([...documented].sort()).toEqual([...PLUGIN_ICON_IDS].sort());
  });
});
