/**
 * Tests for optimistic panel spawn (#5789).
 *
 * addPanel commits to the store synchronously (as a "spawning" placeholder),
 * then realizes backend spawn and visible xterm mount through the startup
 * queue. Six rapid agent clicks surface as six parallel placeholders without
 * dispatching six PTY spawns / xterm opens in the same layout burst.
 */

import { beforeAll, describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PtyPanelData } from "@shared/types/panel";
import { ClientAppError } from "@/utils/clientAppError";

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
    fetchAndRestore: vi.fn().mockResolvedValue(true),
    setAgentState: vi.fn(),
    // No attached renderer xterm in these tests — spawn falls back to the
    // default/estimated dims path.
    get: vi.fn(() => null),
  };
  return {
    createTerminalPaintPlane: () => terminalInstanceService,
  };
});

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
const { load: loadTerminalService } =
  await import("@/services/terminal/terminalInstanceServiceAccessor");

// The service mock never evaluates the real module, so nothing registers it;
// loading caches the mock for the synchronous peek() call sites.
beforeAll(async () => {
  await loadTerminalService();
});
const { agentLifecycleLedger } = await import("@/services/terminal/lifecycleLedger");
const { useHostConnectionStore } = await import("@/store/hostConnectionStore");
const { isSpawnUnconfirmed } = await import("../unconfirmedSpawn");
const { terminalClient } = (await import("@/clients")) as unknown as {
  terminalClient: {
    spawn: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    trash: ReturnType<typeof vi.fn>;
  };
};

function getPtyPanel(id: string): PtyPanelData | undefined {
  return usePanelStore.getState().panelsById[id] as PtyPanelData | undefined;
}

// Drain microtasks. The background spawn promise chains through Promise.all
// (env fetch) → terminalClient.spawn → .then, which takes several ticks.
async function drainMicrotasks(iterations = 100): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await Promise.resolve();
  }
}

// The queue waits on a visible attach only for a pane whose chrome is on the
// page (#15271). These suites run without a DOM, so the panes a test treats as
// mounted grid panes are put on a stand-in page.
function putPanesOnPage(ids: string[]): void {
  vi.stubGlobal("document", {
    querySelectorAll: () => ids.map((panelId) => ({ dataset: { panelId } })),
  });
}

