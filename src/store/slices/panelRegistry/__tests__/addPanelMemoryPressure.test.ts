/**
 * Agent launches held at critical kernel memory pressure (#13530). The pane's
 * chrome commits as usual; only the PTY spawn waits, outside the startup
 * queue, until pressure eases or the user launches it anyway.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PtyPanelData } from "@shared/types/panel";

const isMemoryPressureCriticalMock = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
vi.mock("@/clients/systemClient", () => ({
  systemClient: { isMemoryPressureCritical: isMemoryPressureCriticalMock },
}));

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
    // No attached renderer xterm in these tests — spawn falls back to the
    // default/estimated dims path.
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
const { terminalClient } = (await import("@/clients")) as unknown as {
  terminalClient: { spawn: ReturnType<typeof vi.fn> };
};
const {
  launchDespiteMemoryPressure,
  panelHoldKey,
  resetMemoryPressureHoldsForTesting,
  useMemoryPressureWaitStore,
  MEMORY_PRESSURE_POLL_MS,
} = await import("@/store/memoryPressureWaitStore");

function getPtyPanel(id: string): PtyPanelData | undefined {
  return usePanelStore.getState().panelsById[id] as PtyPanelData | undefined;
}

async function drainMicrotasks(iterations = 100): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await Promise.resolve();
  }
}

const spawnedIds = () =>
  terminalClient.spawn.mock.calls.map(([options]) => (options as { id: string }).id);

const isHeld = (id: string) => useMemoryPressureWaitStore.getState().heldPanelIds[id] === true;

function launchAgent(requestedId: string, extra: Record<string, unknown> = {}) {
  return usePanelStore.getState().addPanel({
    kind: "terminal",
    launchAgentId: "claude",
    command: "claude",
    requestedId,
    cwd: "/",
    bypassLimits: true,
    ...extra,
  });
}

describe("agent launches at critical memory pressure (#13530)", () => {
  beforeEach(async () => {
    await usePanelStore.getState().reset();
    resetMemoryPressureHoldsForTesting();
    terminalClient.spawn.mockReset();
    terminalClient.spawn.mockImplementation(async ({ id }: { id?: string }) => id ?? "spawn-id");
    isMemoryPressureCriticalMock.mockReset();
    isMemoryPressureCriticalMock.mockResolvedValue(true);
  });

  afterEach(() => {
    resetMemoryPressureHoldsForTesting();
    vi.useRealTimers();
  });

  it("commits the pane but holds its spawn", async () => {
    await launchAgent("held-1");
    await drainMicrotasks();

    expect(getPtyPanel("held-1")?.spawnStatus).toBe("spawning");
    expect(isHeld("held-1")).toBe(true);
    expect(terminalClient.spawn).not.toHaveBeenCalled();
  });

  it("never holds a plain shell, even queued behind a held agent", async () => {
    await launchAgent("held-agent");
    await usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: "shell-1",
      cwd: "/",
      bypassLimits: true,
    });
    await drainMicrotasks();

    expect(spawnedIds()).toEqual(["shell-1"]);
    expect(getPtyPanel("shell-1")?.spawnStatus).toBe("ready");
    expect(isHeld("held-agent")).toBe(true);
  });

  it("never holds the assistant", async () => {
    await launchAgent("assistant-1", { location: "overlay" });
    await drainMicrotasks();

    expect(spawnedIds()).toEqual(["assistant-1"]);
    expect(isHeld("assistant-1")).toBe(false);
  });

  it("holds a restored agent like a launched one", async () => {
    await launchAgent("restored-1", { restore: true });
    await drainMicrotasks();

    expect(isHeld("restored-1")).toBe(true);
    expect(terminalClient.spawn).not.toHaveBeenCalled();
  });

  it("launches one held pane anyway, at once, without the others", async () => {
    await launchAgent("held-a");
    await launchAgent("held-b");
    await drainMicrotasks();

    launchDespiteMemoryPressure(panelHoldKey("held-a"));
    await drainMicrotasks();

    expect(spawnedIds()).toEqual(["held-a"]);
    expect(getPtyPanel("held-a")?.spawnStatus).toBe("ready");
    expect(isHeld("held-b")).toBe(true);
  });

  it("starts held panes on its own once pressure eases", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await launchAgent("held-a");
    await launchAgent("held-b");
    await drainMicrotasks();
    expect(terminalClient.spawn).not.toHaveBeenCalled();

    isMemoryPressureCriticalMock.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(MEMORY_PRESSURE_POLL_MS);
    await drainMicrotasks();

    expect(spawnedIds()).toEqual(["held-a", "held-b"]);
    expect(getPtyPanel("held-b")?.spawnStatus).toBe("ready");
  });

  it("drops the hold of a pane removed while it waited", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await launchAgent("held-gone");
    await drainMicrotasks();

    usePanelStore.getState().removePanel("held-gone");
    isMemoryPressureCriticalMock.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(MEMORY_PRESSURE_POLL_MS);
    await drainMicrotasks();

    expect(terminalClient.spawn).not.toHaveBeenCalled();
    expect(isHeld("held-gone")).toBe(false);
  });

  it("launches straight away when pressure is below critical", async () => {
    isMemoryPressureCriticalMock.mockResolvedValue(false);
    await launchAgent("free-1");
    await drainMicrotasks();

    expect(spawnedIds()).toEqual(["free-1"]);
    expect(isHeld("free-1")).toBe(false);
  });
});
