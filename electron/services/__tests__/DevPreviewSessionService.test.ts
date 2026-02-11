import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevPreviewSessionService } from "../DevPreviewSessionService.js";
import type { PtyClient } from "../PtyClient.js";
import type { DevPreviewSessionState } from "../../../shared/types/ipc/devPreview.js";

type DataListener = (id: string, data: string | Uint8Array) => void;
type ExitListener = (id: string, exitCode: number) => void;

function createPtyClientMock(options?: { spawnError?: Error }) {
  const dataListeners = new Set<DataListener>();
  const exitListeners = new Set<ExitListener>();
  const terminals = new Map<string, { projectId?: string; hasPty: boolean }>();

  return {
    on: vi.fn((event: string, callback: DataListener | ExitListener) => {
      if (event === "data") {
        dataListeners.add(callback as DataListener);
      }
      if (event === "exit") {
        exitListeners.add(callback as ExitListener);
      }
    }),
    off: vi.fn((event: string, callback: DataListener | ExitListener) => {
      if (event === "data") {
        dataListeners.delete(callback as DataListener);
      }
      if (event === "exit") {
        exitListeners.delete(callback as ExitListener);
      }
    }),
    spawn: vi.fn((id: string, spawnOptions: { projectId?: string }) => {
      if (options?.spawnError) {
        throw options.spawnError;
      }
      terminals.set(id, { projectId: spawnOptions.projectId, hasPty: true });
    }),
    kill: vi.fn((id: string) => {
      const terminal = terminals.get(id);
      if (terminal) {
        terminal.hasPty = false;
      }
    }),
    submit: vi.fn(),
    hasTerminal: vi.fn((id: string) => terminals.get(id)?.hasPty ?? false),
    setIpcDataMirror: vi.fn(),
    replayHistoryAsync: vi.fn(async (_id: string, _maxLines?: number) => 0),
    getTerminalAsync: vi.fn(async (id: string) => {
      const terminal = terminals.get(id);
      if (!terminal) return null;
      return {
        id,
        projectId: terminal.projectId,
        hasPty: terminal.hasPty,
        cwd: "/repo",
        spawnedAt: Date.now(),
      };
    }),
    emitExit(id: string, exitCode: number) {
      const terminal = terminals.get(id);
      if (terminal) {
        terminal.hasPty = false;
      }
      for (const callback of exitListeners) {
        callback(id, exitCode);
      }
    },
    emitData(id: string, data: string | Uint8Array) {
      for (const callback of dataListeners) {
        callback(id, data);
      }
    },
  };
}

