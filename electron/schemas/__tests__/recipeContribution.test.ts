import { describe, expect, it } from "vitest";
import { getPluginManifestSchema, MANIFEST_CONTRIBUTION_CAPS } from "../plugin.js";
import { MAX_TERMINALS_PER_RECIPE } from "../../../shared/utils/recipeSanitizer.js";

function parseManifest(contributes: Record<string, unknown>, capabilities: string[] = []) {
  return getPluginManifestSchema(false).safeParse({
    name: "acme.recipes-test",
    version: "1.0.0",
    capabilities,
    contributes,
  });
}

const terminal = (overrides: Record<string, unknown> = {}) => ({
  type: "terminal",
  command: "npm run dev",
  ...overrides,
});

const recipe = (i: number, overrides: Record<string, unknown> = {}) => ({
  id: `recipe-${i}`,
  name: `Recipe ${i}`,
  terminals: [terminal()],
  ...overrides,
});

describe("contributes.recipes manifest shape (#11860)", () => {
  it("accepts a recipe contribution with no capability declared", () => {
    // Recipes follow the `skills` precedent: inert declarative content, so
    // requiring a capability would gate nothing an unsandboxed runtime enforces.
    // Contrast `agents`, which does require `agent:register`.
    const result = parseManifest({ recipes: [recipe(1)] });
    expect(result.success).toBe(true);
    const agentsWithoutCapability = parseManifest({
      agents: [{ id: "acme-agent", name: "Acme", command: "acme" }],
    });
    expect(agentsWithoutCapability.success).toBe(false);
  });

  it("materializes an empty recipes array for a manifest that declares none", () => {
    const result = parseManifest({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.contributes.recipes).toEqual([]);
  });

  it("rejects unknown fields on the contribution and on a terminal", () => {
    expect(parseManifest({ recipes: [recipe(1, { scope: "inrepo" })] }).success).toBe(false);
    expect(
      parseManifest({ recipes: [recipe(1, { terminals: [terminal({ location: "dock" })] })] })
        .success
    ).toBe(false);
  });

  it("rejects the transient per-launch fields a recipe editor strips on persist", () => {
    // agentModelId / agentLaunchFlags are session state — accepting them in a
    // manifest would advertise a field the registry silently drops.
    for (const field of ["agentModelId", "agentLaunchFlags"]) {
      const result = parseManifest({
        recipes: [recipe(1, { terminals: [terminal({ [field]: "x" })] })],
      });
      expect(result.success, field).toBe(false);
    }
  });

  it("requires at least one terminal and stops at the shared per-recipe cap", () => {
    expect(parseManifest({ recipes: [recipe(1, { terminals: [] })] }).success).toBe(false);
    const atCap = Array.from({ length: MAX_TERMINALS_PER_RECIPE }, () => terminal());
    expect(parseManifest({ recipes: [recipe(1, { terminals: atCap })] }).success).toBe(true);
    expect(
      parseManifest({ recipes: [recipe(1, { terminals: [...atCap, terminal()] })] }).success
    ).toBe(false);
  });

  it("bounds the recipe array by its own cap", () => {
    const cap = MANIFEST_CONTRIBUTION_CAPS.recipes;
    expect(
      parseManifest({ recipes: Array.from({ length: cap }, (_, i) => recipe(i)) }).success
    ).toBe(true);
    expect(
      parseManifest({ recipes: Array.from({ length: cap + 1 }, (_, i) => recipe(i)) }).success
    ).toBe(false);
  });

  it("rejects two recipes sharing an id within one manifest", () => {
    // A duplicate would first-wins silently in the registry's qualified-id map,
    // so the second contribution would vanish with no diagnostic.
    const result = parseManifest({ recipes: [recipe(1), recipe(1)] });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.some((issue) => issue.path.join(".").startsWith("contributes.recipes"))
    ).toBe(true);
  });

  it("keeps the metadata defaults a plugin declares", () => {
    const result = parseManifest({
      recipes: [recipe(1, { showInEmptyState: true, autoAssign: "never" })],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const parsed = result.data.contributes.recipes[0]!;
    expect(parsed.showInEmptyState).toBe(true);
    expect(parsed.autoAssign).toBe("never");
    expect(parseManifest({ recipes: [recipe(1, { autoAssign: "sometimes" })] }).success).toBe(
      false
    );
  });
});
