/**
 * Overlapping panel admissions against the real panel store (#15607).
 *
 * A recipe run sizes itself once at its aggregate gate and then spawns with
 * `bypassLimits`, and a single add checks the limit before awaiting its way to
 * the commit. The capacity either was granted has to stay spoken for until the
 * panels it pays for are visible to every other gate — while they are still
 * being created, and while they sit in a spawn batch's deferred `panelIds`
 * append.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TerminalRecipe } from "@shared/types/project";

const { prewarmTerminalMock } = vi.hoisted(() => ({
  prewarmTerminalMock: vi.fn<(...args: unknown[]) => Promise<void>>(),
}));

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn(async ({ id }: { id?: string }) => id ?? "spawn-id"),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
  },
  appClient: { setState: vi.fn().mockResolvedValue(undefined) },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({}),
    getRecipes: vi.fn().mockResolvedValue({ recipes: [], collisions: [] }),
    updateRecipe: vi.fn().mockResolvedValue(undefined),
    updateInRepoRecipe: vi.fn().mockResolvedValue(undefined),
  },
  globalEnvClient: {
    get: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockResolvedValue(undefined),
    invalidate: vi.fn(),
  },
  agentSettingsClient: { get: vi.fn().mockResolvedValue({ agents: {} }) },
  systemClient: {
    getAppMetrics: vi.fn().mockResolvedValue({ totalMemoryMB: 512 }),
    getTmpDir: vi.fn().mockResolvedValue("/tmp"),
  },
  globalRecipesClient: {
    getRecipes: vi.fn().mockResolvedValue([]),
    updateRecipe: vi.fn().mockResolvedValue(undefined),
  },
  pluginRecipesClient: {
    getRecipes: vi.fn().mockResolvedValue([]),
    recordUse: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => {
  const terminalInstanceService = {
    get: vi.fn(() => null),
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    destroy: vi.fn(),
    prewarmTerminal: prewarmTerminalMock,
    setInputLocked: vi.fn(),
    sendPtyResize: vi.fn(),
    wakeForFocus: vi.fn(),
  };
  return { createTerminalPaintPlane: () => terminalInstanceService };
});

beforeEach(() => {
  (globalThis as { window?: unknown }).window = {
    electron: {
      globalEnv: { get: vi.fn().mockResolvedValue({}) },
      runHistory: { append: vi.fn().mockResolvedValue(undefined) },
    },
  };
});

const { usePanelStore } = await import("../panelStore");
const { usePanelLimitStore } = await import("../panelLimitStore");
const { useRecipeStore } = await import("../recipeStore");
const { countPanelLimitUsage, countPanelsTowardLimit } =
  await import("../slices/panelRegistry/panelCount");
const { reservePanelSlots } = await import("../slices/panelRegistry/panelSlotReservations");

const HARD_LIMIT = 12;

function threeShellRecipe(id: string): TerminalRecipe {
  return {
    id,
    name: `Recipe ${id}`,
    projectId: "project-1",
    terminals: [0, 1, 2].map((i) => ({
      type: "terminal" as const,
      title: `${id} shell ${i}`,
      command: "echo",
    })),
    createdAt: 0,
  };
}

/** Panels a recipe run created, read from the registry rather than its results. */
function recipePanelIds(): string[] {
  return Object.values(usePanelStore.getState().panelsById)
    .filter((panel) => panel.cwd === "/wt")
    .map((panel) => panel.id);
}

function committedCount(): number {
  const { panelsById, panelIds } = usePanelStore.getState();
  return countPanelsTowardLimit(panelsById, panelIds);
}

/** Hold every prewarm (and with it each recipe `addPanel`) until released. */
function holdPrewarms(): () => void {
  const releases: Array<() => void> = [];
  prewarmTerminalMock.mockImplementation(
    () => new Promise<void>((resolve) => releases.push(resolve))
  );
  return () => {
    prewarmTerminalMock.mockResolvedValue(undefined);
    for (const release of releases.splice(0)) release();
  };
}

async function openOtherPanels(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await usePanelStore.getState().addPanel({
      kind: "browser",
      requestedId: `existing-${i}`,
      cwd: "/",
      bypassLimits: true,
      browserUrl: "about:blank",
    });
  }
}

