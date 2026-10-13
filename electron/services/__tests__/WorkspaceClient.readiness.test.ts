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

    send = vi.fn((_msg?: unknown) => true);

    // Second parameter mirrors the real sendWithResponse(request, timeoutMs?)
    // so callers passing an explicit timeout type-check against this double.
    sendWithResponse = vi.fn(
      <T>(request: { requestId: string; type: string }, _timeoutMs?: number): Promise<T> => {
        return new Promise<T>((resolve, reject) => {
          this.responseHandlers.set(request.requestId, resolve);
          this.responseRejects.set(request.requestId, reject);
        });
      }
    );

    pauseHealthCheck = vi.fn();
    resumeHealthCheck = vi.fn();
    dispose = vi.fn(() => {
      this._isDisposed = true;
    });

    // Mirrors the real host: the policy is cached for replay on every host and
    // only delivered to the ones the client chose.
    cachedWorkspacePolicy: unknown = null;
    setWorkspacePowerPolicy = vi.fn((policy: unknown, deliver: boolean) => {
      this.cachedWorkspacePolicy = policy;
      if (deliver) this.send({ type: "set-workspace-power-policy", policy });
    });

    flushWorkspacePowerPolicy = vi.fn(() => {
      if (this.cachedWorkspacePolicy === null) return;
      this.send({ type: "set-workspace-power-policy", policy: this.cachedWorkspacePolicy });
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

    simulateReadyFailure(err: Error): void {
      if (this.readyReject) {
        this.readyReject(err);
        this.readyReject = null;
      }
    }

    /** Reset the ready promise to simulate a restart that hasn't completed yet. */
    resetReady(): void {
      this._isReady = false;
      this.readyPromise = new Promise((resolve) => {
        this.readyResolve = resolve;
      });
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

    getAllRequests(): Array<{ requestId: string; type: string; [key: string]: any }> {
      return this.sendWithResponse.mock.calls.map(([req]: any) => req);
    }
  }

  return { mockHosts, MockWorkspaceHostProcess };
});

vi.mock("../WorkspaceHostProcess.js", () => ({
  WorkspaceHostProcess: MockWorkspaceHostProcess,
}));

vi.mock("electron", () => {
  return {
    BrowserWindow: {
      getAllWindows: vi.fn(() => []),
    },
  };
});

vi.mock("../events.js", () => ({
  events: { emit: vi.fn() },
}));

