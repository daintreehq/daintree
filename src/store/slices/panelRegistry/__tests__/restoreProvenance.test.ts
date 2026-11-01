/**
 * Restore provenance and the plugin hold on the live panel (#14017): committed
 * by `addPanel`, kept current by the store, and written as they change.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { isPtyPanel, type PtyPanelData } from "@shared/types/panel";

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

vi.mock("@/services/TerminalInstanceService", () => {
  const terminalInstanceService = {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    destroy: vi.fn(),
    prewarmTerminal: vi.fn(),
    setInputLocked: vi.fn(),
    sendPtyResize: vi.fn(),
    invalidatePtyGrid: vi.fn(),
    waitForAttachSettled: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(() => null),
  };
  return {
    createTerminalPaintPlane: () => terminalInstanceService,
  };
});

vi.mock("@/store/helpPanelStore", () => ({
  useHelpPanelStore: {
    getState: () => ({ width: 500, sessions: {}, activeSlot: 0 }),
  },
  selectActiveSlot: () => ({ terminalId: null, sessionId: null, agentId: null }),
  selectSlotTerminalIds: () => [],
}));

vi.mock("../persistence", async () => {
  const actual = await vi.importActual<typeof import("../persistence")>("../persistence");
  return {
    ...actual,
    saveNormalized: vi.fn(),
  };
});

beforeEach(() => {
  (globalThis as { window?: unknown }).window = {
    innerHeight: 900,
    electron: {
      globalEnv: {
        get: vi.fn().mockResolvedValue({}),
      },
    },
  };
});

const { usePanelStore } = await import("../../../panelStore");
const { usePanelLimitStore } = await import("@/store/panelLimitStore");
const { saveNormalized } = await import("../persistence");
const { beginBatch, consumeBatch } = await import("../hydrationBatch");

function ptyPanel(id: string): PtyPanelData | undefined {
  const panel = usePanelStore.getState().panelsById[id];
  return panel && isPtyPanel(panel) ? panel : undefined;
}

const provenance = {
  at: 5_000,
  disposition: "held" as const,
  lastSeen: { agentState: "idle" as const, at: 4_000 },
};

beforeEach(async () => {
  await usePanelStore.getState().reset();
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
  usePanelLimitStore.setState({ hardLimit: 1000 });
  vi.mocked(saveNormalized).mockClear();
});

describe("addPanel", () => {
  it("commits a held pane's provenance and its plugin's hold", async () => {
    await usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: "held",
      launchAgentId: "claude",
      command: "claude",
      cwd: "/repo",
      restoreRecovery: { reason: "held-by-plugin" },
      restoreProvenance: provenance,
      launchedByPluginId: "acme.orchestrator",
      holdOnRestart: true,
      title: "Claude",
      bypassLimits: true,
    });

    expect(ptyPanel("held")).toMatchObject({
      restoreRecovery: { reason: "held-by-plugin" },
      restoreProvenance: provenance,
      launchedByPluginId: "acme.orchestrator",
      holdOnRestart: true,
      hasPty: false,
    });
  });

  it("adds none of them to a pane launched without them", async () => {
    await usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: "plain",
      cwd: "/repo",
      title: "Shell",
      bypassLimits: true,
    });

    const panel = ptyPanel("plain");
    expect(panel).toBeDefined();
    expect(panel).not.toHaveProperty("restoreProvenance");
    expect(panel).not.toHaveProperty("launchedByPluginId");
    expect(panel).not.toHaveProperty("holdOnRestart");
  });
});

describe("updateAgentState", () => {
  function seedAgent() {
    usePanelStore.setState({
      panelsById: {
        a: {
          id: "a",
          kind: "terminal",
          title: "Claude",
          cwd: "/repo",
          cols: 80,
          rows: 24,
          location: "grid",
          launchAgentId: "claude",
          agentState: "working",
        } as PtyPanelData,
      },
      panelIds: ["a"],
    });
  }

  it("records what the host reported and saves it, so the next restore sees it", () => {
    seedAgent();

    usePanelStore.getState().updateAgentState("a", "idle", undefined, 7_000, "output");

    expect(ptyPanel("a")).toMatchObject({
      agentState: "idle",
      lastStateChange: 7_000,
      lastAgentObservation: { agentState: "idle", at: 7_000 },
    });
    expect(saveNormalized).toHaveBeenCalledTimes(1);
    const [byId] = vi.mocked(saveNormalized).mock.calls[0]!;
    expect((byId.a as PtyPanelData).lastAgentObservation).toEqual({
      agentState: "idle",
      at: 7_000,
    });
  });

  it("neither records nor saves the renderer's own overlays and guesses", () => {
    seedAgent();
    usePanelStore.getState().updateAgentState("a", "idle", undefined, 7_000, "output");
    vi.mocked(saveNormalized).mockClear();

    // The input controller's directing, then its optimistic working: no host time.
    usePanelStore.getState().updateAgentState("a", "directing");
    usePanelStore.getState().updateAgentState("a", "working");

    expect(ptyPanel("a")?.agentState).toBe("working");
    expect(ptyPanel("a")?.lastAgentObservation).toEqual({ agentState: "idle", at: 7_000 });
    expect(saveNormalized).not.toHaveBeenCalled();
  });

  it("records but doesn't save while a hydration batch has panels still to add", () => {
    seedAgent();
    const token = beginBatch();
    try {
      usePanelStore.getState().updateAgentState("a", "idle", undefined, 7_000, "output");
    } finally {
      consumeBatch(token);
    }

    expect(ptyPanel("a")?.lastAgentObservation).toEqual({ agentState: "idle", at: 7_000 });
    expect(saveNormalized).not.toHaveBeenCalled();
  });

  it("records the host confirming what the screen already guessed", () => {
    seedAgent();
    // The optimistic `working` the controller writes on Enter: no host time.
    usePanelStore.getState().updateAgentState("a", "working");
    const shownSince = ptyPanel("a")?.lastStateChange;

    // Host resync reports the same state, with its time and no trigger.
    usePanelStore.getState().updateAgentState("a", "working", undefined, 7_000);

    expect(ptyPanel("a")?.lastAgentObservation).toEqual({ agentState: "working", at: 7_000 });
    // Nothing visible changed, so neither does when the screen says it began.
    expect(ptyPanel("a")?.lastStateChange).toBe(shownSince);
    expect(saveNormalized).toHaveBeenCalledTimes(1);
  });

  it("keeps when an observed state began across a repeated report of it", () => {
    seedAgent();
    usePanelStore.getState().updateAgentState("a", "idle", undefined, 7_000, "output");
    vi.mocked(saveNormalized).mockClear();

    usePanelStore.getState().updateAgentState("a", "idle", undefined, 9_000, "heuristic");

    expect(ptyPanel("a")?.lastAgentObservation).toEqual({ agentState: "idle", at: 7_000 });
    expect(saveNormalized).not.toHaveBeenCalled();
  });

  it("writes what a batch deferred when it closes, even with no panels to add", () => {
    seedAgent();
    const token = usePanelStore.getState().beginHydrationBatch();
    usePanelStore.getState().updateAgentState("a", "idle", undefined, 7_000, "output");
    expect(saveNormalized).not.toHaveBeenCalled();

    usePanelStore.getState().flushHydrationBatch(token);

    expect(saveNormalized).toHaveBeenCalledTimes(1);
    const [byId, ids] = vi.mocked(saveNormalized).mock.calls[0]!;
    expect(ids).toEqual(["a"]);
    expect((byId.a as PtyPanelData).lastAgentObservation).toEqual({
      agentState: "idle",
      at: 7_000,
    });
  });

  it("records a report kept off a directing pane, and saves it (#16062)", () => {
    seedAgent();
    usePanelStore.getState().updateAgentState("a", "directing");

    usePanelStore.getState().noteAgentObservation("a", "waiting", 7_000);

    expect(ptyPanel("a")).toMatchObject({
      agentState: "directing",
      lastAgentObservation: { agentState: "waiting", at: 7_000 },
    });
    expect(saveNormalized).toHaveBeenCalledTimes(1);
  });

  it("notes neither directing nor a repeat of the observed state", () => {
    seedAgent();
    usePanelStore.getState().noteAgentObservation("a", "waiting", 7_000);
    vi.mocked(saveNormalized).mockClear();

    usePanelStore.getState().noteAgentObservation("a", "waiting", 9_000);
    usePanelStore.getState().noteAgentObservation("a", "directing", 9_500);

    expect(ptyPanel("a")?.lastAgentObservation).toEqual({ agentState: "waiting", at: 7_000 });
    expect(saveNormalized).not.toHaveBeenCalled();
  });

  it("leaves a noted report's save to a hydration batch's close", () => {
    seedAgent();
    const token = usePanelStore.getState().beginHydrationBatch();
    usePanelStore.getState().noteAgentObservation("a", "waiting", 7_000);
    expect(saveNormalized).not.toHaveBeenCalled();

    usePanelStore.getState().flushHydrationBatch(token);

    expect(saveNormalized).toHaveBeenCalledTimes(1);
    const [byId] = vi.mocked(saveNormalized).mock.calls[0]!;
    expect((byId.a as PtyPanelData).lastAgentObservation).toEqual({
      agentState: "waiting",
      at: 7_000,
    });
  });

  it("writes nothing for a duplicate event", () => {
    seedAgent();

    usePanelStore.getState().updateAgentState("a", "working");

    expect(saveNormalized).not.toHaveBeenCalled();
  });
});

describe("setHoldOnRestart", () => {
  function seedPane(holdOnRestart?: true) {
    usePanelStore.setState({
      panelsById: {
        a: {
          id: "a",
          kind: "terminal",
          title: "Claude",
          cwd: "/repo",
          cols: 80,
          rows: 24,
          location: "grid",
          launchAgentId: "claude",
          launchedByPluginId: "acme.orchestrator",
          ...(holdOnRestart && { holdOnRestart }),
        } as PtyPanelData,
      },
      panelIds: ["a"],
    });
  }

  it("sets and clears the hold, saving each change", () => {
    seedPane();

    usePanelStore.getState().setHoldOnRestart("a", true);
    expect(ptyPanel("a")?.holdOnRestart).toBe(true);

    usePanelStore.getState().setHoldOnRestart("a", false);
    expect(ptyPanel("a")?.holdOnRestart).toBeUndefined();
    expect(saveNormalized).toHaveBeenCalledTimes(2);
  });

  it("writes nothing when the hold is already as asked, or the pane is gone", () => {
    seedPane(true);

    usePanelStore.getState().setHoldOnRestart("a", true);
    usePanelStore.getState().setHoldOnRestart("missing", true);

    expect(saveNormalized).not.toHaveBeenCalled();
  });
});

describe("reconnecting onto a pane the store already holds", () => {
  it("keeps the newer observation, and drops a hold the live PTY has left", async () => {
    usePanelStore.setState({
      panelsById: {
        a: {
          id: "a",
          kind: "terminal",
          title: "Claude",
          cwd: "/repo",
          cols: 80,
          rows: 24,
          location: "grid",
          launchAgentId: "claude",
          lastAgentObservation: { agentState: "idle", at: 8_000 },
          restoreProvenance: provenance,
        } as PtyPanelData,
      },
      panelIds: ["a"],
    });

    // A backend read taken before the live report landed.
    await usePanelStore.getState().addPanel({
      kind: "terminal",
      existingId: "a",
      launchAgentId: "claude",
      cwd: "/repo",
      title: "Claude",
      lastAgentObservation: { agentState: "working", at: 6_000 },
      restoreProvenance: provenance,
      bypassLimits: true,
    });

    expect(ptyPanel("a")?.lastAgentObservation).toEqual({ agentState: "idle", at: 8_000 });
    expect(ptyPanel("a")?.restoreProvenance).toBeUndefined();
  });
});
