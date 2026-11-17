// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { TerminalRecipe } from "@/types";

const { mockRecipes, mockDispatch } = vi.hoisted(() => ({
  mockRecipes: { value: [] as TerminalRecipe[] },
  mockDispatch: vi.fn(),
}));

vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: () => ({
    recipes: mockRecipes.value,
    isLoading: false,
    loadRecipes: vi.fn().mockResolvedValue(undefined),
    deleteRecipe: vi.fn(),
    exportRecipe: vi.fn().mockReturnValue(""),
    importRecipe: vi.fn(),
  }),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: mockDispatch },
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
  id: "recipe-1",
  name: "Dev",
  terminals: [],
  createdAt: Date.now(),
  ...overrides,
});

describe("RecipesTab — delete failure", () => {
  beforeEach(() => {
    mockRecipes.value = [makeRecipe()];
    mockDispatch.mockReset();
  });

  it("keeps the consequence description and shows the error as an alert below it", async () => {
    mockDispatch.mockResolvedValue({
      ok: false,
      error: { code: "INTERNAL", message: "Disk is read-only" },
    });
    render(
      <RecipesTab
        projectId="proj-1"
        defaultWorktreeRecipeId={undefined}
        onDefaultWorktreeRecipeIdChange={vi.fn()}
        worktreeMap={new Map()}
        isOpen={true}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete recipe Dev" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete recipe" }));

    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert.textContent).toContain("Disk is read-only"));
    expect(alert.textContent).not.toMatch(/^Error:/);
    expect(screen.getByText(/Deletes this recipe/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry delete" })).toBeTruthy();
  });
});
