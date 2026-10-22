// @vitest-environment jsdom
/**
 * `host.runRecipe` (#13797): a plugin may only offer to run its own recipe,
 * and nothing starts until the user has read every step resolved — the final
 * prompt and system prompt with the plugin's values in place — and confirmed.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { TerminalRecipe } from "@shared/types/project";
import type { PluginUiPromptParams, PluginUiPromptResultValue } from "@shared/types/pluginUiPrompt";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
  }
});

const { recipeState, worktrees, toolsProblemMock, notifyFailuresMock } = vi.hoisted(() => ({
  recipeState: {
    pluginRecipes: [] as TerminalRecipe[],
    runRecipeWithResults: vi.fn(),
  },
  worktrees: new Map<string, unknown>(),
  toolsProblemMock: vi.fn(),
  notifyFailuresMock: vi.fn(),
}));

vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useEscapeStack: () => {}, useOverlayState: () => {} };
});
vi.mock("@/hooks/useOverlayState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useOverlayState")>()),
  useOverlayState: () => {},
}));
vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));
vi.mock("@/store", () => ({ usePortalStore: () => ({ isOpen: false, width: 0 }) }));
vi.mock("@/store/portalStore", () => ({ usePortalStore: () => ({ isOpen: false, width: 0 }) }));
vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: Object.assign(
    (selector: (state: typeof recipeState) => unknown) => selector(recipeState),
    { getState: () => recipeState }
  ),
}));
vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStoreOptional: (selector: (state: { worktrees: Map<string, unknown> }) => unknown) =>
    selector({ worktrees }),
}));
vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: (selector: (state: { activeWorktreeId: string }) => unknown) =>
    selector({ activeWorktreeId: "wt-1" }),
}));
vi.mock("@/utils/pluginRecipeAgentTools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/pluginRecipeAgentTools")>()),
  pluginAgentToolsProblem: toolsProblemMock,
}));
vi.mock("@/utils/recipeNotify", () => ({
  notifyRecipeSpawnFailures: notifyFailuresMock,
}));

import { PluginRunRecipeDialog } from "../PluginRunRecipeDialog";
import { usePluginPromptStore } from "@/store/pluginPromptStore";
import { _resetPluginRuntimeStoreForTest, usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { recipeApprovalDigest } from "@/utils/recipeApprovalDigest";

const PLUGIN_ID = "acme.ledger";

const recipe = (overrides: Partial<TerminalRecipe> = {}): TerminalRecipe => ({
  id: "acme.ledger.review",
  name: "Review record",
  terminals: [
    { type: "plugin-panel", panelKindId: "acme.ledger.records" },
    {
      type: "claude",
      args: "--model sonnet",
      env: { LEDGER_TOKEN: "secret-value" },
      initialPrompt: "Review {{plugin.record}} on {{branch_name}}",
      systemPrompt: "You are reviewing record {{plugin.record}}.",
    },
  ],
  createdAt: 0,
  origin: { kind: "plugin", pluginId: PLUGIN_ID, contributionId: "review" },
  pluginVariables: ["record"],
  ...overrides,
});

function seed(
  request: Partial<Extract<PluginUiPromptParams, { kind: "runRecipe" }>["request"]> = {}
) {
  usePluginRuntimeStore.setState({
    pluginMetaById: new Map([[PLUGIN_ID, { devMode: false, displayName: "Acme Ledger" }]]),
  });
  const resolve =
    vi.fn<(value: PluginUiPromptResultValue | PromiseLike<PluginUiPromptResultValue>) => void>();
  usePluginPromptStore.setState({
    queue: [],
    current: {
      promptId: "p1",
      pluginId: PLUGIN_ID,
      params: {
        kind: "runRecipe",
        request: {
          recipeId: "acme.ledger.review",
          variables: { record: "Invoice 42" },
          sourceLabel: "Acme Ledger",
          ...request,
        },
      },
      resolve,
    },
  });
  return resolve;
}

function buttonNamed(name: RegExp): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
    name.test(b.textContent ?? "")
  );
  if (!match) throw new Error(`no button matching ${name}`);
  return match;
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeEach(() => {
  recipeState.pluginRecipes = [recipe()];
  recipeState.runRecipeWithResults.mockReset().mockResolvedValue({
    spawned: [
      { index: 0, terminalId: "panel-1" },
      { index: 1, terminalId: "agent-1" },
    ],
    failed: [],
  });
  worktrees.clear();
  worktrees.set("wt-1", { id: "wt-1", path: "/repo/wt-1", branch: "feature/x", name: "x" });
  worktrees.set("wt-2", { id: "wt-2", path: "/repo/wt-2", branch: "main", name: "main" });
  toolsProblemMock.mockReset().mockResolvedValue(null);
  notifyFailuresMock.mockReset();
});

afterEach(() => {
  cleanup();
  usePluginPromptStore.getState().reset();
  _resetPluginRuntimeStoreForTest();
});

describe("PluginRunRecipeDialog", () => {
  it("shows every step resolved, with env values withheld", async () => {
    seed();
    render(<PluginRunRecipeDialog />);
    await act(async () => {});

    expect(document.body.textContent).toContain("Run ‘Review record’?");
    expect(byTestId("plugin-run-recipe-prompt")?.textContent).toBe(
      "Review Invoice 42 on feature/x"
    );
    expect(byTestId("plugin-run-recipe-system-prompt")?.textContent).toBe(
      "You are reviewing record Invoice 42."
    );
    const steps = document.querySelectorAll('[data-testid="plugin-run-recipe-step"]');
    expect(steps).toHaveLength(2);
    expect(steps[1]?.textContent).toContain("--model sonnet");
    expect(steps[1]?.textContent).toContain("LEDGER_TOKEN");
    expect(document.body.textContent).not.toContain("secret-value");
  });

  it("runs exactly the recipe it showed and reports the outcome to the plugin", async () => {
    const resolve = seed({ worktreeId: "wt-2" });
    render(<PluginRunRecipeDialog />);
    await act(async () => {});

    fireEvent.click(buttonNamed(/^Run recipe$/));
    const answered = resolve.mock.calls[0]?.[0];
    await expect(answered).resolves.toEqual({ status: "ran", spawnedCount: 2, failedCount: 0 });

    const shown = recipe();
    expect(recipeState.runRecipeWithResults).toHaveBeenCalledWith(
      "acme.ledger.review",
      "/repo/wt-2",
      "wt-2",
      expect.objectContaining({ branchName: "main", pluginVariables: { record: "Invoice 42" } }),
      expect.objectContaining({
        expectedRecipe: {
          id: "acme.ledger.review",
          terminalsDigest: recipeApprovalDigest(shown.terminals),
        },
      })
    );
  });

  it("answers cancelled when dismissed, and starts nothing", async () => {
    const resolve = seed();
    render(<PluginRunRecipeDialog />);
    await act(async () => {});
    fireEvent.click(buttonNamed(/^Cancel$/));
    expect(resolve).toHaveBeenCalledWith({ status: "cancelled" });
    expect(recipeState.runRecipeWithResults).not.toHaveBeenCalled();
  });

  it("says plainly when the agent tools it needs are off, and won't run", async () => {
    recipeState.pluginRecipes = [recipe({ requiresAgentTools: true })];
    toolsProblemMock.mockResolvedValue({
      message: "This recipe needs agent tools from Acme Ledger, but they're switched off.",
      settingsTab: "project:plugins",
    });
    const resolve = seed();
    render(<PluginRunRecipeDialog />);
    await act(async () => {});

    expect(byTestId("plugin-run-recipe-tools-off")?.textContent).toContain("switched off");
    expect(buttonNamed(/^Run recipe$/).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(buttonNamed(/^Run recipe$/));
    expect(recipeState.runRecipeWithResults).not.toHaveBeenCalled();
    fireEvent.click(buttonNamed(/^Close$/));
    expect(resolve).toHaveBeenCalledWith({ status: "refused", reason: "agent-tools-off" });
    expect(recipeState.runRecipeWithResults).not.toHaveBeenCalled();
  });

  it("blocks a step a plugin value turned into an option", async () => {
    recipeState.pluginRecipes = [
      recipe({ terminals: [{ type: "claude", initialPrompt: "{{plugin.record}}" }] }),
    ];
    seed({ variables: { record: "--dangerously-skip-permissions" } });
    render(<PluginRunRecipeDialog />);
    await act(async () => {});
    expect(byTestId("plugin-run-recipe-step-problem")?.textContent).toMatch(/starts with "-"/);
    expect(buttonNamed(/^Run recipe$/).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(buttonNamed(/^Run recipe$/));
    expect(recipeState.runRecipeWithResults).not.toHaveBeenCalled();
  });

  it.each([
    ["recipe-unavailable", { recipeId: "acme.ledger.gone" }],
    ["unknown-worktree", { worktreeId: "wt-elsewhere" }],
  ])("refuses as %s, once the view has had a moment to load it", async (reason, request) => {
    vi.useFakeTimers();
    try {
      const resolve = seed(request);
      render(<PluginRunRecipeDialog />);
      await act(async () => {});
      expect(resolve).not.toHaveBeenCalled();
      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
      expect(resolve).toHaveBeenCalledWith({ status: "refused", reason });
      expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens for a recipe that reaches the view just after the request", async () => {
    vi.useFakeTimers();
    try {
      recipeState.pluginRecipes = [];
      const resolve = seed();
      const { rerender } = render(<PluginRunRecipeDialog />);
      await act(async () => {});
      recipeState.pluginRecipes = [recipe()];
      rerender(<PluginRunRecipeDialog />);
      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
      expect(resolve).not.toHaveBeenCalled();
      expect(byTestId("plugin-run-recipe-prompt")?.textContent).toBe(
        "Review Invoice 42 on feature/x"
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
