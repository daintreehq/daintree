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
    private responseRejects = new Map<string, (error: Error) => void>();

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
