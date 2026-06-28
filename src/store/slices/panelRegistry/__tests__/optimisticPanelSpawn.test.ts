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
    waitForAttachSettled: vi.fn().mockResolvedValue(undefined),
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

  it("marks reconnect panels as 'ready' without calling spawn", async () => {
    const { terminalClient } = (await import("@/clients")) as unknown as {
      terminalClient: { spawn: ReturnType<typeof vi.fn> };
    };

    const { addPanel } = usePanelStore.getState();
    const id = await addPanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
      existingId: "reconnect-1",
      cwd: "/",
      bypassLimits: true,
    });

    expect(id).toBe("reconnect-1");
    expect(getPtyPanel("reconnect-1")?.spawnStatus).toBe("ready");
    expect(terminalClient.spawn).not.toHaveBeenCalled();
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

  it("issues a compensating kill when the panel is removed mid-spawn", async () => {
    // Edge case: user closes panel before spawn IPC arrives at the backend.
    // removePanel's kill was a no-op then (no terminal yet); when the spawn
    // eventually succeeds, the success handler must issue a follow-up kill so
    // the PTY isn't orphaned.
    const { terminalClient } = (await import("@/clients")) as unknown as {
      terminalClient: { spawn: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> };
    };

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    terminalClient.spawn.mockImplementationOnce(async ({ id }: { id?: string }) => {
      await gate;
      return id ?? "late";
    });
    terminalClient.kill.mockClear();

    const { addPanel, removePanel } = usePanelStore.getState();
    await addPanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
      requestedId: "orphan-id",
      cwd: "/",
      bypassLimits: true,
    });
    await drainMicrotasks();
    expect(terminalClient.spawn).toHaveBeenCalledTimes(1);
    removePanel("orphan-id");
    // removePanel fires kill (no-op on the backend since the PTY isn't spawned yet).
    expect(terminalClient.kill).toHaveBeenCalledWith("orphan-id");
    const killCallsAfterRemove = terminalClient.kill.mock.calls.length;

    release();
    await drainMicrotasks();

    // A compensating kill must have fired after spawn succeeded for the
    // now-missing panel.
    expect(terminalClient.kill.mock.calls.length).toBeGreaterThan(killCallsAfterRemove);
    expect(terminalClient.kill).toHaveBeenLastCalledWith("orphan-id");
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

  it("propagates the pre-assigned id to terminalClient.spawn", async () => {
    const { terminalClient } = (await import("@/clients")) as unknown as {
      terminalClient: { spawn: ReturnType<typeof vi.fn> };
    };

    const { addPanel } = usePanelStore.getState();
    await addPanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
      requestedId: "stable-id",
      cwd: "/",
      bypassLimits: true,
    });

    // Drain microtasks so the background spawn has run.
    await drainMicrotasks();

    const spawnCall = terminalClient.spawn.mock.calls[0]?.[0] as { id?: string } | undefined;
    expect(spawnCall?.id).toBe("stable-id");
  });
});
