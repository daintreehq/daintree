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
    emitData(id: string, data: string) {
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
});
