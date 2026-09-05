import { afterEach, describe, expect, it } from "vitest";
import { useRecipeConflictStore, type RecipeConflictRequest } from "../recipeConflictStore";

const baseRequest = (recipeId: string): RecipeConflictRequest => ({
  recipeId,
  recipeName: `Recipe ${recipeId}`,
  updates: { name: `Recipe ${recipeId}` },
  reason: "stale",
});

afterEach(() => {
  // Release any leaked awaiter so it can't bleed into the next test.
  if (useRecipeConflictStore.getState().pendingConflict) {
    useRecipeConflictStore.getState().resolveConflict("cancel");
  }
});

describe("recipeConflictStore", () => {
  it("resolves the awaited Promise with the chosen resolution", async () => {
    const pending = useRecipeConflictStore.getState().requestConflict(baseRequest("a"));
    expect(useRecipeConflictStore.getState().pendingConflict?.recipeId).toBe("a");

    useRecipeConflictStore.getState().resolveConflict("overwrite");
    await expect(pending).resolves.toBe("overwrite");
    expect(useRecipeConflictStore.getState().pendingConflict).toBeNull();
  });

  it("cancels a prior pending request (resolves it 'cancel') when a new one arrives", async () => {
    const first = useRecipeConflictStore.getState().requestConflict(baseRequest("a"));
    const second = useRecipeConflictStore.getState().requestConflict(baseRequest("b"));

    await expect(first).resolves.toBe("cancel");
    expect(useRecipeConflictStore.getState().pendingConflict?.recipeId).toBe("b");

    useRecipeConflictStore.getState().resolveConflict("reload");
    await expect(second).resolves.toBe("reload");
  });

  it("resolveConflict is a no-op when nothing is pending", () => {
    expect(() => useRecipeConflictStore.getState().resolveConflict("reload")).not.toThrow();
    expect(useRecipeConflictStore.getState().pendingConflict).toBeNull();
  });

  describe("requestSeq (ErrorBoundary reset signal, #9918)", () => {
    it("strictly increases on each request, including back-to-back supersede", () => {
      const before = useRecipeConflictStore.getState().requestSeq;

      useRecipeConflictStore.getState().requestConflict(baseRequest("a"));
      const afterFirst = useRecipeConflictStore.getState().requestSeq;
      expect(afterFirst).toBeGreaterThan(before);

      // Supersede without resolving in between — `pendingConflict` never returns
      // to null, so the counter (not a boolean toggle) is what changes.
      useRecipeConflictStore.getState().requestConflict(baseRequest("b"));
      const afterSecond = useRecipeConflictStore.getState().requestSeq;
      expect(afterSecond).toBeGreaterThan(afterFirst);
    });

    it("does not change when a pending request is resolved", () => {
      useRecipeConflictStore.getState().requestConflict(baseRequest("a"));
      const afterRequest = useRecipeConflictStore.getState().requestSeq;

      useRecipeConflictStore.getState().resolveConflict("reload");
      expect(useRecipeConflictStore.getState().requestSeq).toBe(afterRequest);
    });
  });
});
