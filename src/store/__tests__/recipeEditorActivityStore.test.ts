import { beforeEach, describe, expect, it } from "vitest";
import { useRecipeEditorActivityStore } from "../recipeEditorActivityStore";

describe("recipeEditorActivityStore (#9186)", () => {
  beforeEach(() => {
    useRecipeEditorActivityStore.setState({ openCount: 0 });
  });

  it("isOpen is false by default", () => {
    expect(useRecipeEditorActivityStore.getState().isOpen()).toBe(false);
  });

  it("enter/leave flip isOpen", () => {
    useRecipeEditorActivityStore.getState().enter();
    expect(useRecipeEditorActivityStore.getState().isOpen()).toBe(true);
    useRecipeEditorActivityStore.getState().leave();
    expect(useRecipeEditorActivityStore.getState().isOpen()).toBe(false);
  });

  it("nested enter calls require matching leave calls to release", () => {
    useRecipeEditorActivityStore.getState().enter();
    useRecipeEditorActivityStore.getState().enter();
    expect(useRecipeEditorActivityStore.getState().isOpen()).toBe(true);
    useRecipeEditorActivityStore.getState().leave();
    expect(useRecipeEditorActivityStore.getState().isOpen()).toBe(true);
    useRecipeEditorActivityStore.getState().leave();
    expect(useRecipeEditorActivityStore.getState().isOpen()).toBe(false);
  });

  it("leave never drives the counter negative", () => {
    useRecipeEditorActivityStore.getState().leave();
    useRecipeEditorActivityStore.getState().leave();
    useRecipeEditorActivityStore.getState().leave();
    expect(useRecipeEditorActivityStore.getState().openCount).toBe(0);
  });
});