describe("optimistic panel spawn (#5789)", () => {
  beforeEach(async () => {
    const { reset } = usePanelStore.getState();
    await reset();

    const { terminalClient } = (await import("@/clients")) as unknown as {
      terminalClient: { spawn: ReturnType<typeof vi.fn> };
    };
    terminalClient.spawn.mockReset();
    terminalClient.spawn.mockImplementation(async ({ id }: { id?: string }) => id ?? "spawn-id");
    const terminalInstanceService = (
      await import("@/services/TerminalInstanceService")
    ).createTerminalPaintPlane();
    const waitForAttachSettledMock = vi.mocked(terminalInstanceService.waitForAttachSettled);
    waitForAttachSettledMock.mockReset();
    waitForAttachSettledMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("commits the panel to the store before terminalClient.spawn resolves", async () => {
    const { terminalClient } = (await import("@/clients")) as unknown as {
      terminalClient: { spawn: ReturnType<typeof vi.fn> };
    };

    let release: (() => void) | null = null;
    const spawnGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    terminalClient.spawn.mockImplementationOnce(async ({ id }: { id?: string }) => {
      await spawnGate;
      return id ?? "delayed";
    });

    const { addPanel } = usePanelStore.getState();
    const id = await addPanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
      requestedId: "opt-1",
      cwd: "/",
      bypassLimits: true,
    });

    expect(id).toBe("opt-1");
    const panel = getPtyPanel("opt-1");
    expect(panel).toBeDefined();
    expect(panel?.spawnStatus).toBe("spawning");
    // A single active-grid launch mounts its xterm eagerly (startup queue idle).
    expect(panel?.eagerAttach).toBe(true);
    expect(panel?.runtimeIdentity).toMatchObject({
      kind: "agent",
      agentId: "claude",
      iconId: "claude",
    });
    expect(usePanelStore.getState().panelIds).toContain("opt-1");

    release!();
    // Drain microtasks so spawnStatus transitions to "ready".
    await drainMicrotasks();

    const after = getPtyPanel("opt-1");
    expect(after?.spawnStatus).toBe("ready");
  });

  it("registers six concurrent agent launches as parallel placeholders but queued spawns", async () => {
    const { terminalClient } = (await import("@/clients")) as unknown as {
      terminalClient: { spawn: ReturnType<typeof vi.fn> };
    };
    const terminalInstanceService = (
      await import("@/services/TerminalInstanceService")
    ).createTerminalPaintPlane();
    const waitForAttachSettledMock = vi.mocked(terminalInstanceService.waitForAttachSettled);

    let releaseFirstSpawn: () => void = () => {};
    const firstSpawnGate = new Promise<void>((resolve) => {
      releaseFirstSpawn = resolve;
    });
    let releaseFirstAttach: () => void = () => {};
    const firstAttachGate = new Promise<void>((resolve) => {
      releaseFirstAttach = resolve;
    });
    terminalClient.spawn.mockImplementation(async ({ id }: { id?: string }) => {
      if (id === "concurrent-0") {
        await firstSpawnGate;
      }
      return id ?? "queued";
    });
    waitForAttachSettledMock.mockImplementation((id: string) => {
      if (id === "concurrent-0") {
        return firstAttachGate;
      }
      return Promise.resolve();
    });
    putPanesOnPage(Array.from({ length: 6 }, (_, i) => `concurrent-${i}`));

    const { addPanel } = usePanelStore.getState();
    const launches = Array.from({ length: 6 }, (_, i) =>
      addPanel({
        kind: "terminal",
        launchAgentId: "claude",
        command: "claude",
        requestedId: `concurrent-${i}`,
        cwd: "/",
        bypassLimits: true,
      })
    );

    // All addPanel promises resolve immediately: chrome placeholders are not queued.
    const ids = (await Promise.all(launches)).filter((id): id is string => id !== null);
    expect(ids).toEqual([
      "concurrent-0",
      "concurrent-1",
      "concurrent-2",
      "concurrent-3",
      "concurrent-4",
      "concurrent-5",
    ]);

    const state = usePanelStore.getState();
    for (const id of ids) {
      expect((state.panelsById[id] as PtyPanelData | undefined)?.spawnStatus).toBe("spawning");
      expect(state.panelIds).toContain(id);
    }

    // Only the first launch of the burst gets the eager xterm mount; the
    // reservation taken at its eager decision hides the still-empty queue
    // from the rest, so they keep the one-per-frame realization gate.
    expect((state.panelsById["concurrent-0"] as PtyPanelData | undefined)?.eagerAttach).toBe(true);
    for (const id of ids.slice(1)) {
      expect((state.panelsById[id] as PtyPanelData | undefined)?.eagerAttach).toBeUndefined();
    }

    // Only the first PTY spawn is allowed to start while the startup job is
    // blocked, however long the queue is left to run.
    await drainMicrotasks();
    expect(terminalClient.spawn).toHaveBeenCalledTimes(1);
    expect(terminalClient.spawn.mock.calls[0]?.[0]).toMatchObject({ id: "concurrent-0" });

    releaseFirstSpawn();
    await drainMicrotasks();

    // The second spawn must also wait for the first visible attach to settle.
    expect(terminalClient.spawn).toHaveBeenCalledTimes(1);

    releaseFirstAttach();
    await drainMicrotasks();

    expect(terminalClient.spawn).toHaveBeenCalledTimes(6);

    const after = usePanelStore.getState();
    for (const id of ids) {
      expect((after.panelsById[id] as PtyPanelData | undefined)?.spawnStatus).toBe("ready");
    }
  });

  it("realizes a declared recipe batch three terminals at a time", async () => {
    const { terminalClient } = (await import("@/clients")) as unknown as {
      terminalClient: { spawn: ReturnType<typeof vi.fn> };
    };
    const terminalInstanceService = (
      await import("@/services/TerminalInstanceService")
    ).createTerminalPaintPlane();
    const waitForAttachSettledMock = vi.mocked(terminalInstanceService.waitForAttachSettled);
    const releases: Array<() => void> = [];
    const attachGates = Array.from(
      { length: 4 },
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        })
    );

    terminalClient.spawn.mockImplementation(async ({ id }: { id?: string }) => id ?? "batched");
    waitForAttachSettledMock.mockImplementation((id: string) => {
      const index = Number(id.slice("recipe-".length));
      return attachGates[index]!;
    });
    putPanesOnPage(Array.from({ length: 4 }, (_, i) => `recipe-${i}`));

    const { addPanel } = usePanelStore.getState();
    const launches = Array.from({ length: 4 }, (_, i) =>
      addPanel({
        kind: "terminal",
        launchAgentId: "claude",
        command: "claude",
        requestedId: `recipe-${i}`,
        cwd: "/",
        bypassLimits: true,
        spawnBatchId: "recipe-batch",
        spawnBatchSize: 4,
      })
    );

    await Promise.all(launches);
    await drainMicrotasks();
    expect(terminalClient.spawn).toHaveBeenCalledTimes(3);

    releases[0]!();
    await drainMicrotasks();
    expect(terminalClient.spawn).toHaveBeenCalledTimes(4);

    releases[1]!();
    await drainMicrotasks();
    expect(terminalClient.spawn).toHaveBeenCalledTimes(4);

    releases[2]!();
    releases[3]!();
    await drainMicrotasks();

    const state = usePanelStore.getState();
    for (let i = 0; i < 4; i++) {
      expect((state.panelsById[`recipe-${i}`] as PtyPanelData | undefined)?.spawnStatus).toBe(
        "ready"
      );
    }
  });

  it("doesn't hold a burst of launches on panes that aren't on the page", async () => {
    const { terminalClient } = (await import("@/clients")) as unknown as {
      terminalClient: { spawn: ReturnType<typeof vi.fn> };
    };
    const terminalInstanceService = (
      await import("@/services/TerminalInstanceService")
    ).createTerminalPaintPlane();
    const waitForAttachSettledMock = vi.mocked(terminalInstanceService.waitForAttachSettled);
    // An attach that never comes: the wait would hold each launch to its timeout.
    waitForAttachSettledMock.mockImplementation(() => new Promise<void>(() => {}));
    putPanesOnPage([]);

    const { addPanel } = usePanelStore.getState();
    const ids = Array.from({ length: 13 }, (_, i) => `fleet-${i}`);
    await Promise.all(
      ids.map((requestedId) =>
        addPanel({
          kind: "terminal",
          launchAgentId: "claude",
          command: "claude",
          requestedId,
          cwd: "/",
          bypassLimits: true,
        })
      )
    );
    await drainMicrotasks(ids.length * 100);

    expect(terminalClient.spawn).toHaveBeenCalledTimes(ids.length);
    expect(waitForAttachSettledMock).not.toHaveBeenCalled();
    for (const id of ids) {
      expect(getPtyPanel(id)?.spawnStatus).toBe("ready");
    }
  });

  it("holds the next spawn only behind a pane that is on the page", async () => {
    const { terminalClient } = (await import("@/clients")) as unknown as {
      terminalClient: { spawn: ReturnType<typeof vi.fn> };
    };
    const terminalInstanceService = (
      await import("@/services/TerminalInstanceService")
    ).createTerminalPaintPlane();
    const waitForAttachSettledMock = vi.mocked(terminalInstanceService.waitForAttachSettled);
    let releaseAttach: () => void = () => {};
    const attachGate = new Promise<void>((resolve) => {
      releaseAttach = resolve;
    });
    waitForAttachSettledMock.mockImplementation(() => attachGate);
    putPanesOnPage(["mixed-1"]);

    const { addPanel } = usePanelStore.getState();
    await Promise.all(
      ["mixed-0", "mixed-1", "mixed-2"].map((requestedId) =>
        addPanel({
          kind: "terminal",
          launchAgentId: "claude",
          command: "claude",
          requestedId,
          cwd: "/",
          bypassLimits: true,
        })
      )
    );
    await drainMicrotasks(300);

    expect(terminalClient.spawn.mock.calls.map(([args]) => (args as { id: string }).id)).toEqual([
      "mixed-0",
      "mixed-1",
    ]);
    expect(waitForAttachSettledMock).toHaveBeenCalledTimes(1);
    expect(waitForAttachSettledMock.mock.calls[0]?.[0]).toBe("mixed-1");

    releaseAttach();
    await drainMicrotasks();

    expect(terminalClient.spawn).toHaveBeenCalledTimes(3);
    expect(getPtyPanel("mixed-2")?.spawnStatus).toBe("ready");
  });

  it("does not stamp eagerAttach on dock launches", async () => {
    const { addPanel } = usePanelStore.getState();
    const id = await addPanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
      requestedId: "dock-eager",
      cwd: "/",
      location: "dock",
      bypassLimits: true,
    });

    expect(id).toBe("dock-eager");
    expect(getPtyPanel("dock-eager")?.eagerAttach).toBeUndefined();
    await drainMicrotasks();
  });

  it("keeps the panel with spawnStatus 'failed' when the background spawn rejects", async () => {
    const { terminalClient } = (await import("@/clients")) as unknown as {
      terminalClient: { spawn: ReturnType<typeof vi.fn> };
    };
    terminalClient.spawn.mockImplementationOnce(async () => {
      throw new Error("spawn boom");
    });

    const { addPanel } = usePanelStore.getState();
    const id = await addPanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
      requestedId: "will-fail",
      cwd: "/",
      bypassLimits: true,
    });

    expect(id).toBe("will-fail");
    expect(usePanelStore.getState().panelsById["will-fail"]).toBeDefined();

    // Drain microtasks for the rejection handler to set spawnStatus: "failed".
    await drainMicrotasks();

    const state = usePanelStore.getState();
    const failed = state.panelsById["will-fail"] as PtyPanelData | undefined;
    expect(failed).toBeDefined();
    expect(failed?.spawnStatus).toBe("failed");
    expect(failed?.spawnError?.code).toBe("UNKNOWN");
    expect(failed?.spawnError?.message).toBe("spawn boom");
    expect(failed?.runtimeStatus).toBe("error");
    // A launched agent that fails to start never produces a PTY exit, so mark it
    // "exited" so terminal.list / terminal.getStatus report the crash rather
    // than a phantom running agent (#10816).
    expect(failed?.agentState).toBe("exited");
  });

  it("leaves agentState undefined when a plain-shell spawn fails (#10816)", async () => {
    const { terminalClient } = (await import("@/clients")) as unknown as {
      terminalClient: { spawn: ReturnType<typeof vi.fn> };
    };
    terminalClient.spawn.mockImplementationOnce(async () => {
      throw new Error("shell boom");
    });

    const { addPanel } = usePanelStore.getState();
    await addPanel({
      kind: "terminal",
      command: "bash",
      requestedId: "shell-fail",
      cwd: "/",
      bypassLimits: true,
    });

    await drainMicrotasks();

    const failed = usePanelStore.getState().panelsById["shell-fail"] as PtyPanelData | undefined;
    expect(failed?.spawnStatus).toBe("failed");
    // No launchAgentId — it was never an agent, so it must not gain an agent state.
    expect(failed?.agentState).toBeUndefined();
  });

  it("shows a refusal from main by its user message, never the encoded wire prefix", async () => {
    const { terminalClient } = (await import("@/clients")) as unknown as {
      terminalClient: { spawn: ReturnType<typeof vi.fn> };
    };
    terminalClient.spawn.mockImplementationOnce(async () => {
      throw new Error(
        `[AppError|DRIVEN_ELSEWHERE|${encodeURIComponent(
          "This project is being driven from studio-01. Take it over to make changes."
        )}] terminal:spawn changes a project another window drives`
      );
    });

    const id = await usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: "refused-spawn",
      cwd: "/",
      bypassLimits: true,
    });
    await drainMicrotasks();

    const failed = usePanelStore.getState().panelsById[id!] as PtyPanelData | undefined;
    expect(failed?.spawnStatus).toBe("failed");
    // Not a spawn errno, so the banner's generic copy, with the person's sentence.
    expect(failed?.spawnError?.code).toBe("UNKNOWN");
    expect(failed?.spawnError?.message).toBe(
      "This project is being driven from studio-01. Take it over to make changes."
    );
  });

  it("does not remove a replacement panel when a stale spawn rejects", async () => {
    // Edge case: user closes spawning panel A (id X), a reconnect path reuses
    // id X with spawnStatus already "ready", then A's original spawn rejects.
    // The reject handler must not evict the replacement.
    const { terminalClient } = (await import("@/clients")) as unknown as {
      terminalClient: { spawn: ReturnType<typeof vi.fn> };
    };

    let rejectA: (reason: Error) => void = () => {};
    const gateA = new Promise<never>((_, reject) => {
      rejectA = reject;
    });
    terminalClient.spawn.mockImplementationOnce(async () => {
      await gateA;
      return "never";
    });

    const { addPanel, removePanel } = usePanelStore.getState();
    // Panel A (will fail).
    await addPanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
      requestedId: "shared-id",
      cwd: "/",
      bypassLimits: true,
    });
    await drainMicrotasks();
    expect(terminalClient.spawn).toHaveBeenCalledTimes(1);
    // User closes it mid-spawn.
    removePanel("shared-id");
    expect(usePanelStore.getState().panelsById["shared-id"]).toBeUndefined();

    // Reconnect path reuses the id (spawnStatus: "ready", spawn is skipped).
    await addPanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
      existingId: "shared-id",
      cwd: "/",
      bypassLimits: true,
    });
    expect(getPtyPanel("shared-id")?.spawnStatus).toBe("ready");

    // Now A's spawn finally rejects. The replacement must survive.
    rejectA(new Error("late failure"));
    await drainMicrotasks();

    const after = getPtyPanel("shared-id");
    expect(after).toBeDefined();
    expect(after?.spawnStatus).toBe("ready");
  });

  it("does not block the panel render on env fetch latency", async () => {
    // The panel must appear before globalEnvClient.get() and
    // projectClient.getSettings() resolve — env fetch is background, not gating.
    const { globalEnvClient, projectClient } = (await import("@/clients")) as unknown as {
      globalEnvClient: { get: ReturnType<typeof vi.fn> };
      projectClient: { getSettings: ReturnType<typeof vi.fn> };
    };
    let releaseEnv: () => void = () => {};
    globalEnvClient.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseEnv = () => resolve({});
        })
    );

    let releaseSettings: () => void = () => {};
    projectClient.getSettings.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSettings = () => resolve({});
        })
    );

    const { addPanel } = usePanelStore.getState();
    const id = await addPanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
      requestedId: "env-latent",
      cwd: "/",
      bypassLimits: true,
    });

    expect(id).toBe("env-latent");
    expect(getPtyPanel("env-latent")?.spawnStatus).toBe("spawning");
    expect(usePanelStore.getState().panelIds).toContain("env-latent");

    releaseEnv();
    releaseSettings();
    await drainMicrotasks();
    expect(getPtyPanel("env-latent")?.spawnStatus).toBe("ready");
  });
});

