// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalRecipe } from "@/types";

vi.mock("@/store/projectSettingsStore", () => ({
  useProjectSettingsStore: <T,>(selector: (state: { allDetectedRunners: [] }) => T) =>
    selector({ allDetectedRunners: [] }),
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: <T,>(selector: (state: { addPanel: () => Promise<null> }) => T) =>
    selector({ addPanel: async () => null }),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(async () => ({ ok: true, result: undefined })) },
}));

// The card reduced to the click that runs it.
vi.mock("../RecipeRunnerItem", () => ({
  RecipeRunnerItem: ({
    recipe,
    id,
    onRun,
  }: {
    recipe: TerminalRecipe;
    id: string;
    onRun: (id: string) => void;
  }) => (
    <button
      type="button"
      role="option"
      aria-selected={false}
      id={id}
      onClick={() => onRun(recipe.id)}
    >
      Run {recipe.name}
    </button>
  ),
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

import { useRecipeStore } from "@/store/recipeStore";
import {
  cancelRecipeRunConfirmations,
  resolveRecipeRunConfirmation,
  useRecipeRunConfirmStore,
} from "@/store/recipeRunConfirmStore";
import { RecipeRunner } from "../RecipeRunner";

function needsPr(overrides: Partial<TerminalRecipe> = {}): TerminalRecipe {
  return {
    id: "r1",
    name: "Review",
    terminals: [{ type: "claude", env: {}, initialPrompt: "review pr {{pr_number}}" }],
    createdAt: 0,
    ...overrides,
  };
}

const other: TerminalRecipe = {
  id: "r2",
  name: "Docs",
  terminals: [{ type: "terminal", env: {} }],
  createdAt: 0,
};

// Run the card, change the store while the confirm waits, then confirm.
async function confirmAfterChange(before: TerminalRecipe, after: TerminalRecipe[]) {
  useRecipeStore.setState({ recipes: [before, other] });
  render(<RecipeRunner activeWorktreeId={null} defaultCwd="/repo" />);
  fireEvent.click(screen.getByRole("option", { name: `Run ${before.name}` }));
  const pending = useRecipeRunConfirmStore.getState().current;
  expect(pending?.missing).toEqual(["pr_number"]);
  act(() => {
    useRecipeStore.setState({ recipes: after });
  });
  await act(async () => {
    resolveRecipeRunConfirmation(pending!.requestId, true);
  });
  return screen.findByTestId("recipe-changed-banner");
}

const reviewButton = (banner: HTMLElement) =>
  within(banner).queryByRole("button", { name: /Review recipe/ });

describe("RecipeRunner — a confirmed recipe that changed before it started (#17447)", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });

  afterEach(() => {
    cleanup();
    cancelRecipeRunConfirmations();
    useRecipeStore.setState({ recipes: [] });
  });

  it("shows the store's refusal under the name confirmed, and opens the current recipe", async () => {
    const opened: unknown[] = [];
    const listener = (e: Event) => {
      if (e instanceof CustomEvent) opened.push(e.detail.recipeId);
    };
    window.addEventListener("daintree:open-recipe-editor", listener);
    try {
      const banner = await confirmAfterChange(needsPr(), [
        needsPr({
          name: "Review v2",
          terminals: [{ type: "claude", env: {}, initialPrompt: "ship pr {{pr_number}}" }],
        }),
        other,
      ]);

      expect(banner.getAttribute("role")).toBe("alert");
      expect(banner.textContent).toMatch(/'Review'/);
      expect(banner.textContent).toMatch(/changed.*confirmation/i);
      fireEvent.click(reviewButton(banner)!);
      expect(opened).toEqual(["r1"]);
      expect(useRecipeStore.getState().recipes.every((r) => r.lastUsedAt === undefined)).toBe(true);
    } finally {
      window.removeEventListener("daintree:open-recipe-editor", listener);
    }
  });

  it("offers no editor for a plugin's recipe", async () => {
    const origin = { kind: "plugin" as const, pluginId: "acme.tools", contributionId: "rel" };
    const banner = await confirmAfterChange(
      needsPr({ id: "acme.tools.rel", name: "Release", origin }),
      [
        needsPr({
          id: "acme.tools.rel",
          name: "Release",
          origin,
          terminals: [{ type: "claude", env: {}, initialPrompt: "release pr {{pr_number}}" }],
        }),
        other,
      ]
    );

    expect(banner.textContent).toMatch(/plugin/i);
    expect(reviewButton(banner)).toBeNull();
  });

  it("explains a recipe deleted while the confirmation was open", async () => {
    const banner = await confirmAfterChange(needsPr(), [other]);

    expect(banner.textContent).toMatch(/'Review'/);
    expect(banner.textContent).toMatch(/no longer available/i);
    expect(reviewButton(banner)).toBeNull();
  });

  it("drops Review once the recipe is deleted after the refusal", async () => {
    const banner = await confirmAfterChange(needsPr(), [
      needsPr({ terminals: [{ type: "terminal", env: {} }] }),
      other,
    ]);
    expect(reviewButton(banner)).not.toBeNull();

    act(() => {
      useRecipeStore.setState({ recipes: [other] });
    });

    expect(reviewButton(screen.getByTestId("recipe-changed-banner"))).toBeNull();
  });

  it("keeps the refusal above the empty state when that was the last recipe", async () => {
    const before = await confirmAfterChange(needsPr(), [
      needsPr({ terminals: [{ type: "terminal", env: {} }] }),
    ]);
    const dismiss = within(before).getByRole("button", { name: "Dismiss" });
    dismiss.focus();

    act(() => {
      useRecipeStore.setState({ recipes: [] });
    });

    expect(screen.getByTestId("recipe-runner-empty")).toBeTruthy();
    const banner = screen.getByTestId("recipe-changed-banner");
    expect(banner.textContent).toMatch(/'Review'/);
    // The same banner, not a remount: focus stays where the user left it.
    expect(document.activeElement).toBe(dismiss);
    fireEvent.click(within(banner).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("recipe-changed-banner")).toBeNull();
  });

  it("goes away when dismissed", async () => {
    const banner = await confirmAfterChange(needsPr(), [
      needsPr({ terminals: [{ type: "terminal", env: {} }] }),
      other,
    ]);

    fireEvent.click(within(banner).getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByTestId("recipe-changed-banner")).toBeNull();
  });
});
