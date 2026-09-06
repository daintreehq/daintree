import http from "node:http";
import https from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevPreviewSessionService } from "../DevPreviewSessionService.js";
import * as portAllocator from "../DevPreviewPortAllocator.js";
import { buildDevPreviewSubdomain } from "../../../shared/utils/devPreviewProxy.js";
import type { PtyClient } from "../PtyClient.js";
import type { DevPreviewSessionState } from "../../../shared/types/ipc/devPreview.js";

vi.mock("node:http", () => ({ default: { request: vi.fn() }, request: vi.fn() }));
vi.mock("node:https", () => ({ default: { request: vi.fn() }, request: vi.fn() }));

vi.mock("ws", () => {
  class WebSocketMock {
    once(event: "open" | "error" | "close", listener: () => void) {
      if (event === "error") queueMicrotask(() => listener());
      return this;
    }
    terminate() {}
    constructor() {}
  }
  return { default: WebSocketMock };
});

type DataListener = (id: string, data: string | Uint8Array) => void;
type ExitListener = (id: string, exitCode: number, signal?: number) => void;
type MockIncomingMessage = {
  statusCode?: number;
  resume: () => void;
};
type MockRequest = {
  on: (event: "error" | "timeout", handler: (...args: unknown[]) => void) => MockRequest;
  end: () => void;
  destroy: () => void;
};

function mockHttpResponse(statusCode: number) {
  const impl = ((_: unknown, __: unknown, cb: (res: MockIncomingMessage) => void) => {
    const req: MockRequest = {
      on: () => {
        return req;
      },
      end: () => cb({ statusCode, resume: () => {} }),
      destroy: () => {},
    };
    return req;
  }) as unknown as typeof http.request;
  vi.mocked(http.request).mockImplementation(impl);
  vi.mocked(https.request).mockImplementation(impl);
}