/**
 * Generation-safety tests for the panel-store lifecycle ledger wiring:
 * close-before-spawn resolution, stale hydration replay over a live launch,
 * and idempotent double-hydration re-merge.
 */
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
    const terminalInstanceService = (
      await import("@/services/TerminalInstanceService")
    ).createTerminalPaintPlane();
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

describe("a spawn whose answer was lost with the link (#13915)", () => {
  const lostReply = () =>
    new ClientAppError(
      "OUTCOME_UNKNOWN",
      "Link closed before the peer answered: socket closed",
      "The host may have completed this; check before retrying."
    );
  const hostReconnect = vi.fn();
  const reconnect = () => hostReconnect;

  beforeEach(async () => {
    await usePanelStore.getState().reset();
    agentLifecycleLedger.clear();
    useHostConnectionStore.getState().reset();
    terminalClient.spawn.mockReset().mockResolvedValue(undefined);
    terminalClient.kill.mockReset().mockResolvedValue(undefined);
    hostReconnect.mockReset().mockResolvedValue({ exists: false });
    Object.assign(window.electron, { terminal: { reconnect: hostReconnect } });
    const terminalInstanceService = (
      await import("@/services/TerminalInstanceService")
    ).createTerminalPaintPlane();
    vi.mocked(terminalInstanceService.waitForAttachSettled)
      .mockReset()
      .mockResolvedValue(undefined);
    vi.mocked(terminalInstanceService.fetchAndRestore).mockClear();
  });

  // A test that stopped early leaves its check waiting on the link; settle it
  // here, at once, before the next test's mocks are in place.
  afterEach(async () => {
    hostReconnect.mockResolvedValue({ exists: false, conflict: true });
    useHostConnectionStore.getState().reset();
    await drainMicrotasks(300);
  });

  it("attaches to the terminal the host started instead of failing the pane", async () => {
    terminalClient.spawn.mockRejectedValueOnce(lostReply());
    reconnect().mockResolvedValue({
      exists: true,
      id: "lost-1",
      hasPty: true,
      agentState: "waiting",
      waitingReason: "prompt",
      lastStateChange: Date.now() + 1_000,
    });

    await usePanelStore.getState().addPanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
      requestedId: "lost-1",
      cwd: "/",
      bypassLimits: true,
    });
    await drainMicrotasks(300);

    const panel = getPtyPanel("lost-1");
    expect(reconnect()).toHaveBeenCalledWith("lost-1");
    expect(panel?.spawnStatus).toBe("ready");
    expect(panel?.spawnError).toBeUndefined();
    expect(panel?.runtimeStatus).not.toBe("error");
    expect(panel?.agentState).toBe("waiting");
    expect(agentLifecycleLedger.getEntry("lost-1")?.spawnOk).toBe(true);
    // The screen the agent drew while the link was down comes from the host.
    const terminalInstanceService = (
      await import("@/services/TerminalInstanceService")
    ).createTerminalPaintPlane();
    expect(terminalInstanceService.fetchAndRestore).toHaveBeenCalledWith("lost-1");
  });

  const launchAgent = (requestedId: string) =>
    usePanelStore.getState().addPanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
      requestedId,
      cwd: "/",
      bypassLimits: true,
    });

  const linkDown = () =>
    useHostConnectionStore.setState({
      hostId: "studio-01",
      hostName: "studio-01",
      connection: { status: "connecting", attempt: 1 },
    });
  const linkUp = () =>
    useHostConnectionStore.setState({
      connection: {
        status: "connected",
        rttMs: null,
        handshake: {
          version: "1.0.0",
          commit: "abc123",
          protocolVersion: 1,
          platform: "darwin",
          arch: "arm64",
        },
      },
    });

  it("fails the pane, with Retry, once the host has gone on not listing the terminal", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      terminalClient.spawn.mockRejectedValueOnce(lostReply());
      await launchAgent("lost-absent");
      await drainMicrotasks(300);
      // Still unknown while the host is asked again: not failed yet.
      expect(getPtyPanel("lost-absent")?.spawnStatus).toBe("spawning");

      await vi.advanceTimersByTimeAsync(30_000);
      // Still being asked well past the first answers: a large recipe can keep
      // a launch in the host's admission queue that long.
      expect(getPtyPanel("lost-absent")?.spawnStatus).toBe("spawning");

      await vi.advanceTimersByTimeAsync(40_000);
      await drainMicrotasks(300);
    } finally {
      vi.useRealTimers();
    }

    const panel = getPtyPanel("lost-absent");
    expect(reconnect().mock.calls.length).toBeGreaterThan(1);
    expect(panel?.spawnStatus).toBe("failed");
    expect(panel?.runtimeStatus).toBe("error");
    expect(panel?.agentState).toBe("exited");
    expect(panel?.spawnError?.message).toBe(
      "The host didn't start this terminal before the connection dropped."
    );
  });

  it("fails a spawn that never left the queue at once, without asking the host", async () => {
    terminalClient.spawn.mockRejectedValueOnce(
      new ClientAppError("HOST_DISCONNECTED", "Link is not open", "The host isn't connected.")
    );

    await launchAgent("queued-1");
    await drainMicrotasks(300);

    expect(reconnect()).not.toHaveBeenCalled();
    expect(getPtyPanel("queued-1")?.spawnStatus).toBe("failed");
  });

  it("waits for the link before asking, and shows it is checking with the host", async () => {
    linkDown();
    terminalClient.spawn.mockRejectedValueOnce(lostReply());
    reconnect().mockResolvedValue({ exists: true, id: "lost-wait", hasPty: true });

    await launchAgent("lost-wait");
    await drainMicrotasks(300);
    expect(reconnect()).not.toHaveBeenCalled();
    expect(getPtyPanel("lost-wait")?.spawnStatus).toBe("spawning");
    expect(useHostConnectionStore.getState().checking).toBe(1);

    linkUp();
    await drainMicrotasks(300);

    expect(getPtyPanel("lost-wait")?.spawnStatus).toBe("ready");
    expect(useHostConnectionStore.getState().checking).toBe(0);
  });

  it("refuses a restart while the launch is being checked", async () => {
    linkDown();
    terminalClient.spawn.mockRejectedValueOnce(lostReply());
    await launchAgent("lost-restart");
    await drainMicrotasks(300);

    await usePanelStore.getState().restartTerminal("lost-restart");

    expect(terminalClient.kill).not.toHaveBeenCalled();
    expect(terminalClient.spawn).toHaveBeenCalledTimes(1);
    expect(getPtyPanel("lost-restart")?.isRestarting).toBeFalsy();
    expect(getPtyPanel("lost-restart")?.spawnStatus).toBe("spawning");
    // Refused up front, not stopped later by the restart's own validation.
    expect(getPtyPanel("lost-restart")?.restartError).toBeUndefined();

    reconnect().mockResolvedValue({ exists: true, id: "lost-restart", hasPty: true });
    linkUp();
    await drainMicrotasks(300);
    expect(getPtyPanel("lost-restart")?.spawnStatus).toBe("ready");
  });

  it("ends the terminal on the host when its pane was closed while checking", async () => {
    linkDown();
    terminalClient.spawn.mockRejectedValueOnce(lostReply());
    reconnect().mockResolvedValue({ exists: true, id: "lost-closed", hasPty: true });
    await launchAgent("lost-closed");
    await drainMicrotasks(300);

    usePanelStore.getState().removePanel("lost-closed");
    const killsAtClose = terminalClient.kill.mock.calls.length;

    linkUp();
    await drainMicrotasks(300);

    expect(terminalClient.kill.mock.calls.length).toBeGreaterThan(killsAtClose);
    expect(terminalClient.kill).toHaveBeenLastCalledWith("lost-closed");
    expect(usePanelStore.getState().panelsById["lost-closed"]).toBeUndefined();
  });

  it("keeps the id from resync until the closed pane's terminal is really ended", async () => {
    linkDown();
    terminalClient.spawn.mockRejectedValueOnce(lostReply());
    reconnect().mockResolvedValue({ exists: true, id: "lost-closed-2", hasPty: true });
    await launchAgent("lost-closed-2");
    await drainMicrotasks(300);
    usePanelStore.getState().removePanel("lost-closed-2");
    // The link drops again before the compensating kill gets through.
    terminalClient.kill.mockImplementationOnce(async () => {
      linkDown();
      throw new ClientAppError("HOST_DISCONNECTED", "Link is not open");
    });
    const killsAtClose = terminalClient.kill.mock.calls.length;

    linkUp();
    await drainMicrotasks(300);
    expect(terminalClient.kill.mock.calls.length).toBe(killsAtClose + 1);
    expect(isSpawnUnconfirmed("lost-closed-2")).toBe(true);

    linkUp();
    await drainMicrotasks(300);
    expect(terminalClient.kill.mock.calls.length).toBe(killsAtClose + 2);
    expect(isSpawnUnconfirmed("lost-closed-2")).toBe(false);
  });

  it("leaves the assistant's own pane to fail at once: the host's probe never lists it", async () => {
    terminalClient.spawn.mockRejectedValueOnce(lostReply());

    await usePanelStore.getState().addPanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
      requestedId: "lost-assistant",
      cwd: "/",
      location: "overlay",
      bypassLimits: true,
    });
    await drainMicrotasks(300);

    expect(reconnect()).not.toHaveBeenCalled();
    expect(getPtyPanel("lost-assistant")?.spawnStatus).toBe("failed");
  });

  it("shows an agent that started and already quit as exited, not failed to start", async () => {
    terminalClient.spawn.mockRejectedValueOnce(lostReply());
    // No agent state on the record: the PTY going is enough to say it quit.
    reconnect().mockResolvedValue({ exists: true, id: "lost-exited", hasPty: false });

    await launchAgent("lost-exited");
    await drainMicrotasks(300);

    const panel = getPtyPanel("lost-exited");
    expect(panel?.spawnStatus).toBe("ready");
    expect(panel?.spawnError).toBeUndefined();
    expect(panel?.runtimeStatus).toBe("exited");
    expect(panel?.agentState).toBe("exited");
  });

  it("takes the host's agent state over the launch guess, whatever the host's clock says", async () => {
    terminalClient.spawn.mockRejectedValueOnce(lostReply());
    reconnect().mockResolvedValue({
      exists: true,
      id: "lost-skew",
      hasPty: true,
      agentState: "waiting",
      waitingReason: "prompt",
      // A host clock behind this machine's.
      lastStateChange: Date.now() - 60_000,
    });

    await launchAgent("lost-skew");
    await drainMicrotasks(300);

    expect(getPtyPanel("lost-skew")?.agentState).toBe("waiting");
  });

  it("clears a launch error reported while it was asked, once the host has the terminal", async () => {
    linkDown();
    terminalClient.spawn.mockRejectedValueOnce(lostReply());
    reconnect().mockResolvedValue({ exists: true, id: "lost-timeout", hasPty: true });
    await launchAgent("lost-timeout");
    await drainMicrotasks(300);
    usePanelStore.getState().setSpawnError("lost-timeout", {
      code: "SPAWN_TIMEOUT",
      message: "The terminal backend hasn't confirmed this launch after 30 seconds.",
    });

    linkUp();
    await drainMicrotasks(300);

    const panel = getPtyPanel("lost-timeout");
    expect(panel?.spawnStatus).toBe("ready");
    expect(panel?.spawnError).toBeUndefined();
    expect(panel?.runtimeStatus).not.toBe("error");
  });

  it("keeps the reason the host gave when it never started the terminal", async () => {
    linkDown();
    terminalClient.spawn.mockRejectedValueOnce(lostReply());
    reconnect().mockResolvedValue({ exists: false, conflict: true });
    await launchAgent("lost-refused");
    await drainMicrotasks(300);
    usePanelStore.getState().setSpawnError("lost-refused", {
      code: "ENOENT",
      message: "No such file or directory: /bin/nosh",
    });

    linkUp();
    await drainMicrotasks(300);

    const panel = getPtyPanel("lost-refused");
    expect(panel?.spawnStatus).toBe("failed");
    expect(panel?.spawnError?.code).toBe("ENOENT");
    expect(panel?.spawnError?.message).toBe("No such file or directory: /bin/nosh");
  });

  it("fails with the lost answer when the host can't be asked at all", async () => {
    terminalClient.spawn.mockRejectedValueOnce(lostReply());
    reconnect().mockRejectedValue(new Error("Failed to reconnect to terminal: shard down"));

    await launchAgent("lost-unaskable");
    await drainMicrotasks(300);

    const panel = getPtyPanel("lost-unaskable");
    expect(panel?.spawnStatus).toBe("failed");
    expect(panel?.spawnError?.message).toBe(
      "The host may have completed this; check before retrying."
    );
    expect(useHostConnectionStore.getState().checking).toBe(0);
  });

  it("trashes the terminal on the host when its pane was trashed while checking", async () => {
    linkDown();
    terminalClient.spawn.mockRejectedValueOnce(lostReply());
    reconnect().mockResolvedValue({ exists: true, id: "lost-trashed", hasPty: true });
    await launchAgent("lost-trashed");
    await drainMicrotasks(300);
    usePanelStore.getState().trashPanel("lost-trashed");
    const trashesAtClose = terminalClient.trash.mock.calls.length;

    linkUp();
    await drainMicrotasks(300);

    expect(getPtyPanel("lost-trashed")?.location).toBe("trash");
    expect(getPtyPanel("lost-trashed")?.spawnStatus).toBe("ready");
    expect(terminalClient.trash.mock.calls.length).toBeGreaterThan(trashesAtClose);
    expect(terminalClient.trash).toHaveBeenLastCalledWith("lost-trashed");
  });

  it("settles each member of a recipe on its own, without holding the queue for the lost one", async () => {
    linkDown();
    terminalClient.spawn.mockImplementation(async ({ id }: { id: string }) => {
      if (id === "batch-lost") throw lostReply();
      if (id === "batch-queued") {
        throw new ClientAppError(
          "HOST_DISCONNECTED",
          "Link is not open",
          "The host isn't connected."
        );
      }
      return id;
    });
    reconnect().mockResolvedValue({ exists: true, id: "batch-lost", hasPty: true });

    const ids = ["batch-lost", "batch-queued", "batch-a", "batch-b", "batch-c"];
    await Promise.all(
      ids.map((requestedId) =>
        usePanelStore.getState().addPanel({
          kind: "terminal",
          launchAgentId: "claude",
          command: "claude",
          requestedId,
          cwd: "/",
          bypassLimits: true,
          spawnBatchId: "recipe-1",
          spawnBatchSize: ids.length,
        })
      )
    );
    await drainMicrotasks(300);

    // Every member reached the host while the link was still down.
    expect(terminalClient.spawn).toHaveBeenCalledTimes(ids.length);
    expect(getPtyPanel("batch-lost")?.spawnStatus).toBe("spawning");
    expect(getPtyPanel("batch-queued")?.spawnStatus).toBe("failed");
    expect(getPtyPanel("batch-a")?.spawnStatus).toBe("ready");
    expect(getPtyPanel("batch-c")?.spawnStatus).toBe("ready");

    linkUp();
    await drainMicrotasks(300);

    expect(reconnect().mock.calls).toEqual([["batch-lost"]]);
    expect(getPtyPanel("batch-lost")?.spawnStatus).toBe("ready");
    expect(getPtyPanel("batch-queued")?.spawnStatus).toBe("failed");
  });
});

