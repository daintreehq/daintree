import { describe, it, expect } from "vitest";
import type { ActionManifestEntry } from "../../../../shared/types/actions.js";
import { McpSurfaceResultSchema } from "../../../../shared/types/mcpSurface.js";
import { TIER_ALLOWLISTS, type McpTier } from "../shared.js";
import { shouldExposeTool } from "../tierAuth.js";
import { buildSurfaceManifest, MCP_SURFACE_TOOL_ID } from "../surfaceManifest.js";

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

  it("stamps a usable shape version, the app version it was given, and the caller tier", () => {
    const result = buildSurfaceManifest(realisticManifest(), "action", APP_VERSION);

    // Asserting equality against the imported constant would compare the
    // implementation with itself. What a client needs is that the field is a
    // version it can compare — a positive integer, not a float or a string.
    expect(Number.isInteger(result.manifestVersion)).toBe(true);
    expect(result.manifestVersion).toBeGreaterThan(0);
    expect(result.appVersion).toBe(APP_VERSION);
    expect(result.tier).toBe("action");
  });

  it("returns an empty, still-valid surface for an empty manifest", () => {
    const result = buildSurfaceManifest([], "workbench", APP_VERSION);

    expect(result.tools).toEqual([]);
    expect(McpSurfaceResultSchema.safeParse(result).success).toBe(true);
    // A zero-tool surface is a real answer, so its hash must still be a hash.
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("advertises exactly the top-level fields the published schema declares", () => {
    // Cross-layer: the builder's own output against the schema shipped as the
    // tool's outputSchema. A field added to one and not the other is the drift
    // this catches — neither side is a copy of the other.
    const advertised = Object.keys(McpSurfaceResultSchema.shape).sort();
    const emitted = Object.keys(
      buildSurfaceManifest(realisticManifest(), "system", APP_VERSION)
    ).sort();

    expect(emitted).toEqual(advertised);
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

    // Derived from the live allowlists rather than hardcoded, so moving a tool
    // between rungs cannot make this pass by being edited in lockstep. The
    // invariant: the reported rung permits the tool, and every rung below it
    // does not — that is what "minimum" means, and it is the demotion answer.
    const rungs = ["workbench", "action", "system"] as const;
    expect(result.tools.length).toBeGreaterThan(0);
    for (const tool of result.tools) {
      const reported = rungs.indexOf(tool.tier as (typeof rungs)[number]);
      expect(reported).toBeGreaterThanOrEqual(0);
      expect(TIER_ALLOWLISTS[rungs[reported]!].has(tool.id)).toBe(true);
      for (const lower of rungs.slice(0, reported)) {
        expect(TIER_ALLOWLISTS[lower].has(tool.id)).toBe(false);
      }
    }
    // Guard the guard: an all-workbench fixture would satisfy the loop
    // vacuously, so prove the fixture actually spans rungs.
    expect(new Set(result.tools.map((t) => t.tier)).size).toBeGreaterThan(1);
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

  it("overrides the two hints independently", () => {
    // Both hints default off `kind`, so a bug that coupled them would survive
    // any test that only ever moves them together.
    const oneOverride = (mcpAnnotations: Record<string, boolean>) =>
      buildSurfaceManifest(
        [entry({ id: "terminal.new", kind: "command", mcpAnnotations })],
        "action",
        APP_VERSION
      ).tools[0]!;

    expect(oneOverride({ readOnlyHint: true })).toMatchObject({
      readOnlyHint: true,
      idempotentHint: false,
    });
    expect(oneOverride({ idempotentHint: true })).toMatchObject({
      readOnlyHint: false,
      idempotentHint: true,
    });
  });

  it("honors an override that turns a hint OFF for a query", () => {
    // `false` must beat the kind-derived default, not be swallowed as absent by
    // a `??`-style fallback.
    const [tool] = buildSurfaceManifest(
      [entry({ id: "actions.list", kind: "query", mcpAnnotations: { idempotentHint: false } })],
      "workbench",
      APP_VERSION
    ).tools;

    expect(tool).toMatchObject({ readOnlyHint: true, idempotentHint: false });
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

  it("changes when a tool starts requiring host confirmation", () => {
    // `safe` → `confirm` rewrites the invocation contract — the call now blocks
    // on a user dialog — while leaving every reported field identical. A client
    // that trusted the hash to spot that would be silently wrong.
    const base = [entry({ id: "actions.list" })];
    const gated = [entry({ id: "actions.list", danger: "confirm" })];

    expect(hashOf(gated, "workbench")).not.toBe(hashOf(base, "workbench"));
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

  it("ignores prose INSIDE a schema, down to nested properties", () => {
    // Argument descriptions reach the wire through the same JSON Schema the
    // hash covers, and they are maintained continuously — hashing them would
    // reintroduce exactly the churn the tool-level exclusion prevents.
    const schema = (prose: string): ActionManifestEntry[] => [
      entry({
        id: "actions.list",
        inputSchema: {
          type: "object",
          description: prose,
          properties: {
            limit: { type: "number", description: prose, title: prose },
            nested: {
              type: "object",
              properties: { deep: { type: "string", description: prose } },
            },
          },
          required: ["limit"],
        },
      }),
    ];

    expect(hashOf(schema("before"))).toBe(hashOf(schema("after")));
  });

  it("still hashes a PROPERTY named description, which is contract not prose", () => {
    // The annotation slot and a field that happens to be called `description`
    // live one level apart; stripping by name alone would erase the field.
    const withProperty = (type: string): ActionManifestEntry[] => [
      entry({
        id: "actions.list",
        inputSchema: { type: "object", properties: { description: { type } } },
      }),
    ];

    expect(hashOf(withProperty("string"))).not.toBe(hashOf(withProperty("number")));
  });

  it("ignores the order a generator emitted `required` in", () => {
    // `required` is a set in JSON Schema semantics; its order is an artifact.
    const req = (required: string[]): ActionManifestEntry[] => [
      entry({
        id: "actions.list",
        inputSchema: {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "string" } },
          required,
        },
      }),
    ];

    expect(hashOf(req(["a", "b"]))).toBe(hashOf(req(["b", "a"])));
  });

  it("still distinguishes a reordered `enum`, whose order is not an artifact", () => {
    const withEnum = (values: string[]): ActionManifestEntry[] => [
      entry({
        id: "actions.list",
        inputSchema: { type: "object", properties: { mode: { enum: values } } },
      }),
    ];

    // A deliberate conservative choice, not an oversight. `enum` validates as a
    // set, so sorting it would arguably be defensible — but normalising is the
    // dangerous direction: an over-sensitive hash costs a client one re-read,
    // while an over-normalised one hides a real change permanently. `required`
    // is normalised because its order is purely a generator artifact; `enum`
    // order is authored, reaches the model verbatim, and stays significant.
    expect(hashOf(withEnum(["a", "b"]))).not.toBe(hashOf(withEnum(["b", "a"])));
  });

  it("pins the published digest for a frozen surface", () => {
    // The hash is a client-facing contract: a refactor that changed every
    // digest would keep every relative assertion above green while silently
    // breaking every client that stored one. This fixture is deliberately
    // hand-frozen — update it only alongside a MCP_SURFACE_MANIFEST_VERSION
    // bump and a note in the PR, never to make a failing run pass.
    const frozen: ActionManifestEntry[] = [
      entry({
        id: "actions.list",
        kind: "query",
        danger: "safe",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "number" } },
          required: ["limit"],
        },
      }),
      entry({ id: "terminal.new", kind: "command", danger: "safe" }),
    ];

    expect(buildSurfaceManifest(frozen, "action", APP_VERSION).hash).toBe(
      "00c81d0089fa582bd988cf8fa8280cd703b69b523846f190b5fce5cf2340055b"
    );
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

// Registration is not asserted here: mirroring the allowlist arrays would only
// restate them. The real guard is that `tools/list` serves `mcp.surface` at
// every tier, which sessionServer.test.ts checks against the live handler.

describe("buildSurfaceManifest with a workspace-bound session (#11789)", () => {
  const BOUND = { workspaceBound: true };

  it("omits confirm-gated tools a bound external session cannot reach", () => {
    const manifest = [
      entry({ id: "actions.list" }),
      entry({ id: "recipe.run", kind: "command", danger: "confirm" }),
    ];

    const unbound = buildSurfaceManifest(manifest, "external", APP_VERSION);
    const bound = buildSurfaceManifest(manifest, "external", APP_VERSION, BOUND);

    expect(unbound.tools.map((t) => t.id)).toContain("recipe.run");
    expect(bound.tools.map((t) => t.id)).not.toContain("recipe.run");
    expect(bound.tools.map((t) => t.id)).toContain("actions.list");
  });

  it("reports exactly what `tools/list` would expose for the same session", () => {
    // The invariant the shared `shouldExposeTool` gate exists to hold: a report
    // that advertised a tool the listing withheld is the drift it detects.
    const manifest = realisticManifest();
    const reported = buildSurfaceManifest(manifest, "external", APP_VERSION, BOUND).tools.map(
      (t) => t.id
    );
    const listed = manifest
      .filter((e) => shouldExposeTool(e, "external", BOUND))
      .map((e) => e.id)
      .sort();

    expect(reported).toEqual(listed);
  });

  it("changes the hash when the bound surface differs from the unbound one", () => {
    const manifest = [
      entry({ id: "actions.list" }),
      entry({ id: "recipe.run", kind: "command", danger: "confirm" }),
    ];

    expect(buildSurfaceManifest(manifest, "external", APP_VERSION, BOUND).hash).not.toBe(
      buildSurfaceManifest(manifest, "external", APP_VERSION).hash
    );
  });

  it("leaves the unbound output identical to the pre-binding shape", () => {
    const manifest = realisticManifest();
    expect(
      buildSurfaceManifest(manifest, "external", APP_VERSION, { workspaceBound: false })
    ).toEqual(buildSurfaceManifest(manifest, "external", APP_VERSION));
  });

  it("does not narrow a non-external tier, so the pinned Assistant is unaffected", () => {
    const manifest = realisticManifest();
    for (const tier of ["workbench", "action", "system"] as const) {
      expect(buildSurfaceManifest(manifest, tier, APP_VERSION, BOUND)).toEqual(
        buildSurfaceManifest(manifest, tier, APP_VERSION)
      );
    }
  });
});
