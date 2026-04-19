/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockHosts, MockWorkspaceHostProcess } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("events") as typeof import("events");

  const mockHosts: any[] = [];

  class MockWorkspaceHostProcess extends EventEmitter {
    projectPath: string;
    private _isReady = false;
    private _isDisposed = false;
    private readyResolve: (() => void) | null = null;
    private readyReject: ((err: Error) => void) | null = null;
    private readyPromise: Promise<void>;
    private responseHandlers = new Map<string, (result: any) => void>();
    private responseRejects = new Map<string, (error: Error) => void>();

    constructor(projectPath: string) {
      super();
      this.projectPath = projectPath;
      this.readyPromise = new Promise((resolve, reject) => {
        this.readyResolve = resolve;
        this.readyReject = reject;
      });
      mockHosts.push(this);
    }

    waitForReady(): Promise<void> {
      return this.readyPromise;
    }

    isReady(): boolean {
      return this._isReady && !this._isDisposed;
    }

    generateRequestId(): string {
      return `req-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    }

    send = vi.fn(() => true);

    sendWithResponse = vi.fn(<T>(request: { requestId: string; type: string }): Promise<T> => {
      return new Promise<T>((resolve, reject) => {
        this.responseHandlers.set(request.requestId, resolve);
        this.responseRejects.set(request.requestId, reject);
      });
    });

    pauseHealthCheck = vi.fn();
    resumeHealthCheck = vi.fn();
    dispose = vi.fn(() => {
      this._isDisposed = true;
    });
    attachRendererPort = vi.fn(() => true);

    setLogLevelOverrides = vi.fn();

    simulateReady(): void {
      this._isReady = true;
      if (this.readyResolve) {
        this.readyResolve();
        this.readyResolve = null;
      }
    }

    simulateReadyFailure(err: Error): void {
      if (this.readyReject) {
        this.readyReject(err);
        this.readyReject = null;
      }
    }

    resolveRequest(requestId: string, result: any = {}): void {
      const handler = this.responseHandlers.get(requestId);
      if (handler) {
        this.responseHandlers.delete(requestId);
        handler(result);
      }
    }

    rejectRequest(requestId: string, error: Error): void {
      const handler = this.responseRejects.get(requestId);
      if (handler) {
        this.responseRejects.delete(requestId);
        this.responseHandlers.delete(requestId);
        handler(error);
      }
    }

    getLastRequest(): { requestId: string; type: string; [key: string]: any } | undefined {
      const calls = this.sendWithResponse.mock.calls;
      if (calls.length === 0) return undefined;
      return calls[calls.length - 1][0] as any;
    }
  }

  return { mockHosts, MockWorkspaceHostProcess };
});

vi.mock("../WorkspaceHostProcess.js", () => ({
  WorkspaceHostProcess: MockWorkspaceHostProcess,
}));

vi.mock("electron", () => {
  class MockMessageChannelMain {
    port1 = { close: vi.fn() };
    port2 = { close: vi.fn() };
  }
  return {
    BrowserWindow: { getAllWindows: vi.fn(() => []) },
    MessageChannelMain: MockMessageChannelMain,
  };
});

vi.mock("../events.js", () => ({
  events: { emit: vi.fn() },
}));

import path from "path";
import { WorkspaceClient } from "../WorkspaceClient.js";

type MockHost = InstanceType<typeof MockWorkspaceHostProcess>;

describe("WorkspaceClient.prewarmProject", () => {
  let client: WorkspaceClient;

  beforeEach(() => {
    vi.useFakeTimers();
    mockHosts.length = 0;
    client = new WorkspaceClient({
      maxRestartAttempts: 3,
      showCrashDialog: false,
      healthCheckIntervalMs: 1000,
    });
  });

  afterEach(() => {
    client.dispose();
    vi.useRealTimers();
  });

  function h(index: number): MockHost {
    return mockHosts[index];
  }

  async function readyAndResolveLoadFake(hostIndex: number): Promise<void> {
    h(hostIndex).simulateReady();
    await vi.advanceTimersByTimeAsync(0);
    const req = h(hostIndex).getLastRequest()!;
    h(hostIndex).resolveRequest(req.requestId);
    await vi.advanceTimersByTimeAsync(0);
  }

  it("creates a host with refCount=0 and starts dormant cleanup", () => {
    client.prewarmProject("/project-a");

    expect(mockHosts).toHaveLength(1);
    expect(h(0).projectPath).toBe(path.resolve("/project-a"));
  });

  it("is idempotent — second call for same path is a no-op", () => {
    client.prewarmProject("/project-a");
    client.prewarmProject("/project-a");

    expect(mockHosts).toHaveLength(1);
  });

  it("is a no-op when entry already exists from loadProject", async () => {
    const load = client.loadProject("/project-a", 1);
    await readyAndResolveLoadFake(0);
    await load;

    client.prewarmProject("/project-a");
    expect(mockHosts).toHaveLength(1);
  });

  it("is a no-op after dispose", () => {
    client.dispose();
    client.prewarmProject("/project-a");
    expect(mockHosts).toHaveLength(0);
  });

  it("loadProject after prewarm hits the warm path — no second fork", async () => {
    client.prewarmProject("/project-a");
    await readyAndResolveLoadFake(0);

    const load = client.loadProject("/project-a", 1);
    await load;

    // Only one host was ever created
    expect(mockHosts).toHaveLength(1);
    expect(h(0).dispose).not.toHaveBeenCalled();
  });

  it("loadProject during in-flight prewarm awaits the same initPromise", async () => {
    client.prewarmProject("/project-a");
    // Host created but not ready yet
    expect(mockHosts).toHaveLength(1);

    // Start loadProject while prewarm is in-flight
    const loadPromise = client.loadProject("/project-a", 1);

    // Complete the init
    await readyAndResolveLoadFake(0);
    await loadPromise;

    // Still only one host
    expect(mockHosts).toHaveLength(1);
  });

  it("dormant cleanup evicts prewarm entry after grace period", async () => {
    client.prewarmProject("/project-a");
    await readyAndResolveLoadFake(0);

    // Just before grace period
    await vi.advanceTimersByTimeAsync(179_999);
    expect(h(0).dispose).not.toHaveBeenCalled();

    // At grace period
    await vi.advanceTimersByTimeAsync(1);
    expect(h(0).dispose).toHaveBeenCalledTimes(1);
  });

  it("LRU cap evicts oldest prewarm when 4th dormant entry is added", async () => {
    // Prewarm 4 projects
    for (let i = 0; i < 4; i++) {
      client.prewarmProject(`/project-${i}`);
      await readyAndResolveLoadFake(i);
    }

    // 4 dormant entries — cap is 3, so the oldest (project-0) should be evicted
    expect(h(0).dispose).toHaveBeenCalledTimes(1);
    expect(h(1).dispose).not.toHaveBeenCalled();
    expect(h(2).dispose).not.toHaveBeenCalled();
    expect(h(3).dispose).not.toHaveBeenCalled();
  });

  it("failed init cleans up the entry", async () => {
    client.prewarmProject("/project-a");
    h(0).simulateReadyFailure(new Error("Fork failed"));
    await vi.advanceTimersByTimeAsync(0);

    expect(h(0).dispose).toHaveBeenCalled();

    // A subsequent loadProject should create a fresh host
    const load = client.loadProject("/project-a", 1);
    expect(mockHosts).toHaveLength(2);
    await readyAndResolveLoadFake(1);
    await load;
  });

  it("failed init via sendWithResponse rejection cleans up the entry", async () => {
    client.prewarmProject("/project-a");
    h(0).simulateReady();
    await vi.advanceTimersByTimeAsync(0);
    const req = h(0).getLastRequest()!;
    h(0).rejectRequest(req.requestId, new Error("load-project failed"));
    await vi.advanceTimersByTimeAsync(0);

    expect(h(0).dispose).toHaveBeenCalled();
  });
});
