// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook } from "@testing-library/react";
import type { TerminalRecipe } from "@shared/types/project";

// Focus-driven work benchmark: repeated window focus with nothing changed on
// disk and no waiting agents should not churn the recipe store or the badge.

const { notifyMock, updateBadgeMock, clearFaviconMock, updateFaviconMock, counts, getInRepoMock } =
  vi.hoisted(() => ({
    notifyMock: vi.fn(),
    updateBadgeMock: vi.fn(),
    clearFaviconMock: vi.fn(),
    updateFaviconMock: vi.fn(),
    counts: { waitingCount: 0 },
    getInRepoMock: vi.fn(),
  }));

function makeRecipe(id: string, scope?: "inrepo"): TerminalRecipe {
  return {
    id,
    name: `Recipe ${id}`,
    projectId: "p1",
    createdAt: 1,
    lastUsedAt: 5,
    usageHistory: [1, 2, 3],
    terminals: [
      { type: "terminal", command: "npm run dev", title: "dev" },
      { type: "claude", title: "agent" },
    ],
    ...(scope ? { scope } : {}),
  } as TerminalRecipe;
}

// Every read returns fresh objects, as structured-clone IPC does.
const globalData = () => [makeRecipe("recipe-g1"), makeRecipe("recipe-g2")];
const projectData = () => ({
  recipes: [makeRecipe("recipe-p1"), makeRecipe("recipe-p2")],
  collisions: [{ droppedName: "dup", filename: "dup.json" }],
});
const inRepoData = () => [makeRecipe("inrepo-a", "inrepo"), makeRecipe("inrepo-b", "inrepo")];

vi.mock("@/lib/notify", () => ({ notify: notifyMock }));
vi.mock("@/clients", () => ({
  projectClient: {
    getRecipes: vi.fn(async () => projectData()),
    getInRepoRecipes: getInRepoMock.mockImplementation(async () => inRepoData()),
  },
  globalRecipesClient: { getRecipes: vi.fn(async () => globalData()) },
  agentSettingsClient: { get: vi.fn(async () => ({ agents: {} })) },
  systemClient: { getTmpDir: vi.fn(async () => "/tmp") },
  pluginRecipesClient: { getRecipes: vi.fn(async () => []) },
}));
vi.mock("@/services/FaviconBadgeService", () => ({
  updateFaviconBadge: updateFaviconMock,
  clearFaviconBadge: clearFaviconMock,
}));
vi.mock("@/hooks/useTerminalSelectors", () => ({
  useTerminalNotificationCounts: () => ({ waitingCount: counts.waitingCount }),
}));

Object.defineProperty(window, "electron", {
  value: { notification: { updateBadge: updateBadgeMock } },
  writable: true,
});

import { useRecipeStore } from "@/store/recipeStore";
import { useRecipeFocusReload } from "../useRecipeFocusReload";
import { useWindowNotifications } from "../../useWindowNotifications";

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
};

let now = 1_000_000;

describe("focus-driven work benchmark", () => {
  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    notifyMock.mockClear();
    updateBadgeMock.mockClear();
    clearFaviconMock.mockClear();
    updateFaviconMock.mockClear();
    counts.waitingCount = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("10 focus events with unchanged recipes", async () => {
    await act(async () => {
      await useRecipeStore.getState().loadRecipes("p1");
    });
    notifyMock.mockClear();
    getInRepoMock.mockClear();

    let consumerRenders = 0;
    function RecipesConsumer() {
      useRecipeStore((s) => s.recipes);
      consumerRenders++;
      return null;
    }
    function FocusHost() {
      useRecipeFocusReload();
      return null;
    }
    render(
      <>
        <FocusHost />
        <RecipesConsumer />
      </>
    );
    consumerRenders = 0;

    let storeNotifications = 0;
    let recipesIdentityChanges = 0;
    let isLoadingFlips = 0;
    const unsub = useRecipeStore.subscribe((state, prev) => {
      storeNotifications++;
      if (state.recipes !== prev.recipes) recipesIdentityChanges++;
      if (state.isLoading !== prev.isLoading) isLoadingFlips++;
    });

    for (let i = 0; i < 10; i++) {
      now += 1_000;
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      await flush();
    }
    unsub();
    expect(getInRepoMock).toHaveBeenCalledTimes(10);

    const metrics = {
      storeNotifications,
      recipesIdentityChanges,
      isLoadingFlips,
      consumerRenders,
      collisionNotifies: notifyMock.mock.calls.length,
    };
    if (process.env.DAINTREE_BENCH)
      process.stdout.write(`[bench:recipe-focus] ${JSON.stringify(metrics)}\n`);
    expect(metrics).toEqual({
      storeNotifications: 0,
      recipesIdentityChanges: 0,
      isLoadingFlips: 0,
      consumerRenders: 0,
      collisionNotifies: 0,
    });
  });

  it("20 focus/blur cycles with no waiting agents", async () => {
    renderHook(() => useWindowNotifications());
    for (let i = 0; i < 20; i++) {
      act(() => {
        window.dispatchEvent(new Event("blur"));
      });
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
    }
    const metrics = {
      updateBadgeCalls: updateBadgeMock.mock.calls.length,
      faviconClears: clearFaviconMock.mock.calls.length,
    };
    if (process.env.DAINTREE_BENCH)
      process.stdout.write(`[bench:badge-focus] ${JSON.stringify(metrics)}\n`);
    expect(metrics.updateBadgeCalls).toBeLessThanOrEqual(1);
    expect(metrics.faviconClears).toBe(0);
  });

  it("still clears a positive badge and favicon on focus", async () => {
    vi.useFakeTimers();
    try {
      const { rerender } = renderHook(() => useWindowNotifications());
      act(() => {
        window.dispatchEvent(new Event("blur"));
      });
      counts.waitingCount = 2;
      rerender();
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(updateBadgeMock).toHaveBeenLastCalledWith({ waitingCount: 2 });
      expect(updateFaviconMock).toHaveBeenCalledWith(2);

      counts.waitingCount = 0;
      updateBadgeMock.mockClear();
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(updateBadgeMock).toHaveBeenCalledTimes(1);
      expect(updateBadgeMock).toHaveBeenLastCalledWith({ waitingCount: 0 });
      expect(clearFaviconMock).toHaveBeenCalledTimes(1);

      act(() => {
        window.dispatchEvent(new Event("blur"));
        window.dispatchEvent(new Event("focus"));
      });
      expect(updateBadgeMock).toHaveBeenCalledTimes(1);
      expect(clearFaviconMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