// `WorkspaceHostPool` reads forge settings via `projectStore` to plumb into
// the `load-project` payload (#8316). Stub it so importing the pool doesn't
// fire ProjectStore's eager `app.getPath("userData")` constructor.
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
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("WorkspaceClient.waitForReady after host restart", () => {
  let client: WorkspaceClient;

  beforeEach(() => {
    mockHosts.length = 0;
    client = new WorkspaceClient({
      maxRestartAttempts: 3,
      showCrashDialog: false,
      healthCheckIntervalMs: 1000,
    });
  });

  afterEach(() => {
    client.dispose();
  });

  function h(index: number): MockHost {
    return mockHosts[index];
  }

  async function loadAndReady(projectPath: string, windowId: number): Promise<void> {
    const load = client.loadProject(projectPath, windowId);
    h(mockHosts.length - 1).simulateReady();
    await tick();
    const req = h(mockHosts.length - 1).getLastRequest()!;
    h(mockHosts.length - 1).resolveRequest(req.requestId);
    await load;
  }

  it("resolves immediately when no entries exist", async () => {
    await expect(client.waitForReady()).resolves.toBeUndefined();
  });

  it("resolves immediately once initial loadProject has completed", async () => {
    await loadAndReady("/project-a", 1);
    await expect(client.waitForReady()).resolves.toBeUndefined();
  });

  it("blocks until the post-restart load-project completes", async () => {
    await loadAndReady("/project-a", 1);

    // Simulate crash + restart: reset the host's ready promise so the reload
    // has to actually wait, then emit the restart event.
    h(0).resetReady();
    h(0).emit("restarted");
    await tick();

    let resolved = false;
    const waitPromise = client.waitForReady().then(() => {
      resolved = true;
    });
    await tick();
    expect(resolved).toBe(false);

    // Host becomes ready, but `reloadProjectAfterRestart` still has to await
    // its load-project response — `waitForReady` must block on that too.
    h(0).simulateReady();
    await tick();
    expect(resolved).toBe(false);

    // Find the post-restart load-project request and resolve it.
    const loadProjectReqs = h(0)
      .getAllRequests()
      .filter((r: any) => r.type === "load-project");
    expect(loadProjectReqs.length).toBe(2);
    h(0).resolveRequest(loadProjectReqs[1].requestId);

    await waitPromise;
    expect(resolved).toBe(true);
  });

  it("rejects when the post-restart load-project fails so callers can bail", async () => {
    await loadAndReady("/project-a", 1);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    h(0).resetReady();
    h(0).emit("restarted");
    await tick();
    h(0).simulateReady();
    await tick();

    const loadProjectReqs = h(0)
      .getAllRequests()
      .filter((r: any) => r.type === "load-project");
    h(0).rejectRequest(loadProjectReqs[1].requestId, new Error("reload failed"));

    await expect(client.waitForReady()).rejects.toThrow("reload failed");
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("Failed to reload project after host restart"),
      expect.any(Error)
    );
    consoleError.mockRestore();
  });

  it("resolves cleanly when a failed restart-reload is followed by a successful one", async () => {
    await loadAndReady("/project-a", 1);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    // Restart 1: fails mid-reload.
    h(0).resetReady();
    h(0).emit("restarted");
    await tick();
    h(0).simulateReady();
    await tick();
    const reqsAfterRestart1 = h(0)
      .getAllRequests()
      .filter((r: any) => r.type === "load-project");
    h(0).rejectRequest(reqsAfterRestart1[1].requestId, new Error("reload 1 failed"));
    await tick();

    // Restart 2: succeeds. `currentReadyPromise` is replaced by the fresh
    // restart promise, so waitForReady should now resolve.
    h(0).resetReady();
    h(0).emit("restarted");
    await tick();

    const waitPromise = client.waitForReady();
    h(0).simulateReady();
    await tick();

    const reqsAfterRestart2 = h(0)
      .getAllRequests()
      .filter((r: any) => r.type === "load-project");
    expect(reqsAfterRestart2.length).toBe(3);
    h(0).resolveRequest(reqsAfterRestart2[2].requestId);

    await expect(waitPromise).resolves.toBeUndefined();
    consoleError.mockRestore();
  });

  it("loadProject on a poisoned restarted entry disposes the old host and creates a new one", async () => {
    await loadAndReady("/project-a", 1);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    // Restart fails — entry's currentReadyPromise rejects.
    h(0).resetReady();
    h(0).emit("restarted");
    await tick();
    h(0).simulateReady();
    await tick();
    const reqs = h(0)
      .getAllRequests()
      .filter((r: any) => r.type === "load-project");
    h(0).rejectRequest(reqs[1].requestId, new Error("reload failed"));
    await tick();

    // Second window tries to attach to the same project. The poisoned entry
    // must NOT be reused — loadProject should dispose it and spin up a new
    // host.
    const load = client.loadProject("/project-a", 2);
    await tick();
    expect(h(0).dispose).toHaveBeenCalledTimes(1);
    expect(mockHosts.length).toBe(2);

    h(1).simulateReady();
    await tick();
    const newReq = h(1).getLastRequest()!;
    expect(newReq.type).toBe("load-project");
    h(1).resolveRequest(newReq.requestId);

    // A poisoned entry is replaced by a freshly spawned host, so the load is cold.
    await expect(load).resolves.toBe("cold");
    consoleError.mockRestore();
  });
});

