/**
 * Tests for hydration batching (#5196)
 *
 * beginHydrationBatch / flushHydrationBatch collapse N `addPanel` mutations within
 * a restore phase into a single Zustand `set()` call — so a project with N panels
 * produces 1 render per phase instead of N. The batch also runs `saveNormalized`
 * exactly once at flush time rather than once per panel.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn(),
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

  it("defers panel mutations until flushHydrationBatch is called", async () => {
    const { beginHydrationBatch, flushHydrationBatch, addPanel } = usePanelStore.getState();

    const token = beginHydrationBatch();

    // Non-PTY panels use the sync branch of addPanel; during a batch they should
    // not appear in the store yet.
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

    expect(usePanelStore.getState().panelIds).toEqual([]);
    expect(usePanelStore.getState().panelsById).toEqual({});

    flushHydrationBatch(token);

    expect(usePanelStore.getState().panelIds).toEqual(["browser-1", "browser-2"]);
    expect(usePanelStore.getState().panelsById["browser-1"]).toBeDefined();
    expect(usePanelStore.getState().panelsById["browser-2"]).toBeDefined();
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
    saveNormalizedMock.mockClear();
    flushHydrationBatch(token);

    expect(saveNormalizedMock).toHaveBeenCalledTimes(1);
    // Full final state was persisted — all 5 panels should be in the saved bag.
    const [savedById, savedIds] = saveNormalizedMock.mock.calls[0] as [
      Record<string, unknown>,
      string[],
    ];
    expect(savedIds).toEqual(["browser-0", "browser-1", "browser-2", "browser-3", "browser-4"]);
    expect(Object.keys(savedById)).toHaveLength(5);
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

    // A new hydration starts and discards the previous batch.
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
    expect(usePanelStore.getState().panelIds).toEqual(["browser-2"]);
  });

  it("is a no-op when flushing an empty batch", () => {
    const { beginHydrationBatch, flushHydrationBatch } = usePanelStore.getState();
    const before = usePanelStore.getState();
    const token = beginHydrationBatch();
    saveNormalizedMock.mockClear();
    flushHydrationBatch(token);

    expect(saveNormalizedMock).not.toHaveBeenCalled();
    expect(usePanelStore.getState().panelsById).toBe(before.panelsById);
    expect(usePanelStore.getState().panelIds).toBe(before.panelIds);
  });

  it("appends only ids that aren't already in the store (update-in-place on conflict)", async () => {
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

  it("collapses N panel additions into one store mutation", async () => {
    const { beginHydrationBatch, flushHydrationBatch, addPanel } = usePanelStore.getState();

    let notifyCount = 0;
    const unsubscribe = usePanelStore.subscribe(() => {
      notifyCount++;
    });

    try {
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
      // No store commits during the batch — no subscriber notifications.
      expect(notifyCount).toBe(0);

      flushHydrationBatch(token);

      // Exactly one notification for 10 panels. With the legacy per-panel path,
      // this would be 10 (one per addPanel) + 10 from the panelStore focus wrapper.
      expect(notifyCount).toBe(1);
    } finally {
      unsubscribe();
    }
  });
});
