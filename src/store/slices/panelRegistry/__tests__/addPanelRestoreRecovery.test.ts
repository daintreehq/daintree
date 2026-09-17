/**
 * A pane held for recovery (#12434) commits without a process, and a later
 * launch replaces it in place — once, and never after it was closed.
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
const { agentLifecycleLedger } = await import("@/services/terminal/lifecycleLedger");
const { terminalClient } = await import("@/clients");
const spawn = vi.mocked(terminalClient.spawn);
const { terminalInstanceService } = await import("@/services/TerminalInstanceService");

async function drainMicrotasks(iterations = 100): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await Promise.resolve();
  }
}

function ptyPanel(id: string): PtyPanelData | undefined {
  const panel = usePanelStore.getState().panelsById[id];
  return panel && isPtyPanel(panel) ? panel : undefined;
}

async function holdPane(id: string): Promise<void> {
  await usePanelStore.getState().addPanel({
    kind: "terminal",
    requestedId: id,
    launchAgentId: "codex",
    command: "codex",
    cwd: "/worktrees/task-a",
    worktreeId: "/worktrees/task-a",
    conversationCwd: "/repo",
    restoreRecovery: { reason: "sibling-owns-resume-latest-slot" },
    title: "Task A",
    bypassLimits: true,
  });
}

function launchOver(id: string) {
  return usePanelStore.getState().addPanel({
    kind: "terminal",
    requestedId: id,
    replacesRestoreRecovery: true,
    launchAgentId: "codex",
    command: "codex resume sess-1 -C '.'",
    agentSessionId: "sess-1",
    conversationCwd: "/repo",
    cwd: "/worktrees/task-a",
    worktreeId: "/worktrees/task-a",
    title: "Task A",
  });
}

describe("addPanel — recovery holds (#12434)", () => {
  beforeEach(async () => {
    await usePanelStore.getState().reset();
    spawn.mockReset();
    spawn.mockImplementation(async ({ id }) => id ?? "spawn-id");
    vi.mocked(terminalInstanceService.prewarmTerminal).mockReset();
    usePanelLimitStore.setState({ softWarningLimit: 100, confirmationLimit: 200, hardLimit: 300 });
  });

  it("commits a held pane with no process, no startup work and no launch record", async () => {
    await holdPane("held-1");
    await drainMicrotasks();

    const panel = ptyPanel("held-1");
    expect(panel?.restoreRecovery).toEqual({ reason: "sibling-owns-resume-latest-slot" });
    expect(panel?.hasPty).toBe(false);
    expect(panel?.conversationCwd).toBe("/repo");
    expect(panel?.cwd).toBe("/worktrees/task-a");
    expect(panel?.command).toBe("codex");
    expect(panel?.agentState).toBeUndefined();
    expect(panel?.spawnStatus).toBeUndefined();
    expect(panel?.runtimeStatus).toBeUndefined();
    expect(panel?.startedAt).toBeUndefined();
    expect(usePanelStore.getState().panelIds).toContain("held-1");

    expect(spawn).not.toHaveBeenCalled();
    expect(terminalInstanceService.prewarmTerminal).not.toHaveBeenCalled();
    expect(agentLifecycleLedger.getEntry("held-1")).toBeUndefined();
  });

  it("leaves the startup queue free for the launches that follow", async () => {
    await holdPane("held-1");
    await holdPane("held-2");

    await usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: "plain",
      cwd: "/repo",
      bypassLimits: true,
    });
    await drainMicrotasks();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({ id: "plain" });
  });

  it("launches a held pane in place, keeping its position", async () => {
    await usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: "before",
      cwd: "/repo",
      bypassLimits: true,
    });
    await holdPane("held-1");
    await usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: "after",
      cwd: "/repo",
      bypassLimits: true,
    });
    await drainMicrotasks();
    spawn.mockClear();

    await expect(launchOver("held-1")).resolves.toBe("held-1");
    await drainMicrotasks();

    expect(usePanelStore.getState().panelIds).toEqual(["before", "held-1", "after"]);
    const panel = ptyPanel("held-1");
    expect(panel?.restoreRecovery).toBeUndefined();
    expect(panel?.hasPty).not.toBe(false);
    expect(panel?.agentSessionId).toBe("sess-1");
    expect(panel?.conversationCwd).toBe("/repo");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({
      id: "held-1",
      cwd: "/worktrees/task-a",
      command: "codex resume sess-1 -C '.'",
      agentSessionId: "sess-1",
    });
  });

  it("drops a launch for a held pane that was closed while it waited", async () => {
    await holdPane("held-1");
    const pending = launchOver("held-1");
    usePanelStore.getState().removePanel("held-1");

    await expect(pending).resolves.toBeNull();
    await drainMicrotasks();

    expect(usePanelStore.getState().panelsById["held-1"]).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("launches a held pane only once however many launches race for it", async () => {
    await holdPane("held-1");

    const results = await Promise.all([launchOver("held-1"), launchOver("held-1")]);
    await drainMicrotasks();

    expect(results.filter((id) => id === "held-1")).toHaveLength(1);
    expect(results.filter((id) => id === null)).toHaveLength(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("refuses to treat an ordinary pane as a held one", async () => {
    await usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: "plain",
      cwd: "/repo",
      bypassLimits: true,
    });
    await drainMicrotasks();
    spawn.mockClear();

    await expect(launchOver("plain")).resolves.toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("lets a held pane launch at the panel limit, since it replaces rather than adds", async () => {
    await holdPane("held-1");
    usePanelLimitStore.setState({ softWarningLimit: 1, confirmationLimit: 1, hardLimit: 1 });

    await expect(
      usePanelStore.getState().addPanel({ kind: "terminal", requestedId: "extra", cwd: "/repo" })
    ).resolves.toBeNull();
    await expect(launchOver("held-1")).resolves.toBe("held-1");
  });
});
