// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecipeTerminal, TerminalRecipe } from "@/types";
import type { RecipeSpawnResults } from "@/store/recipeStore";

vi.mock("@/hooks/useOverlayState", () => ({
  useOverlayState: () => {},
}));

vi.mock("@/lib/scrollbarGutter", () => ({
  SCROLLBAR_GUTTER_VAR: "--app-scrollbar-gutter",
  measureScrollbarGutter: vi.fn(() => 0),
  publishScrollbarGutter: vi.fn(() => 0),
}));

vi.mock("@/store/projectSettingsStore", () => ({
  useProjectSettingsStore: <T,>(selector: (state: { allDetectedRunners: [] }) => T) =>
    selector({ allDetectedRunners: [] }),
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: <T,>(selector: (state: { addPanel: () => Promise<null> }) => T) =>
    selector({ addPanel: async () => null }),
}));

// The run reads the worktree's variables; this render has no view provider.
vi.mock("@/store/createWorktreeStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/store/createWorktreeStore")>()),
  getCurrentViewStore: () => ({ getState: () => ({ worktrees: new Map() }) }),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn() },
}));

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
      {recipe.name}
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
import { recipeApprovalDigest } from "@/utils/recipeApprovalDigest";
import { RecipeRunner } from "../RecipeRunner";

const install: RecipeTerminal = { type: "terminal", title: "Install", command: "npm ci", env: {} };
const lint: RecipeTerminal = { type: "terminal", title: "Lint", command: "npm run lint", env: {} };
const deploy: RecipeTerminal = {
  type: "terminal",
  title: "Deploy",
  command: "npm run deploy",
  env: {},
};

const pipeline = (terminals: RecipeTerminal[]): TerminalRecipe => ({
  id: "r1",
  name: "Pipeline",
  terminals,
  createdAt: 0,
});

describe("RecipeRunner retry banner after the recipe changes (#17446)", () => {
  const run = vi.fn<(...args: unknown[]) => Promise<RecipeSpawnResults>>();
  const original = useRecipeStore.getState().runRecipeWithResults;

  beforeEach(() => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    run.mockReset();
    useRecipeStore.setState({
      recipes: [pipeline([install, lint, deploy])],
      runRecipeWithResults: run as never,
    });
  });

  afterEach(() => {
    cleanup();
    useRecipeStore.setState({ recipes: [], runRecipeWithResults: original });
  });

  async function failLint() {
    run.mockResolvedValueOnce({
      spawned: [
        { index: 0, terminalId: "t-0" },
        { index: 2, terminalId: "t-2" },
      ],
      failed: [{ index: 1, error: "spawn ENOENT" }],
    });
    render(<RecipeRunner activeWorktreeId="wt-1" defaultCwd="/repo" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "Pipeline" }));
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Retry failed terminals" })).toBeTruthy();
  }

  it("withdraws Retry as soon as the steps are reordered", async () => {
    await failLint();

    act(() => {
      useRecipeStore.setState({ recipes: [pipeline([install, deploy, lint])] });
    });

    expect(screen.queryByRole("button", { name: "Retry failed terminals" })).toBeNull();
    const banner = screen.getByTestId("recipe-spawn-failure-banner");
    expect(banner.textContent).toContain("Lint");
    expect(banner.textContent).toContain("changed or was removed");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("brings Retry back when the steps are restored, and it retries the step that failed", async () => {
    await failLint();
    const ran = { id: "r1", terminalsDigest: recipeApprovalDigest([install, lint, deploy]) };

    act(() => {
      useRecipeStore.setState({ recipes: [pipeline([install, deploy])] });
    });
    expect(screen.queryByRole("button", { name: "Retry failed terminals" })).toBeNull();

    act(() => {
      useRecipeStore.setState({ recipes: [pipeline([install, lint, deploy])] });
    });
    expect(screen.getByTestId("recipe-spawn-failure-banner").textContent).toContain("spawn ENOENT");

    run.mockResolvedValueOnce({ spawned: [{ index: 1, terminalId: "t-1" }], failed: [] });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry failed terminals" }));
      await Promise.resolve();
    });
    expect(run).toHaveBeenLastCalledWith("r1", "/repo", "wt-1", expect.anything(), {
      spawnedBy: "recipe",
      terminalIndices: [1],
      expectedRecipe: ran,
    });
    expect(screen.queryByTestId("recipe-spawn-failure-banner")).toBeNull();
  });

  it("keeps the failure report when the last recipe is deleted", async () => {
    await failLint();

    act(() => {
      useRecipeStore.setState({ recipes: [] });
    });

    expect(screen.getByTestId("recipe-runner-empty")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry failed terminals" })).toBeNull();
    const banner = screen.getByTestId("recipe-spawn-failure-banner");
    expect(banner.textContent).toContain("Lint");
    expect(banner.textContent).toContain("changed or was removed");
  });
});
