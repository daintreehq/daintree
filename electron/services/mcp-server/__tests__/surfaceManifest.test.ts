import { describe, it, expect } from "vitest";
import type { ActionManifestEntry } from "../../../../shared/types/actions.js";
import { McpSurfaceResultSchema } from "../../../../shared/types/mcpSurface.js";
import { TIER_ALLOWLISTS, type McpTier } from "../shared.js";
import { shouldExposeTool } from "../tierAuth.js";
import {
  buildSurfaceManifest,
  MCP_SURFACE_MANIFEST_VERSION,
  MCP_SURFACE_TOOL_ID,
} from "../surfaceManifest.js";

const APP_VERSION = "9.9.9";

function entry(overrides: Partial<ActionManifestEntry> & { id: string }): ActionManifestEntry {
  return {
    name: overrides.id,
    title: "Title",
    description: "Description",
    category: "test",
    kind: "query",
    danger: "safe",
    enabled: true,
    requiresArgs: false,
    ...overrides,
  };
}

/**
 * A manifest covering every branch the builder can take, built from ids that are
 * really on the workbench/action/system rungs so the tier reporting is exercised
 * against the live allowlists rather than invented ones.
 */
function realisticManifest(): ActionManifestEntry[] {
  return [
    entry({ id: "actions.list" }),
    entry({ id: MCP_SURFACE_TOOL_ID }),
    entry({ id: "terminal.new", kind: "command" }),
    entry({ id: "git.commit", kind: "command", danger: "confirm" }),
  ];
}

describe("buildSurfaceManifest", () => {
  it("reports exactly the tools `tools/list` would expose at the same tier", () => {
    const manifest = [
      entry({ id: "actions.list" }),
      entry({ id: "terminal.new", kind: "command" }),
      entry({ id: "git.commit", kind: "command", danger: "confirm" }),
      entry({ id: "actions.persistedStores", mcpVisibility: "hidden" }),
      entry({ id: "actions.getContext", danger: "restricted" }),
      entry({ id: "not.a.real.tool" }),
    ];

    for (const tier of ["workbench", "action", "system", "external"] as const) {
      const expected = manifest
        .filter((e) => shouldExposeTool(e, tier))
        .map((e) => e.id)
        .sort();
      expect(buildSurfaceManifest(manifest, tier, APP_VERSION).tools.map((t) => t.id)).toEqual(
        expected
      );
    }
  });

  it("returns tools sorted by id regardless of manifest order", () => {
    const forward = realisticManifest();
    const reversed = [...forward].reverse();

    const a = buildSurfaceManifest(forward, "system", APP_VERSION);
    const b = buildSurfaceManifest(reversed, "system", APP_VERSION);

    expect(a.tools.map((t) => t.id)).toEqual([...a.tools.map((t) => t.id)].sort());
    expect(b.tools).toEqual(a.tools);
    expect(b.hash).toBe(a.hash);
  });

  it("stamps the shape version, app version, and caller tier", () => {
    const result = buildSurfaceManifest(realisticManifest(), "action", APP_VERSION);

    expect(result.manifestVersion).toBe(MCP_SURFACE_MANIFEST_VERSION);
    expect(result.appVersion).toBe(APP_VERSION);
    expect(result.tier).toBe("action");
  });

  it("satisfies the schema published as the tool's outputSchema", () => {
    for (const tier of ["workbench", "action", "system", "external"] as const) {
      const result = buildSurfaceManifest(realisticManifest(), tier, APP_VERSION);
      expect(McpSurfaceResultSchema.safeParse(result).success).toBe(true);
    }
  });
});

describe("per-tool tier", () => {
  it("reports the minimum in-app rung for a ladder caller", () => {
    const result = buildSurfaceManifest(realisticManifest(), "system", APP_VERSION);
    const byId = new Map(result.tools.map((t) => [t.id, t.tier]));

    // A `system` session sees all three rungs, and each tool reports the lowest
    // one that would still permit it — the demotion answer.
    expect(byId.get("actions.list")).toBe("workbench");
    expect(byId.get("terminal.new")).toBe("action");
    expect(byId.get("git.commit")).toBe("system");
  });

  it("reports `external` for every tool an external caller sees", () => {
    const result = buildSurfaceManifest(realisticManifest(), "external", APP_VERSION);

    expect(result.tools.length).toBeGreaterThan(0);
    expect(result.tools.every((t) => t.tier === "external")).toBe(true);
  });

  it("never reports a rung above the caller's own tier", () => {
    const order: Record<string, number> = { workbench: 0, action: 1, system: 2 };
    for (const tier of ["workbench", "action", "system"] as const) {
      const result = buildSurfaceManifest(realisticManifest(), tier, APP_VERSION);
      for (const tool of result.tools) {
        expect(order[tool.tier]).toBeLessThanOrEqual(order[tier]);
      }
    }
  });
});

