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
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue({}),
  },
  systemClient: {
    getAppMetrics: vi.fn().mockResolvedValue({ totalMemoryMB: 512 }),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
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
        type: "terminal",
        requestedId: "term-1",
        cwd: "/",
        bypassLimits: true,
      });
      await addPanel({
        kind: "terminal",
        type: "terminal",
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
          kind: "agent",
          type: "terminal",
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
        } as import("../types").TerminalInstance,
      },
      panelIds: [...state.panelIds, "term-1"],
    }));

    const token = beginHydrationBatch();
    await addPanel({
      kind: "agent",
      agentId: "claude",
      command: "claude",
      existingId: "term-1",
      cwd: "/",
      bypassLimits: true,
      // Omit agentState/lastStateChange/exitBehavior/extensionState so the merge
      // kicks in and preserves the seeded values.
    });
    flushHydrationBatch(token);

    const result = usePanelStore.getState().panelsById["term-1"];
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
      kind: "agent",
      agentId: "claude",
      command: "claude",
      type: "terminal",
      requestedId: "term-1",
      cwd: "/",
      bypassLimits: true,
    });

    // Simulate an IPC event arriving for this panel BEFORE the phase's flush —
    // both handlers look panels up by id via `state.panelsById[id]` and bail if
    // missing. With deferred `panelIds`, the entry is already in `panelsById`,
    // so the updates must stick.
    updateAgentState("term-1", "waiting");
    updateActivity("term-1", "writing code", "working", "interactive", 100);

    const mid = usePanelStore.getState().panelsById["term-1"];
    expect(mid?.agentState).toBe("waiting");
    expect(mid?.activityHeadline).toBe("writing code");

    flushHydrationBatch(token);

    const after = usePanelStore.getState().panelsById["term-1"];
    expect(after?.agentState).toBe("waiting");
    expect(after?.activityHeadline).toBe("writing code");
  });

  it("does not append ids whose addPanel failed before reaching panelsById", async () => {
    const { beginHydrationBatch, flushHydrationBatch, addPanel } = usePanelStore.getState();

    // Make spawn reject for one id, succeed for the next.
    const { terminalClient } = (await import("@/clients")) as unknown as {
      terminalClient: { spawn: ReturnType<typeof vi.fn> };
    };
    terminalClient.spawn
      .mockImplementationOnce(async () => {
        throw new Error("spawn failed");
      })
      .mockImplementationOnce(async ({ id }: { id?: string }) => id ?? "ok");

    const token = beginHydrationBatch();
    // First addPanel: spawn throws, caught by addPanel's outer try/catch and re-thrown.
    await expect(
      addPanel({
        kind: "terminal",
        type: "terminal",
        requestedId: "fail-1",
        cwd: "/",
        bypassLimits: true,
      })
    ).rejects.toThrow("spawn failed");
    // Second addPanel succeeds.
    await addPanel({
      kind: "terminal",
      type: "terminal",
      requestedId: "ok-1",
      cwd: "/",
      bypassLimits: true,
    });

    saveNormalizedMock.mockClear();
    flushHydrationBatch(token);

    // Only the successful id lands in panelIds.
    expect(usePanelStore.getState().panelIds).toEqual(["ok-1"]);
    expect(usePanelStore.getState().panelsById["fail-1"]).toBeUndefined();

    // saveNormalized fired once with the correct id list.
    expect(saveNormalizedMock).toHaveBeenCalledTimes(1);
    const [, savedIds] = saveNormalizedMock.mock.calls[0] as [Record<string, unknown>, string[]];
    expect(savedIds).toEqual(["ok-1"]);
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
});
