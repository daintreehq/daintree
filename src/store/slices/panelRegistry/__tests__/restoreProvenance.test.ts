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

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
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
  },
}));

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

  it("saves the layout when the state changes, so the next restore sees it", () => {
    seedAgent();

    usePanelStore.getState().updateAgentState("a", "idle", undefined, 7_000);

    expect(ptyPanel("a")).toMatchObject({ agentState: "idle", lastStateChange: 7_000 });
    expect(saveNormalized).toHaveBeenCalledTimes(1);
    const [byId] = vi.mocked(saveNormalized).mock.calls[0]!;
    expect((byId.a as PtyPanelData).agentState).toBe("idle");
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
