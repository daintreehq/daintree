import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPluginRecipeRegistry,
  getPluginRecipe,
  getPluginRecipeOwner,
  getPluginRecipeQualifiedIdsByPlugin,
  getPluginRecipes,
  registerPluginRecipes,
  setPluginRecipeMetadataSnapshot,
  unregisterPluginRecipes,
} from "../PluginRecipeRegistry.js";
import type { RecipeContribution } from "../../../../shared/types/plugin.js";

const recipe = (overrides: Partial<RecipeContribution> = {}): RecipeContribution => ({
  id: "deploy",
  name: "Deploy stack",
  terminals: [{ type: "terminal", command: "npm run dev" }],
  ...overrides,
});

beforeEach(() => {
  clearPluginRecipeRegistry();
});

describe("PluginRecipeRegistry (#11860)", () => {
  it("qualifies ids and stamps provenance as real fields", () => {
    registerPluginRecipes("acme.tools", [recipe()], new Set());
    const [registered] = getPluginRecipes();
    expect(registered?.id).toBe("acme.tools.deploy");
    // The id cannot be split back into its halves — a plugin id is itself
    // dotted — so provenance has to be carried, not derived (#10109).
    expect(registered?.origin).toEqual({
      kind: "plugin",
      pluginId: "acme.tools",
      contributionId: "deploy",
    });
  });

  it("keeps two plugins' same-named contributions distinct", () => {
    // A bare contribution id is unique only per-plugin (#10109), so both must
    // survive under their own qualified ids — asserting only that the second
    // resolves would still pass if it had clobbered the first.
    registerPluginRecipes("acme.tools", [recipe()], new Set());
    registerPluginRecipes("other.tools", [recipe()], new Set());
    expect(
      getPluginRecipes()
        .map((r) => r.id)
        .sort()
    ).toEqual(["acme.tools.deploy", "other.tools.deploy"]);
    expect(getPluginRecipeOwner("acme.tools.deploy")?.pluginId).toBe("acme.tools");
    expect(getPluginRecipeOwner("other.tools.deploy")?.pluginId).toBe("other.tools");
  });

  it("admits an agent type the same plugin owns and drops one it does not", () => {
    registerPluginRecipes(
      "acme.tools",
      [
        recipe({
          id: "mixed",
          terminals: [
            { type: "acme-agent", initialPrompt: "go" },
            { type: "someone-elses-agent", initialPrompt: "go" },
            { type: "terminal", command: "ls" },
          ],
        }),
      ],
      new Set(["acme-agent"])
    );
    const types = getPluginRecipe("acme.tools.mixed")?.terminals.map((t) => t.type);
    expect(types).toEqual(["acme-agent", "terminal"]);
  });

  it("skips a contribution whose terminals all fail content validation", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerPluginRecipes(
      "acme.tools",
      [
        recipe({ id: "bad", terminals: [{ type: "terminal", command: "echo hi\nrm -rf /" }] }),
        recipe({ id: "good" }),
      ],
      new Set()
    );
    expect(getPluginRecipes().map((r) => r.id)).toEqual(["acme.tools.good"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("overlays sidecar metadata over the manifest defaults", () => {
    registerPluginRecipes(
      "acme.tools",
      [recipe({ showInEmptyState: true, autoAssign: "always" })],
      new Set()
    );
    expect(getPluginRecipe("acme.tools.deploy")?.showInEmptyState).toBe(true);

    setPluginRecipeMetadataSnapshot({
      "acme.tools.deploy": {
        pluginId: "acme.tools",
        contributionId: "deploy",
        showInEmptyState: false,
        autoAssign: "never",
        lastUsedAt: 42,
        usageHistory: [41, 42],
      },
    });
    const overlaid = getPluginRecipe("acme.tools.deploy");
    // A user override of `false` must beat a manifest default of `true` —
    // `??` semantics, not `||`.
    expect(overlaid?.showInEmptyState).toBe(false);
    expect(overlaid?.autoAssign).toBe("never");
    expect(overlaid?.lastUsedAt).toBe(42);
    expect(overlaid?.usageHistory).toEqual([41, 42]);
  });

  it("re-registration replaces only that plugin's entries", () => {
    registerPluginRecipes("acme.tools", [recipe({ id: "one" }), recipe({ id: "two" })], new Set());
    registerPluginRecipes("other.tools", [recipe({ id: "keep" })], new Set());
    registerPluginRecipes("acme.tools", [recipe({ id: "one" })], new Set());
    expect(
      getPluginRecipes()
        .map((r) => r.id)
        .sort()
    ).toEqual(["acme.tools.one", "other.tools.keep"]);
  });

  it("unregistering one plugin leaves the others addressable", () => {
    registerPluginRecipes("acme.tools", [recipe()], new Set());
    registerPluginRecipes("other.tools", [recipe({ id: "keep" })], new Set());
    unregisterPluginRecipes("acme.tools");
    expect(getPluginRecipeOwner("acme.tools.deploy")).toBeUndefined();
    expect(getPluginRecipeOwner("other.tools.keep")).toBeDefined();
    expect(getPluginRecipeQualifiedIdsByPlugin().has("acme.tools")).toBe(false);
  });

  it("hands out copies, so a consumer cannot mutate the registry through a snapshot", () => {
    registerPluginRecipes(
      "acme.tools",
      [recipe({ terminals: [{ type: "terminal", command: "npm run dev", env: { API: "a" } }] })],
      new Set()
    );
    const first = getPluginRecipes()[0]!;
    first.terminals[0]!.command = "rm -rf /";
    first.name = "Mutated";
    // Nested too: a shallow spread would leave the same env object reachable,
    // so one consumer could rewrite every later reader's environment.
    first.terminals[0]!.env!.API = "stolen";

    const second = getPluginRecipes()[0]!;
    expect(second.terminals[0]?.command).toBe("npm run dev");
    expect(second.name).toBe("Deploy stack");
    expect(second.terminals[0]?.env).toEqual({ API: "a" });
  });
});
