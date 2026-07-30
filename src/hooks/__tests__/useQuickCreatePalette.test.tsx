// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { TerminalRecipe } from "@/types";

const mockRecipes = vi.hoisted(() => ({ value: [] as TerminalRecipe[] }));
const paletteCapture = vi.hoisted(() => ({
  items: [] as unknown[],
  selectedIndex: 0,
}));
const dispatchMock = vi.hoisted(() => vi.fn());

vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      recipes: mockRecipes.value,
      // Mirrors the real store: a shadowed recipe resolves to the same-named winner.
      getRecipeById: (id: string) => {
        const found = mockRecipes.value.find((r) => r.id === id);
        if (found?.shadowedBy) {
          return mockRecipes.value.find((r) => r.name === found.name && !r.shadowedBy) ?? found;
        }
        return found;
      },
    }),
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        quickCreate: { isOpen: false, issue: { number: 7, title: "Fix the thing" }, pr: null },
        openCreateDialog: vi.fn(),
        closeQuickCreate: vi.fn(),
      }),
    {
      getState: () => ({ setPendingWorktree: vi.fn(), selectWorktree: vi.fn() }),
    }
  ),
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector({ currentProject: null }),
    { getState: () => ({ currentProject: { path: "/repo" } }) }
  ),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatchMock(...args) },
}));

vi.mock("../useSearchablePalette", () => ({
  useSearchablePalette: ({ items }: { items: unknown[] }) => {
    paletteCapture.items = items;
    return {
      isOpen: true,
      query: "",
      results: items,
      totalResults: items.length,
      selectedIndex: paletteCapture.selectedIndex,
      matchesById: new Map(),
      isStale: false,
      open: vi.fn(),
      close: vi.fn(),
      setQuery: vi.fn(),
      selectPrevious: vi.fn(),
      selectNext: vi.fn(),
    };
  },
}));

const { useQuickCreatePalette } = await import("../useQuickCreatePalette");

function makeRecipe(overrides: Partial<TerminalRecipe>): TerminalRecipe {
  return {
    id: "r",
    name: "Work",
    terminals: [{ type: "terminal", env: {} }],
    createdAt: 0,
    ...overrides,
  } as TerminalRecipe;
}

beforeEach(() => {
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue({ ok: false, error: new Error("stop here") });
  paletteCapture.items = [];
  paletteCapture.selectedIndex = 0;
});

describe("useQuickCreatePalette — shadowed recipes (#11510)", () => {
  it("lists a shadowed recipe instead of dropping it from the palette", () => {
    mockRecipes.value = [
      makeRecipe({ id: "winner", scope: "inrepo" }),
      makeRecipe({ id: "loser", projectId: "p", shadowedBy: "Work" }),
    ];

    renderHook(() => useQuickCreatePalette());

    const ids = (paletteCapture.items as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toContain("loser");
    expect(ids).toContain("winner");
  });

  it("derives the auto-assign prompt from the winner, not the shadowed row", () => {
    // The loser opts out of assignment; the winner asks. Since selecting the
    // loser runs the winner, the toggle must follow the winner or the user is
    // never offered the choice that submission will act on.
    mockRecipes.value = [
      makeRecipe({ id: "winner", scope: "inrepo", autoAssign: "prompt" }),
      makeRecipe({ id: "loser", projectId: "p", shadowedBy: "Work", autoAssign: "never" }),
    ];
    paletteCapture.selectedIndex = 1;

    const { result } = renderHook(() => useQuickCreatePalette());

    expect(result.current.selectedRecipe?.id).toBe("winner");
    expect(result.current.selectedRecipe?.autoAssign).toBe("prompt");
  });

  it("dispatches the selected row's own id and lets the store resolve the winner", async () => {
    mockRecipes.value = [
      makeRecipe({ id: "winner", scope: "inrepo" }),
      makeRecipe({ id: "loser", projectId: "p", shadowedBy: "Work" }),
    ];

    const { result } = renderHook(() => useQuickCreatePalette());
    const loser = (paletteCapture.items as Array<{ id: string }>).find((i) => i.id === "loser");

    await act(async () => {
      result.current.confirmItem(loser as never);
    });

    expect(dispatchMock).toHaveBeenCalledWith(
      "worktree.createWithRecipe",
      expect.objectContaining({ recipeId: "loser" }),
      expect.anything()
    );
  });
});
