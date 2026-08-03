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

    manualRestart = vi.fn(() => {
      // Emulate the real host: a manual restart emits "restarted" so
      // `WorkspaceClient` runs reloadProjectAfterRestart.
      this.emit("restarted");
    });

    setLogLevelOverrides = vi.fn();
    relayFetchThrottle = vi.fn();

    // Test helpers
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
  events: {
    emit: vi.fn(),
  },
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

import path from "path";
import { WorkspaceClient } from "../WorkspaceClient.js";
import { projectStore } from "../ProjectStore.js";

type MockHost = InstanceType<typeof MockWorkspaceHostProcess>;

// After simulateReady(), sendWithResponse is called asynchronously (next microtask).
// This helper waits for that to happen.
const tick = () => new Promise((r) => setTimeout(r, 0));

let nextWcId = 100;
/** Create a mock webContents with the properties needed by attachDirectPort. */
function createMockWebContents() {
  return {
    id: nextWcId++,
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
    postMessage: vi.fn(),
  };
}

describe("WorkspaceClient multi-process manager", () => {
  let client: WorkspaceClient;

  beforeEach(() => {
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
  });

  function h(index: number): MockHost {
    return mockHosts[index];
  }

  /** Helper: simulateReady + wait for initPromise's sendWithResponse + resolve it */
  async function readyAndResolveLoad(hostIndex: number): Promise<void> {
    h(hostIndex).simulateReady();
    await tick();
    const req = h(hostIndex).getLastRequest()!;
    h(hostIndex).resolveRequest(req.requestId);
    await tick();
  }

  describe("loadProject", () => {
    it("creates a new host process for a new project", async () => {
      const loadPromise = client.loadProject("/project-a", 1);

      expect(mockHosts).toHaveLength(1);
      expect(h(0).projectPath).toBe(path.resolve("/project-a"));

      h(0).simulateReady();
      await tick();
      const req = h(0).getLastRequest()!;
      expect(req.type).toBe("load-project");
      expect(req.rootPath).toBe(path.resolve("/project-a"));
      h(0).resolveRequest(req.requestId);

      await loadPromise;
    });

    it("reuses existing host for same project from different window", async () => {
      const load1 = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load1;

      const load2 = client.loadProject("/project-a", 2);
      expect(mockHosts).toHaveLength(1);
      await load2;
    });

    it("creates separate hosts for different projects", async () => {
      const load1 = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load1;

      const load2 = client.loadProject("/project-b", 2);
      expect(mockHosts).toHaveLength(2);
      expect(h(1).projectPath).toBe(path.resolve("/project-b"));

      await readyAndResolveLoad(1);
      await load2;
    });

    it("switches window from one project to another", async () => {
      const load1 = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load1;

      const load2 = client.loadProject("/project-b", 1);
      expect(mockHosts).toHaveLength(2);

      await readyAndResolveLoad(1);
      await load2;
    });

    it("demotes the old host to background when the last window switches away (#10743)", async () => {
      const load1 = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load1;

      const load2 = client.loadProject("/project-b", 1);
      await readyAndResolveLoad(1);
      await load2;

      // refCount on project-a dropped to 0 — its host should be paused so it
      // stops full-rate polling while dormant.
      expect(h(0).send).toHaveBeenCalledWith({ type: "background" });
    });

    it("does NOT background the old host while another window still holds it (#10743)", async () => {
      const load1 = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load1;

      // A second window also holds project-a (refCount = 2).
      const load1b = client.loadProject("/project-a", 2);
      await load1b;

      // Window 1 switches to project-b; project-a still has window 2.
      const load2 = client.loadProject("/project-b", 1);
      await readyAndResolveLoad(1);
      await load2;

      expect(h(0).send).not.toHaveBeenCalledWith({ type: "background" });
    });

    it("foregrounds a warm host when a window re-attaches after switch-away (#10743)", async () => {
      const load1 = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load1;

      // Switch away: project-a is demoted to background (refCount 0).
      const load2 = client.loadProject("/project-b", 1);
      await readyAndResolveLoad(1);
      await load2;
      expect(h(0).send).toHaveBeenCalledWith({ type: "background" });

      // Re-attach to the still-warm project-a — the pool must resume it so it
      // doesn't stay paused (covers menu open / reopen / switch-back paths).
      const load3 = client.loadProject("/project-a", 1);
      await load3;
      expect(h(0).send).toHaveBeenCalledWith({ type: "foreground" });
    });
  });

  describe("getAllStatesAsync", () => {
    it("routes to window-specific host when windowId provided", async () => {
      const load = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load;

      const statesPromise = client.getAllStatesAsync(1);
      await tick();
      const req = h(0).getLastRequest()!;
      expect(req.type).toBe("get-all-states");
      h(0).resolveRequest(req.requestId, {
        states: [{ id: "wt-1", name: "Main" }],
      });

      const result = await statesPromise;
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("wt-1");
    });

    it("returns empty array when window has no project", async () => {
      const result = await client.getAllStatesAsync(999);
      expect(result).toEqual([]);
    });

    it("aggregates from all hosts in parallel when no windowId", async () => {
      const load1 = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load1;

      const load2 = client.loadProject("/project-b", 2);
      await readyAndResolveLoad(1);
      await load2;

      const statesPromise = client.getAllStatesAsync();
      await tick();

      // Both hosts receive requests concurrently (parallel fan-out)
      const reqA = h(0).getLastRequest()!;
      const reqB = h(1).getLastRequest()!;
      expect(reqA.type).toBe("get-all-states");
      expect(reqB.type).toBe("get-all-states");

      h(0).resolveRequest(reqA.requestId, {
        states: [{ id: "wt-a", name: "A" }],
      });
      h(1).resolveRequest(reqB.requestId, {
        states: [{ id: "wt-b", name: "B" }],
      });

      const result = await statesPromise;
      expect(result).toHaveLength(2);
      expect(result.map((s) => s.id)).toEqual(["wt-a", "wt-b"]);
    });

    it("dedupes snapshots by id when no-window fallback sees the same worktree twice", async () => {
      const load1 = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load1;

      const load2 = client.loadProject("/project-b", 2);
      await readyAndResolveLoad(1);
      await load2;

      const statesPromise = client.getAllStatesAsync();
      await tick();

      const reqA = h(0).getLastRequest()!;
      const reqB = h(1).getLastRequest()!;
      h(0).resolveRequest(reqA.requestId, {
        states: [
          { id: "wt-shared", name: "Shared", branch: "race-wt" },
          { id: "wt-a", name: "A" },
        ],
      });
      h(1).resolveRequest(reqB.requestId, {
        states: [
          { id: "wt-shared", name: "Shared duplicate", branch: "race-wt" },
          { id: "wt-b", name: "B" },
        ],
      });

      const result = await statesPromise;
      expect(result.map((s) => s.id)).toEqual(["wt-shared", "wt-a", "wt-b"]);
      expect(result.filter((s) => s.id === "wt-shared")).toHaveLength(1);
    });

    it("waits for the host to finish re-populating after a restart before reading, so a mid-syncMonitors partial list is never returned (#11387)", async () => {
      const load = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load;

      // Simulate a crash-restart: the pool reassigns currentReadyPromise to the
      // reload promise, which resolves only after load-project — and thus the
      // whole syncMonitors populate — completes. Until then this.monitors is
      // partial (often just the main worktree, which git enumerates first).
      h(0).emit("restarted");
      await tick();
      const reloadReq = h(0).getLastRequest()!;
      expect(reloadReq.type).toBe("load-project");

      // A read landing during the resync must NOT fire get-all-states yet — it
      // would observe the partial monitor map that restore wrongly trusts.
      const statesPromise = client.getAllStatesAsync(1);
      await tick();
      expect(
        h(0)
          .getAllRequests()
          .filter((r: any) => r.type === "get-all-states")
      ).toHaveLength(0);

      // Once the reload settles, the gated read proceeds against the complete map.
      h(0).resolveRequest(reloadReq.requestId);
      await tick();
      const statesReq = h(0)
        .getAllRequests()
        .find((r: any) => r.type === "get-all-states")!;
      expect(statesReq).toBeDefined();
      h(0).resolveRequest(statesReq.requestId, {
        states: [{ id: "wt-1" }, { id: "wt-2" }],
      });

      expect((await statesPromise).map((s) => s.id)).toEqual(["wt-1", "wt-2"]);
    });

    it("returns [] without ever reading a partial map when the restart reload rejects (#11387)", async () => {
      const load = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load;

      h(0).emit("restarted");
      await tick();
      const reloadReq = h(0).getLastRequest()!;
      expect(reloadReq.type).toBe("load-project");

      const statesPromise = client.getAllStatesAsync(1);
      await tick();
      expect(
        h(0)
          .getAllRequests()
          .filter((r: any) => r.type === "get-all-states")
      ).toHaveLength(0);

      // A failed/timed-out reload leaves the host's monitor map genuinely
      // partial (the host keeps syncing after the parent request rejects), so
      // the gate reports "unknown": it resolves [] WITHOUT ever sending
      // get-all-states — never reading, let alone trusting, a partial list —
      // and never hangs.
      h(0).rejectRequest(reloadReq.requestId, new Error("reload failed"));
      expect(await statesPromise).toEqual([]);
      expect(
        h(0)
          .getAllRequests()
          .filter((r: any) => r.type === "get-all-states")
      ).toHaveLength(0);
    });
  });

  describe("getAllStatesForProjectAsync", () => {
    // Mirrors the ProjectStore mock: entry.projectId is minted from
    // resolveProjectIdForPath(normalizedPath) at host construction.
    const idFor = (p: string) => `id-for-${path.resolve(p)}`;

    it("routes to the project's own host even after its window was rebound (#11366)", async () => {
      const loadA = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await loadA;

      // Window 1 switches to project B — windowToProject now points at B,
      // exactly the state a backgrounded A view lives in.
      const loadB = client.loadProject("/project-b", 1);
      await readyAndResolveLoad(1);
      await loadB;

      const statesPromise = client.getAllStatesForProjectAsync("/project-a", idFor("/project-a"));
      await tick();
      const req = h(0)
        .getAllRequests()
        .find((r: any) => r.type === "get-all-states")!;
      expect(req).toBeDefined();
      h(0).resolveRequest(req.requestId, { states: [{ id: "wt-a", name: "A" }] });

      const result = await statesPromise;
      expect(result.map((s: any) => s.id)).toEqual(["wt-a"]);

      // B's host never saw a state query — no cross-project fan-out.
      const hostBStateReqs = h(1)
        .getAllRequests()
        .filter((r: any) => r.type === "get-all-states");
      expect(hostBStateReqs).toHaveLength(0);
    });

    it("keeps a request started before a rebind on the originally resolved host", async () => {
      const loadA = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await loadA;

      // Start the A-scoped query first, then COMPLETE the window's rebind to B
      // while the request is still in flight — the captured host must not be
      // re-resolved from the now-repointed window mapping.
      const statesPromise = client.getAllStatesForProjectAsync("/project-a", idFor("/project-a"));
      await tick();
      const req = h(0)
        .getAllRequests()
        .find((r: any) => r.type === "get-all-states")!;
      expect(req).toBeDefined();

      const loadB = client.loadProject("/project-b", 1);
      await readyAndResolveLoad(1);
      await loadB;

      h(0).resolveRequest(req.requestId, { states: [{ id: "wt-a" }] });
      expect((await statesPromise).map((s: any) => s.id)).toEqual(["wt-a"]);

      // B's host answered no state query on behalf of the pre-rebind request.
      const hostBStateReqs = h(1)
        .getAllRequests()
        .filter((r: any) => r.type === "get-all-states");
      expect(hostBStateReqs).toHaveLength(0);
    });

    it("returns empty for an unknown project path without contacting any host", async () => {
      const loadA = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await loadA;

      const callsBefore = h(0).sendWithResponse.mock.calls.length;
      const result = await client.getAllStatesForProjectAsync(
        "/no-such-project",
        idFor("/no-such-project")
      );
      expect(result).toEqual([]);
      expect(h(0).sendWithResponse.mock.calls.length).toBe(callsBefore);
    });

    it("returns empty when the entry's immutable projectId does not match the caller's", async () => {
      const loadA = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await loadA;

      // A caller holding a different project identity but pointing at A's path
      // (e.g. its project row's path was rewritten) must not reach A's host.
      const callsBefore = h(0).sendWithResponse.mock.calls.length;
      const result = await client.getAllStatesForProjectAsync("/project-a", idFor("/project-b"));
      expect(result).toEqual([]);
      expect(h(0).sendWithResponse.mock.calls.length).toBe(callsBefore);
    });

    it("gates the initial load too — no read until the first load-project completes (#11387)", async () => {
      // Hydration's project-scoped prefetch can resolve the pool entry (created
      // synchronously by loadProject) before its initial load-project — and thus
      // the first syncMonitors populate — has finished. The read must wait.
      const loadA = client.loadProject("/project-a", 1);
      h(0).simulateReady();
      await tick();
      const loadReq = h(0).getLastRequest()!;
      expect(loadReq.type).toBe("load-project");

      const statesPromise = client.getAllStatesForProjectAsync("/project-a", idFor("/project-a"));
      await tick();
      expect(
        h(0)
          .getAllRequests()
          .filter((r: any) => r.type === "get-all-states")
      ).toHaveLength(0);

      // Complete the initial load; only now may the gated read fire.
      h(0).resolveRequest(loadReq.requestId);
      await loadA;
      await tick();
      const statesReq = h(0)
        .getAllRequests()
        .find((r: any) => r.type === "get-all-states")!;
      expect(statesReq).toBeDefined();
      h(0).resolveRequest(statesReq.requestId, { states: [{ id: "wt-a" }] });
      expect((await statesPromise).map((s: any) => s.id)).toEqual(["wt-a"]);
    });

    it("waits for host readiness before reading, so a resync never yields a partial list (#11387)", async () => {
      const loadA = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await loadA;

      // Same crash-restart resync window as the window-scoped path — the
      // project-scoped read (the one hydration now uses, #11387) must gate on
      // the same readiness signal.
      h(0).emit("restarted");
      await tick();
      const reloadReq = h(0).getLastRequest()!;
      expect(reloadReq.type).toBe("load-project");

      const statesPromise = client.getAllStatesForProjectAsync("/project-a", idFor("/project-a"));
      await tick();
      expect(
        h(0)
          .getAllRequests()
          .filter((r: any) => r.type === "get-all-states")
      ).toHaveLength(0);

      h(0).resolveRequest(reloadReq.requestId);
      await tick();
      const statesReq = h(0)
        .getAllRequests()
        .find((r: any) => r.type === "get-all-states")!;
      expect(statesReq).toBeDefined();
      h(0).resolveRequest(statesReq.requestId, { states: [{ id: "wt-a" }] });
      expect((await statesPromise).map((s: any) => s.id)).toEqual(["wt-a"]);
    });

    describe("readiness gate timeout", () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      // Long enough that any sane hydration-facing deadline has elapsed, short
      // enough to stay well inside the host's 30s per-request budget — the gate
      // must give up inside this window rather than riding the host's timeout.
      // Not the deadline itself: the test asserts the behavior, not the number.
      const GATE_OBSERVATION_WINDOW_MS = 10_000;

      it("degrades to the unknown sentinel rather than stalling restore when the host never posts ready (#11387)", async () => {
        // A host that forks but hangs before posting "ready" leaves
        // currentReadyPromise pending forever (waitForReady carries no timeout),
        // and the pool entry is in the map from the moment loadProject is called
        // — so hydration's prefetch resolves this entry and waits on the gate.
        // Every PTY panel's restore awaits that prefetch, so an unbounded gate
        // means zero terminals restore for as long as it waits.
        const load = client.loadProject("/project-a", 1);
        void load.catch(() => {});
        expect(mockHosts).toHaveLength(1);

        const statesPromise = client.getAllStatesForProjectAsync("/project-a", idFor("/project-a"));
        let resolved: any = undefined;
        void statesPromise.then((r) => {
          resolved = r;
        });

        // While the populate is genuinely in flight the gate holds: no read of a
        // possibly-partial monitor map.
        await vi.advanceTimersByTimeAsync(0);
        expect(resolved).toBeUndefined();

        await vi.advanceTimersByTimeAsync(GATE_OBSERVATION_WINDOW_MS);

        // Gate gave up: "unknown" ([] — #11234), so restore keeps every panel's
        // saved worktreeId instead of re-homing it, and the partial map was
        // never read — get-all-states is never sent.
        expect(resolved).toEqual([]);
        expect(await statesPromise).toEqual([]);
        expect(
          h(0)
            .getAllRequests()
            .filter((r: any) => r.type === "get-all-states")
        ).toHaveLength(0);
      });
    });

    it("normalizes the path before keying — equivalent spellings share one request", async () => {
      const loadA = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await loadA;

      const p1 = client.getAllStatesForProjectAsync("/project-a", idFor("/project-a"));
      const p2 = client.getAllStatesForProjectAsync("/project-a/", idFor("/project-a"));
      const p3 = client.getAllStatesForProjectAsync("/other/../project-a", idFor("/project-a"));
      expect(p2).toBe(p1);
      expect(p3).toBe(p1);

      await tick();
      const reqs = h(0)
        .getAllRequests()
        .filter((r: any) => r.type === "get-all-states");
      expect(reqs).toHaveLength(1);
      h(0).resolveRequest(reqs[0].requestId, { states: [{ id: "wt-a" }] });
      await p1;
    });

    it("evicts the in-flight entry on error so the next call retries", async () => {
      const loadA = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await loadA;

      const p1 = client.getAllStatesForProjectAsync("/project-a", idFor("/project-a"));
      await tick();
      const req1 = h(0)
        .getAllRequests()
        .filter((r: any) => r.type === "get-all-states")[0];
      h(0).rejectRequest(req1.requestId, new Error("host crashed"));
      await expect(p1).rejects.toThrow("host crashed");

      // Immediately after the error a fresh promise (and request) is issued —
      // a cached rejection here would fail every file-browser retry for 150ms.
      const p2 = client.getAllStatesForProjectAsync("/project-a", idFor("/project-a"));
      expect(p2).not.toBe(p1);
      await tick();
      const req2 = h(0)
        .getAllRequests()
        .filter((r: any) => r.type === "get-all-states")[1];
      h(0).resolveRequest(req2.requestId, { states: [{ id: "wt-ok" }] });
      expect(await p2).toEqual([{ id: "wt-ok" }]);
    });

    it("coalesces concurrent calls per project path, separately per project", async () => {
      const loadA = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await loadA;

      const loadB = client.loadProject("/project-b", 2);
      await readyAndResolveLoad(1);
      await loadB;

      const p1 = client.getAllStatesForProjectAsync("/project-a", idFor("/project-a"));
      const p2 = client.getAllStatesForProjectAsync("/project-a", idFor("/project-a"));
      const p3 = client.getAllStatesForProjectAsync("/project-b", idFor("/project-b"));
      expect(p1).toBe(p2);
      expect(p3).not.toBe(p1);

      await tick();
      const reqA = h(0)
        .getAllRequests()
        .filter((r: any) => r.type === "get-all-states");
      expect(reqA).toHaveLength(1);
      h(0).resolveRequest(reqA[0].requestId, { states: [{ id: "wt-a" }] });
      const reqB = h(1)
        .getAllRequests()
        .filter((r: any) => r.type === "get-all-states");
      expect(reqB).toHaveLength(1);
      h(1).resolveRequest(reqB[0].requestId, { states: [{ id: "wt-b" }] });

      expect(await p1).toEqual([{ id: "wt-a" }]);
      expect(await p3).toEqual([{ id: "wt-b" }]);
    });
  });

  // #11650. Hydration cannot read an empty list as "this folder has no
  // repository" — the same `[]` also means "no host yet" and "readiness gate
  // timed out". These cases pin which of those the envelope distinguishes.
  describe("getAllStatesWithGitBackedForProjectAsync", () => {
    const idFor = (p: string) => `id-for-${path.resolve(p)}`;

    it("passes the host's verdict through beside the states", async () => {
      const loadA = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await loadA;

      const resultPromise = client.getAllStatesWithGitBackedForProjectAsync(
        "/project-a",
        idFor("/project-a")
      );
      await tick();
      const req = h(0)
        .getAllRequests()
        .find((r: any) => r.type === "get-all-states")!;
      h(0).resolveRequest(req.requestId, { states: [], gitBacked: false });

      expect(await resultPromise).toEqual({ states: [], gitBacked: false });
    });

    // The distinction the whole fix rests on: same empty list, opposite verdict.
    it("reports unknown, not false, when no host has classified the path", async () => {
      const loadA = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await loadA;

      const callsBefore = h(0).sendWithResponse.mock.calls.length;
      const result = await client.getAllStatesWithGitBackedForProjectAsync(
        "/no-such-project",
        idFor("/no-such-project")
      );
      expect(result).toEqual({ states: [], gitBacked: null });
      expect(h(0).sendWithResponse.mock.calls.length).toBe(callsBefore);
    });

    // A host predating the field omits it. Degrading to `null` keeps the
    // permissive #11234 path; a `false` here would strip a real repo's state.
    it("reports unknown when the host omits the field", async () => {
      const loadA = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await loadA;

      const resultPromise = client.getAllStatesWithGitBackedForProjectAsync(
        "/project-a",
        idFor("/project-a")
      );
      await tick();
      const req = h(0)
        .getAllRequests()
        .find((r: any) => r.type === "get-all-states")!;
      h(0).resolveRequest(req.requestId, { states: [{ id: "wt-a" }] });

      expect(await resultPromise).toEqual({ states: [{ id: "wt-a" }], gitBacked: null });
    });

    // The array-shaped method hands the same promise back to concurrent callers
    // and several tests above assert that identity. Deriving one method from the
    // other with `.then()` would quietly break it, so the two coalesce apart.
    it("does not disturb the array-shaped method's promise identity", async () => {
      const loadA = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await loadA;

      void client.getAllStatesWithGitBackedForProjectAsync("/project-a", idFor("/project-a"));
      const p1 = client.getAllStatesForProjectAsync("/project-a", idFor("/project-a"));
      const p2 = client.getAllStatesForProjectAsync("/project-a", idFor("/project-a"));
      expect(p2).toBe(p1);

      await tick();
      for (const req of h(0)
        .getAllRequests()
        .filter((r: any) => r.type === "get-all-states")) {
        h(0).resolveRequest(req.requestId, { states: [{ id: "wt-a" }], gitBacked: true });
      }
      expect(await p1).toEqual([{ id: "wt-a" }]);
    });
  });

  describe("singleflight cache", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    async function readyAndResolveLoadFake(hostIndex: number): Promise<void> {
      h(hostIndex).simulateReady();
      await vi.advanceTimersByTimeAsync(0);
      const req = h(hostIndex).getLastRequest()!;
      h(hostIndex).resolveRequest(req.requestId);
      await vi.advanceTimersByTimeAsync(0);
    }

    it("concurrent calls return the same Promise", async () => {
      const load = client.loadProject("/project-a", 1);
      await readyAndResolveLoadFake(0);
      await load;

      const p1 = client.getAllStatesAsync(1);
      const p2 = client.getAllStatesAsync(1);
      expect(p1).toBe(p2);

      await vi.advanceTimersByTimeAsync(0);
      const req = h(0).getLastRequest()!;
      expect(h(0).sendWithResponse).toHaveBeenCalledTimes(2); // 1 load + 1 get-all-states
      h(0).resolveRequest(req.requestId, { states: [{ id: "wt-1" }] });

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toEqual([{ id: "wt-1" }]);
      expect(r2).toEqual([{ id: "wt-1" }]);
    });

    it("creates new Promise after TTL expires", async () => {
      const load = client.loadProject("/project-a", 1);
      await readyAndResolveLoadFake(0);
      await load;

      const p1 = client.getAllStatesAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      const req1 = h(0).getLastRequest()!;
      h(0).resolveRequest(req1.requestId, { states: [{ id: "wt-1" }] });
      await vi.advanceTimersByTimeAsync(0);

      // Before TTL: same Promise
      const p2 = client.getAllStatesAsync(1);
      expect(p2).toBe(p1);

      // Advance past TTL
      await vi.advanceTimersByTimeAsync(150);

      // After TTL: new Promise
      const p3 = client.getAllStatesAsync(1);
      expect(p3).not.toBe(p1);

      await vi.advanceTimersByTimeAsync(0);
      const req2 = h(0).getLastRequest()!;
      h(0).resolveRequest(req2.requestId, { states: [{ id: "wt-2" }] });
      const r3 = await p3;
      expect(r3).toEqual([{ id: "wt-2" }]);
    });

    it("evicts immediately on error allowing retry", async () => {
      const load = client.loadProject("/project-a", 1);
      await readyAndResolveLoadFake(0);
      await load;

      const p1 = client.getAllStatesAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      const req1 = h(0).getLastRequest()!;
      h(0).rejectRequest(req1.requestId, new Error("host crashed"));
      await expect(p1).rejects.toThrow("host crashed");

      // Immediately after error: new Promise (not cached)
      const p2 = client.getAllStatesAsync(1);
      expect(p2).not.toBe(p1);

      await vi.advanceTimersByTimeAsync(0);
      const req2 = h(0).getLastRequest()!;
      h(0).resolveRequest(req2.requestId, { states: [{ id: "wt-ok" }] });
      const r2 = await p2;
      expect(r2).toEqual([{ id: "wt-ok" }]);
    });

    it("project-scoped cache also expires after TTL", async () => {
      const load = client.loadProject("/project-a", 1);
      await readyAndResolveLoadFake(0);
      await load;

      const projectId = `id-for-${path.resolve("/project-a")}`;
      const p1 = client.getAllStatesForProjectAsync("/project-a", projectId);
      await vi.advanceTimersByTimeAsync(0);
      const req1 = h(0)
        .getAllRequests()
        .filter((r: any) => r.type === "get-all-states")[0];
      h(0).resolveRequest(req1.requestId, { states: [{ id: "wt-1" }] });
      await vi.advanceTimersByTimeAsync(0);

      // Before TTL: same Promise
      const p2 = client.getAllStatesForProjectAsync("/project-a", projectId);
      expect(p2).toBe(p1);

      // After TTL: new Promise, new host request
      await vi.advanceTimersByTimeAsync(150);
      const p3 = client.getAllStatesForProjectAsync("/project-a", projectId);
      expect(p3).not.toBe(p1);

      await vi.advanceTimersByTimeAsync(0);
      const req2 = h(0)
        .getAllRequests()
        .filter((r: any) => r.type === "get-all-states")[1];
      h(0).resolveRequest(req2.requestId, { states: [{ id: "wt-2" }] });
      expect(await p3).toEqual([{ id: "wt-2" }]);
    });

    it("different windowIds get separate cache entries", async () => {
      const load1 = client.loadProject("/project-a", 1);
      await readyAndResolveLoadFake(0);
      await load1;

      const load2 = client.loadProject("/project-b", 2);
      await readyAndResolveLoadFake(1);
      await load2;

      const p1 = client.getAllStatesAsync(1);
      const p2 = client.getAllStatesAsync(2);
      expect(p1).not.toBe(p2);

      await vi.advanceTimersByTimeAsync(0);
      const req1 = h(0).getLastRequest()!;
      const req2 = h(1).getLastRequest()!;
      h(0).resolveRequest(req1.requestId, { states: [{ id: "wt-a" }] });
      h(1).resolveRequest(req2.requestId, { states: [{ id: "wt-b" }] });

      expect(await p1).toEqual([{ id: "wt-a" }]);
      expect(await p2).toEqual([{ id: "wt-b" }]);
    });

    it("no-windowId path fans out to all hosts in parallel", async () => {
      const load1 = client.loadProject("/project-a", 1);
      await readyAndResolveLoadFake(0);
      await load1;

      const load2 = client.loadProject("/project-b", 2);
      await readyAndResolveLoadFake(1);
      await load2;

      const callsBefore0 = h(0).sendWithResponse.mock.calls.length;
      const callsBefore1 = h(1).sendWithResponse.mock.calls.length;

      const statesPromise = client.getAllStatesAsync();
      await vi.advanceTimersByTimeAsync(0);

      // Both hosts received requests before either resolves
      expect(h(0).sendWithResponse.mock.calls.length).toBe(callsBefore0 + 1);
      expect(h(1).sendWithResponse.mock.calls.length).toBe(callsBefore1 + 1);

      const reqA = h(0).getLastRequest()!;
      const reqB = h(1).getLastRequest()!;
      h(0).resolveRequest(reqA.requestId, { states: [{ id: "wt-a" }] });
      h(1).resolveRequest(reqB.requestId, { states: [{ id: "wt-b" }] });

      const result = await statesPromise;
      expect(result).toHaveLength(2);
      expect(result.map((s: any) => s.id)).toEqual(["wt-a", "wt-b"]);
    });
  });

  describe("blue-green swap", () => {
    it("does not release old host until new host is ready", async () => {
      // Load project A on window 1
      const load1 = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load1;

      // Start switching to project B — do NOT resolve yet
      const load2 = client.loadProject("/project-b", 1);
      expect(mockHosts).toHaveLength(2);

      // During init, old host should NOT be disposed
      expect(h(0).dispose).not.toHaveBeenCalled();

      // Window should still be mapped to project A during the swap
      const statesPromise = client.getAllStatesAsync(1);
      await tick();
      const req = h(0).getLastRequest()!;
      expect(req.type).toBe("get-all-states");
      h(0).resolveRequest(req.requestId, { states: [{ id: "wt-a" }] });
      const result = await statesPromise;
      expect(result).toHaveLength(1);

      // Now complete the new host init
      await readyAndResolveLoad(1);
      await load2;

      // After swap, window should now route to project B
      const statesPromise2 = client.getAllStatesAsync(1);
      await tick();
      const req2 = h(1).getLastRequest()!;
      expect(req2.type).toBe("get-all-states");
      h(1).resolveRequest(req2.requestId, { states: [{ id: "wt-b" }] });
      const result2 = await statesPromise2;
      expect(result2).toHaveLength(1);
      expect(result2[0].id).toBe("wt-b");
    });

    it("preserves old project when new host init fails", async () => {
      // Load project A on window 1
      const load1 = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load1;

      // Start switching to project B
      const load2 = client.loadProject("/project-b", 1);
      expect(mockHosts).toHaveLength(2);

      // Simulate ready, then reject the load-project request
      h(1).simulateReady();
      await tick();
      const req = h(1).getLastRequest()!;
      expect(req.type).toBe("load-project");
      h(1).rejectRequest(req.requestId, new Error("Load failed"));

      await expect(load2).rejects.toThrow("Load failed");

      // Window should still route to project A (blue-green: old host preserved)
      const statesPromise = client.getAllStatesAsync(1);
      await tick();
      const statesReq = h(0).getLastRequest()!;
      expect(statesReq.type).toBe("get-all-states");
      h(0).resolveRequest(statesReq.requestId, { states: [{ id: "wt-a" }] });
      const result = await statesPromise;
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("wt-a");

      // Old host should NOT be disposed
      expect(h(0).dispose).not.toHaveBeenCalled();
    });

    it("handles rapid A→B→C switching — B is discarded", async () => {
      // Load project A
      const load1 = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load1;

      // Start switch to B (don't resolve yet)
      const load2 = client.loadProject("/project-b", 1);
      expect(mockHosts).toHaveLength(2);

      // Start switch to C before B finishes
      const load3 = client.loadProject("/project-c", 1);
      expect(mockHosts).toHaveLength(3);

      // Resolve B first — B completes and window routes to B
      await readyAndResolveLoad(1);
      await load2;

      // Then resolve C — C completes and window switches from B to C
      await readyAndResolveLoad(2);
      await load3;

      // B's host gets scheduled for cleanup (grace timeout) since no windows reference it
      // Window should route to project C (last loadProject wins)
      const statesPromise = client.getAllStatesAsync(1);
      await tick();
      const req = h(2).getLastRequest()!;
      expect(req.type).toBe("get-all-states");
      h(2).resolveRequest(req.requestId, { states: [{ id: "wt-c" }] });
      const result = await statesPromise;
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("wt-c");
    });
  });

  describe("host event routing", () => {
    it("does not relay worktree-update to renderers (delivered via the per-view port)", async () => {
      // The workspace host fans worktree-update directly to each per-view
      // worktree MessagePort; a second main-relayed events:push copy doubled
      // the renderer-bound serialization for the heaviest worktree stream.
      const wc = createMockWebContents();

      const load = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load;
      client.attachDirectPort(1, wc as any);

      h(0).emit("host-event", {
        type: "worktree-update",
        worktree: { id: "wt-1", path: "/a/wt", name: "wt", branch: "main" },
      });

      expect(wc.send).not.toHaveBeenCalled();
    });

    it("emits top-level worktree-update event so plugin subscribers can observe", async () => {
      const load = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load;

      const listener = vi.fn();
      client.on("worktree-update", listener);

      h(0).emit("host-event", {
        type: "worktree-update",
        worktree: { id: "wt-1", path: "/a/wt", name: "wt", branch: "main" },
      });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({
        worktree: expect.objectContaining({ id: "wt-1" }),
        projectPath: path.resolve("/project-a"),
      });
    });

    it("emits top-level worktree-removed event when a worktree is removed", async () => {
      const load = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load;

      const listener = vi.fn();
      client.on("worktree-removed", listener);

      h(0).emit("host-event", {
        type: "worktree-removed",
        worktreeId: "wt-1",
      });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({
        worktreeId: "wt-1",
        projectPath: path.resolve("/project-a"),
      });
    });

    it("emits the plugin-bus worktree-activated exactly once for a non-silent activation (#9945)", async () => {
      const load = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load;

      const listener = vi.fn();
      client.on("worktree-activated", listener);

      // Non-silent Main-originated activation (the githubWorkIssue path).
      const activatePromise = client.setActiveWorktree("wt-1", 1);
      await tick();
      const setActiveReq = h(0)
        .getAllRequests()
        .find((r) => r.type === "set-active");
      expect(setActiveReq).toBeDefined();
      // The host's silent flag must propagate so the router can gate on it.
      expect(setActiveReq).toMatchObject({ silent: undefined });
      h(0).resolveRequest(setActiveReq!.requestId, { success: true });
      await activatePromise;

      // WorkspaceClient itself must NOT emit on the plugin bus — that was the
      // duplicate source. At this point (before the host round-trip) the bus is
      // silent.
      expect(listener).not.toHaveBeenCalled();

      // The host always round-trips a `worktree-activated` event for every
      // successful set-active; the router is the SOLE plugin-bus source.
      h(0).emit("host-event", {
        type: "worktree-activated",
        worktreeId: "wt-1",
        silent: undefined,
      });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({
        worktreeId: "wt-1",
        projectPath: path.resolve("/project-a"),
      });
    });

    it("does not emit worktree-activated when setActiveWorktree is silent", async () => {
      const load = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load;

      const listener = vi.fn();
      client.on("worktree-activated", listener);

      const activatePromise = client.setActiveWorktree("wt-1", 1, { silent: true });
      await tick();
      const setActiveReq = h(0)
        .getAllRequests()
        .find((r) => r.type === "set-active");
      // The silent flag must reach the host so its round-trip event carries it
      // and the router suppresses the bus emit.
      expect(setActiveReq).toMatchObject({ silent: true });
      h(0).resolveRequest(setActiveReq!.requestId, { success: true });
      await activatePromise;

      // Router suppresses the silent host round-trip too.
      h(0).emit("host-event", {
        type: "worktree-activated",
        worktreeId: "wt-1",
        silent: true,
      });

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("early windowId detachment during project switch", () => {
    it("prevents old host events from reaching renderer during new host init", async () => {
      const wcA = createMockWebContents();

      // Load project A
      const load1 = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load1;
      client.attachDirectPort(1, wcA as any);

      // Start switching to project B (don't resolve yet)
      const load2 = client.loadProject("/project-b", 1);
      expect(mockHosts).toHaveLength(2);

      // Window stays mapped to project A during B's init (blue-green: old host
      // continues serving until new host is ready). Events from A still reach
      // the renderer via directPortViews — this is by design for reliability.
      wcA.send.mockClear();
      h(0).emit("host-event", { type: "worktree-removed", worktreeId: "wt-a" });

      expect(wcA.send).toHaveBeenCalled();

      // Complete B's init — window now routes to B
      await readyAndResolveLoad(1);
      await load2;

      // After swap, old host A events should no longer reach the view
      // because releaseOldProject cleaned up directPortViews for destroyed entries.
      // Note: wcA is still in entryA.directPortViews (it's not destroyed), so
      // events still reach it — but they only go to project A's own view, not B's.
      const wcB = createMockWebContents();
      client.attachDirectPort(1, wcB as any);

      wcB.send.mockClear();
      h(0).emit("host-event", { type: "worktree-removed", worktreeId: "wt-a2" });

      // Project A's events should NOT reach project B's view
      expect(wcB.send).not.toHaveBeenCalled();
    });

    it("restores old host event routing when new host init fails", async () => {
      const wcA = createMockWebContents();

      // Load project A
      const load1 = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load1;
      client.attachDirectPort(1, wcA as any);

      // Start switching to project B
      const load2 = client.loadProject("/project-b", 1);

      // Fail B's init
      h(1).simulateReady();
      await tick();
      const req = h(1).getLastRequest()!;
      h(1).rejectRequest(req.requestId, new Error("Init failed"));
      await expect(load2).rejects.toThrow("Init failed");

      // Old host (A) events should work — wcA is still in entryA.directPortViews
      wcA.send.mockClear();
      h(0).emit("host-event", { type: "worktree-removed", worktreeId: "wt-a" });

      expect(wcA.send).toHaveBeenCalled();
    });

    it("A→B→A cached reactivation: B events do not reach A view", async () => {
      const wcA = createMockWebContents();
      const wcB = createMockWebContents();

      // Load project A in window 1
      const load1 = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load1;
      client.attachDirectPort(1, wcA as any);

      // Switch window 1 to project B
      const load2 = client.loadProject("/project-b", 1);
      await readyAndResolveLoad(1);
      await load2;
      client.attachDirectPort(1, wcB as any);

      // Switch window 1 back to project A (cached reactivation)
      // loadProject finds the existing entryA, re-attaches window 1
      await client.loadProject("/project-a", 1);
      // Re-attach direct port for A (simulates what projectCrud does)
      client.attachDirectPort(1, wcA as any);

      wcA.send.mockClear();
      wcB.send.mockClear();

      // Project B emits an event — should NOT reach A's view
      h(1).emit("host-event", { type: "worktree-removed", worktreeId: "wt-b" });

      expect(wcA.send).not.toHaveBeenCalled();
      // B's view should still get its own events via directPortViews
      expect(wcB.send).toHaveBeenCalled();

      // Project A emits an event — should reach A's view
      wcA.send.mockClear();
      h(0).emit("host-event", { type: "worktree-removed", worktreeId: "wt-a" });

      expect(wcA.send).toHaveBeenCalled();
      expect(wcB.send).toHaveBeenCalledTimes(1); // only the earlier B event
    });

    it("loadProject resolves without error", async () => {
      const load = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await expect(load).resolves.toBeUndefined();
    });
  });

  describe("broadcast methods", () => {
    it("pauseHealthCheck fans out to all hosts", async () => {
      const load1 = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load1;

      const load2 = client.loadProject("/project-b", 2);
      await readyAndResolveLoad(1);
      await load2;

      client.pauseHealthCheck();

      expect(h(0).pauseHealthCheck).toHaveBeenCalled();
      expect(h(1).pauseHealthCheck).toHaveBeenCalled();
    });

    it("updateForgeCredentials sends to all hosts", async () => {
      const load1 = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load1;

      client.updateForgeCredentials("daintree.github.github", {
        kind: "bearer",
        value: "test-token",
      });

      expect(h(0).send).toHaveBeenCalledWith({
        type: "update-forge-credentials",
        providerId: "daintree.github.github",
        credentials: { kind: "bearer", value: "test-token" },
      });
    });

    it("updateForgeCredentials propagates null credentials", async () => {
      const load1 = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load1;

      client.updateForgeCredentials("daintree.github.github", null);

      expect(h(0).send).toHaveBeenCalledWith({
        type: "update-forge-credentials",
        providerId: "daintree.github.github",
        credentials: null,
      });
    });
  });

  describe("dispose", () => {
    it("disposes all host processes", async () => {
      const load1 = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load1;

      const load2 = client.loadProject("/project-b", 2);
      await readyAndResolveLoad(1);
      await load2;

      client.dispose();

      expect(h(0).dispose).toHaveBeenCalled();
      expect(h(1).dispose).toHaveBeenCalled();
    });

    it("rejects loadProject after dispose", async () => {
      client.dispose();
      await expect(client.loadProject("/project-a", 1)).rejects.toThrow("disposed");
    });
  });

  describe("isReady", () => {
    it("returns true when no entries exist and not disposed", () => {
      expect(client.isReady()).toBe(true);
    });

    it("returns false after dispose", () => {
      client.dispose();
      expect(client.isReady()).toBe(false);
    });

    it("returns true when at least one host is ready", async () => {
      const load = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load;

      expect(client.isReady()).toBe(true);
    });
  });

  describe("resolveHostForPath", () => {
    it("routes listBranches to the correct host by path", async () => {
      const load1 = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load1;

      const load2 = client.loadProject("/project-b", 2);
      await readyAndResolveLoad(1);
      await load2;

      const branchesPromise = client.listBranches("/project-a");
      await tick();
      const req = h(0).getLastRequest()!;
      expect(req.type).toBe("list-branches");
      h(0).resolveRequest(req.requestId, { branches: [{ name: "main" }] });

      const result = await branchesPromise;
      expect(result).toHaveLength(1);

      const hostBReqs = h(1)
        .getAllRequests()
        .filter((r: any) => r.type === "list-branches");
      expect(hostBReqs).toHaveLength(0);
    });

    it("resolves child paths to parent project host", async () => {
      const load = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load;

      const branchesPromise = client.listBranches("/project-a/worktrees/feature-1");
      await tick();
      const req = h(0).getLastRequest()!;
      expect(req.type).toBe("list-branches");
      h(0).resolveRequest(req.requestId, { branches: [] });

      await branchesPromise;
    });
  });

  describe("restart recovery", () => {
    it("re-sends loadProject after host restart", async () => {
      const load = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load;

      // Simulate restart — host is already "ready" from simulateReady
      h(0).emit("restarted");

      await vi.waitFor(() => {
        const reqs = h(0)
          .getAllRequests()
          .filter((r: any) => r.type === "load-project");
        expect(reqs).toHaveLength(2);
      });

      const reloadReq = h(0)
        .getAllRequests()
        .filter((r: any) => r.type === "load-project")[1];
      expect(reloadReq.rootPath).toBe(path.resolve("/project-a"));
    });

    it("forwards the selected forgeRemote on the post-restart load-project (#8456)", async () => {
      vi.mocked(projectStore.getProjectSettings).mockResolvedValue({
        runCommands: [],
        forgeRemote: "upstream",
      } as any);

      const load = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load;

      h(0).emit("restarted");

      await vi.waitFor(() => {
        const reqs = h(0)
          .getAllRequests()
          .filter((r: any) => r.type === "load-project");
        expect(reqs).toHaveLength(2);
      });

      const reloadReq = h(0)
        .getAllRequests()
        .filter((r: any) => r.type === "load-project")[1];
      expect(reloadReq.forgeRemote).toBe("upstream");

      vi.mocked(projectStore.getProjectSettings).mockResolvedValue({ runCommands: [] } as any);
    });
  });

  describe("manualRestartForWindow", () => {
    it("resolves the window's host and invokes manualRestart", async () => {
      const load = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load;

      client.manualRestartForWindow(1);

      expect(h(0).manualRestart).toHaveBeenCalledTimes(1);
    });

    it("triggers reloadProjectAfterRestart via the emitted 'restarted' event", async () => {
      const load = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load;

      client.manualRestartForWindow(1);

      // The mock's manualRestart() emits "restarted"; the real
      // WorkspaceClient listener should enqueue a fresh load-project.
      await vi.waitFor(() => {
        const reqs = h(0)
          .getAllRequests()
          .filter((r: any) => r.type === "load-project");
        expect(reqs).toHaveLength(2);
      });
    });

    it("no-ops when the window has no associated project", () => {
      // No loadProject — window is not tracked.
      expect(() => client.manualRestartForWindow(999)).not.toThrow();
      expect(mockHosts).toHaveLength(0);
    });
  });

  describe("host-disconnected broadcast", () => {
    it("broadcasts WORKTREE_HOST_DISCONNECTED to affected views when host emits host-recovering", async () => {
      const wc = createMockWebContents();

      const load = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load;
      client.attachDirectPort(1, wc as any);

      wc.send.mockClear();
      h(0).emit("host-recovering", 1);

      expect(wc.send).toHaveBeenCalledWith("worktree:host-disconnected", { fatal: false });
    });

    it("does not broadcast host-recovering to views of other projects", async () => {
      const wcA = createMockWebContents();
      const wcB = createMockWebContents();

      const load1 = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load1;
      client.attachDirectPort(1, wcA as any);

      const load2 = client.loadProject("/project-b", 2);
      await readyAndResolveLoad(1);
      await load2;
      client.attachDirectPort(2, wcB as any);

      wcA.send.mockClear();
      wcB.send.mockClear();

      h(0).emit("host-recovering", 1);

      expect(wcA.send).toHaveBeenCalledWith("worktree:host-disconnected", { fatal: false });
      expect(wcB.send).not.toHaveBeenCalled();
    });

    it("broadcasts fatal: true on host-crash (max retries exhausted)", async () => {
      const wc = createMockWebContents();

      const load = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load;
      client.attachDirectPort(1, wc as any);

      wc.send.mockClear();
      h(0).emit("host-crash", 137);

      expect(wc.send).toHaveBeenCalledWith("worktree:host-disconnected", { fatal: true });
    });
  });

  describe("setActiveWorktree", () => {
    it("emits WORKTREE_ACTIVATED by default", async () => {
      const wc = createMockWebContents();

      const load = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load;
      client.attachDirectPort(1, wc as any);

      const setActivePromise = client.setActiveWorktree("wt-1", 1);
      await tick();
      const req = h(0).getLastRequest()!;
      h(0).resolveRequest(req.requestId);
      await setActivePromise;

      expect(wc.send).toHaveBeenCalledWith("worktree:activated", {
        worktreeId: "wt-1",
      });
    });

    it("does NOT emit WORKTREE_ACTIVATED when silent: true", async () => {
      const wc = createMockWebContents();

      const load = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load;
      client.attachDirectPort(1, wc as any);

      const setActivePromise = client.setActiveWorktree("wt-1", 1, { silent: true });
      await tick();
      const req = h(0).getLastRequest()!;
      h(0).resolveRequest(req.requestId);
      await setActivePromise;

      expect(wc.send).not.toHaveBeenCalled();
    });

    it("does NOT emit WORKTREE_ACTIVATED when all hosts reject", async () => {
      const wc = createMockWebContents();

      const load = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load;
      client.attachDirectPort(1, wc as any);

      // Make sendWithResponse reject for set-active
      h(0).sendWithResponse.mockImplementationOnce(() => {
        return Promise.reject(new Error("Worktree not found"));
      });

      await client.setActiveWorktree("wt-nonexistent", 1);

      expect(wc.send).not.toHaveBeenCalled();
    });
  });

  describe("worktree path routing", () => {
    it("routes via worktreePathToProject reverse map for sibling worktrees", async () => {
      const load = client.loadProject("/repos/app", 1);
      await readyAndResolveLoad(0);
      await load;

      // Simulate worktree-update event that populates the reverse map
      h(0).emit("host-event", {
        type: "worktree-update",
        worktree: {
          id: "wt-feat",
          path: "/repos/app-worktrees/feature-1",
          name: "feature-1",
          branch: "feature-1",
        },
      });

      // Now resolve a path-based call to the sibling worktree
      const branchesPromise = client.listBranches("/repos/app-worktrees/feature-1");
      await tick();
      const req = h(0).getLastRequest()!;
      expect(req.type).toBe("list-branches");
      h(0).resolveRequest(req.requestId, { branches: [{ name: "feature-1" }] });

      const result = await branchesPromise;
      expect(result).toHaveLength(1);
    });

    it("does not route to wrong host when multiple projects exist", async () => {
      const load1 = client.loadProject("/repos/app-a", 1);
      await readyAndResolveLoad(0);
      await load1;

      const load2 = client.loadProject("/repos/app-b", 2);
      await readyAndResolveLoad(1);
      await load2;

      // Unknown path with multiple hosts should return undefined (not fall back)
      const result = await client.listBranches("/repos/unknown-project").catch(() => []);
      expect(result).toEqual([]);
    });
  });

  describe("warm cache LRU eviction", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Ready + resolve using fake timers. */
    async function readyAndResolveLoadFake(hostIndex: number): Promise<void> {
      h(hostIndex).simulateReady();
      await vi.advanceTimersByTimeAsync(0);
      const req = h(hostIndex).getLastRequest()!;
      h(hostIndex).resolveRequest(req.requestId);
      await vi.advanceTimersByTimeAsync(0);
    }

    it("grace period: host not disposed before 180s, disposed at 180s", async () => {
      const load = client.loadProject("/project-a", 1);
      await readyAndResolveLoadFake(0);
      await load;

      // Unregister the window — entry becomes dormant
      client.unregisterWindow(1);

      // Just before 180s — host should still be alive
      await vi.advanceTimersByTimeAsync(179_999);
      expect(h(0).dispose).not.toHaveBeenCalled();

      // At 180s — host should be disposed
      await vi.advanceTimersByTimeAsync(1);
      expect(h(0).dispose).toHaveBeenCalledTimes(1);
    });

    it("warm reuse: switch A→B→A within grace reuses host A", async () => {
      // Load A on window 1
      const loadA = client.loadProject("/project-a", 1);
      await readyAndResolveLoadFake(0);
      await loadA;

      // Switch to B — A becomes dormant
      const loadB = client.loadProject("/project-b", 1);
      await readyAndResolveLoadFake(1);
      await loadB;

      expect(mockHosts).toHaveLength(2);

      // Switch back to A within grace — should reuse, no new host
      const loadA2 = client.loadProject("/project-a", 1);
      await loadA2;

      expect(mockHosts).toHaveLength(2); // No 3rd host created
      expect(h(0).dispose).not.toHaveBeenCalled(); // A was not disposed
    });

    it("LRU cap: 4th dormant entry evicts the LRU", async () => {
      // Load 4 projects on separate windows, then release them in order
      for (let i = 0; i < 4; i++) {
        const load = client.loadProject(`/project-${i}`, i + 1);
        await readyAndResolveLoadFake(i);
        await load;
      }

      // Release windows in order: 1, 2, 3, 4 → projects 0, 1, 2, 3 become dormant
      client.unregisterWindow(1); // project-0 dormant (LRU)
      client.unregisterWindow(2); // project-1 dormant
      client.unregisterWindow(3); // project-2 dormant
      // At this point: 3 dormant entries (0, 1, 2) — at cap
      expect(h(0).dispose).not.toHaveBeenCalled();

      client.unregisterWindow(4); // project-3 dormant → 4 dormant, cap breached
      // project-0 should have been evicted (first dormant in Map order = LRU)
      expect(h(0).dispose).toHaveBeenCalledTimes(1);
      // Others should still be alive
      expect(h(1).dispose).not.toHaveBeenCalled();
      expect(h(2).dispose).not.toHaveBeenCalled();
      expect(h(3).dispose).not.toHaveBeenCalled();
    });

    it("LRU promotion: reactivated entry is not the eviction target", async () => {
      // Load A, B, C on separate windows
      for (let i = 0; i < 3; i++) {
        const load = client.loadProject(`/project-${String.fromCharCode(97 + i)}`, i + 1);
        await readyAndResolveLoadFake(i);
        await load;
      }

      // Make all dormant: A, B, C (in that order)
      client.unregisterWindow(1); // A dormant (LRU)
      client.unregisterWindow(2); // B dormant
      client.unregisterWindow(3); // C dormant

      // Reactivate A — promotes it to MRU
      const reloadA = client.loadProject("/project-a", 4);
      await reloadA;
      expect(h(0).dispose).not.toHaveBeenCalled();

      // Now release window 4 to make A dormant again (but it's MRU now)
      client.unregisterWindow(4);

      // Load D on window 5 → D is active, A/B/C are dormant → cap at 3, no eviction yet
      const loadD = client.loadProject("/project-d", 5);
      await readyAndResolveLoadFake(3);
      await loadD;

      // Release D → 4 dormant entries. B should be evicted (oldest dormant, not A)
      client.unregisterWindow(5);
      expect(h(0).dispose).not.toHaveBeenCalled(); // A was promoted, not LRU
      expect(h(1).dispose).toHaveBeenCalledTimes(1); // B is evicted (LRU)
      expect(h(2).dispose).not.toHaveBeenCalled();
      expect(h(3).dispose).not.toHaveBeenCalled();
    });

    it("active entries are never evicted regardless of cap", async () => {
      // Load 4 projects, all active (each on its own window)
      for (let i = 0; i < 4; i++) {
        const load = client.loadProject(`/project-${i}`, i + 1);
        await readyAndResolveLoadFake(i);
        await load;
      }

      // All 4 active — no evictions should happen
      expect(h(0).dispose).not.toHaveBeenCalled();
      expect(h(1).dispose).not.toHaveBeenCalled();
      expect(h(2).dispose).not.toHaveBeenCalled();
      expect(h(3).dispose).not.toHaveBeenCalled();

      // Make project-0 dormant — now 1 dormant + 3 active, under cap
      client.unregisterWindow(1);
      expect(h(0).dispose).not.toHaveBeenCalled();
    });

    it("dispose clears pending grace timers — no delayed disposals fire", async () => {
      const load = client.loadProject("/project-a", 1);
      await readyAndResolveLoadFake(0);
      await load;

      // Make dormant — starts 180s timer
      client.unregisterWindow(1);
      expect(h(0).dispose).not.toHaveBeenCalled();

      // Dispose the client — should clear the timer and dispose immediately
      client.dispose();
      expect(h(0).dispose).toHaveBeenCalledTimes(1);

      // Advance past the grace period — dispose should NOT be called again
      await vi.advanceTimersByTimeAsync(200_000);
      expect(h(0).dispose).toHaveBeenCalledTimes(1);
    });
  });
});
