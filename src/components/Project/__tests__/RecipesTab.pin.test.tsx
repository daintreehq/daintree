// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { TerminalRecipe } from "@/types";

const {
  mockRecipes,
  mockIsLoading,
  mockLoadRecipes,
  mockDeleteRecipe,
  mockExportRecipe,
  mockImportRecipe,
} = vi.hoisted(() => ({
  mockRecipes: { value: [] as TerminalRecipe[] },
  mockIsLoading: { value: false },
  mockLoadRecipes: vi.fn().mockResolvedValue(undefined),
  mockDeleteRecipe: vi.fn().mockResolvedValue(undefined),
  mockExportRecipe: vi.fn().mockReturnValue(""),
  mockImportRecipe: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: () => ({
    recipes: mockRecipes.value,
    isLoading: mockIsLoading.value,
    loadRecipes: mockLoadRecipes,
    deleteRecipe: mockDeleteRecipe,
    exportRecipe: mockExportRecipe,
    importRecipe: mockImportRecipe,
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

const makeRecipe = (overrides: Partial<TerminalRecipe> = {}): TerminalRecipe => ({
  id: overrides.id ?? "recipe-1",
  name: overrides.name ?? "My Recipe",
  projectId: overrides.projectId,
  worktreeId: overrides.worktreeId,
  terminals: overrides.terminals ?? [],
  createdAt: overrides.createdAt ?? Date.now(),
  ...overrides,
});

describe("RecipesTab — default pin", () => {
  beforeEach(() => {
    mockRecipes.value = [];
    mockIsLoading.value = false;
    mockLoadRecipes.mockClear();
    mockDeleteRecipe.mockClear();
    mockExportRecipe.mockClear();
    mockImportRecipe.mockClear();
  });

  it("renders a pin button for globally-scoped recipes", () => {
    mockRecipes.value = [makeRecipe({ id: "global-1", name: "Global Recipe" })];
    const onChange = vi.fn();
    render(
      <RecipesTab
        projectId="proj-1"
        defaultWorktreeRecipeId={undefined}
        onDefaultWorktreeRecipeIdChange={onChange}
        worktreeMap={new Map()}
        isOpen={true}
      />
    );

    expect(
      screen.getByRole("button", {
        name: /set global recipe as default worktree recipe/i,
      })
    ).toBeTruthy();
  });

  it("does not render a pin button for worktree-scoped recipes", () => {
    mockRecipes.value = [makeRecipe({ id: "wt-1", name: "Worktree Recipe", worktreeId: "wt-abc" })];
    const onChange = vi.fn();
    render(
      <RecipesTab
        projectId="proj-1"
        defaultWorktreeRecipeId={undefined}
        onDefaultWorktreeRecipeIdChange={onChange}
        worktreeMap={new Map()}
        isOpen={true}
      />
    );

    expect(screen.queryByRole("button", { name: /as default worktree recipe/i })).toBeNull();
  });

  it("calls onDefaultWorktreeRecipeIdChange with the recipe id when an unpinned eligible recipe is clicked", async () => {
    mockRecipes.value = [makeRecipe({ id: "global-1", name: "Recipe One" })];
    const onChange = vi.fn();
    render(
      <RecipesTab
        projectId="proj-1"
        defaultWorktreeRecipeId={undefined}
        onDefaultWorktreeRecipeIdChange={onChange}
        worktreeMap={new Map()}
        isOpen={true}
      />
    );

    const pin = screen.getByRole("button", {
      name: /set recipe one as default worktree recipe/i,
    });
    fireEvent.click(pin);
    expect(onChange).toHaveBeenCalledWith("global-1");
  });

  it("calls onDefaultWorktreeRecipeIdChange with undefined when a pinned recipe is clicked", async () => {
    mockRecipes.value = [makeRecipe({ id: "global-1", name: "Pinned" })];
    const onChange = vi.fn();
    render(
      <RecipesTab
        projectId="proj-1"
        defaultWorktreeRecipeId="global-1"
        onDefaultWorktreeRecipeIdChange={onChange}
        worktreeMap={new Map()}
        isOpen={true}
      />
    );

    const pin = screen.getByRole("button", {
      name: /unset pinned as default worktree recipe/i,
    });
    fireEvent.click(pin);
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("renders the Default pill for the pinned recipe", () => {
    mockRecipes.value = [makeRecipe({ id: "global-1", name: "Pinned" })];
    render(
      <RecipesTab
        projectId="proj-1"
        defaultWorktreeRecipeId="global-1"
        onDefaultWorktreeRecipeIdChange={vi.fn()}
        worktreeMap={new Map()}
        isOpen={true}
      />
    );

    expect(screen.getByText("Default")).toBeTruthy();
  });

  it("renders the dangling-default banner when the pinned id no longer exists and loading is false", () => {
    mockRecipes.value = [makeRecipe({ id: "global-1", name: "Recipe One" })];
    render(
      <RecipesTab
        projectId="proj-1"
        defaultWorktreeRecipeId="missing-recipe-id"
        onDefaultWorktreeRecipeIdChange={vi.fn()}
        worktreeMap={new Map()}
        isOpen={true}
      />
    );

    expect(screen.getByText(/default recipe unavailable/i)).toBeTruthy();
  });

  it("clears the default when the banner action button is clicked", async () => {
    mockRecipes.value = [];
    const onChange = vi.fn();
    render(
      <RecipesTab
        projectId="proj-1"
        defaultWorktreeRecipeId="missing-recipe-id"
        onDefaultWorktreeRecipeIdChange={onChange}
        worktreeMap={new Map()}
        isOpen={true}
      />
    );

    const clearButton = screen.getByRole("button", { name: /clear default/i });
    fireEvent.click(clearButton);
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("does not render the dangling-default banner while recipes are loading", () => {
    mockRecipes.value = [];
    mockIsLoading.value = true;
    render(
      <RecipesTab
        projectId="proj-1"
        defaultWorktreeRecipeId="some-id"
        onDefaultWorktreeRecipeIdChange={vi.fn()}
        worktreeMap={new Map()}
        isOpen={true}
      />
    );

    expect(screen.queryByText(/default recipe unavailable/i)).toBeNull();
  });

  it("does not render the dangling-default banner when the pinned recipe exists", () => {
    mockRecipes.value = [makeRecipe({ id: "global-1", name: "Recipe One" })];
    render(
      <RecipesTab
        projectId="proj-1"
        defaultWorktreeRecipeId="global-1"
        onDefaultWorktreeRecipeIdChange={vi.fn()}
        worktreeMap={new Map()}
        isOpen={true}
      />
    );

    expect(screen.queryByText(/default recipe unavailable/i)).toBeNull();
  });

  it("renders the dangling-default banner when the pinned recipe is a worktree-scoped recipe that no longer qualifies", () => {
    mockRecipes.value = [makeRecipe({ id: "wt-1", name: "Worktree Recipe", worktreeId: "wt-abc" })];
    render(
      <RecipesTab
        projectId="proj-1"
        defaultWorktreeRecipeId="wt-1"
        onDefaultWorktreeRecipeIdChange={vi.fn()}
        worktreeMap={new Map()}
        isOpen={true}
      />
    );

    expect(screen.getByText(/default recipe unavailable/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /clear default/i })).toBeTruthy();
  });

  it("exposes the project-default-recipe DOM anchor for settings deep-links", () => {
    mockRecipes.value = [];
    const { container } = render(
      <RecipesTab
        projectId="proj-1"
        defaultWorktreeRecipeId={undefined}
        onDefaultWorktreeRecipeIdChange={vi.fn()}
        worktreeMap={new Map()}
        isOpen={true}
      />
    );

    expect(container.querySelector("#project-default-recipe")).not.toBeNull();
  });
});