describe("hints", () => {
  it("derives read-only and idempotent from kind, matching the tools/list annotations", () => {
    const manifest = [
      entry({ id: "actions.list", kind: "query" }),
      entry({ id: "terminal.new", kind: "command" }),
    ];
    const byId = new Map(
      buildSurfaceManifest(manifest, "system", APP_VERSION).tools.map((t) => [t.id, t])
    );

    expect(byId.get("actions.list")).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    expect(byId.get("terminal.new")).toMatchObject({ readOnlyHint: false, idempotentHint: false });
  });

  it("honors per-action annotation overrides", () => {
    const manifest = [
      entry({
        id: "terminal.new",
        kind: "command",
        mcpAnnotations: { readOnlyHint: true, idempotentHint: true },
      }),
    ];
    const [tool] = buildSurfaceManifest(manifest, "action", APP_VERSION).tools;

    expect(tool).toMatchObject({ readOnlyHint: true, idempotentHint: true });
  });
});

describe("deprecation", () => {
  it("omits the field for a tool that is not deprecated", () => {
    const [tool] = buildSurfaceManifest(
      [entry({ id: "actions.list" })],
      "workbench",
      APP_VERSION
    ).tools;

    expect(tool).not.toHaveProperty("deprecated");
  });

  it("reports reason and replacement when the manifest entry carries them", () => {
    const manifest = [
      entry({
        id: "actions.list",
        deprecated: { reason: "Superseded by ranked search", replacedBy: "actions.search" },
      }),
      entry({ id: "actions.search", deprecated: { reason: "No replacement" } }),
    ];
    const byId = new Map(
      buildSurfaceManifest(manifest, "workbench", APP_VERSION).tools.map((t) => [t.id, t])
    );

    expect(byId.get("actions.list")?.deprecated).toEqual({
      reason: "Superseded by ranked search",
      replacedBy: "actions.search",
    });
    expect(byId.get("actions.search")?.deprecated).toEqual({ reason: "No replacement" });
  });
});

describe("hash", () => {
  const hashOf = (manifest: ActionManifestEntry[], tier: McpTier = "system"): string =>
    buildSurfaceManifest(manifest, tier, APP_VERSION).hash;

  it("is a full lowercase hex sha256", () => {
    expect(hashOf(realisticManifest())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not depend on the app version", () => {
    const manifest = realisticManifest();
    expect(buildSurfaceManifest(manifest, "system", "1.0.0").hash).toBe(
      buildSurfaceManifest(manifest, "system", "2.0.0").hash
    );
  });

  it("changes when a tool joins or leaves the surface", () => {
    const base = realisticManifest();
    const widened = [...base, entry({ id: "recipe.run", kind: "command" })];

    expect(hashOf(widened)).not.toBe(hashOf(base));
    expect(hashOf(base.slice(1))).not.toBe(hashOf(base));
  });

  it("changes when a hint flips", () => {
    const base = realisticManifest();
    const flipped = base.map((e) =>
      e.id === "terminal.new" ? { ...e, mcpAnnotations: { idempotentHint: true } } : e
    );

    expect(hashOf(flipped)).not.toBe(hashOf(base));
  });

  it("changes when a tool becomes deprecated", () => {
    const base = realisticManifest();
    const deprecated = base.map((e) =>
      e.id === "actions.list" ? { ...e, deprecated: { reason: "Going away" } } : e
    );

    expect(hashOf(deprecated)).not.toBe(hashOf(base));
  });

  it("changes when an argument schema changes", () => {
    const withSchema = (properties: Record<string, unknown>): ActionManifestEntry[] => [
      entry({
        id: "actions.list",
        inputSchema: { type: "object", properties, required: Object.keys(properties) },
      }),
    ];

    expect(hashOf(withSchema({ limit: { type: "number" } }))).not.toBe(
      hashOf(withSchema({ limit: { type: "string" } }))
    );
  });

  it("changes when a result schema changes", () => {
    const withOutput = (properties: Record<string, unknown>): ActionManifestEntry[] => [
      entry({ id: "actions.list", outputSchema: { type: "object", properties } }),
    ];

    expect(hashOf(withOutput({ total: { type: "number" } }))).not.toBe(
      hashOf(withOutput({ total: { type: "string" } }))
    );
  });

  it("ignores description edits, so wording changes never read as drift", () => {
    const base = realisticManifest();
    const reworded = base.map((e) => ({
      ...e,
      description: `${e.description} — reworded`,
      title: "Renamed",
    }));

    expect(hashOf(reworded)).toBe(hashOf(base));
  });

  it("ignores the key order a schema generator happened to emit", () => {
    const ordered = (schema: Record<string, unknown>): ActionManifestEntry[] => [
      entry({ id: "actions.list", inputSchema: { type: "object", ...schema } }),
    ];

    expect(hashOf(ordered({ properties: { a: { type: "string" } }, required: ["a"] }))).toBe(
      hashOf(ordered({ required: ["a"], properties: { a: { type: "string" } } }))
    );
  });

  it("differs across tiers even when one surface is a subset of another", () => {
    const manifest = realisticManifest();

    const hashes = (["workbench", "action", "system", "external"] as const).map((t) =>
      hashOf(manifest, t)
    );
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

describe("tier allowlist registration", () => {
  it("is reachable from every in-app tier and from external", () => {
    for (const tier of ["workbench", "action", "system", "external"] as const) {
      expect(TIER_ALLOWLISTS[tier].has(MCP_SURFACE_TOOL_ID)).toBe(true);
    }
  });
});