function mockHttpError() {
  const impl = ((_: unknown, __: unknown, ___: unknown) => {
    let errorHandler: ((error: Error) => void) | undefined;
    const req: MockRequest = {
      on: (event, handler) => {
        if (event === "error") errorHandler = handler as (error: Error) => void;
        return req;
      },
      end: () => {
        errorHandler?.(new Error("ECONNREFUSED"));
      },
      destroy: () => {},
    };
    return req;
  }) as unknown as typeof http.request;
  vi.mocked(http.request).mockImplementation(impl);
  vi.mocked(https.request).mockImplementation(impl);
}

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
    spawn: vi.fn((id: string, spawnOptions: { projectId?: string; args?: string[] }) => {
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
    emitExit(id: string, exitCode: number, signal?: number) {
      const terminal = terminals.get(id);
      if (terminal) {
        terminal.hasPty = false;
      }
      for (const callback of exitListeners) {
        callback(id, exitCode, signal);
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
    mockHttpResponse(200);
  });

  afterEach(() => {
    service.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
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

    await service.ensure(baseRequest);

    await vi.waitFor(() => {
      const state = service.getState({
        panelId: baseRequest.panelId,
        projectId: baseRequest.projectId,
      });
      expect(state.status).toBe("running");
      expect(state.url).toMatch(/^http:\/\/localhost:4173\/?$/);
    });

    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
  });

  it("respawns stale starting sessions when URL was never detected", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    const first = await service.ensure(baseRequest);
    expect(first.status).toBe("starting");
    expect(first.terminalId).toBeTruthy();

    nowSpy.mockReturnValue(12_500);
    vi.mocked(performance.now).mockReturnValue(12_500);
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

  it("restarts terminal when turbopackEnabled toggles", async () => {
    const first = await service.ensure({
      ...baseRequest,
      turbopackEnabled: true,
    });
    const second = await service.ensure({
      ...baseRequest,
      turbopackEnabled: false,
    });

    expect(first.terminalId).toBeTruthy();
    expect(second.terminalId).toBeTruthy();
    expect(second.terminalId).not.toBe(first.terminalId);
    expect(ptyClient.kill).toHaveBeenCalledWith(first.terminalId, "dev-preview:config-change");
    expect(ptyClient.spawn).toHaveBeenCalledTimes(2);
  });

  it("reuses terminal when turbopackEnabled stays the same across ensures", async () => {
    const first = await service.ensure({
      ...baseRequest,
      turbopackEnabled: false,
    });
    const second = await service.ensure({
      ...baseRequest,
      turbopackEnabled: false,
    });

    expect(second.terminalId).toBe(first.terminalId);
    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
  });

  it("rejects non-boolean turbopackEnabled in ensure request", async () => {
    await expect(
      service.ensure({
        ...baseRequest,
        // @ts-expect-error — intentional runtime violation to cover the guard
        turbopackEnabled: "yes",
      })
    ).rejects.toThrow(/turbopackEnabled/);
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

  it("classifies port-conflict exit from buffered output", async () => {
    const started = await service.ensure(baseRequest);
    expect(started.status).toBe("starting");
    expect(started.terminalId).toBeTruthy();

    // Emit port-conflict output — handleData detects it mid-stream and
    // transitions to "error" before the exit fires.
    ptyClient.emitData(
      started.terminalId!,
      "Error: listen EADDRINUSE: address already in use :::3000\n"
    );

    const afterData = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(afterData.status).toBe("error");
    expect(afterData.error?.type).toBe("port-conflict");

    // Exit fires after mid-stream detection — handleExit reclassifies with
    // full context (exit code + signal + buffer), preserving the classified error.
    ptyClient.emitExit(started.terminalId!, 1);

    const state = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(state.status).toBe("error");
    expect(state.error?.type).toBe("port-conflict");
    expect(state.error?.port).toBe("3000");
  });

  it("handles exit after mid-stream missing-dependency detection triggers reinstall", async () => {
    const started = await service.ensure(baseRequest);
    expect(started.status).toBe("starting");
    expect(started.terminalId).toBeTruthy();

    // Mid-stream detection arms needsInstall and surfaces the error, but the
    // session stays "starting" — no install has begun yet (#12295).
    ptyClient.emitData(started.terminalId!, "Error: Cannot find module 'vite'\n");

    const afterData = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(afterData.status).toBe("starting");
    expect(afterData.error?.type).toBe("missing-dependencies");

    // Exit after that detection triggers a guarded reinstall (not an error stop)
    ptyClient.emitExit(started.terminalId!, 1);
  });

  // The wrapper shell exits normally when its child is signalled, so the raw
  // signal is gone and node-pty reports signal 0 — the encoded 128+n status is
  // the only evidence left (#12295).
  it.skipIf(process.platform === "win32")(
    "treats an encoded SIGINT exit with node-pty's signal 0 as a clean stop",
    async () => {
      const started = await service.ensure(baseRequest);
      ptyClient.emitExit(started.terminalId!, 130, 0);

      const state = service.getState({
        panelId: baseRequest.panelId,
        projectId: baseRequest.projectId,
      });
      expect(state.status).toBe("stopped");
      expect(state.error).toBeNull();
    }
  );

  it.skipIf(process.platform === "win32")(
    "keeps crash classification for an encoded SIGSEGV exit",
    async () => {
      const started = await service.ensure(baseRequest);
      ptyClient.emitExit(started.terminalId!, 139, 0);

      const state = service.getState({
        panelId: baseRequest.panelId,
        projectId: baseRequest.projectId,
      });
      expect(state.status).toBe("error");
      expect(state.error?.type).toBe("process-crash");
    }
  );

  it("does not treat a plain nonzero exit as a signal", async () => {
    const started = await service.ensure(baseRequest);
    ptyClient.emitExit(started.terminalId!, 7, 0);

    const state = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(state.status).toBe("error");
    expect(state.error?.message).toContain("7");
  });

  it("classifies compile-error exit from buffered output", async () => {
    const started = await service.ensure(baseRequest);
    expect(started.status).toBe("starting");
    expect(started.terminalId).toBeTruthy();

    // Emit compile-error output — handleData detects it mid-stream
    ptyClient.emitData(started.terminalId!, "Build failed with 3 errors:\n");

    const afterData = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(afterData.status).toBe("error");
    expect(afterData.error?.type).toBe("compile-error");

    // Exit reclassifies with full context
    ptyClient.emitExit(started.terminalId!, 1);

    const state = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(state.status).toBe("error");
    expect(state.error?.type).toBe("compile-error");
  });

  it("classifies process-crash exit from SIGSEGV signal", async () => {
    const started = await service.ensure(baseRequest);
    expect(started.status).toBe("starting");
    expect(started.terminalId).toBeTruthy();

    ptyClient.emitExit(started.terminalId!, 0, 11); // SIGSEGV

    const state = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(state.status).toBe("error");
    expect(state.error?.type).toBe("process-crash");
    expect(state.error?.message).toContain("crashed");
  });

  it("treats SIGINT as clean stop (error: null)", async () => {
    const started = await service.ensure(baseRequest);
    expect(started.status).toBe("starting");
    expect(started.terminalId).toBeTruthy();

    ptyClient.emitExit(started.terminalId!, 0, 2); // SIGINT

    const state = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(state.status).toBe("stopped");
    expect(state.error).toBeNull();
  });

  it("treats SIGTERM as clean stop (error: null)", async () => {
    const started = await service.ensure(baseRequest);
    expect(started.status).toBe("starting");
    expect(started.terminalId).toBeTruthy();

    ptyClient.emitExit(started.terminalId!, 0, 15); // SIGTERM

    const state = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(state.status).toBe("stopped");
    expect(state.error).toBeNull();
  });

  it("classifies SIGKILL + OOM output as oom", async () => {
    const started = await service.ensure(baseRequest);
    expect(started.status).toBe("starting");
    expect(started.terminalId).toBeTruthy();

    ptyClient.emitData(
      started.terminalId!,
      "FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory\n"
    );
    ptyClient.emitExit(started.terminalId!, 0, 9); // SIGKILL

    const state = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(state.status).toBe("error");
    expect(state.error?.type).toBe("oom");
  });

  it("classifies SIGABRT + OOM output as oom (Node.js heap OOM)", async () => {
    const started = await service.ensure(baseRequest);
    expect(started.status).toBe("starting");
    expect(started.terminalId).toBeTruthy();

    ptyClient.emitData(
      started.terminalId!,
      "FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory\n"
    );
    ptyClient.emitExit(started.terminalId!, 0, 6); // SIGABRT

    const state = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(state.status).toBe("error");
    expect(state.error?.type).toBe("oom");
  });

  it("classifies SIGKILL without OOM output as unknown", async () => {
    const started = await service.ensure(baseRequest);
    expect(started.status).toBe("starting");
    expect(started.terminalId).toBeTruthy();

    ptyClient.emitExit(started.terminalId!, 0, 9); // SIGKILL, no OOM output

    const state = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(state.status).toBe("error");
    expect(state.error?.type).toBe("unknown");
  });

  it("classifies exit code 0 with no signal as unknown error (exited before ready)", async () => {
    const started = await service.ensure(baseRequest);
    expect(started.status).toBe("starting");
    expect(started.terminalId).toBeTruthy();

    ptyClient.emitExit(started.terminalId!, 0);

    const state = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(state.status).toBe("error");
    expect(state.error?.type).toBe("unknown");
  });

  it("classifies even when buffer is cleared after mid-stream detection", async () => {
    const started = await service.ensure(baseRequest);
    expect(started.status).toBe("starting");
    expect(started.terminalId).toBeTruthy();

    // handleData detects port-conflict and transitions to "error"
    ptyClient.emitData(
      started.terminalId!,
      "Error: listen EADDRINUSE: address already in use :::3000\n"
    );
    // handleExit captures buffer before clearing, reclassifies correctly
    ptyClient.emitExit(started.terminalId!, 1);

    const state = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(state.error?.type).toBe("port-conflict");
  });

  it("detects URLs and transitions to running after readiness poll succeeds", async () => {
    const started = await service.ensure(baseRequest);
    expect(started.terminalId).toBeTruthy();

    const encoder = new TextEncoder();
    ptyClient.emitData(started.terminalId!, encoder.encode("ready at http://localhost:4173\n"));

    await vi.waitFor(() => {
      const updated = service.getState({
        panelId: baseRequest.panelId,
        projectId: baseRequest.projectId,
      });
      expect(updated.status).toBe("running");
      expect(updated.url).toMatch(/^http:\/\/localhost:4173\/?$/);
    });
  });

  it("transitions to running from the assigned URL when no URL is printed", async () => {
    const started = await service.ensure(baseRequest);
    expect(started.status).toBe("starting");
    expect(started.terminalId).toBeTruthy();
    expect(started.predictedUrl).toMatch(/^http:\/\/localhost:\d+$/);

    await new Promise((resolve) => setTimeout(resolve, 0));

    await vi.waitFor(() => {
      const updated = service.getState({
        panelId: baseRequest.panelId,
        projectId: baseRequest.projectId,
      });
      expect(updated.status).toBe("running");
      expect(updated.url).toBe(started.predictedUrl);
    });
  });

  it("does not treat HTTP 5xx responses as ready", async () => {
    vi.useFakeTimers();
    mockHttpResponse(503);

    const started = await service.ensure(baseRequest);
    expect(started.terminalId).toBeTruthy();

    ptyClient.emitData(started.terminalId!, "ready at http://localhost:4173\n");

    const during = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(during.status).toBe("starting");

    await vi.advanceTimersByTimeAsync(31_000);

    const after = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(after.status).toBe("error");
  });

  it("does not treat HTTP 4xx as ready (waits for 2xx/3xx)", async () => {
    vi.useFakeTimers();
    mockHttpResponse(404);

    const started = await service.ensure(baseRequest);
    expect(started.terminalId).toBeTruthy();

    ptyClient.emitData(started.terminalId!, "ready at http://localhost:4173\n");

    await vi.advanceTimersByTimeAsync(31_000);

    const after = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(after.status).toBe("error");
  });

  it("stays in starting status while readiness poll is in progress", async () => {
    mockHttpError();

    const started = await service.ensure(baseRequest);
    expect(started.terminalId).toBeTruthy();

    ptyClient.emitData(started.terminalId!, "ready at http://localhost:4173\n");

    const during = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(during.status).toBe("starting");
    expect(during.url).toBeNull();
  });

  it("transitions to error when server never becomes ready", async () => {
    vi.useFakeTimers();
    mockHttpError();

    const started = await service.ensure(baseRequest);
    expect(started.terminalId).toBeTruthy();

    ptyClient.emitData(started.terminalId!, "ready at http://localhost:4173\n");

    const during = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(during.status).toBe("starting");

    await vi.advanceTimersByTimeAsync(31_000);

    const after = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(after.status).toBe("error");
    expect(after.error?.message).toContain("did not respond within 30 seconds");
  });

  it("cancels readiness poll when session is stopped", async () => {
    vi.useFakeTimers();
    mockHttpError();

    const started = await service.ensure(baseRequest);
    expect(started.terminalId).toBeTruthy();

    ptyClient.emitData(started.terminalId!, "ready at http://localhost:4173\n");

    await service.stop({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });

    const after = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(after.status).toBe("stopped");
    expect(after.url).toBeNull();

    await vi.advanceTimersByTimeAsync(31_000);

    const afterTimeout = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(afterTimeout.status).toBe("stopped");
    expect(afterTimeout.error).toBeNull();
  });

  it("cancels readiness poll when terminal exits during polling", async () => {
    vi.useFakeTimers();
    mockHttpError();

    const started = await service.ensure(baseRequest);
    expect(started.terminalId).toBeTruthy();

    ptyClient.emitData(started.terminalId!, "ready at http://localhost:4173\n");

    ptyClient.emitExit(started.terminalId!, 1);

    const after = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(after.status).toBe("error");
    expect(after.error?.message).toContain("Dev server exited with code 1");

    await vi.advanceTimersByTimeAsync(31_000);

    const afterTimeout = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(afterTimeout.status).toBe("error");
    expect(afterTimeout.error?.message).toContain("Dev server exited with code 1");
  });

  it("cancels the previous readiness poll when restart spawns a new generation", async () => {
    vi.useFakeTimers();
    mockHttpError();

    const started = await service.ensure(baseRequest);
    expect(started.terminalId).toBeTruthy();

    ptyClient.emitData(started.terminalId!, "ready at http://localhost:4173\n");

    const restarted = await service.restart({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(restarted.status).toBe("starting");
    expect(restarted.terminalId).toBeTruthy();
    expect(restarted.terminalId).not.toBe(started.terminalId);

    mockHttpResponse(200);
    ptyClient.emitData(restarted.terminalId!, "ready at http://localhost:4174\n");
    await vi.advanceTimersByTimeAsync(10);

    const running = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(running.status).toBe("running");
    expect(running.url).toMatch(/^http:\/\/localhost:4174\/?$/);

    await vi.advanceTimersByTimeAsync(31_000);

    const afterOldTimeout = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(afterOldTimeout.status).toBe("running");
    expect(afterOldTimeout.url).toMatch(/^http:\/\/localhost:4174\/?$/);
    expect(afterOldTimeout.error).toBeNull();
  });

  it("cancels stale readiness poll when a new URL is detected", async () => {
    vi.useFakeTimers();
    mockHttpError();

    const started = await service.ensure(baseRequest);
    expect(started.terminalId).toBeTruthy();

    ptyClient.emitData(started.terminalId!, "ready at http://localhost:4173\n");

    mockHttpResponse(200);
    ptyClient.emitData(started.terminalId!, "ready at http://localhost:4174\n");
    await vi.advanceTimersByTimeAsync(10);

    const running = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(running.status).toBe("running");
    expect(running.url).toMatch(/^http:\/\/localhost:4174\/?$/);

    await vi.advanceTimersByTimeAsync(31_000);

    const afterOldTimeout = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(afterOldTimeout.status).toBe("running");
    expect(afterOldTimeout.url).toMatch(/^http:\/\/localhost:4174\/?$/);
    expect(afterOldTimeout.error).toBeNull();
  });

  it("does not trigger stale-start recovery while readiness poll is active", async () => {
    mockHttpError();

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    const first = await service.ensure(baseRequest);
    expect(first.status).toBe("starting");

    ptyClient.emitData(first.terminalId!, "ready at http://localhost:4173\n");

    nowSpy.mockReturnValue(12_500);
    vi.mocked(performance.now).mockReturnValue(12_500);
    const second = await service.ensure(baseRequest);

    expect(second.terminalId).toBe(first.terminalId);
    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
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

  it("clears stale readiness state on dead terminal respawn", async () => {
    mockHttpError();

    const started = await service.ensure(baseRequest);
    expect(started.terminalId).toBeTruthy();

    ptyClient.emitData(started.terminalId!, "ready at http://localhost:4173\n");

    const firstTerminalId = started.terminalId!;
    ptyClient.getTerminalAsync.mockImplementation(async (id: string) => {
      if (id === firstTerminalId) return null;
      return {
        id,
        projectId: baseRequest.projectId,
        hasPty: true,
        cwd: "/repo",
        spawnedAt: Date.now(),
      };
    });

    const respawned = await service.ensure(baseRequest);
    expect(respawned.terminalId).toBeTruthy();
    expect(respawned.terminalId).not.toBe(firstTerminalId);

    ptyClient.emitData(respawned.terminalId!, "ready at http://localhost:4173\n");

    mockHttpResponse(200);
    ptyClient.emitData(respawned.terminalId!, "ready at http://localhost:4173\n");

    await vi.waitFor(() => {
      const after = service.getState({
        panelId: baseRequest.panelId,
        projectId: baseRequest.projectId,
      });
      expect(after.status).toBe("running");
      expect(after.url).toMatch(/^http:\/\/localhost:4173\/?$/);
    });
  });

  it("retries transient errors before succeeding", async () => {
    let callCount = 0;
    const impl = ((_: unknown, __: unknown, cb: (res: MockIncomingMessage) => void) => {
      callCount++;
      let errorHandler: ((error: Error) => void) | undefined;
      const req: MockRequest = {
        on: (event, handler) => {
          if (event === "error") errorHandler = handler as (error: Error) => void;
          return req;
        },
        end: () => {
          setTimeout(() => {
            if (callCount < 3) {
              errorHandler?.(new Error("ECONNREFUSED"));
            } else {
              cb({ statusCode: 200, resume: () => {} });
            }
          }, 0);
        },
        destroy: () => {},
      };
      return req;
    }) as unknown as typeof http.request;
    vi.mocked(http.request).mockImplementation(impl);
    vi.mocked(https.request).mockImplementation(impl);

    const started = await service.ensure(baseRequest);
    expect(started.terminalId).toBeTruthy();

    ptyClient.emitData(started.terminalId!, "ready at http://localhost:4173\n");

    await vi.waitFor(
      () => {
        const updated = service.getState({
          panelId: baseRequest.panelId,
          projectId: baseRequest.projectId,
        });
        expect(updated.status).toBe("running");
        expect(updated.url).toMatch(/^http:\/\/localhost:4173\/?$/);
      },
      { timeout: 5000 }
    );

    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it("logs a warning (not silently swallows) when replayRecentOutput fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    ptyClient.replayHistoryAsync.mockRejectedValueOnce(new Error("replay unavailable"));

    await service.ensure(baseRequest);
    const second = await service.ensure(baseRequest);

    expect(second.terminalId).toBeTruthy();
    expect(
      warnSpy.mock.calls.some(
        (args) =>
          typeof args[0] === "string" &&
          args[0].includes("[DevPreviewSessionService] replayRecentOutput failed")
      )
    ).toBe(true);

    warnSpy.mockRestore();
  });

  it("detects URL via proactive startup replay on first spawn", async () => {
    vi.useFakeTimers();
    mockHttpError();

    const started = await service.ensure(baseRequest);
    expect(started.status).toBe("starting");
    expect(started.terminalId).toBeTruthy();

    ptyClient.replayHistoryAsync.mockImplementation(async (id: string) => {
      mockHttpResponse(200);
      ptyClient.emitData(id, "ready at http://localhost:4173\n");
      return 1;
    });

    // Advance past the 100ms submit delay + 1500ms startup replay delay
    await vi.advanceTimersByTimeAsync(1600);

    expect(ptyClient.replayHistoryAsync).toHaveBeenCalledWith(started.terminalId, 300);

    await vi.advanceTimersByTimeAsync(10);

    const after = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(after.status).toBe("running");
    expect(after.url).toMatch(/^http:\/\/localhost:4173\/?$/);

    // Only one spawn — no stale-start recovery needed
    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
  });

  it("cancels startup replay timer on stop", async () => {
    vi.useFakeTimers();

    const started = await service.ensure(baseRequest);
    expect(started.terminalId).toBeTruthy();

    await service.stop({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });

    ptyClient.replayHistoryAsync.mockClear();

    await vi.advanceTimersByTimeAsync(2000);

    expect(ptyClient.replayHistoryAsync).not.toHaveBeenCalled();
  });

  it("cancels startup replay timer on restart and schedules new one", async () => {
    vi.useFakeTimers();
    mockHttpError();

    const started = await service.ensure(baseRequest);
    expect(started.terminalId).toBeTruthy();

    const restarted = await service.restart({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(restarted.terminalId).toBeTruthy();
    expect(restarted.terminalId).not.toBe(started.terminalId);

    ptyClient.replayHistoryAsync.mockImplementation(async (id: string) => {
      ptyClient.emitData(id, "ready at http://localhost:5173\n");
      return 1;
    });

    await vi.advanceTimersByTimeAsync(1600);

    // Replay should be called only for the new terminal
    const replayCalls = ptyClient.replayHistoryAsync.mock.calls;
    const calledIds = replayCalls.map((c: unknown[]) => c[0]);
    expect(calledIds).not.toContain(started.terminalId);
    expect(calledIds).toContain(restarted.terminalId);
  });

  it("skips startup replay if URL already detected before timer fires", async () => {
    vi.useFakeTimers();

    const started = await service.ensure(baseRequest);
    expect(started.terminalId).toBeTruthy();

    // URL detected immediately via live data
    ptyClient.emitData(started.terminalId!, "ready at http://localhost:4173\n");
    await vi.advanceTimersByTimeAsync(10);

    ptyClient.replayHistoryAsync.mockClear();

    // Advance past startup replay delay
    await vi.advanceTimersByTimeAsync(1600);

    // Replay should not be called since URL was already detected
    expect(ptyClient.replayHistoryAsync).not.toHaveBeenCalled();
  });

  it("transitions to error when port doesn't release after stop", async () => {
    const started = await service.ensure(baseRequest);
    expect(started.terminalId).toBeTruthy();

    const waitSpy = vi.spyOn(portAllocator, "waitForPortFree").mockResolvedValueOnce(false);

    const result = await service.stop({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });

    expect(waitSpy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("error");
    expect(result.error?.type).toBe("port-conflict");
    expect(result.error?.port).toBeDefined();
    expect(result.terminalId).toBeNull();

    // After a port-free timeout the registry entry is released so the next
    // ensure() picks a fresh candidate via allocatePort.
    const restarted = await service.ensure(baseRequest);
    expect(restarted.predictedUrl).not.toBe(started.predictedUrl);
  });

  it("transitions to stopped when waitForPortFree succeeds", async () => {
    const started = await service.ensure(baseRequest);
    expect(started.terminalId).toBeTruthy();

    const waitSpy = vi.spyOn(portAllocator, "waitForPortFree").mockResolvedValueOnce(true);

    const result = await service.stop({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });

    expect(waitSpy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("stopped");
    expect(result.error).toBeNull();
  });

  it("does not wait for port-free when stopping a session with no terminal", async () => {
    const waitSpy = vi.spyOn(portAllocator, "waitForPortFree");

    const result = await service.stop({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });

    expect(waitSpy).not.toHaveBeenCalled();
    expect(result.status).toBe("stopped");
  });

  it("transitions to error when port doesn't release before restart", async () => {
    const started = await service.ensure(baseRequest);
    expect(started.terminalId).toBeTruthy();
    const initialSpawnCount = ptyClient.spawn.mock.calls.length;

    vi.spyOn(portAllocator, "waitForPortFree").mockResolvedValueOnce(false);

    const result = await service.restart({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });

    expect(result.status).toBe("error");
    expect(result.error?.type).toBe("port-conflict");
    // Spawn must not run when port is still occupied.
    expect(ptyClient.spawn).toHaveBeenCalledTimes(initialSpawnCount);
  });

  it("transitions to error when port doesn't release before restart-and-clear-cache", async () => {
    const started = await service.ensure(baseRequest);
    expect(started.terminalId).toBeTruthy();
    const initialSpawnCount = ptyClient.spawn.mock.calls.length;

    vi.spyOn(portAllocator, "waitForPortFree").mockResolvedValueOnce(false);

    const result = await service.restartAndClearCache({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });

    expect(result.status).toBe("error");
    expect(result.error?.type).toBe("port-conflict");
    expect(ptyClient.spawn).toHaveBeenCalledTimes(initialSpawnCount);
  });

  describe("stopByWorktree", () => {
    it("stops the session matching the given worktreeId", async () => {
      const wtA = await service.ensure({
        panelId: "panel-a",
        projectId: "project-1",
        cwd: "/repo/a",
        devCommand: "npm run dev",
        worktreeId: "wt-target",
      });
      const wtB = await service.ensure({
        panelId: "panel-b",
        projectId: "project-1",
        cwd: "/repo/b",
        devCommand: "npm run dev",
        worktreeId: "wt-other",
      });

      await service.stopByWorktree("wt-target");

      expect(ptyClient.kill).toHaveBeenCalledWith(wtA.terminalId, "dev-preview:worktree-delete");
      expect(ptyClient.kill).not.toHaveBeenCalledWith(wtB.terminalId, expect.anything());

      const stopped = service.getState({ panelId: "panel-a", projectId: "project-1" });
      const surviving = service.getState({ panelId: "panel-b", projectId: "project-1" });
      expect(stopped.status).toBe("stopped");
      expect(stopped.terminalId).toBeNull();
      expect(surviving.terminalId).toBe(wtB.terminalId);
    });

    it("is a no-op when no session matches the worktreeId", async () => {
      await service.ensure({
        ...baseRequest,
        worktreeId: "wt-other",
      });

      await expect(service.stopByWorktree("wt-missing")).resolves.toBeUndefined();
      expect(ptyClient.kill).not.toHaveBeenCalled();
    });

    it("rejects when the underlying terminal kill fails", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const session = await service.ensure({
        ...baseRequest,
        worktreeId: "wt-failing",
      });

      ptyClient.kill.mockImplementation((id: string) => {
        if (id === session.terminalId) {
          throw new Error("kill failed");
        }
      });

      await expect(service.stopByWorktree("wt-failing")).rejects.toThrow(/kill failed/);
      expect(warnSpy).toHaveBeenCalledWith(
        "[DevPreviewSessionService] stopByWorktree failed for session",
        expect.objectContaining({ worktreeId: "wt-failing" })
      );
    });
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

  describe("restore manifest (#9094)", () => {
    it("captureManifest returns only running-state sessions with their spawn metadata", async () => {
      await service.ensure({ ...baseRequest, env: { FOO: "bar" }, worktreeId: "wt-1" });

      const captured = service.captureManifest();
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({
        panelId: baseRequest.panelId,
        projectId: baseRequest.projectId,
        worktreeId: "wt-1",
        cwd: baseRequest.cwd,
        devCommand: baseRequest.devCommand,
        env: { FOO: "bar" },
      });
      // Port comes from the allocator-backed registry, not the (possibly null) url.
      expect(typeof captured[0].lastKnownPort === "number").toBe(true);
    });

    it("captureManifest omits a session once it has stopped", async () => {
      await service.ensure(baseRequest);
      await service.stop({ panelId: baseRequest.panelId, projectId: baseRequest.projectId });
      expect(service.captureManifest()).toEqual([]);
    });

    it("reports restored-stopped for a panel that has a manifest entry but no live session", () => {
      service.dispose();
      service = new DevPreviewSessionService(ptyClient as unknown as PtyClient, onStateChanged, [
        {
          panelId: baseRequest.panelId,
          projectId: baseRequest.projectId,
          worktreeId: "wt-1",
          cwd: baseRequest.cwd,
          devCommand: baseRequest.devCommand,
          lastKnownPort: 5173,
          capturedAt: 1000,
        },
      ]);

      const state = service.getState({
        panelId: baseRequest.panelId,
        projectId: baseRequest.projectId,
      });
      expect(state.status).toBe("restored-stopped");
      expect(state.worktreeId).toBe("wt-1");
      expect(state.terminalId).toBeNull();
      expect(state.url).toBeNull();
    });

    it("reports stopped (not restored-stopped) for an unrelated panel", () => {
      service.dispose();
      service = new DevPreviewSessionService(ptyClient as unknown as PtyClient, onStateChanged, [
        {
          panelId: baseRequest.panelId,
          projectId: baseRequest.projectId,
          cwd: baseRequest.cwd,
          devCommand: baseRequest.devCommand,
          lastKnownPort: null,
          capturedAt: 1000,
        },
      ]);

      const state = service.getState({ panelId: "other-panel", projectId: baseRequest.projectId });
      expect(state.status).toBe("stopped");
    });

    it("getByWorktree falls back to a restored entry when no live session exists", () => {
      service.dispose();
      service = new DevPreviewSessionService(ptyClient as unknown as PtyClient, onStateChanged, [
        {
          panelId: baseRequest.panelId,
          projectId: baseRequest.projectId,
          worktreeId: "wt-7",
          cwd: baseRequest.cwd,
          devCommand: baseRequest.devCommand,
          lastKnownPort: null,
          capturedAt: 1000,
        },
      ]);

      const state = service.getByWorktree("wt-7");
      expect(state?.status).toBe("restored-stopped");
      expect(service.getByWorktree("wt-unknown")).toBeNull();
    });

    it("persists the running manifest on start and clears it on explicit stop", async () => {
      const persist = vi.fn();
      service.dispose();
      service = new DevPreviewSessionService(
        ptyClient as unknown as PtyClient,
        onStateChanged,
        [],
        persist
      );

      await service.ensure(baseRequest);
      expect(persist).toHaveBeenCalled();
      expect(persist.mock.calls.at(-1)?.[0]).toHaveLength(1);

      persist.mockClear();
      await service.stop({ panelId: baseRequest.panelId, projectId: baseRequest.projectId });
      expect(persist).toHaveBeenCalled();
      // Explicit stop persists an empty manifest (deletes the restore prompt).
      expect(persist.mock.calls.at(-1)?.[0]).toEqual([]);
    });

    it("does not persist when a session exits on its own (manifest survives for restore)", async () => {
      const persist = vi.fn();
      service.dispose();
      service = new DevPreviewSessionService(
        ptyClient as unknown as PtyClient,
        onStateChanged,
        [],
        persist
      );

      const started = await service.ensure(baseRequest);
      persist.mockClear();

      // A PTY exit (e.g. shutdown kill or server crash) must NOT clear the
      // manifest — that's how the next launch keeps the restart offer.
      ptyClient.emitExit(started.terminalId!, 0);
      expect(persist).not.toHaveBeenCalled();
    });

    it("clears the restored-stopped status once the session is started", async () => {
      service.dispose();
      service = new DevPreviewSessionService(ptyClient as unknown as PtyClient, onStateChanged, [
        {
          panelId: baseRequest.panelId,
          projectId: baseRequest.projectId,
          cwd: baseRequest.cwd,
          devCommand: baseRequest.devCommand,
          lastKnownPort: null,
          capturedAt: 1000,
        },
      ]);

      expect(
        service.getState({ panelId: baseRequest.panelId, projectId: baseRequest.projectId }).status
      ).toBe("restored-stopped");

      await service.ensure(baseRequest);

      // Once a real session exists, the synthetic restored-stopped status is gone
      // even if the user later stops the server.
      await service.stop({ panelId: baseRequest.panelId, projectId: baseRequest.projectId });
      expect(
        service.getState({ panelId: baseRequest.panelId, projectId: baseRequest.projectId }).status
      ).toBe("stopped");
    });
  });

  describe("compile markers", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    async function sessionToRunning(): Promise<string> {
      vi.useRealTimers();
      const started = await service.ensure(baseRequest);
      const tid = started.terminalId!;
      ptyClient.emitData(tid, "ready at http://localhost:4173\n");
      await vi.waitFor(() => {
        const s = service.getState({
          panelId: baseRequest.panelId,
          projectId: baseRequest.projectId,
        });
        expect(s.status).toBe("running");
      });
      vi.useFakeTimers();
      (onStateChanged as unknown as ReturnType<typeof vi.fn>).mockClear();
      return tid;
    }

    it("arms then publishes Compiling after 1000ms during running session", async () => {
      const tid = await sessionToRunning();

      ptyClient.emitData(tid, "compiling...");

      await vi.advanceTimersByTimeAsync(500);
      let state = service.getState({
        panelId: baseRequest.panelId,
        projectId: baseRequest.projectId,
      });
      expect(state.phaseLabel).toBeUndefined();

      await vi.advanceTimersByTimeAsync(500);
      state = service.getState({ panelId: baseRequest.panelId, projectId: baseRequest.projectId });
      expect(state.phaseLabel).toBe("Compiling");

      await vi.advanceTimersByTimeAsync(1500);
      state = service.getState({ panelId: baseRequest.panelId, projectId: baseRequest.projectId });
      expect(state.phaseLabel).toBeUndefined();
    });

    it("fires compile marker during starting with pendingUrl set", async () => {
      mockHttpError();
      vi.useRealTimers();
      const started = await service.ensure(baseRequest);
      const tid = started.terminalId!;
      ptyClient.emitData(tid, "http://localhost:3000\n");
      await vi.waitFor(() => {
        const s = service.getState({
          panelId: baseRequest.panelId,
          projectId: baseRequest.projectId,
        });
        expect(s.status).toBe("starting");
        expect(s.url).toBeNull();
      });

      vi.useFakeTimers();
      (onStateChanged as unknown as ReturnType<typeof vi.fn>).mockClear();

      ptyClient.emitData(tid, "compiling...");
      await vi.advanceTimersByTimeAsync(1000);
      const state = service.getState({
        panelId: baseRequest.panelId,
        projectId: baseRequest.projectId,
      });
      expect(state.phaseLabel).toBe("Compiling");
    });

    it("readyMarker within arm window cancels compile and never publishes", async () => {
      const tid = await sessionToRunning();

      ptyClient.emitData(tid, "compiling...");
      await vi.advanceTimersByTimeAsync(400);
      ptyClient.emitData(tid, "webpack compiled successfully");
      await vi.advanceTimersByTimeAsync(1000);

      const state = service.getState({
        panelId: baseRequest.panelId,
        projectId: baseRequest.projectId,
      });
      expect(state.phaseLabel).toBeUndefined();
    });

    it("second compile marker while visible resets auto-clear timer", async () => {
      const tid = await sessionToRunning();

      ptyClient.emitData(tid, "compiling...");
      await vi.advanceTimersByTimeAsync(1000);
      expect(
        service.getState({ panelId: baseRequest.panelId, projectId: baseRequest.projectId })
          .phaseLabel
      ).toBe("Compiling");

      // Advance 1300ms: auto-clear fires at 1500ms from publish, 200ms remain.
      await vi.advanceTimersByTimeAsync(1300);

      // Second compile marker resets the auto-clear timer.
      ptyClient.emitData(tid, "Compiling /new-route");

      // Old timer point (200ms later): should be suppressed (was cancelled).
      await vi.advanceTimersByTimeAsync(200);
      expect(
        service.getState({ panelId: baseRequest.panelId, projectId: baseRequest.projectId })
          .phaseLabel
      ).toBe("Compiling");

      // Still visible 1100ms later (1400ms since reset, 100ms before new auto-clear).
      await vi.advanceTimersByTimeAsync(1100);
      expect(
        service.getState({ panelId: baseRequest.panelId, projectId: baseRequest.projectId })
          .phaseLabel
      ).toBe("Compiling");

      // Auto-clear fires after remaining 200ms (1500ms since reset).
      await vi.advanceTimersByTimeAsync(200);
      expect(
        service.getState({ panelId: baseRequest.panelId, projectId: baseRequest.projectId })
          .phaseLabel
      ).toBeUndefined();
    });

    it("stop clears arm timer and never publishes", async () => {
      const tid = await sessionToRunning();

      ptyClient.emitData(tid, "compiling...");
      await vi.advanceTimersByTimeAsync(500);

      await service.stop({ panelId: baseRequest.panelId, projectId: baseRequest.projectId });

      await vi.advanceTimersByTimeAsync(1000);
      const state = service.getState({
        panelId: baseRequest.panelId,
        projectId: baseRequest.projectId,
      });
      expect(state.phaseLabel).toBeUndefined();
    });

    it("error in data handler clears compile timers", async () => {
      const tid = await sessionToRunning();

      ptyClient.emitData(tid, "compiling...");
      await vi.advanceTimersByTimeAsync(1000);
      expect(
        service.getState({ panelId: baseRequest.panelId, projectId: baseRequest.projectId })
          .phaseLabel
      ).toBe("Compiling");

      ptyClient.emitData(tid, "Error: EACCES: permission denied");

      const state = service.getState({
        panelId: baseRequest.panelId,
        projectId: baseRequest.projectId,
      });
      expect(state.status).toBe("error");
      expect(state.phaseLabel).toBeUndefined();
    });

    it("terminal exit clears compile timers", async () => {
      const tid = await sessionToRunning();

      ptyClient.emitData(tid, "compiling...");
      await vi.advanceTimersByTimeAsync(1000);
      expect(
        service.getState({ panelId: baseRequest.panelId, projectId: baseRequest.projectId })
          .phaseLabel
      ).toBe("Compiling");

      ptyClient.emitExit(tid, 0);

      const state = service.getState({
        panelId: baseRequest.panelId,
        projectId: baseRequest.projectId,
      });
      expect(state.phaseLabel).toBeUndefined();
    });

    it("readyMarker during active compile clears label early", async () => {
      const tid = await sessionToRunning();

      ptyClient.emitData(tid, "compiling...");
      await vi.advanceTimersByTimeAsync(1000);
      expect(
        service.getState({ panelId: baseRequest.panelId, projectId: baseRequest.projectId })
          .phaseLabel
      ).toBe("Compiling");

      ptyClient.emitData(tid, "webpack compiled successfully");

      const state = service.getState({
        panelId: baseRequest.panelId,
        projectId: baseRequest.projectId,
      });
      expect(state.phaseLabel).toBeUndefined();
    });
  });

  describe("getUpstreamPortForSubdomain (#9100)", () => {
    it("resolves a panel's proxy subdomain to its allocated upstream port (plain HTTP fallback)", async () => {
      vi.spyOn(portAllocator, "allocatePort").mockImplementation(
        async (registry: Map<string, number>, key: string) => {
          registry.set(key, 4321);
          return 4321;
        }
      );

      await service.ensure(baseRequest);

      const subdomain = buildDevPreviewSubdomain(baseRequest.projectId, baseRequest.panelId);
      // Before any URL is detected the allocated port is used with the safe plain-HTTP default.
      expect(service.getUpstreamPortForSubdomain(subdomain)).toEqual({
        port: 4321,
        isHttps: false,
      });
    });

    it("returns null for an unknown subdomain", () => {
      expect(service.getUpstreamPortForSubdomain("dp-nope-nope")).toBeNull();
    });

    it("returns the detected port with isHttps:true for an HTTPS dev server (#9974)", async () => {
      const started = await service.ensure(baseRequest);
      ptyClient.emitData(started.terminalId!, "ready at https://localhost:8443\n");

      const subdomain = buildDevPreviewSubdomain(baseRequest.projectId, baseRequest.panelId);
      await vi.waitFor(() => {
        expect(service.getUpstreamPortForSubdomain(subdomain)).toEqual({
          port: 8443,
          isHttps: true,
        });
      });
    });

    it("returns the detected port with isHttps:false for an HTTP dev server (#9974)", async () => {
      const started = await service.ensure(baseRequest);
      ptyClient.emitData(started.terminalId!, "ready at http://localhost:5173\n");

      const subdomain = buildDevPreviewSubdomain(baseRequest.projectId, baseRequest.panelId);
      await vi.waitFor(() => {
        expect(service.getUpstreamPortForSubdomain(subdomain)).toEqual({
          port: 5173,
          isHttps: false,
        });
      });
    });

    it("resolves the scheme-default port when an HTTPS URL omits the port (#9974)", async () => {
      // WHATWG URL strips the default port, so `https://localhost/` surfaces an empty port — the
      // resolver must still dial 443 over HTTPS rather than falling back to the wrong port/scheme.
      const started = await service.ensure(baseRequest);
      ptyClient.emitData(started.terminalId!, "ready at https://localhost/\n");

      const subdomain = buildDevPreviewSubdomain(baseRequest.projectId, baseRequest.panelId);
      await vi.waitFor(() => {
        expect(service.getUpstreamPortForSubdomain(subdomain)).toEqual({
          port: 443,
          isHttps: true,
        });
      });
    });

    it("returns null once the session is stopped even though the registry entry lingers", async () => {
      vi.spyOn(portAllocator, "allocatePort").mockImplementation(
        async (registry: Map<string, number>, key: string) => {
          registry.set(key, 4321);
          return 4321;
        }
      );

      await service.ensure(baseRequest);
      const subdomain = buildDevPreviewSubdomain(baseRequest.projectId, baseRequest.panelId);
      expect(service.getUpstreamPortForSubdomain(subdomain)).toEqual({
        port: 4321,
        isHttps: false,
      });

      await service.stop({ panelId: baseRequest.panelId, projectId: baseRequest.projectId });

      expect(service.getUpstreamPortForSubdomain(subdomain)).toBeNull();
    });
  });
});
