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
    counts: { waitingPanelIds: [] as string[] },
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
  useTerminalNotificationPanelIds: () => counts.waitingPanelIds,
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
    counts.waitingPanelIds = [];
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
      counts.waitingPanelIds = ["t-1", "t-2"];
      rerender();
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(updateBadgeMock).toHaveBeenLastCalledWith({ waitingPanelIds: ["t-1", "t-2"] });
      expect(updateFaviconMock).toHaveBeenCalledWith(2);

      counts.waitingPanelIds = [];
      updateBadgeMock.mockClear();
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(updateBadgeMock).toHaveBeenCalledTimes(1);
      expect(updateBadgeMock).toHaveBeenLastCalledWith({ waitingPanelIds: [] });
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

  it("reports a swap of waiting panes at the same count", async () => {
    vi.useFakeTimers();
    try {
      const { rerender } = renderHook(() => useWindowNotifications());
      act(() => {
        window.dispatchEvent(new Event("blur"));
      });
      counts.waitingPanelIds = ["t-1"];
      rerender();
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(updateBadgeMock).toHaveBeenLastCalledWith({ waitingPanelIds: ["t-1"] });

      // Main counts a pane once with a question waiting in it, so which pane matters.
      counts.waitingPanelIds = ["t-2"];
      rerender();
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(updateBadgeMock).toHaveBeenLastCalledWith({
        waitingPanelIds: ["t-2"],
        membershipOnly: true,
      });
      expect(updateBadgeMock).toHaveBeenCalledTimes(2);
      // The count, and so the favicon, stayed where it was.
      expect(updateFaviconMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends a swap by the pending report's own deadline, never later", async () => {
    vi.useFakeTimers();
    try {
      const { rerender } = renderHook(() => useWindowNotifications());
      act(() => {
        window.dispatchEvent(new Event("blur"));
      });
      counts.waitingPanelIds = ["t-1"];
      rerender();
      act(() => {
        vi.advanceTimersByTime(200);
      });
      counts.waitingPanelIds = ["t-2"];
      rerender();
      act(() => {
        vi.advanceTimersByTime(101);
      });

      expect(updateBadgeMock).toHaveBeenCalledTimes(1);
      expect(updateBadgeMock).toHaveBeenLastCalledWith({ waitingPanelIds: ["t-2"] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a count change after a swap restart the wait, and sends only the latest", async () => {
    vi.useFakeTimers();
    try {
      const { rerender } = renderHook(() => useWindowNotifications());
      act(() => {
        window.dispatchEvent(new Event("blur"));
      });
      counts.waitingPanelIds = ["t-a"];
      rerender();
      act(() => {
        vi.advanceTimersByTime(100);
      });
      counts.waitingPanelIds = ["t-b"];
      rerender();
      act(() => {
        vi.advanceTimersByTime(100);
      });
      counts.waitingPanelIds = ["t-b", "t-c"];
      rerender();
      act(() => {
        vi.advanceTimersByTime(299);
      });
      expect(updateBadgeMock).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(updateBadgeMock).toHaveBeenCalledTimes(1);
      expect(updateBadgeMock).toHaveBeenLastCalledWith({ waitingPanelIds: ["t-b", "t-c"] });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { through: ["t-b"], membershipOnly: true },
    { through: ["t-a", "t-b"], membershipOnly: false },
  ])(
    "marks panes back where they were by way of $through as membership-only: $membershipOnly",
    async ({ through, membershipOnly }) => {
      vi.useFakeTimers();
      try {
        const { rerender } = renderHook(() => useWindowNotifications());
        act(() => {
          window.dispatchEvent(new Event("blur"));
        });
        counts.waitingPanelIds = ["t-a"];
        rerender();
        act(() => {
          vi.advanceTimersByTime(400);
        });
        expect(updateBadgeMock).toHaveBeenCalledTimes(1);

        counts.waitingPanelIds = through;
        rerender();
        act(() => {
          vi.advanceTimersByTime(100);
        });
        counts.waitingPanelIds = ["t-a"];
        rerender();
        act(() => {
          vi.advanceTimersByTime(400);
        });

        // A count that moved and came back is sent as it always was; panes that
        // only traded places are marked, so main runs no pass for them alone.
        expect(updateBadgeMock).toHaveBeenCalledTimes(2);
        expect(updateBadgeMock).toHaveBeenLastCalledWith(
          membershipOnly
            ? { waitingPanelIds: ["t-a"], membershipOnly }
            : { waitingPanelIds: ["t-a"] }
        );
        expect(updateFaviconMock).toHaveBeenCalledTimes(membershipOnly ? 1 : 2);
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it("tells two panes from one whose id joins theirs", async () => {
    vi.useFakeTimers();
    try {
      const { rerender } = renderHook(() => useWindowNotifications());
      act(() => {
        window.dispatchEvent(new Event("blur"));
      });
      counts.waitingPanelIds = ["a\u0000b"];
      rerender();
      act(() => {
        vi.advanceTimersByTime(400);
      });
      counts.waitingPanelIds = ["a", "b"];
      rerender();
      act(() => {
        vi.advanceTimersByTime(400);
      });

      expect(updateBadgeMock).toHaveBeenLastCalledWith({ waitingPanelIds: ["a", "b"] });
      expect(updateFaviconMock).toHaveBeenLastCalledWith(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["focus", "unmount"] as const)(
    "never lets a pending report land after %s",
    async (end) => {
      vi.useFakeTimers();
      try {
        const { rerender, unmount } = renderHook(() => useWindowNotifications());
        act(() => {
          window.dispatchEvent(new Event("blur"));
        });
        counts.waitingPanelIds = ["t-1"];
        rerender();
        act(() => {
          vi.advanceTimersByTime(100);
        });
        // A swap that joined the pending report goes with it.
        counts.waitingPanelIds = ["t-2"];
        rerender();
        act(() => {
          vi.advanceTimersByTime(100);
        });

        if (end === "focus") {
          act(() => {
            window.dispatchEvent(new Event("focus"));
          });
          counts.waitingPanelIds = [];
          rerender();
        } else {
          unmount();
        }
        act(() => {
          vi.advanceTimersByTime(400);
        });

        expect(updateBadgeMock).toHaveBeenCalledTimes(1);
        expect(updateBadgeMock).toHaveBeenLastCalledWith({ waitingPanelIds: [] });
      } finally {
        vi.useRealTimers();
      }
    }
  );
});
