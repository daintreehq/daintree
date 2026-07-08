/**
 * Generation-safety tests for the panel-store lifecycle ledger wiring:
 * close-before-spawn resolution, stale hydration replay over a live launch,
 * and idempotent double-hydration re-merge.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PtyPanelData } from "@shared/types/panel";

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
    waitForAttachSettled: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(() => null),
  },
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
    electron: {
      globalEnv: {
        get: vi.fn().mockResolvedValue({}),
      },
    },
  };
});

const { usePanelStore } = await import("../../../panelStore");
const { agentLifecycleLedger } = await import("@/services/terminal/lifecycleLedger");
const { terminalClient } = (await import("@/clients")) as unknown as {
  terminalClient: {
    spawn: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
  };
};

function getPtyPanel(id: string): PtyPanelData | undefined {
  return usePanelStore.getState().panelsById[id] as PtyPanelData | undefined;
}

// Drain microtasks: the spawn task chains through Promise.all (env fetch) →
// terminalClient.spawn → set ready → waitForAttachSettled, all microtask-fast
// under mocked IPC. Mirrors the optimisticPanelSpawn test (#5789), which uses
// the same spawn flow and passes reliably under CI. vi.waitFor's macrotask
// polling adds OS-scheduler jitter that can race the spawn task under load.
async function drainMicrotasks(iterations = 100): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await Promise.resolve();
  }
}

describe("addPanel lifecycle ledger", () => {
  beforeEach(async () => {
    await usePanelStore.getState().reset();
    agentLifecycleLedger.clear();
    terminalClient.spawn.mockReset().mockResolvedValue(undefined);
    terminalClient.kill.mockReset().mockResolvedValue(undefined);
    // Explicitly reset waitForAttachSettled so the spawn task's post-ready
    // await resolves immediately. The mock factory sets mockResolvedValue but
    // a prior test's mockImplementation (or vitest's mock state under load)
    // can survive into the next test if not explicitly cleared — mirrors the
    // optimisticPanelSpawn test's beforeEach.
    const { terminalInstanceService } = await import("@/services/TerminalInstanceService");
    const waitForAttachSettledMock = vi.mocked(terminalInstanceService.waitForAttachSettled);
    waitForAttachSettledMock.mockReset();
    waitForAttachSettledMock.mockResolvedValue(undefined);
  });

  it("records launch facts, spawn resolution, and env provenance", async () => {
    const id = await usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: "term-facts",
      cwd: "/repo/wt-a",
      worktreeId: "wt-a",
      launchAgentId: "claude",
      agentModelId: "opus",
      env: { ANTHROPIC_API_KEY: "sk-secret" },
      location: "grid",
      bypassLimits: true,
    });

    expect(id).toBe("term-facts");
    await drainMicrotasks();
    expect(getPtyPanel("term-facts")?.spawnStatus).toBe("ready");

    const entry = agentLifecycleLedger.getEntry("term-facts");
    expect(entry?.generation).toBe(1);
    expect(entry?.facts).toMatchObject({
      launchAgentId: "claude",
      agentModelId: "opus",
      worktreeId: "wt-a",
      worktreeSource: "explicit",
    });
    expect(entry?.spawnOk).toBe(true);
    expect(entry?.facts.env?.keys).toEqual(["ANTHROPIC_API_KEY"]);
    expect(JSON.stringify(entry)).not.toContain("sk-secret");
  });

  it("close-before-spawn: removal mid-spawn closes the generation and compensates with a kill", async () => {
    let resolveSpawn!: () => void;
    terminalClient.spawn.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSpawn = resolve;
        })
    );

    const id = await usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: "term-race",
      cwd: "/repo",
      location: "grid",
      bypassLimits: true,
    });
    expect(id).toBe("term-race");

    // Wait until the startup queue has issued the spawn IPC.
    await drainMicrotasks();
    expect(terminalClient.spawn).toHaveBeenCalledTimes(1);

    // User closes the panel while the spawn IPC is still in flight.
    usePanelStore.getState().removePanel("term-race");
    expect(agentLifecycleLedger.getEntry("term-race")?.closedAt).toBeDefined();
    expect(agentLifecycleLedger.getEntry("term-race")?.closeReason).toBe("removed");
    const killsAtRemoval = terminalClient.kill.mock.calls.length;

    // Spawn resolves late — the orphaned PTY must be compensating-killed.
    resolveSpawn();
    await drainMicrotasks();
    expect(terminalClient.kill.mock.calls.length).toBeGreaterThan(killsAtRemoval);
    expect(usePanelStore.getState().panelsById["term-race"]).toBeUndefined();
  });

  it("stale hydration replay cannot overwrite a live fresh launch", async () => {
    // Fresh user launch owns the id.
    await usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: "term-live",
      cwd: "/repo/wt-a",
      worktreeId: "wt-a",
      launchAgentId: "claude",
      agentModelId: "opus",
      location: "grid",
      bypassLimits: true,
    });
    await drainMicrotasks();
    expect(getPtyPanel("term-live")?.spawnStatus).toBe("ready");

    // A hydration replay for the same id arrives late, carrying a stale
    // persisted snapshot with different launch metadata.
    const replayId = await usePanelStore.getState().addPanel({
      kind: "terminal",
      existingId: "term-live",
      cwd: "/repo/old-path",
      launchAgentId: "codex",
      agentModelId: "stale-model",
      location: "grid",
      bypassLimits: true,
    });

    // The call reports the id (panel exists) but the live panel is untouched.
    expect(replayId).toBe("term-live");
    const panel = getPtyPanel("term-live");
    expect(panel?.launchAgentId).toBe("claude");
    expect(panel?.agentModelId).toBe("opus");
    expect(panel?.cwd).toBe("/repo/wt-a");

    // The rejection is auditable.
    const anomalies = agentLifecycleLedger.getAnomalies();
    expect(anomalies.some((a) => a.op === "restore" && a.terminalId === "term-live")).toBe(true);
  });

  it("allows an idempotent re-merge when the panel itself is restore-born", async () => {
    // First hydration pass creates the reconnect panel.
    await usePanelStore.getState().addPanel({
      kind: "terminal",
      existingId: "term-restored",
      cwd: "/repo/wt-a",
      launchAgentId: "claude",
      agentModelId: "opus",
      location: "grid",
      bypassLimits: true,
    });
    expect(getPtyPanel("term-restored")).toBeDefined();
    expect(agentLifecycleLedger.getEntry("term-restored")?.restoredAt).toBeDefined();

    // Double hydration re-merges the same snapshot — allowed and applied.
    await usePanelStore.getState().addPanel({
      kind: "terminal",
      existingId: "term-restored",
      cwd: "/repo/wt-a",
      launchAgentId: "claude",
      agentModelId: "opus-4.1",
      location: "grid",
      bypassLimits: true,
    });

    expect(getPtyPanel("term-restored")?.agentModelId).toBe("opus-4.1");
    expect(agentLifecycleLedger.currentGeneration("term-restored")).toBe(2);
  });

  it("stamps inferred worktree provenance from AddPanelOptions", async () => {
    await usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: "term-inferred",
      cwd: "/repo/wt-b/sub",
      worktreeId: "wt-b",
      worktreeIdSource: "inferred",
      location: "grid",
      bypassLimits: true,
    });

    const entry = agentLifecycleLedger.getEntry("term-inferred");
    expect(entry?.facts.worktreeSource).toBe("inferred");

    // A later explicit move wins; a later divergent inference is rejected.
    const generation = entry!.generation;
    expect(
      agentLifecycleLedger.recordWorktreeAttribution(
        "term-inferred",
        generation,
        "wt-c",
        "explicit"
      ).accepted
    ).toBe(true);
    expect(
      agentLifecycleLedger.recordWorktreeAttribution(
        "term-inferred",
        generation,
        "wt-d",
        "inferred"
      ).accepted
    ).toBe(false);
  });
});