/**
 * Tests that addPanel propagates a caller-supplied `titleMode` onto the created
 * PTY panel (issue #10439).
 *
 * `titleMode: "custom"` is how an assistant-named agent launch pins its title so
 * the identity reducer's agent-detected/exited rewrites skip it. The field was
 * previously dropped on the floor between AddPanelOptions and the panel object.
 *
 * The non-PTY half (#11917) kept dropping it long after the PTY half was fixed:
 * persistence writes the mode and hydration forwards it, so a restored file
 * viewer or file browser kept the name a rename gave it while losing the
 * ownership that stops a derived surface — the dock chip — from overriding it.
 */
describe("addPanel titleMode propagation (#10439)", () => {
  beforeEach(async () => {
    const { reset } = usePanelStore.getState();
    await reset();

    const { terminalClient } = (await import("@/clients")) as unknown as {
      terminalClient: { spawn: ReturnType<typeof vi.fn> };
    };
    terminalClient.spawn.mockReset();
    terminalClient.spawn.mockImplementation(async ({ id }: { id?: string }) => id ?? "spawn-id");
  });

  it("stamps titleMode 'custom' and the supplied title onto the panel", async () => {
    const { addPanel } = usePanelStore.getState();
    const id = await addPanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
      title: "Claude: auth refactor",
      titleMode: "custom",
      requestedId: "named-1",
      cwd: "/",
      bypassLimits: true,
    });

    expect(id).toBe("named-1");
    const panel = getPtyPanel("named-1");
    expect(panel?.title).toBe("Claude: auth refactor");
    expect(panel?.titleMode).toBe("custom");
  });

  it("leaves titleMode unset when the caller does not supply one", async () => {
    const { addPanel } = usePanelStore.getState();
    const id = await addPanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
      requestedId: "default-1",
      cwd: "/",
      bypassLimits: true,
    });

    expect(id).toBe("default-1");
    const panel = getPtyPanel("default-1");
    expect(panel?.titleMode).toBeUndefined();
  });

  it("stamps titleMode onto a non-PTY panel too, the way hydration replays it", async () => {
    const { addPanel } = usePanelStore.getState();
    const id = await addPanel({
      kind: "file-browser",
      title: "My notes",
      titleMode: "user",
      requestedId: "fb-named",
      cwd: "/",
      bypassLimits: true,
    });

    expect(id).toBe("fb-named");
    const panel = usePanelStore.getState().panelsById["fb-named"];
    expect(panel?.title).toBe("My notes");
    expect(panel?.titleMode).toBe("user");
  });

  it("leaves a non-PTY panel's titleMode unset when the caller supplies none", async () => {
    const { addPanel } = usePanelStore.getState();
    const id = await addPanel({
      kind: "file-browser",
      title: "Files — develop",
      requestedId: "fb-default",
      cwd: "/",
      bypassLimits: true,
    });

    expect(id).toBe("fb-default");
    expect(usePanelStore.getState().panelsById["fb-default"]?.titleMode).toBeUndefined();
  });
});
