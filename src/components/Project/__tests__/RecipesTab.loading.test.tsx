// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StrictMode } from "react";
import { act, render, screen } from "@testing-library/react";
import type { TerminalRecipe } from "@/types";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";

const { mockRecipes, mockIsLoading, mockLoadRecipes } = vi.hoisted(() => ({
  mockRecipes: { value: [] as TerminalRecipe[] },
  mockIsLoading: { value: false },
  mockLoadRecipes: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: () => ({
    recipes: mockRecipes.value,
    isLoading: mockIsLoading.value,
    loadRecipes: mockLoadRecipes,
    exportRecipe: vi.fn().mockReturnValue(""),
  }),
}));

vi.mock("@/components/TerminalRecipe/RecipeEditor", () => ({
  RecipeEditor: () => null,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

import { RecipesTab } from "../RecipesTab";

const makeRecipe = (id: string, name: string): TerminalRecipe => ({
  id,
  name,
  terminals: [],
  createdAt: 0,
});

function tab(projectId: string, isOpen = true, defaultWorktreeRecipeId?: string) {
  return (
    <RecipesTab
      projectId={projectId}
      defaultWorktreeRecipeId={defaultWorktreeRecipeId}
      onDefaultWorktreeRecipeIdChange={vi.fn()}
      worktreeMap={new Map()}
      isOpen={isOpen}
    />
  );
}

type Rerender = (ui: React.ReactElement) => void;

// The store raises isLoading synchronously inside loadRecipes and drops it when
// the read settles; a fixture that skips that cycle can't tell the old
// loaded-flag effect from the new request effect.
function runLoad(rerender: Rerender, projectId: string) {
  mockIsLoading.value = true;
  rerender(tab(projectId));
  mockIsLoading.value = false;
  rerender(tab(projectId));
}

describe("RecipesTab — loading", () => {
  beforeEach(() => {
    mockRecipes.value = [];
    mockIsLoading.value = false;
    mockLoadRecipes.mockClear();
    mockLoadRecipes.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("load requests", () => {
    it("loads the open project once, not again when its own load settles", () => {
      const { rerender } = render(tab("proj-1"));
      expect(mockLoadRecipes).toHaveBeenCalledTimes(1);
      expect(mockLoadRecipes).toHaveBeenLastCalledWith("proj-1");

      mockIsLoading.value = true;
      rerender(tab("proj-1"));
      mockIsLoading.value = false;
      rerender(tab("proj-1"));

      expect(mockLoadRecipes).toHaveBeenCalledTimes(1);
    });

    it("loads the new project after the first project's load has settled", () => {
      const { rerender } = render(tab("proj-1"));
      runLoad(rerender, "proj-1");
      mockLoadRecipes.mockClear();

      rerender(tab("proj-2"));

      expect(mockLoadRecipes).toHaveBeenCalledTimes(1);
      expect(mockLoadRecipes).toHaveBeenLastCalledWith("proj-2");
    });

    it("loads the new project once even when another load is in flight at the switch", () => {
      const { rerender } = render(tab("proj-1"));
      mockLoadRecipes.mockClear();

      mockIsLoading.value = true;
      rerender(tab("proj-2"));
      expect(mockLoadRecipes).toHaveBeenLastCalledWith("proj-2");

      mockIsLoading.value = false;
      rerender(tab("proj-2"));
      expect(mockLoadRecipes).toHaveBeenCalledTimes(1);
    });

    it("loads again when the tab is reopened", () => {
      const { rerender } = render(tab("proj-1"));
      rerender(tab("proj-1", false));
      mockLoadRecipes.mockClear();

      rerender(tab("proj-1", true));

      expect(mockLoadRecipes).toHaveBeenCalledTimes(1);
      expect(mockLoadRecipes).toHaveBeenLastCalledWith("proj-1");
    });

    it("requests each project on a switch and back", () => {
      const { rerender } = render(tab("proj-1"));
      runLoad(rerender, "proj-1");
      rerender(tab("proj-2"));
      runLoad(rerender, "proj-2");
      rerender(tab("proj-1"));

      expect(mockLoadRecipes.mock.calls).toEqual([["proj-1"], ["proj-2"], ["proj-1"]]);
    });

    it("loads the project that is current when a closed tab reopens", () => {
      const { rerender } = render(tab("proj-1"));
      rerender(tab("proj-1", false));
      rerender(tab("proj-2", false));
      expect(mockLoadRecipes).toHaveBeenCalledTimes(1);

      rerender(tab("proj-2", true));

      expect(mockLoadRecipes).toHaveBeenCalledTimes(2);
      expect(mockLoadRecipes).toHaveBeenLastCalledWith("proj-2");
    });

    it("requests once when React replays the mount effects", () => {
      render(<StrictMode>{tab("proj-1")}</StrictMode>);

      expect(mockLoadRecipes).toHaveBeenCalledTimes(1);
    });

    it("does not load while closed", () => {
      render(tab("proj-1", false));
      expect(mockLoadRecipes).not.toHaveBeenCalled();
    });
  });

  describe("while a load is pending", () => {
    it("keeps cached recipes and the Add recipe button on screen", () => {
      mockRecipes.value = [makeRecipe("r1", "Cached recipe")];
      mockIsLoading.value = true;

      render(tab("proj-1"));

      expect(screen.getByText("Cached recipe")).toBeTruthy();
      expect(screen.getByRole("button", { name: /add recipe/i })).toBeTruthy();
      expect(screen.queryByRole("status", { name: /loading recipes/i })).toBeNull();
    });

    it("keeps the same Add recipe button, and its focus, through a reload", () => {
      vi.useFakeTimers();
      mockRecipes.value = [makeRecipe("r1", "Cached recipe")];
      const { rerender } = render(tab("proj-1"));
      const addButton = screen.getByRole("button", { name: /add recipe/i });
      addButton.focus();

      mockIsLoading.value = true;
      rerender(tab("proj-1"));
      act(() => {
        vi.advanceTimersByTime(UI_DOHERTY_THRESHOLD * 2);
      });

      expect(screen.getByRole("button", { name: /add recipe/i })).toBe(addButton);
      expect(document.activeElement).toBe(addButton);
      expect(screen.getByText("Cached recipe")).toBeTruthy();
      expect(screen.queryByRole("status", { name: /loading recipes/i })).toBeNull();
    });

    it("keeps the dangling-default warning hidden while cached recipes reload", () => {
      mockRecipes.value = [makeRecipe("r1", "Cached recipe")];
      mockIsLoading.value = true;

      render(tab("proj-1", true, "missing-recipe-id"));

      expect(screen.queryByText(/default recipe unavailable/i)).toBeNull();
    });

    it("shows neither a skeleton nor the empty state before the 400ms gate", () => {
      vi.useFakeTimers();
      mockIsLoading.value = true;

      render(tab("proj-1"));
      act(() => {
        vi.advanceTimersByTime(399);
      });

      expect(screen.queryByRole("status", { name: /loading recipes/i })).toBeNull();
      expect(screen.queryByText(/add a recipe to open a set of terminals/i)).toBeNull();
    });

    it("shows the skeleton once the gate elapses, still without the empty state", () => {
      vi.useFakeTimers();
      mockIsLoading.value = true;

      render(tab("proj-1"));
      act(() => {
        vi.advanceTimersByTime(400);
      });

      const status = screen.getByRole("status", { name: /loading recipes/i });
      expect(screen.queryByText(/add a recipe to open a set of terminals/i)).toBeNull();
      // The gate has already spent the 400ms wait. Bones that kept their own
      // CSS delay would stay invisible for 400ms more, leaving a visible
      // loading region with nothing drawn in it.
      expect(status.querySelector(".animate-pulse-immediate")).not.toBeNull();
      expect(status.querySelector(".animate-pulse-delayed")).toBeNull();
    });

    it("starts the next project's 400ms gate afresh after rows replaced a skeleton", () => {
      vi.useFakeTimers();
      mockIsLoading.value = true;
      const { rerender } = render(tab("proj-1"));
      act(() => {
        vi.advanceTimersByTime(UI_DOHERTY_THRESHOLD);
      });
      expect(screen.getByRole("status", { name: /loading recipes/i })).toBeTruthy();

      mockIsLoading.value = false;
      mockRecipes.value = [makeRecipe("r1", "First project recipe")];
      rerender(tab("proj-1"));
      expect(screen.queryByRole("status", { name: /loading recipes/i })).toBeNull();

      mockRecipes.value = [];
      mockIsLoading.value = true;
      rerender(tab("proj-2"));
      expect(screen.queryByRole("status", { name: /loading recipes/i })).toBeNull();

      act(() => {
        vi.advanceTimersByTime(UI_DOHERTY_THRESHOLD - 1);
      });
      expect(screen.queryByRole("status", { name: /loading recipes/i })).toBeNull();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.getByRole("status", { name: /loading recipes/i })).toBeTruthy();
    });

    it("shows the empty state, not a lingering skeleton, when a shown skeleton's load settles empty", () => {
      vi.useFakeTimers();
      mockIsLoading.value = true;
      const { rerender } = render(tab("proj-1"));
      act(() => {
        vi.advanceTimersByTime(UI_DOHERTY_THRESHOLD);
      });
      expect(screen.getByRole("status", { name: /loading recipes/i })).toBeTruthy();

      mockIsLoading.value = false;
      rerender(tab("proj-1"));

      expect(screen.queryByRole("status", { name: /loading recipes/i })).toBeNull();
      expect(screen.getByText(/add a recipe to open a set of terminals/i)).toBeTruthy();
    });

    it("replaces the skeleton with the list when the load resolves", () => {
      vi.useFakeTimers();
      mockIsLoading.value = true;
      const { rerender } = render(tab("proj-1"));
      act(() => {
        vi.advanceTimersByTime(400);
      });

      mockIsLoading.value = false;
      mockRecipes.value = [makeRecipe("r1", "Loaded recipe")];
      rerender(tab("proj-1"));

      expect(screen.queryByRole("status", { name: /loading recipes/i })).toBeNull();
      expect(screen.getByText("Loaded recipe")).toBeTruthy();
    });

    it("never shows a skeleton for a load that settles inside the gate", () => {
      vi.useFakeTimers();
      mockIsLoading.value = true;
      const { rerender } = render(tab("proj-1"));
      act(() => {
        vi.advanceTimersByTime(UI_DOHERTY_THRESHOLD - 100);
      });

      mockIsLoading.value = false;
      rerender(tab("proj-1"));
      act(() => {
        vi.advanceTimersByTime(UI_DOHERTY_THRESHOLD * 2);
      });

      expect(screen.queryByRole("status", { name: /loading recipes/i })).toBeNull();
      expect(screen.getByText(/add a recipe to open a set of terminals/i)).toBeTruthy();
    });

    it("shows the empty state once an empty load has settled", () => {
      render(tab("proj-1"));

      expect(screen.getByText(/add a recipe to open a set of terminals/i)).toBeTruthy();
    });
  });
});
