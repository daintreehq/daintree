// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { TerminalRecipe } from "@shared/types";

const { getRecipesMock, onRecipesChangedMock, setPluginRecipesMock } = vi.hoisted(() => ({
  getRecipesMock: vi.fn(),
  onRecipesChangedMock: vi.fn(),
  setPluginRecipesMock: vi.fn(),
}));

vi.mock("@/clients", () => ({
  pluginRecipesClient: { getRecipes: getRecipesMock },
}));
vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: { getState: () => ({ setPluginRecipes: setPluginRecipesMock }) },
}));

import { usePluginRecipes } from "../usePluginRecipes";

const recipe = (id: string): TerminalRecipe => ({
  id,
  name: id,
  terminals: [{ type: "terminal" }],
  createdAt: 0,
  origin: { kind: "plugin", pluginId: "acme.tools", contributionId: id },
});

let pushListener: ((payload: { recipes: TerminalRecipe[]; complete: boolean }) => void) | null;

beforeEach(() => {
  vi.clearAllMocks();
  pushListener = null;
  (globalThis as unknown as { window: unknown }).window = Object.assign(globalThis.window ?? {}, {
    electron: {
      plugin: { getRecipes: getRecipesMock, onRecipesChanged: onRecipesChangedMock },
    },
  });
  getRecipesMock.mockResolvedValue([]);
  onRecipesChangedMock.mockImplementation((cb: typeof pushListener) => {
    pushListener = cb;
    return () => {};
  });
});

describe("usePluginRecipes (#11860)", () => {
  it("seeds the tier from the mount-time pull", async () => {
    getRecipesMock.mockResolvedValue([recipe("deploy")]);
    renderHook(() => usePluginRecipes());
    await waitFor(() =>
      expect(setPluginRecipesMock).toHaveBeenCalledWith([expect.objectContaining({ id: "deploy" })])
    );
  });

  it("replaces the tier wholesale on a push", async () => {
    renderHook(() => usePluginRecipes());
    await waitFor(() => expect(onRecipesChangedMock).toHaveBeenCalled());
    pushListener!({ recipes: [recipe("a"), recipe("b")], complete: true });
    expect(setPluginRecipesMock).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "a" }),
      expect.objectContaining({ id: "b" }),
    ]);
  });

  it("a slow mount-time pull cannot roll back a push that already landed", async () => {
    // Push is authoritative; without this guard a cached WebContentsView's
    // in-flight pull would reinstate a snapshot the broadcast superseded.
    let resolvePull!: (value: TerminalRecipe[]) => void;
    getRecipesMock.mockReturnValue(
      new Promise<TerminalRecipe[]>((resolve) => {
        resolvePull = resolve;
      })
    );
    renderHook(() => usePluginRecipes());
    await waitFor(() => expect(onRecipesChangedMock).toHaveBeenCalled());

    pushListener!({ recipes: [recipe("fresh")], complete: true });
    resolvePull([recipe("stale")]);
    await Promise.resolve();
    await Promise.resolve();

    const ids = setPluginRecipesMock.mock.calls.flatMap((call) =>
      (call[0] as TerminalRecipe[]).map((r) => r.id)
    );
    expect(ids).not.toContain("stale");
  });

  it("clears the tier on unmount", async () => {
    const { unmount } = renderHook(() => usePluginRecipes());
    await waitFor(() => expect(onRecipesChangedMock).toHaveBeenCalled());
    unmount();
    expect(setPluginRecipesMock).toHaveBeenLastCalledWith([]);
  });

  it("survives a failed pull without clearing the tier", async () => {
    getRecipesMock.mockRejectedValue(new Error("main not ready"));
    renderHook(() => usePluginRecipes());
    await waitFor(() => expect(onRecipesChangedMock).toHaveBeenCalled());
    expect(setPluginRecipesMock).not.toHaveBeenCalled();
  });
});
