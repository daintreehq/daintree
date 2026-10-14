import { describe, expect, it } from "vitest";
import { findForbiddenKitReach, formatKitReach } from "./plugin-kit-graph-lib.mjs";

function meta(graph) {
  const inputs = {};
  for (const [file, imports] of Object.entries(graph)) {
    inputs[file] = {
      imports: imports.map((edge) =>
        typeof edge === "string" ? { path: edge, kind: "import-statement" } : edge
      ),
    };
  }
  return { inputs };
}

describe("findForbiddenKitReach", () => {
  it("passes a graph that stays inside the kit", () => {
    const { hits, moduleCount } = findForbiddenKitReach(
      meta({
        "src/pluginUi/index.ts": ["src/components/ui/button.tsx"],
        "src/components/ui/button.tsx": [
          { path: "react", kind: "import-statement", external: true },
        ],
      }),
      ["src/pluginUi/index.ts"]
    );
    expect(hits).toEqual([]);
    expect(moduleCount).toBe(2);
  });

  it("reports the shortest chain to each forbidden module", () => {
    const { hits } = findForbiddenKitReach(
      meta({
        "src/pluginUi/index.ts": ["src/a.ts", "src/b.ts"],
        "src/a.ts": ["src/c.ts"],
        "src/c.ts": ["src/hooks/index.ts"],
        "src/b.ts": ["src/hooks/index.ts", "src/clients/terminalClient.ts"],
        "src/hooks/index.ts": ["src/store/index.ts"],
        "src/store/index.ts": [],
        "src/clients/terminalClient.ts": [],
      }),
      ["src/pluginUi/index.ts"]
    );
    expect(hits.map((h) => h.chain)).toEqual([
      ["src/pluginUi/index.ts", "src/b.ts", "src/hooks/index.ts"],
      ["src/pluginUi/index.ts", "src/b.ts", "src/clients/terminalClient.ts"],
    ]);
    // Past a forbidden module the walk stops: the store barrel is its problem.
    expect(hits.some((h) => h.module === "src/store/index.ts")).toBe(false);
    expect(formatKitReach(hits)).toContain(
      "the @/hooks barrel: src/pluginUi/index.ts > src/b.ts > src/hooks/index.ts"
    );
  });

  it("follows dynamic imports, which a preview loads too", () => {
    const { hits } = findForbiddenKitReach(
      meta({
        "src/pluginUi/kit.tsx": [
          { path: "src/components/PluginKit/PluginKit.tsx", kind: "dynamic-import" },
        ],
        "src/components/PluginKit/PluginKit.tsx": ["src/services/ActionService.ts"],
        "src/services/ActionService.ts": [],
      }),
      ["src/pluginUi/kit.tsx"]
    );
    expect(hits.map((h) => h.label)).toEqual(["ActionService"]);
  });

  it("ignores stylesheet and asset edges", () => {
    const { hits } = findForbiddenKitReach(
      meta({
        "src/pluginUi/index.ts": [{ path: "src/registry/index.ts", kind: "import-rule" }],
        "src/registry/index.ts": [],
      }),
      ["src/pluginUi/index.ts"]
    );
    expect(hits).toEqual([]);
  });

  it("throws when an entry is missing from the metafile", () => {
    expect(() => findForbiddenKitReach(meta({}), ["src/pluginUi/index.ts"])).toThrow(
      /not in the metafile/
    );
  });
});
