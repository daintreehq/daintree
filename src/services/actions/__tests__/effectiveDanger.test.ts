import { describe, expect, it } from "vitest";
import { dispatchCarriesRecipeId, resolveEffectiveActionDanger } from "../effectiveDanger";

describe("resolveEffectiveActionDanger (#11860)", () => {
  it("elevates a safe action to confirm when an agent names a recipe", () => {
    expect(resolveEffectiveActionDanger("safe", "agent", { recipeId: "r1" })).toBe("confirm");
  });

  it("leaves the same action alone when the agent names no recipe", () => {
    // This is the whole reason the gate is args-conditional: bumping the
    // declared danger would confirmation-gate every plain worktree creation.
    expect(resolveEffectiveActionDanger("safe", "agent", { branchName: "feat/x" })).toBe("safe");
    expect(resolveEffectiveActionDanger("safe", "agent", undefined)).toBe("safe");
  });

  it("does not elevate for user or plugin sources", () => {
    // A user IS the confirmation. A plugin has no confirm bypass at all, so it
    // is rejected outright by its action's own guard rather than prompted.
    expect(resolveEffectiveActionDanger("safe", "user", { recipeId: "r1" })).toBe("safe");
    expect(resolveEffectiveActionDanger("safe", "plugin", { recipeId: "r1" })).toBe("safe");
  });

  it("never lowers a tier the definition declared for itself", () => {
    for (const source of ["user", "agent", "plugin"] as const) {
      expect(resolveEffectiveActionDanger("confirm", source, {})).toBe("confirm");
      expect(resolveEffectiveActionDanger("restricted", source, { recipeId: "r1" })).toBe(
        "restricted"
      );
    }
  });
});

describe("dispatchCarriesRecipeId", () => {
  it("accepts only a non-empty string id", () => {
    expect(dispatchCarriesRecipeId({ recipeId: "r1" })).toBe(true);
    expect(dispatchCarriesRecipeId({ recipeId: "" })).toBe(false);
    expect(dispatchCarriesRecipeId({ recipeId: 7 })).toBe(false);
    expect(dispatchCarriesRecipeId({ recipeId: null })).toBe(false);
    expect(dispatchCarriesRecipeId({ recipeId: undefined })).toBe(false);
  });

  it("ignores non-object argument shapes", () => {
    for (const args of [undefined, null, "recipeId", 42, ["recipeId"]]) {
      expect(dispatchCarriesRecipeId(args)).toBe(false);
    }
  });

  it("still gates on a recipeId reached through the prototype chain", () => {
    // Fail-safe direction: an inherited id elevates to confirm rather than
    // slipping past. Under-gating is the failure that matters here.
    const args = Object.create({ recipeId: "inherited" }) as Record<string, unknown>;
    expect(dispatchCarriesRecipeId(args)).toBe(true);
  });
});