// The project-switch IPC handler starts loadProject concurrently with the view
// swap, so rapid switches can have several loads in flight per window at once.
// The pool's windowToProject mapping must be "last REQUESTED wins" — a slow
// early load completing after a later one must not steal the mapping back.
describe("WorkspaceClient.loadProject request ordering", () => {
  let client: WorkspaceClient;

  beforeEach(() => {
    vi.useFakeTimers();
    mockHosts.length = 0;
    client = new WorkspaceClient({
      maxRestartAttempts: 3,
      showCrashDialog: false,
      healthCheckIntervalMs: 1000,
      maxWarmEntries: 3,
    });
  });

  afterEach(() => {
    client.dispose();
    vi.useRealTimers();
  });

  function h(index: number): MockHost {
    return mockHosts[index];
  }

  async function readyAndResolveLoad(hostIndex: number): Promise<void> {
    h(hostIndex).simulateReady();
    await vi.advanceTimersByTimeAsync(0);
    const req = h(hostIndex).getLastRequest()!;
    h(hostIndex).resolveRequest(req.requestId);
    await vi.advanceTimersByTimeAsync(0);
  }

  it("a superseded load completing late does not steal the window mapping (A→B→C)", async () => {
    const loadA = client.loadProject("/project-a", 1);
    await readyAndResolveLoad(0);
    await loadA;
    expect(client.getHostForWindow(1)).toBe(h(0));

    // Rapid A→B→C: both loads in flight; C's host becomes ready FIRST.
    const loadB = client.loadProject("/project-b", 1);
    const loadC = client.loadProject("/project-c", 1);

    await readyAndResolveLoad(2);
    await loadC;
    expect(client.getHostForWindow(1)).toBe(h(2));

    // B's slow host finishes last — the stale completion must not flip the
    // mapping back to B while the window displays C.
    await readyAndResolveLoad(1);
    await loadB;

    expect(client.getHostForWindow(1)).toBe(h(2));
    // The superseded host stays warm for a future switch-back but is demoted
    // to background polling, mirroring a switch-away.
    expect(h(1).send).toHaveBeenCalledWith({ type: "background" });
  });

  it("a same-project re-request does not strand the winning attachment", async () => {
    const loadA = client.loadProject("/project-a", 1);
    await readyAndResolveLoad(0);
    await loadA;

    // Two loads for the SAME project race (e.g. a switch retried while the
    // first cold spawn is still in flight). Whatever the completion order,
    // the window must stay attached to the project's host and the host must
    // not be reaped as dormant.
    const first = client.loadProject("/project-b", 1);
    const second = client.loadProject("/project-b", 1);
    await readyAndResolveLoad(1);
    await Promise.all([first, second]);

    expect(client.getHostForWindow(1)).toBe(h(1));

    // Far past the dormant grace period: the winning attachment's host must
    // survive (a stale-undo that stranded it would have scheduled cleanup).
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(h(1).dispose).not.toHaveBeenCalled();
  });

  it("a load completing after the window released does not resurrect the mapping", async () => {
    const load = client.loadProject("/project-b", 1);
    client.unregisterWindow(1);

    await readyAndResolveLoad(0);
    await load;

    expect(client.getHostForWindow(1)).toBeUndefined();
  });
});

describe("WorkspaceClient.prewarmProject", () => {
  let client: WorkspaceClient;

  beforeEach(() => {
    vi.useFakeTimers();
    mockHosts.length = 0;
    client = new WorkspaceClient({
      maxRestartAttempts: 3,
      showCrashDialog: false,
      healthCheckIntervalMs: 1000,
      // Pin the dormant warm-pool cap so eviction assertions stay deterministic
      // regardless of the host machine's RAM (the default is now RAM-scaled).
      maxWarmEntries: 3,
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
    await expect(load).resolves.toBe("warm");

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
    // Joined the prewarmed host rather than spawning one, even though it was
    // still loading.
    await expect(loadPromise).resolves.toBe("warm");

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
    const timeoutMs = h(0).sendWithResponse.mock.calls[0][1];
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
