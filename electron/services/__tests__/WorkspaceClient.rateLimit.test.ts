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
    private readyPromise: Promise<void>;
    private responseHandlers = new Map<string, (result: any) => void>();

    constructor(projectPath: string) {
      super();
      this.projectPath = projectPath;
      this.readyPromise = new Promise((resolve) => {
        this.readyResolve = resolve;
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
      return new Promise<T>((resolve) => {
        this.responseHandlers.set(request.requestId, resolve);
      });
    });

    pauseHealthCheck = vi.fn();
    resumeHealthCheck = vi.fn();
    dispose = vi.fn(() => {
      this._isDisposed = true;
    });

    setLogLevelOverrides = vi.fn();
    relayFetchThrottle = vi.fn();

    simulateReady(): void {
      this._isReady = true;
      if (this.readyResolve) {
        this.readyResolve();
        this.readyResolve = null;
      }
    }

    resolveRequest(requestId: string, result: any = {}): void {
      const handler = this.responseHandlers.get(requestId);
      if (handler) {
        this.responseHandlers.delete(requestId);
        handler(result);
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
  return {
    BrowserWindow: { getAllWindows: vi.fn(() => []) },
  };
});

vi.mock("../events.js", () => ({
  events: { emit: vi.fn() },
}));

vi.mock("../ProjectStore.js", () => ({
  projectStore: {
    getProjectSettings: vi.fn().mockResolvedValue({ runCommands: [] }),
    resolveProjectIdForPath: vi.fn((p: string) => `id-for-${p}`),
  },
}));

vi.mock("../../store.js", () => ({
  store: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

import { WorkspaceClient } from "../WorkspaceClient.js";

type MockHost = InstanceType<typeof MockWorkspaceHostProcess>;

describe("WorkspaceClient.relayFetchThrottle", () => {
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

  async function loadProject(projectPath: string, hostIndex: number, windowId: number) {
    const load = client.loadProject(projectPath, windowId);
    h(hostIndex).simulateReady();
    await vi.advanceTimersByTimeAsync(0);
    const req = h(hostIndex).getLastRequest()!;
    h(hostIndex).resolveRequest(req.requestId);
    await vi.advanceTimersByTimeAsync(0);
    await load;
  }

  it("fans out the multiplier to every pooled host", async () => {
    await loadProject("/project-a", 0, 1);
    await loadProject("/project-b", 1, 2);

    client.relayFetchThrottle(4);

    expect(h(0).relayFetchThrottle).toHaveBeenCalledWith(4);
    expect(h(1).relayFetchThrottle).toHaveBeenCalledWith(4);
  });

  it("seeds hosts created after the last state change from the pool cache", async () => {
    client.relayFetchThrottle(5);

    await loadProject("/project-a", 0, 1);

    // The host was created after the relay — it must still receive the
    // cached multiplier at construction, not wait for the next state change.
    expect(h(0).relayFetchThrottle).toHaveBeenCalledWith(5);
  });

  it("is a no-op (no throw) when the pool is empty", () => {
    expect(() => client.relayFetchThrottle(2)).not.toThrow();
  });
});

describe("WorkspaceClient.refreshPullRequests", () => {
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

  async function loadProject(projectPath: string, hostIndex: number, windowId: number) {
    const load = client.loadProject(projectPath, windowId);
    h(hostIndex).simulateReady();
    await vi.advanceTimersByTimeAsync(0);
    const req = h(hostIndex).getLastRequest()!;
    h(hostIndex).resolveRequest(req.requestId);
    await vi.advanceTimersByTimeAsync(0);
    await load;
  }

  it("dispatches to every pooled host before any of them has responded", async () => {
    await loadProject("/project-a", 0, 1);
    await loadProject("/project-b", 1, 2);
    h(0).sendWithResponse.mockClear();
    h(1).sendWithResponse.mockClear();

    const refresh = client.refreshPullRequests();
    await vi.advanceTimersByTimeAsync(0);

    // Neither host has responded yet. A sequential fan-out would leave the
    // second host untouched until the first resolved, so both requests being
    // in flight at once is what proves the walk is concurrent.
    expect(h(0).getLastRequest()?.type).toBe("refresh-prs");
    expect(h(1).getLastRequest()?.type).toBe("refresh-prs");

    h(0).resolveRequest(h(0).getLastRequest()!.requestId);
    h(1).resolveRequest(h(1).getLastRequest()!.requestId);
    await refresh;
  });

  it("gives the refresh more response headroom than the host default", async () => {
    await loadProject("/project-a", 0, 1);
    h(0).sendWithResponse.mockClear();

    const refresh = client.refreshPullRequests();
    await vi.advanceTimersByTimeAsync(0);

    // A manual refresh now awaits CI enrichment on top of provider
    // re-resolution and PR re-detection, so it must not inherit the host's
    // default per-request budget.
    const timeoutMs = h(0).sendWithResponse.mock.calls[0][1] as number | undefined;
    expect(timeoutMs).toBeDefined();
    expect(timeoutMs).toBeGreaterThan(30_000);

    h(0).resolveRequest(h(0).getLastRequest()!.requestId);
    await refresh;
  });

  it("refreshes the surviving host when another host fails", async () => {
    await loadProject("/project-a", 0, 1);
    await loadProject("/project-b", 1, 2);
    h(0).sendWithResponse.mockClear();
    h(1).sendWithResponse.mockClear();
    h(0).sendWithResponse.mockRejectedValueOnce(new Error("host crashed"));

    const refresh = client.refreshPullRequests();
    await vi.advanceTimersByTimeAsync(0);

    expect(h(1).getLastRequest()?.type).toBe("refresh-prs");
    h(1).resolveRequest(h(1).getLastRequest()!.requestId);

    // A crashed host must not reject the whole fan-out.
    await expect(refresh).resolves.toBeUndefined();
  });
});