describe("overlapping recipe runs and the hard panel limit (#15607)", () => {
  beforeEach(async () => {
    prewarmTerminalMock.mockReset().mockResolvedValue(undefined);
    await usePanelStore.getState().reset();
    useRecipeStore.getState().reset();
    // Usage stamping writes through to disk and reloads; keep the list in memory.
    useRecipeStore.setState({
      recipes: [threeShellRecipe("first"), threeShellRecipe("second")],
      updateRecipe: vi.fn().mockResolvedValue(undefined),
    });
    usePanelLimitStore.setState({
      softWarningLimit: 100,
      confirmationLimit: 100,
      hardLimit: HARD_LIMIT,
      warningsDisabled: true,
    });
    await openOtherPanels(HARD_LIMIT - 3);
  });

  it("opens at most the three free slots across two runs that overlap", async () => {
    const release = holdPrewarms();
    const run = useRecipeStore.getState().runRecipeWithResults;

    const first = run("first", "/wt", "wt-1");
    // The first run's panels are in the registry and still spawning.
    await vi.waitFor(() => expect(recipePanelIds()).toHaveLength(3));

    let secondSettled = false;
    const second = run("second", "/wt", "wt-1").finally(() => {
      secondSettled = true;
    });
    // Wait for the second run to get past its gate: either it was refused and
    // settled, or it was granted slots and its panels are spawning too.
    await vi.waitFor(() => expect(secondSettled || recipePanelIds().length > 3).toBe(true));

    release();
    const [firstResults, secondResults] = await Promise.all([first, second]);

    expect(recipePanelIds()).toHaveLength(3);
    expect(committedCount()).toBe(HARD_LIMIT);
    expect(firstResults.spawned).toHaveLength(3);
    expect(secondResults.spawned).toHaveLength(0);
    expect(secondResults.failed.map((f) => f.error)).toEqual([
      "Panel limit reached",
      "Panel limit reached",
      "Panel limit reached",
    ]);
  });

  it("refuses a single add that races an in-flight run at the limit", async () => {
    const release = holdPrewarms();

    const first = useRecipeStore.getState().runRecipeWithResults("first", "/wt", "wt-1");
    await vi.waitFor(() => expect(recipePanelIds()).toHaveLength(3));

    const panelsBefore = Object.keys(usePanelStore.getState().panelsById).length;
    const single = await usePanelStore.getState().addPanel({
      kind: "browser",
      cwd: "/",
      browserUrl: "about:blank",
    });
    expect(Object.keys(usePanelStore.getState().panelsById)).toHaveLength(panelsBefore);

    release();
    await first;

    expect(single).toBeNull();
    expect(committedCount()).toBe(HARD_LIMIT);
  });

  it("returns the slots a failed run held to the next run", async () => {
    const realAddPanel = usePanelStore.getState().addPanel;
    const releases: Array<() => void> = [];
    // The first run's spawns fail before they commit, but only once released.
    usePanelStore.setState({
      addPanel: () =>
        new Promise<string | null>((_, reject) =>
          releases.push(() => reject(new Error("spawn failed")))
        ),
    });
    const first = useRecipeStore.getState().runRecipeWithResults("first", "/wt", "wt-1");
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    usePanelStore.setState({ addPanel: realAddPanel });

    for (const release of releases) release();
    const firstResults = await first;
    expect(firstResults.spawned).toHaveLength(0);

    const secondResults = await useRecipeStore
      .getState()
      .runRecipeWithResults("second", "/wt", "wt-1");

    expect(secondResults.spawned).toHaveLength(3);
    expect(recipePanelIds()).toHaveLength(3);
    expect(committedCount()).toBe(HARD_LIMIT);
  });
});

describe("single adds and the live panel-limit count (#15607)", () => {
  beforeEach(async () => {
    prewarmTerminalMock.mockReset().mockResolvedValue(undefined);
    await usePanelStore.getState().reset();
    usePanelLimitStore.setState({
      softWarningLimit: 100,
      confirmationLimit: 100,
      hardLimit: HARD_LIMIT,
      warningsDisabled: true,
    });
  });

  it("admits only one of two single adds racing for the last slot", async () => {
    await openOtherPanels(HARD_LIMIT - 1);
    const add = () => usePanelStore.getState().addPanel({ kind: "terminal", cwd: "/single" });

    const ids = await Promise.all([add(), add()]);

    expect(ids.filter((id) => id !== null)).toHaveLength(1);
    expect(committedCount()).toBe(HARD_LIMIT);
  });

  it("counts a granted slot once, from its claim through the batch to the flush", async () => {
    await openOtherPanels(HARD_LIMIT - 3);
    const usage = () => countPanelLimitUsage(usePanelStore.getState());
    const open = usage();

    const grant = reservePanelSlots(2);
    expect(usage()).toBe(open + 2);
    grant.claim("terminal-claimed");
    expect(usage()).toBe(open + 2);

    const token = usePanelStore.getState().beginSpawnBatch();
    await usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: "terminal-claimed",
      cwd: "/",
      bypassLimits: true,
    });
    // Committed, held back from `panelIds`, and still counted once.
    expect(usePanelStore.getState().panelsById["terminal-claimed"]).toBeDefined();
    expect(usePanelStore.getState().panelIds).not.toContain("terminal-claimed");
    expect(usage()).toBe(open + 2);

    usePanelStore.getState().flushSpawnBatch(token);
    expect(usage()).toBe(open + 2);

    // The unclaimed slot goes back; the panel keeps its own.
    grant.release();
    expect(usage()).toBe(open + 1);
    expect(committedCount()).toBe(open + 1);
  });

  it("drops every grant on a store reset, so an abandoned run can't hold capacity", async () => {
    await openOtherPanels(HARD_LIMIT - 3);
    reservePanelSlots(3).claim("terminal-never-added");
    expect(countPanelLimitUsage(usePanelStore.getState())).toBe(HARD_LIMIT);

    await usePanelStore.getState().reset();

    expect(countPanelLimitUsage(usePanelStore.getState())).toBe(0);
  });
});