describe("DevPreviewSessionService", () => {
  const baseRequest = {
    panelId: "panel-1",
    projectId: "project-1",
    cwd: "/repo",
    devCommand: "npm run dev",
  };

  let onStateChanged: (state: DevPreviewSessionState) => void;
  let ptyClient: ReturnType<typeof createPtyClientMock>;
  let service: DevPreviewSessionService;

  beforeEach(() => {
    onStateChanged = vi.fn();
    ptyClient = createPtyClientMock();
    service = new DevPreviewSessionService(ptyClient as unknown as PtyClient, onStateChanged);
  });

  afterEach(() => {
    service.dispose();
    vi.restoreAllMocks();
  });

  it("returns an error state when spawn fails instead of throwing", async () => {
    service.dispose();
    ptyClient = createPtyClientMock({ spawnError: new Error("spawn failed") });
    service = new DevPreviewSessionService(ptyClient as unknown as PtyClient, onStateChanged);

    const state = await service.ensure(baseRequest);

    expect(state.status).toBe("error");
    expect(state.terminalId).toBeNull();
    expect(state.error?.message).toContain("spawn failed");
  });

  it("reuses an existing alive terminal for unchanged config", async () => {
    const first = await service.ensure(baseRequest);
    const second = await service.ensure(baseRequest);

    expect(first.terminalId).toBeTruthy();
    expect(second.terminalId).toBe(first.terminalId);
    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
    expect(ptyClient.replayHistoryAsync).toHaveBeenCalledWith(first.terminalId, 300);
  });

  it("recovers running URL from replayed history when re-attaching a starting session", async () => {
    const first = await service.ensure(baseRequest);
    expect(first.status).toBe("starting");
    expect(first.url).toBeNull();
    expect(first.terminalId).toBeTruthy();

    ptyClient.replayHistoryAsync.mockImplementation(async (id: string) => {
      ptyClient.emitData(id, "ready at http://localhost:4173\n");
      return 1;
    });

    const second = await service.ensure(baseRequest);
    expect(second.status).toBe("running");
    expect(second.url).toMatch(/^http:\/\/localhost:4173\/?$/);
    expect(second.terminalId).toBe(first.terminalId);
    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
  });

  it("respawns stale starting sessions when URL was never detected", async () => {
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000);
    const first = await service.ensure(baseRequest);
    expect(first.status).toBe("starting");
    expect(first.terminalId).toBeTruthy();

    nowSpy.mockReturnValue(12_500);
    const second = await service.ensure(baseRequest);

    expect(second.status).toBe("starting");
    expect(second.terminalId).toBeTruthy();
    expect(second.terminalId).not.toBe(first.terminalId);
    expect(ptyClient.kill).toHaveBeenCalledWith(
      first.terminalId,
      "dev-preview:stale-start-recovery"
    );
    expect(ptyClient.spawn).toHaveBeenCalledTimes(2);
  });

  it("restarts terminal when env changes", async () => {
    const first = await service.ensure({
      ...baseRequest,
      env: { NODE_ENV: "development" },
    });
    const second = await service.ensure({
      ...baseRequest,
      env: { NODE_ENV: "production" },
    });

    expect(first.terminalId).toBeTruthy();
    expect(second.terminalId).toBeTruthy();
    expect(second.terminalId).not.toBe(first.terminalId);
    expect(ptyClient.kill).toHaveBeenCalledWith(first.terminalId, "dev-preview:config-change");
    expect(ptyClient.spawn).toHaveBeenCalledTimes(2);
  });

  it("restarts terminal when worktree changes", async () => {
    const first = await service.ensure({
      ...baseRequest,
      worktreeId: "wt-a",
    });
    const second = await service.ensure({
      ...baseRequest,
      worktreeId: "wt-b",
    });

    expect(first.terminalId).toBeTruthy();
    expect(second.terminalId).toBeTruthy();
    expect(second.terminalId).not.toBe(first.terminalId);
    expect(second.worktreeId).toBe("wt-b");
    expect(ptyClient.kill).toHaveBeenCalledWith(first.terminalId, "dev-preview:config-change");
    expect(ptyClient.spawn).toHaveBeenCalledTimes(2);
  });

  it("keeps simultaneous panels isolated within the same project and worktree", async () => {
    const [first, second] = await Promise.all([
      service.ensure({
        panelId: "panel-a",
        projectId: "project-1",
        cwd: "/repo",
        devCommand: "npm run dev",
        worktreeId: "wt-shared",
      }),
      service.ensure({
        panelId: "panel-b",
        projectId: "project-1",
        cwd: "/repo",
        devCommand: "npm run dev",
        worktreeId: "wt-shared",
      }),
    ]);

    expect(first.terminalId).toBeTruthy();
    expect(second.terminalId).toBeTruthy();
    expect(second.terminalId).not.toBe(first.terminalId);
    expect(first.worktreeId).toBe("wt-shared");
    expect(second.worktreeId).toBe("wt-shared");
    expect(ptyClient.spawn).toHaveBeenCalledTimes(2);

    const firstState = service.getState({ panelId: "panel-a", projectId: "project-1" });
    const secondState = service.getState({ panelId: "panel-b", projectId: "project-1" });

    expect(firstState.panelId).toBe("panel-a");
    expect(firstState.projectId).toBe("project-1");
    expect(secondState.panelId).toBe("panel-b");
    expect(secondState.projectId).toBe("project-1");
    expect(firstState.terminalId).toBe(first.terminalId);
    expect(secondState.terminalId).toBe(second.terminalId);
  });

  it("sets error state when a starting terminal exits", async () => {
    const started = await service.ensure(baseRequest);
    expect(started.status).toBe("starting");
    expect(started.terminalId).toBeTruthy();

    ptyClient.emitExit(started.terminalId!, 9);

    const afterExit = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });

    expect(afterExit.status).toBe("error");
    expect(afterExit.error?.message).toContain("Dev server exited with code 9");
    expect(afterExit.terminalId).toBeNull();
  });

  it("detects URLs from Uint8Array data payloads", async () => {
    const started = await service.ensure(baseRequest);
    expect(started.terminalId).toBeTruthy();

    const encoder = new TextEncoder();
    ptyClient.emitData(started.terminalId!, encoder.encode("ready at http://localhost:4173\n"));

    const updated = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });

    expect(updated.status).toBe("running");
    expect(updated.url).toMatch(/^http:\/\/localhost:4173\/?$/);
  });

  it("stops and removes all sessions for a panel", async () => {
    const sessionOne = await service.ensure({
      panelId: "shared-panel",
      projectId: "project-a",
      cwd: "/repo/a",
      devCommand: "npm run dev",
    });
    const sessionTwo = await service.ensure({
      panelId: "shared-panel",
      projectId: "project-b",
      cwd: "/repo/b",
      devCommand: "pnpm dev",
    });

    await service.stopByPanel({ panelId: "shared-panel" });

    expect(ptyClient.kill).toHaveBeenCalledWith(sessionOne.terminalId, "dev-preview:panel-closed");
    expect(ptyClient.kill).toHaveBeenCalledWith(sessionTwo.terminalId, "dev-preview:panel-closed");

    const firstState = service.getState({ panelId: "shared-panel", projectId: "project-a" });
    const secondState = service.getState({ panelId: "shared-panel", projectId: "project-b" });
    expect(firstState.status).toBe("stopped");
    expect(secondState.status).toBe("stopped");
    expect(firstState.terminalId).toBeNull();
    expect(secondState.terminalId).toBeNull();
  });

  it("continues stop-by-panel cleanup when one session stop fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const sessionOne = await service.ensure({
      panelId: "shared-panel",
      projectId: "project-a",
      cwd: "/repo/a",
      devCommand: "npm run dev",
    });
    await service.ensure({
      panelId: "shared-panel",
      projectId: "project-b",
      cwd: "/repo/b",
      devCommand: "npm run dev",
    });

    const originalKill = ptyClient.kill.getMockImplementation();
    ptyClient.kill.mockImplementation((id: string) => {
      if (id === sessionOne.terminalId) {
        throw new Error("kill failed");
      }
      originalKill?.(id);
    });

    await expect(service.stopByPanel({ panelId: "shared-panel" })).resolves.toBeUndefined();

    const failedState = service.getState({ panelId: "shared-panel", projectId: "project-a" });
    const stoppedState = service.getState({ panelId: "shared-panel", projectId: "project-b" });

    expect(failedState.status).not.toBe("stopped");
    expect(failedState.error?.message).toContain("Failed to stop dev preview:");
    expect(stoppedState.status).toBe("stopped");
    expect(stoppedState.terminalId).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      "[DevPreviewSessionService] stopByPanel failed for session",
      expect.objectContaining({
        panelId: "shared-panel",
        projectId: "project-a",
      })
    );
  });
});
