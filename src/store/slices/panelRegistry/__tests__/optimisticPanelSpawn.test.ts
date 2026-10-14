/**
 * Tests for optimistic panel spawn (#5789).
 *
 * addPanel commits to the store synchronously (as a "spawning" placeholder),
 * then realizes backend spawn and visible xterm mount through the startup
 * queue. Six rapid agent clicks surface as six parallel placeholders without
 * dispatching six PTY spawns / xterm opens in the same layout burst.
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

// Drain microtasks. The background spawn promise chains through Promise.all
// (env fetch) → terminalClient.spawn → .then, which takes several ticks.
async function drainMicrotasks(iterations = 100): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await Promise.resolve();
  }
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
    const { terminalInstanceService } = await import("@/services/TerminalInstanceService");
    const waitForAttachSettledMock = vi.mocked(terminalInstanceService.waitForAttachSettled);
    waitForAttachSettledMock.mockReset();
    waitForAttachSettledMock.mockResolvedValue(undefined);
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
    const { terminalInstanceService } = await import("@/services/TerminalInstanceService");
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

    // Only the first PTY spawn is allowed to start while the startup job is blocked.
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
    const { terminalInstanceService } = await import("@/services/TerminalInstanceService");
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
