// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginLayoutConfig,
  ProjectLayoutSeedOutcome,
  ProjectLayoutSeedRecord,
  ProjectLayoutSeedStatus,
} from "@shared/types/plugin";

const { panelStore, worktreeStore, projectRef, seedPluginLayout } = await vi.hoisted(async () => {
  const { create } = await import("zustand");
  return {
    panelStore: create<{
      panelIds: string[];
      panelsById: Record<string, { location?: string }>;
    }>(() => ({ panelIds: [], panelsById: {} })),
    worktreeStore: create<{ activeWorktreeId: string | null }>(() => ({
      activeWorktreeId: "wt-1",
    })),
    projectRef: { current: { id: "p1", gitBacked: true } as Record<string, unknown> | null },
    seedPluginLayout: vi.fn(),
  };
});

vi.mock("@/store/panelStore", () => ({ usePanelStore: panelStore }));
vi.mock("@/store/worktreeStore", () => ({ useWorktreeSelectionStore: worktreeStore }));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: { getState: () => ({ currentProject: projectRef.current }) },
}));
vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: {
    getState: () => ({
      getRecipeById: (id: string) => (id === "acme.dev" ? { id, name: "Dev server" } : undefined),
    }),
  },
}));
vi.mock("@/services/layout/applyPluginLayout", () => ({ seedPluginLayout }));

import {
  openOfferedLayout,
  selectProjectDefaultLayout,
  useProjectLayoutSeed,
} from "../useProjectLayoutSeed";
import { usePluginLayoutsStore } from "@/store/pluginLayoutsStore";
import {
  _resetProjectLayoutSeedStoreForTest,
  useProjectLayoutSeedStore,
} from "@/store/projectLayoutSeedStore";

/** Main's record, with its compare-and-set, as the IPC handlers expose it. */
let record: ProjectLayoutSeedRecord | null;
const advanceProjectLayoutSeed = vi.fn(
  async (
    from: ProjectLayoutSeedStatus,
    to: ProjectLayoutSeedStatus,
    outcome?: ProjectLayoutSeedOutcome
  ) => {
    if (record?.status !== from) return { advanced: false, record };
    record = { status: to, ...(outcome ? { outcome } : {}), at: 1 };
    return { advanced: true, record };
  }
);
const getProjectLayoutSeed = vi.fn(async () => record);

