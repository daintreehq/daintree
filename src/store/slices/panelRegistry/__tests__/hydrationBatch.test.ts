/**
 * Tests for hydration batching (#5196)
 *
 * `beginHydrationBatch` / `flushHydrationBatch` commit each panel to `panelsById`
 * immediately (so event handlers can look panels up by id) but defer the
 * `panelIds` append until flush — collapsing the N-panel high-fanout render
 * (worktree dashboard, dock, grid) into a single `panelIds` update. Also
 * collapses the N `saveNormalized` calls into 1.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PtyPanelData } from "@shared/types/panel";

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
  appClient: {
    setState: vi.fn().mockResolvedValue(undefined),
  },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({}),
  },
  globalEnvClient: {
    get: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockResolvedValue(undefined),
    invalidate: vi.fn(),
  },
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue({}),
  },
  systemClient: {
    getAppMetrics: vi.fn().mockResolvedValue({ totalMemoryMB: 512 }),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    // No attached renderer xterm in these tests — spawn falls back to the
    // default/estimated dims path.
    get: vi.fn(() => null),
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    destroy: vi.fn(),
    prewarmTerminal: vi.fn(),
    setInputLocked: vi.fn(),
    sendPtyResize: vi.fn(),
  },
}));

const saveNormalizedMock = vi.fn();
vi.mock("../persistence", async () => {
  const actual = await vi.importActual<typeof import("../persistence")>("../persistence");
  return {
    ...actual,
    saveNormalized: (...args: unknown[]) => saveNormalizedMock(...args),
  };
});

// `window.electron.globalEnv.get()` is awaited on the PTY path; stub it so tests
// don't have to set up a full electron shim.
beforeEach(() => {
  (globalThis as { window?: unknown }).window = {
    electron: {
      globalEnv: {
        get: vi.fn().mockResolvedValue({}),
      },
    },
  };
});

const { usePanelStore } = await import("../../../panelStore");

describe("hydration batch (#5196)", () => {
  beforeEach(async () => {
    saveNormalizedMock.mockClear();
    const { reset } = usePanelStore.getState();
    await reset();
  });

  describe("panelsById commits immediately, panelIds defers to flush", () => {
    it("makes non-PTY panels findable via panelsById before flush", async () => {
      const { beginHydrationBatch, flushHydrationBatch, addPanel } = usePanelStore.getState();

      const token = beginHydrationBatch();
      await addPanel({
        kind: "browser",
        requestedId: "browser-1",
        cwd: "/",
        bypassLimits: true,
        browserUrl: "about:blank",
      });
      await addPanel({
        kind: "browser",
        requestedId: "browser-2",
        cwd: "/",
        bypassLimits: true,
        browserUrl: "about:blank",
      });

      // Event handlers that look up by id must succeed before flush.
      expect(usePanelStore.getState().panelsById["browser-1"]).toBeDefined();
      expect(usePanelStore.getState().panelsById["browser-2"]).toBeDefined();
      // But panelIds subscribers see the panels only after flush.
      expect(usePanelStore.getState().panelIds).toEqual([]);

      flushHydrationBatch(token);

      expect(usePanelStore.getState().panelIds).toEqual(["browser-1", "browser-2"]);
    });

    it("makes PTY panels findable via panelsById before flush", async () => {
      const { beginHydrationBatch, flushHydrationBatch, addPanel } = usePanelStore.getState();

      const token = beginHydrationBatch();
      await addPanel({
        kind: "terminal",
        requestedId: "term-1",
        cwd: "/",
        bypassLimits: true,
      });
      await addPanel({
        kind: "terminal",
        requestedId: "term-2",
        cwd: "/",
        bypassLimits: true,
      });

      expect(usePanelStore.getState().panelsById["term-1"]).toBeDefined();
      expect(usePanelStore.getState().panelsById["term-2"]).toBeDefined();
      expect(usePanelStore.getState().panelIds).toEqual([]);

      flushHydrationBatch(token);

      expect(usePanelStore.getState().panelIds).toEqual(["term-1", "term-2"]);
    });
  });

  it("calls saveNormalized exactly once per flush, regardless of panel count", async () => {
    const { beginHydrationBatch, flushHydrationBatch, addPanel } = usePanelStore.getState();

    const token = beginHydrationBatch();
    for (let i = 0; i < 5; i++) {
      await addPanel({
        kind: "browser",
        requestedId: `browser-${i}`,
        cwd: "/",
        bypassLimits: true,
        browserUrl: "about:blank",
      });
    }
    // `saveNormalized` must not fire for the per-panel `panelsById` updates.
    expect(saveNormalizedMock).not.toHaveBeenCalled();

    flushHydrationBatch(token);

    expect(saveNormalizedMock).toHaveBeenCalledTimes(1);
    const [, savedIds] = saveNormalizedMock.mock.calls[0] as [Record<string, unknown>, string[]];
    expect(savedIds).toEqual(["browser-0", "browser-1", "browser-2", "browser-3", "browser-4"]);
  });

  it("ignores flushes made with a stale or mismatched token", async () => {
    const { beginHydrationBatch, flushHydrationBatch, addPanel } = usePanelStore.getState();

    const firstToken = beginHydrationBatch();
    await addPanel({
      kind: "browser",
      requestedId: "browser-1",
      cwd: "/",
      bypassLimits: true,
      browserUrl: "about:blank",
    });

    // A new hydration starts and discards the previous batch's pending-id queue.
    const secondToken = beginHydrationBatch();
    await addPanel({
      kind: "browser",
      requestedId: "browser-2",
      cwd: "/",
      bypassLimits: true,
      browserUrl: "about:blank",
    });

    // Late flush from the cancelled hydration must not corrupt the live batch.
    flushHydrationBatch(firstToken);
    expect(usePanelStore.getState().panelIds).toEqual([]);

    flushHydrationBatch(secondToken);
    // Only the second batch's id appears — the first batch's id was committed to
    // panelsById but never appended to panelIds (cancelled).
    expect(usePanelStore.getState().panelIds).toEqual(["browser-2"]);
  });

  it("is a no-op when flushing an empty batch", () => {
    const { beginHydrationBatch, flushHydrationBatch } = usePanelStore.getState();
    const before = usePanelStore.getState();
    const token = beginHydrationBatch();
    saveNormalizedMock.mockClear();
    flushHydrationBatch(token);

    // An empty batch still fires saveNormalized via the set() updater, but the
    // returned state has no changed keys, so subscribers aren't re-rendered.
    expect(usePanelStore.getState().panelsById).toBe(before.panelsById);
    expect(usePanelStore.getState().panelIds).toBe(before.panelIds);
  });

  it("updates panels in place when the id already exists in panelsById (dedup)", async () => {
    const { beginHydrationBatch, flushHydrationBatch, addPanel } = usePanelStore.getState();

    // Seed a panel outside any batch.
    await addPanel({
      kind: "browser",
      requestedId: "browser-1",
      cwd: "/",
      bypassLimits: true,
      browserUrl: "about:blank",
    });
    expect(usePanelStore.getState().panelIds).toEqual(["browser-1"]);

    // Batch that re-adds the same id + adds a new one: panelIds must remain unique.
    const token = beginHydrationBatch();
    await addPanel({
      kind: "browser",
      requestedId: "browser-1",
      cwd: "/",
      bypassLimits: true,
      browserUrl: "about:blank",
      title: "updated title",
    });
    await addPanel({
      kind: "browser",
      requestedId: "browser-2",
      cwd: "/",
      bypassLimits: true,
      browserUrl: "about:blank",
    });
    flushHydrationBatch(token);

    expect(usePanelStore.getState().panelIds).toEqual(["browser-1", "browser-2"]);
    expect(usePanelStore.getState().panelsById["browser-1"]?.title).toBe("updated title");
  });

  it("preserves runtime fields on PTY reconnect when the snapshot has them unset", async () => {
    const { beginHydrationBatch, flushHydrationBatch, addPanel } = usePanelStore.getState();

    // Seed an existing terminal with runtime state the "reconnect" branch must preserve.
    usePanelStore.setState((state) => ({
      panelsById: {
        ...state.panelsById,
        "term-1": {
          id: "term-1",
          kind: "terminal",
          title: "Agent",
          cwd: "/",
          cols: 80,
          rows: 24,
          location: "grid" as const,
          isVisible: true,
          runtimeStatus: "running" as const,
          agentState: "working",
          lastStateChange: 1234,
          exitBehavior: "restart",
          extensionState: { foo: "bar" },
        } as unknown as PtyPanelData,
      },
      panelIds: [...state.panelIds, "term-1"],
    }));

    const token = beginHydrationBatch();
    await addPanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
      existingId: "term-1",
      cwd: "/",
      bypassLimits: true,
      // Omit agentState/lastStateChange/exitBehavior/extensionState so the merge
      // kicks in and preserves the seeded values.
    });
    flushHydrationBatch(token);

    const result = usePanelStore.getState().panelsById["term-1"] as PtyPanelData | undefined;
    expect(result?.agentState).toBe("working");
    expect(result?.lastStateChange).toBe(1234);
    expect(result?.exitBehavior).toBe("restart");
    expect(result?.extensionState).toEqual({ foo: "bar" });
  });

  it("lets store updaters find a panel by id before flush (event-handler invariant)", async () => {
    const { beginHydrationBatch, flushHydrationBatch, addPanel, updateAgentState, updateActivity } =
      usePanelStore.getState();

    const token = beginHydrationBatch();
    await addPanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
      requestedId: "term-1",
      cwd: "/",
      bypassLimits: true,
    });

    // Simulate an IPC event arriving for this panel BEFORE the phase's flush —
    // both handlers look panels up by id via `state.panelsById[id]` and bail if
    // missing. With deferred `panelIds`, the entry is already in `panelsById`,
    // so the updates must stick.
    updateAgentState("term-1", "waiting");
    updateActivity("term-1", "writing code", "working", "interactive");

    const mid = usePanelStore.getState().panelsById["term-1"] as PtyPanelData | undefined;
    expect(mid?.agentState).toBe("waiting");
    expect(mid?.activityHeadline).toBe("writing code");

    flushHydrationBatch(token);

    const after = usePanelStore.getState().panelsById["term-1"] as PtyPanelData | undefined;
    expect(after?.agentState).toBe("waiting");
    expect(after?.activityHeadline).toBe("writing code");
  });

  it("keeps the optimistic placeholder with spawnStatus 'failed' when spawn rejects", async () => {
    // #9166: addPanel is optimistic — the panel lands in panelsById before spawn
    // resolves. If spawn rejects, the panel stays with spawnStatus "failed" so
    // per-cell error chrome can render.
    const { beginHydrationBatch, flushHydrationBatch, addPanel } = usePanelStore.getState();

    const { terminalClient } = (await import("@/clients")) as unknown as {
      terminalClient: { spawn: ReturnType<typeof vi.fn> };
    };
    terminalClient.spawn
      .mockImplementationOnce(async () => {
        throw new Error("spawn failed");
      })
      .mockImplementationOnce(async ({ id }: { id?: string }) => id ?? "ok");

    const token = beginHydrationBatch();
    await addPanel({
      kind: "terminal",
      requestedId: "fail-1",
      cwd: "/",
      bypassLimits: true,
    });
    await addPanel({
      kind: "terminal",
      requestedId: "ok-1",
      cwd: "/",
      bypassLimits: true,
    });

    for (let i = 0; i < 20; i++) await Promise.resolve();

    saveNormalizedMock.mockClear();
    flushHydrationBatch(token);

    // Both panels persist: the failed panel stays with spawnStatus "failed",
    // the successful one with spawnStatus "ready".
    const state = usePanelStore.getState();
    expect(state.panelIds).toEqual(["fail-1", "ok-1"]);
    expect(state.panelsById["fail-1"]).toBeDefined();
    expect(
      (state.panelsById["fail-1"] as import("@shared/types/panel").PtyPanelData).spawnStatus
    ).toBe("failed");

    expect(saveNormalizedMock).toHaveBeenCalled();
    const lastCall = saveNormalizedMock.mock.calls.at(-1) as [Record<string, unknown>, string[]];
    expect(lastCall[1]).toEqual(["fail-1", "ok-1"]);
  });

  it("collapses N panel additions into a single panelIds render", async () => {
    const { beginHydrationBatch, flushHydrationBatch, addPanel } = usePanelStore.getState();

    let panelIdsNotifyCount = 0;
    let lastPanelIds: string[] | undefined;
    const unsubscribe = usePanelStore.subscribe((state) => {
      if (state.panelIds !== lastPanelIds) {
        panelIdsNotifyCount++;
        lastPanelIds = state.panelIds;
      }
    });

    try {
      // Prime the baseline.
      lastPanelIds = usePanelStore.getState().panelIds;

      const token = beginHydrationBatch();
      for (let i = 0; i < 10; i++) {
        await addPanel({
          kind: "browser",
          requestedId: `browser-${i}`,
          cwd: "/",
          bypassLimits: true,
          browserUrl: "about:blank",
        });
      }
      // panelIds reference stayed the same throughout — no high-fanout render.
      expect(panelIdsNotifyCount).toBe(0);

      flushHydrationBatch(token);

      // Exactly one panelIds change for 10 panels. The legacy per-panel path
      // produced one per addPanel.
      expect(panelIdsNotifyCount).toBe(1);
    } finally {
      unsubscribe();
    }
  });

  describe("spawn batch aliases (#9165)", () => {
    it("collapses a recipe spawn burst into a single panelIds render", async () => {
      const { beginSpawnBatch, flushSpawnBatch, addPanel } = usePanelStore.getState();

      let panelIdsNotifyCount = 0;
      let lastPanelIds: string[] | undefined;
      const unsubscribe = usePanelStore.subscribe((state) => {
        if (state.panelIds !== lastPanelIds) {
          panelIdsNotifyCount++;
          lastPanelIds = state.panelIds;
        }
      });

      try {
        lastPanelIds = usePanelStore.getState().panelIds;

        const token = beginSpawnBatch();
        expect(token).not.toBeNull();
        for (let i = 0; i < 5; i++) {
          await addPanel({
            kind: "browser",
            requestedId: `spawn-${i}`,
            cwd: "/",
            bypassLimits: true,
            browserUrl: "about:blank",
          });
        }
        // Deferred: panelsById is populated but panelIds hasn't changed yet.
        expect(usePanelStore.getState().panelsById["spawn-0"]).toBeDefined();
        expect(panelIdsNotifyCount).toBe(0);

        flushSpawnBatch(token);

        expect(panelIdsNotifyCount).toBe(1);
        expect(usePanelStore.getState().panelIds).toEqual([
          "spawn-0",
          "spawn-1",
          "spawn-2",
          "spawn-3",
          "spawn-4",
        ]);
      } finally {
        unsubscribe();
      }
    });

    it("surfaces a batched grid panel via getTabGroups before flush (#9649)", async () => {
      // Regression for the blank recipe-launched terminal: during the spawn
      // batch window the worktree index is committed eagerly but panelIds is
      // deferred. getTabGroups must still return the panel as a virtual group
      // so the grid paints on first mount. Drives the real addPanel batch path
      // — guards against addPanel ever dropping its addToWorktreeIndex call.
      const { beginSpawnBatch, flushSpawnBatch, addPanel, getTabGroups } = usePanelStore.getState();

      const token = beginSpawnBatch();
      expect(token).not.toBeNull();
      await addPanel({
        kind: "terminal",
        launchAgentId: "claude",
        command: "claude",
        requestedId: "recipe-term",
        cwd: "/",
        worktreeId: "wt-a",
        location: "grid",
        bypassLimits: true,
      });

      // Pre-flush: panelIds is still empty, but the index already has the panel.
      expect(usePanelStore.getState().panelIds).toEqual([]);
      expect(usePanelStore.getState().panelIdsByWorktreeId["wt-a"]).toContain("recipe-term");

      const groups = getTabGroups("grid", "wt-a");
      expect(groups.flatMap((g) => g.panelIds)).toContain("recipe-term");

      // Post-flush: still exactly one group, no duplicate from the id now being
      // in both panelIds and the index.
      flushSpawnBatch(token);
      const afterIds = getTabGroups("grid", "wt-a").flatMap((g) => g.panelIds);
      expect(afterIds).toEqual(["recipe-term"]);
    });

    it("refuses to open a nested batch and sweeps overlapping ids via the active flush", async () => {
      const { beginSpawnBatch, flushSpawnBatch, addPanel } = usePanelStore.getState();

      // Run A opens the batch.
      const tokenA = beginSpawnBatch();
      expect(tokenA).not.toBeNull();

      // An overlapping run B must not supersede A's in-flight batch.
      const tokenB = beginSpawnBatch();
      expect(tokenB).toBeNull();

      await addPanel({
        kind: "browser",
        requestedId: "a-1",
        cwd: "/",
        bypassLimits: true,
        browserUrl: "about:blank",
      });
      // B's panel, added while A's batch is still open, is collected too.
      await addPanel({
        kind: "browser",
        requestedId: "b-1",
        cwd: "/",
        bypassLimits: true,
        browserUrl: "about:blank",
      });

      // B's flush is a no-op for the null token — nothing is orphaned.
      flushSpawnBatch(tokenB);
      expect(usePanelStore.getState().panelIds).toEqual([]);

      // A's flush sweeps up both runs' ids exactly once.
      flushSpawnBatch(tokenA);
      expect(usePanelStore.getState().panelIds).toEqual(["a-1", "b-1"]);
    });

    it("clears an unflushed batch on panelStore.reset() so the next batch can open", async () => {
      const { beginSpawnBatch } = usePanelStore.getState();

      // Open a batch but never flush it (simulates a reset/throw mid-batch).
      expect(beginSpawnBatch()).not.toBeNull();
      // While it's open, a second begin is declined.
      expect(usePanelStore.getState().beginSpawnBatch()).toBeNull();

      await usePanelStore.getState().reset();

      // reset() discarded the stale batch — a fresh batch opens cleanly.
      expect(usePanelStore.getState().beginSpawnBatch()).not.toBeNull();
    });

    it("clears an unflushed batch on clearTerminalStoreForSwitch so a new project's batch can open", () => {
      const { beginSpawnBatch, clearTerminalStoreForSwitch } = usePanelStore.getState();

      // Spawn opens a batch on the outgoing project and never flushes (project switch fires).
      expect(beginSpawnBatch()).not.toBeNull();
      clearTerminalStoreForSwitch();

      // The incoming project's first recipe run must be able to open its own batch.
      expect(usePanelStore.getState().beginSpawnBatch()).not.toBeNull();
    });

    it("commits an in-flight spawn batch's ids when hydration starts mid-spawn", async () => {
      const {
        beginSpawnBatch,
        beginHydrationBatch,
        flushHydrationBatch,
        flushSpawnBatch,
        addPanel,
      } = usePanelStore.getState();

      // Spawn opens a batch and adds one panel.
      const spawnToken = beginSpawnBatch();
      expect(spawnToken).not.toBeNull();
      await addPanel({
        kind: "browser",
        requestedId: "spawn-panel",
        cwd: "/",
        bypassLimits: true,
        browserUrl: "about:blank",
      });
      expect(usePanelStore.getState().panelIds).toEqual([]);

      // Hydration starts before the spawn's flush — it must inherit the spawn's
      // collected ids rather than silently strand them in panelsById.
      const hydrationToken = beginHydrationBatch();
      expect(usePanelStore.getState().panelIds).toEqual(["spawn-panel"]);

      // The stranded spawn token now sees a mismatch — its flush is a no-op,
      // and the spawn panel does not get re-appended.
      flushSpawnBatch(spawnToken);
      expect(usePanelStore.getState().panelIds).toEqual(["spawn-panel"]);

      // Hydration's own panels flush in its turn, with no duplication.
      await addPanel({
        kind: "browser",
        requestedId: "hydration-panel",
        cwd: "/",
        bypassLimits: true,
        browserUrl: "about:blank",
      });
      flushHydrationBatch(hydrationToken);
      expect(usePanelStore.getState().panelIds).toEqual(["spawn-panel", "hydration-panel"]);
    });
  });
});
