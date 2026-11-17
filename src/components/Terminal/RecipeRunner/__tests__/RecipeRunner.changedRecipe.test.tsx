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

const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });

// Run the card, change the recipe while the confirm waits, then confirm.
async function confirmAfterChange(before: TerminalRecipe, after: TerminalRecipe) {
  useRecipeStore.setState({ recipes: [before, other] });
  render(<RecipeRunner activeWorktreeId={null} defaultCwd="/repo" />);
  fireEvent.click(screen.getByRole("option", { name: `Run ${before.name}` }));
  const pending = useRecipeRunConfirmStore.getState().current;
  expect(pending?.missing).toEqual(["pr_number"]);
  act(() => {
    useRecipeStore.setState({ recipes: [after, other] });
  });
  await act(async () => {
    resolveRecipeRunConfirmation(pending!.requestId, true);
  });
  await settle();
  return screen.getByTestId("recipe-changed-banner");
}

describe("RecipeRunner — a confirmed recipe that changed before it started (#17447)", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });

  afterEach(() => {
    cleanup();
    cancelRecipeRunConfirmations();
    useRecipeStore.setState({ recipes: [] });
  });

  it("shows the store's refusal and opens the current recipe for review", async () => {
    const opened: unknown[] = [];
    const listener = (e: Event) => {
      if (e instanceof CustomEvent) opened.push(e.detail.recipeId);
    };
    window.addEventListener("daintree:open-recipe-editor", listener);
    try {
      const banner = await confirmAfterChange(
        needsPr(),
        needsPr({
          terminals: [{ type: "claude", env: {}, initialPrompt: "ship pr {{pr_number}}" }],
        })
      );

      expect(within(banner).getByText("Couldn't start 'Review'")).toBeTruthy();
      expect(banner.textContent).toContain("Review it before running it again.");
      fireEvent.click(within(banner).getByRole("button", { name: /Review recipe/ }));
      expect(opened).toEqual(["r1"]);
    } finally {
      window.removeEventListener("daintree:open-recipe-editor", listener);
    }
  });

  it("offers no editor for a plugin's recipe", async () => {
    const origin = { kind: "plugin" as const, pluginId: "acme.tools", contributionId: "rel" };
    const banner = await confirmAfterChange(
      needsPr({ id: "acme.tools.rel", name: "Release", origin }),
      needsPr({
        id: "acme.tools.rel",
        name: "Release",
        origin,
        terminals: [{ type: "claude", env: {}, initialPrompt: "release pr {{pr_number}}" }],
      })
    );

    expect(banner.textContent).toContain("Its plugin changed the recipe");
    expect(within(banner).queryByRole("button", { name: /Review recipe/ })).toBeNull();
  });

  it("keeps the explanation without a Review action once the recipe is deleted", async () => {
    await confirmAfterChange(needsPr(), needsPr({ terminals: [{ type: "terminal", env: {} }] }));

    act(() => {
      useRecipeStore.setState({ recipes: [other] });
    });

    const banner = screen.getByTestId("recipe-changed-banner");
    expect(banner.textContent).toContain("has since been deleted");
    expect(within(banner).queryByRole("button", { name: /Review recipe/ })).toBeNull();
  });

  it("goes away when dismissed", async () => {
    const banner = await confirmAfterChange(
      needsPr(),
      needsPr({ terminals: [{ type: "terminal", env: {} }] })
    );

    fireEvent.click(within(banner).getByRole("button", { name: "Dismiss" }));
    await settle();

    expect(screen.queryByTestId("recipe-changed-banner")).toBeNull();
  });
});
