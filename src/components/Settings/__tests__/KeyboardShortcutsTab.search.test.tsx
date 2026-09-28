// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }),
});

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub;

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn() },
}));

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

vi.mock("@/components/KeyboardShortcuts", () => ({
  SettingsShortcutCapture: () => <div data-testid="shortcut-capture" />,
}));

vi.mock("@/components/Settings/KeybindingProfileActions", () => ({
  KeybindingProfileActions: () => null,
}));

vi.mock("@/services/KeybindingService", () => ({
  keybindingService: {
    getAllBindingsWithEffectiveCombos: () => [
      {
        actionId: "worktree.openPalette",
        description: "Open Worktree Palette",
        category: "Worktrees",
        scope: "global",
        effectiveCombo: "Cmd+K Cmd+W",
        effectiveCombos: ["Cmd+K Cmd+W"],
      },
      {
        // Matches "worktree" only through its category, which no row shows.
        actionId: "sidebar.toggle",
        description: "Toggle sidebar",
        category: "Worktrees",
        scope: "global",
        effectiveCombo: "Cmd+B",
        effectiveCombos: ["Cmd+B"],
      },
      // Registered in two scopes, so each row carries a scope note as its description.
      {
        actionId: "fleet.toggleArm",
        description: "Toggle arm focused pane",
        category: "Fleet",
        scope: "global",
        effectiveCombo: "X",
        effectiveCombos: ["X"],
      },
      {
        actionId: "fleet.toggleArm",
        description: "Toggle arm focused pane",
        category: "Fleet",
        scope: "worktreeGrid",
        effectiveCombo: "X",
        effectiveCombos: ["X"],
      },
      {
        actionId: "app.save",
        description: "Save file",
        category: "File",
        scope: "global",
        effectiveCombo: "Cmd+S",
        effectiveCombos: ["Cmd+S"],
      },
    ],
    hasOverride: () => false,
    formatComboForDisplay: (combo: string) => combo,
    loadOverrides: vi.fn().mockResolvedValue(undefined),
    subscribe: () => () => {},
  },
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { KeyboardShortcutsTab } from "../KeyboardShortcutsTab";

// The class pair HighlightedText puts on a match; the segmented filter control
// paints its own empty `bg-overlay-medium` indicator, so the class alone is not enough.
const MARK = "span.bg-overlay-medium.text-text-primary:not(:empty)";

async function renderTab() {
  render(
    <TooltipProvider>
      <KeyboardShortcutsTab />
    </TooltipProvider>
  );
  await act(async () => {
    await Promise.resolve();
  });
}

async function search(query: string) {
  await act(async () => {
    fireEvent.change(screen.getByRole("textbox", { name: "Search shortcuts" }), {
      target: { value: query },
    });
  });
}

/** The row label element SettingsRow renders for a given plain-text label. */
function labelOf(text: string): HTMLElement {
  const el = Array.from(document.querySelectorAll<HTMLElement>("[data-settings-row-label]")).find(
    (node) => node.textContent === text
  );
  if (!el) throw new Error(`no row labelled ${text}`);
  return el;
}

const marksIn = (el: Element) => Array.from(el.querySelectorAll(MARK)).map((m) => m.textContent);

describe("KeyboardShortcutsTab search highlighting", () => {
  it("marks exactly the run the search matched in each label, and nothing else", async () => {
    await renderTab();
    await search("  WorkTree ");

    expect(marksIn(labelOf("Open Worktree Palette"))).toEqual(["Worktree"]);
    expect(marksIn(labelOf("Reorder worktree"))).toEqual(["worktree"]);
    for (const text of marksIn(document.body)) expect(text?.toLowerCase()).toBe("worktree");
  });

  it("marks nothing on a row that matched through a field it does not show", async () => {
    await renderTab();
    await search("worktree");

    expect(labelOf("Toggle sidebar")).toBeTruthy();
    expect(marksIn(labelOf("Toggle sidebar"))).toHaveLength(0);
  });

  it("marks the match in a bound row's scope note", async () => {
    await renderTab();
    await search("card");

    const note = screen.getByText((_, el) => el?.textContent === "In an expanded worktree card");
    expect(marksIn(note)).toEqual(["card"]);
  });

  it("marks the match in a fixed shortcut's description", async () => {
    await renderTab();
    await search("sidebar");

    const description = screen.getByText(
      (_, el) => el?.textContent === "With the worktree focused in the sidebar"
    );
    expect(marksIn(description)).toEqual(["sidebar"]);
  });

  it("keeps the row's reset and edit names in plain words", async () => {
    await renderTab();
    await search("worktree");

    expect(
      screen.getByRole("button", { name: /^Edit shortcut for Open Worktree Palette/ })
    ).toBeTruthy();
  });

  it("marks nothing without a search", async () => {
    await renderTab();
    expect(document.querySelectorAll(MARK)).toHaveLength(0);
  });
});
