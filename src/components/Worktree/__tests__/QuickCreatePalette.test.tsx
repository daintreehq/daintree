// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { TerminalRecipe } from "@/types";
import type { QuickCreateItem, UseQuickCreatePaletteReturn } from "@/hooks/useQuickCreatePalette";

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    selector({ worktrees: new Map() }),
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: (selector: (s: { closeQuickCreate: () => void }) => unknown) =>
    selector({ closeQuickCreate: () => {} }),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn() },
}));

import { QuickCreatePalette } from "../QuickCreatePalette";

const recipe: TerminalRecipe = {
  id: "fix",
  name: "Fix an issue",
  terminals: [{ type: "claude" } as TerminalRecipe["terminals"][number]],
  createdAt: 0,
  autoAssign: "prompt",
};

const RESULTS: QuickCreateItem[] = [
  { ...recipe, _kind: "recipe" },
  { _kind: "customize", id: "__customize__", name: "Customize…" },
];

function makePalette(overrides: Partial<UseQuickCreatePaletteReturn>): UseQuickCreatePaletteReturn {
  return {
    isOpen: true,
    query: "",
    results: RESULTS,
    totalResults: RESULTS.length,
    selectedIndex: 0,
    matchesById: new Map(),
    isStale: false,
    open: vi.fn(),
    close: vi.fn(),
    toggle: vi.fn(),
    setQuery: vi.fn(),
    setSelectedIndex: vi.fn(),
    selectPrevious: vi.fn(),
    selectNext: vi.fn(),
    confirmSelection: vi.fn(),
    confirmItem: vi.fn(),
    isPending: false,
    assignToSelf: true,
    setAssignToSelf: vi.fn(),
    selectedRecipe: recipe,
    ...overrides,
  };
}

describe("QuickCreatePalette", () => {
  it("moves the one cursor with the pointer, and keeps the assign toggle on the way to it", () => {
    const palette = makePalette({});
    const { rerender } = render(<QuickCreatePalette palette={palette} />);
    expect(screen.getByText("Assign issue to me")).toBeTruthy();

    // Pointing at Customize moves the cursor there, as the arrow keys would.
    fireEvent.pointerMove(document.getElementById("quick-create-option-__customize__")!);
    expect(palette.setSelectedIndex).toHaveBeenCalledWith(1);

    // With the cursor on Customize there is no selected recipe, but the toggle
    // below the list stays: the pointer crosses Customize to reach it.
    rerender(
      <QuickCreatePalette palette={{ ...palette, selectedIndex: 1, selectedRecipe: null }} />
    );
    expect(screen.getByText("Assign issue to me")).toBeTruthy();

    for (const item of RESULTS) {
      const row = document.getElementById(`quick-create-option-${item.id}`)!;
      expect(row.className.split(/\s+/).filter((t) => t.startsWith("hover:bg-"))).toEqual([]);
    }
  });

  it("forgets the pinned recipe once the palette closes", () => {
    const palette = makePalette({});
    const { rerender } = render(<QuickCreatePalette palette={palette} />);
    rerender(<QuickCreatePalette palette={{ ...palette, isOpen: false, selectedRecipe: null }} />);
    rerender(
      <QuickCreatePalette
        palette={{ ...palette, isOpen: true, selectedIndex: 1, selectedRecipe: null }}
      />
    );
    expect(screen.queryByText("Assign issue to me")).toBeNull();
  });
});