function layout(overrides: Partial<PluginLayoutConfig> = {}): PluginLayoutConfig {
  return {
    id: "project__p1__acme.workbench",
    pluginId: "project__p1__acme",
    pluginName: "Acme",
    name: "Workbench",
    entries: [
      { target: { type: "panel", panelKindId: "acme.records" }, location: "grid" },
      { target: { type: "recipe", recipeId: "acme.dev" }, location: "dock" },
    ],
    projectDefault: true,
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

function mount(enabled = true) {
  return renderHook(({ on }) => useProjectLayoutSeed(on), { initialProps: { on: enabled } });
}

function arrive(layouts: PluginLayoutConfig[]): void {
  act(() => usePluginLayoutsStore.setState({ layouts }));
}

describe("useProjectLayoutSeed (#13782)", () => {
  beforeEach(() => {
    record = { status: "pending", at: 0 };
    advanceProjectLayoutSeed.mockClear();
    getProjectLayoutSeed.mockClear();
    seedPluginLayout.mockReset().mockResolvedValue({
      panelIds: ["new-1"],
      failures: [],
      deferred: [{ target: { type: "recipe", recipeId: "acme.dev" }, location: "dock" }],
    });
    panelStore.setState({ panelIds: [], panelsById: {} });
    worktreeStore.setState({ activeWorktreeId: "wt-1" });
    projectRef.current = { id: "p1", gitBacked: true };
    usePluginLayoutsStore.setState({ layouts: [] });
    _resetProjectLayoutSeedStoreForTest();
    Object.defineProperty(window, "electron", {
      value: { plugin: { getProjectLayoutSeed, advanceProjectLayoutSeed } },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "electron");
  });

  it("applies a default layout that arrives after trust, while the grid is empty", async () => {
    mount();
    await flush();
    expect(seedPluginLayout).not.toHaveBeenCalled();

    arrive([layout()]);
    await flush();

    // Consumed before anything opened, so it can never be applied twice.
    expect(advanceProjectLayoutSeed).toHaveBeenCalledWith("pending", "settled", "applied");
    expect(advanceProjectLayoutSeed.mock.invocationCallOrder[0]).toBeLessThan(
      seedPluginLayout.mock.invocationCallOrder[0]!
    );
    expect(seedPluginLayout).toHaveBeenCalledWith("project__p1__acme.workbench");
    expect(useProjectLayoutSeedStore.getState().waiting).toEqual({
      layoutId: "project__p1__acme.workbench",
      layoutName: "Workbench",
      pluginName: "Acme",
      recipes: [{ id: "acme.dev", name: "Dev server" }],
    });
  });

  it("offers instead once the user has opened something, for good", async () => {
    mount();
    await flush();
    act(() =>
      panelStore.setState({ panelIds: ["mine"], panelsById: { mine: { location: "grid" } } })
    );
    await flush();
    expect(record?.status).toBe("offered");

    // Emptying the grid later is not a first open.
    act(() => panelStore.setState({ panelIds: [], panelsById: {} }));
    arrive([layout()]);
    await flush();
    expect(seedPluginLayout).not.toHaveBeenCalled();
    expect(useProjectLayoutSeedStore.getState().status).toBe("offered");
  });

  it("doesn't count a panel in the trash as opened", async () => {
    panelStore.setState({ panelIds: ["old"], panelsById: { old: { location: "trash" } } });
    mount();
    arrive([layout()]);
    await flush();
    expect(seedPluginLayout).toHaveBeenCalledTimes(1);
  });

  it("counts a docked panel as opened", async () => {
    panelStore.setState({ panelIds: ["dock"], panelsById: { dock: { location: "dock" } } });
    mount();
    arrive([layout()]);
    await flush();
    expect(seedPluginLayout).not.toHaveBeenCalled();
    expect(record?.status).toBe("offered");
  });

  it("counts a panel brought out of the background as opened", async () => {
    // Same ids, new location: no id is added when a parked panel comes back.
    const ids = ["parked"];
    panelStore.setState({ panelIds: ids, panelsById: { parked: { location: "background" } } });
    mount();
    await flush();
    act(() => panelStore.setState({ panelIds: ids, panelsById: { parked: { location: "grid" } } }));
    await flush();
    expect(record?.status).toBe("offered");
  });

  it("does nothing for a project whose seed has settled", async () => {
    record = { status: "settled", outcome: "ineligible", at: 0 };
    mount();
    arrive([layout()]);
    await flush();
    expect(advanceProjectLayoutSeed).not.toHaveBeenCalled();
    expect(seedPluginLayout).not.toHaveBeenCalled();
  });

  it("waits for a worktree before opening a git project's layout", async () => {
    worktreeStore.setState({ activeWorktreeId: null });
    mount();
    arrive([layout()]);
    await flush();
    expect(seedPluginLayout).not.toHaveBeenCalled();

    act(() => worktreeStore.setState({ activeWorktreeId: "wt-1" }));
    await flush();
    expect(seedPluginLayout).toHaveBeenCalledTimes(1);
  });

  it("opens a folder project's layout without a worktree", async () => {
    projectRef.current = { id: "p1", gitBacked: false };
    worktreeStore.setState({ activeWorktreeId: null });
    mount();
    arrive([layout()]);
    await flush();
    expect(seedPluginLayout).toHaveBeenCalledTimes(1);
  });

  it("applies nothing when another view consumed the seed first", async () => {
    mount();
    await flush();
    record = { status: "settled", outcome: "applied", at: 2 };
    arrive([layout()]);
    await flush();
    expect(seedPluginLayout).not.toHaveBeenCalled();
    expect(useProjectLayoutSeedStore.getState().status).toBe("settled");
  });

  it("ignores a layout that isn't the project's default", async () => {
    mount();
    arrive([layout({ projectDefault: undefined })]);
    await flush();
    expect(advanceProjectLayoutSeed).not.toHaveBeenCalled();
  });

  it("decides nothing before hydration has settled", async () => {
    const { rerender } = mount(false);
    arrive([layout()]);
    await flush();
    expect(getProjectLayoutSeed).not.toHaveBeenCalled();

    rerender({ on: true });
    await flush();
    expect(seedPluginLayout).toHaveBeenCalledTimes(1);
  });

  it("opens an offered layout once, on the user's click", async () => {
    record = { status: "offered", at: 0 };
    useProjectLayoutSeedStore.setState({ status: "offered" });

    await openOfferedLayout(layout());
    await openOfferedLayout(layout());

    expect(seedPluginLayout).toHaveBeenCalledTimes(1);
    expect(record).toEqual({ status: "settled", outcome: "opened", at: 1 });
  });
});

describe("selectProjectDefaultLayout", () => {
  it("picks the lower plugin id's default, whatever the order", () => {
    const a = layout({ id: "a.x", pluginId: "project__p1__a" });
    const b = layout({ id: "b.x", pluginId: "project__p1__b" });
    expect(selectProjectDefaultLayout([b, a])?.id).toBe("a.x");
    expect(selectProjectDefaultLayout([a, b])?.id).toBe("a.x");
    expect(selectProjectDefaultLayout([layout({ projectDefault: undefined })])).toBeNull();
  });
});
