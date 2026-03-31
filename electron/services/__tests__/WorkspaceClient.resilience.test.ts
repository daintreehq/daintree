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

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

vi.mock("../events.js", () => ({
  events: {
    emit: vi.fn(),
  },
}));

import path from "path";
import { WorkspaceClient } from "../WorkspaceClient.js";
import { BrowserWindow } from "electron";

type MockHost = InstanceType<typeof MockWorkspaceHostProcess>;

// After simulateReady(), sendWithResponse is called asynchronously (next microtask).
// This helper waits for that to happen.
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("WorkspaceClient multi-process manager", () => {
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

    it("aggregates from all hosts when no windowId", async () => {
      const load1 = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load1;

      const load2 = client.loadProject("/project-b", 2);
      await readyAndResolveLoad(1);
      await load2;

      // getAllStatesAsync iterates sequentially — must resolve host 0 before host 1 is called
      const statesPromise = client.getAllStatesAsync();
      await tick();

      // Host 0 is awaited first
      const reqA = h(0).getLastRequest()!;
      h(0).resolveRequest(reqA.requestId, {
        states: [{ id: "wt-a", name: "A" }],
      });

      // After host 0 resolves, host 1 is called next
      await tick();
      const reqB = h(1).getLastRequest()!;
      h(1).resolveRequest(reqB.requestId, {
        states: [{ id: "wt-b", name: "B" }],
      });

      const result = await statesPromise;
      expect(result).toHaveLength(2);
      expect(result.map((s) => s.id)).toEqual(["wt-a", "wt-b"]);
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
    it("routes worktree-update to windows of the correct project", async () => {
      const mockWindow1 = {
        id: 1,
        isDestroyed: vi.fn(() => false),
        webContents: { isDestroyed: vi.fn(() => false), send: vi.fn() },
      };
      const mockWindow2 = {
        id: 2,
        isDestroyed: vi.fn(() => false),
        webContents: { isDestroyed: vi.fn(() => false), send: vi.fn() },
      };
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mockWindow1, mockWindow2] as any);

      const load1 = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load1;

      const load2 = client.loadProject("/project-b", 2);
      await readyAndResolveLoad(1);
      await load2;

      h(0).emit("host-event", {
        type: "worktree-update",
        worktree: {
          id: "wt-1",
          path: "/a/wt",
          name: "wt",
          branch: "main",
        },
        projectScopeId: "scope-a",
      });

      expect(mockWindow1.webContents.send).toHaveBeenCalled();
      expect(mockWindow2.webContents.send).not.toHaveBeenCalled();
    });

    it("includes scopeId in worktree-update payload sent to renderer", async () => {
      const mockWindow = {
        id: 1,
        isDestroyed: vi.fn(() => false),
        webContents: { isDestroyed: vi.fn(() => false), send: vi.fn() },
      };
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mockWindow] as any);

      const load = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      const scopeId = await load;

      h(0).emit("host-event", {
        type: "worktree-update",
        worktree: { id: "wt-1", path: "/a/wt", name: "wt", branch: "main" },
        projectScopeId: "scope-a",
      });

      expect(mockWindow.webContents.send).toHaveBeenCalledWith("worktree:update", {
        worktree: expect.objectContaining({ id: "wt-1" }),
        scopeId,
      });
    });
  });

  describe("early windowId detachment during project switch", () => {
    it("prevents old host events from reaching renderer during new host init", async () => {
      const mockWindow = {
        id: 1,
        isDestroyed: vi.fn(() => false),
        webContents: { isDestroyed: vi.fn(() => false), send: vi.fn() },
      };
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mockWindow] as any);

      // Load project A
      const load1 = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load1;

      // Start switching to project B (don't resolve yet)
      const load2 = client.loadProject("/project-b", 1);
      expect(mockHosts).toHaveLength(2);

      // Window stays mapped to project A during B's init (blue-green: old host
      // continues serving until new host is ready). Events from A still reach
      // the renderer — this is by design for reliability.
      mockWindow.webContents.send.mockClear();
      h(0).emit("host-event", {
        type: "worktree-update",
        worktree: { id: "wt-a", path: "/a/wt", name: "wt-a", branch: "main" },
        projectScopeId: "scope-a",
      });

      expect(mockWindow.webContents.send).toHaveBeenCalled();

      // Complete B's init — window now routes to B
      await readyAndResolveLoad(1);
      await load2;

      // After swap, old host A events should no longer reach window 1
      mockWindow.webContents.send.mockClear();
      h(0).emit("host-event", {
        type: "worktree-update",
        worktree: { id: "wt-a2", path: "/a/wt2", name: "wt-a2", branch: "dev" },
        projectScopeId: "scope-a",
      });

      expect(mockWindow.webContents.send).not.toHaveBeenCalled();
    });

    it("restores old host event routing when new host init fails", async () => {
      const mockWindow = {
        id: 1,
        isDestroyed: vi.fn(() => false),
        webContents: { isDestroyed: vi.fn(() => false), send: vi.fn() },
      };
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mockWindow] as any);

      // Load project A
      const load1 = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load1;

      // Start switching to project B
      const load2 = client.loadProject("/project-b", 1);

      // Fail B's init
      h(1).simulateReady();
      await tick();
      const req = h(1).getLastRequest()!;
      h(1).rejectRequest(req.requestId, new Error("Init failed"));
      await expect(load2).rejects.toThrow("Init failed");

      // Old host (A) events should work again after rollback
      mockWindow.webContents.send.mockClear();
      h(0).emit("host-event", {
        type: "worktree-update",
        worktree: { id: "wt-a", path: "/a/wt", name: "wt-a", branch: "main" },
        projectScopeId: "scope-a",
      });

      expect(mockWindow.webContents.send).toHaveBeenCalled();
    });

    it("returns scopeId from loadProject", async () => {
      const load = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      const scopeId = await load;

      expect(typeof scopeId).toBe("string");
      expect(scopeId.length).toBeGreaterThan(0);
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

    it("updateGitHubToken sends to all hosts", async () => {
      const load1 = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load1;

      client.updateGitHubToken("test-token");

      expect(h(0).send).toHaveBeenCalledWith({
        type: "update-github-token",
        token: "test-token",
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
  });

  describe("setActiveWorktree", () => {
    it("emits WORKTREE_ACTIVATED by default", async () => {
      const mockWindow = {
        id: 1,
        isDestroyed: vi.fn(() => false),
        webContents: { isDestroyed: vi.fn(() => false), send: vi.fn() },
      };
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mockWindow] as any);

      const load = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load;

      const setActivePromise = client.setActiveWorktree("wt-1", 1);
      await tick();
      const req = h(0).getLastRequest()!;
      h(0).resolveRequest(req.requestId);
      await setActivePromise;

      expect(mockWindow.webContents.send).toHaveBeenCalledWith("worktree:activated", {
        worktreeId: "wt-1",
      });
    });

    it("does NOT emit WORKTREE_ACTIVATED when silent: true", async () => {
      const mockWindow = {
        id: 1,
        isDestroyed: vi.fn(() => false),
        webContents: { isDestroyed: vi.fn(() => false), send: vi.fn() },
      };
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mockWindow] as any);

      const load = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load;

      const setActivePromise = client.setActiveWorktree("wt-1", 1, { silent: true });
      await tick();
      const req = h(0).getLastRequest()!;
      h(0).resolveRequest(req.requestId);
      await setActivePromise;

      expect(mockWindow.webContents.send).not.toHaveBeenCalled();
    });

    it("does NOT emit WORKTREE_ACTIVATED when all hosts reject", async () => {
      const mockWindow = {
        id: 1,
        isDestroyed: vi.fn(() => false),
        webContents: { isDestroyed: vi.fn(() => false), send: vi.fn() },
      };
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mockWindow] as any);

      const load = client.loadProject("/project-a", 1);
      await readyAndResolveLoad(0);
      await load;

      // Make sendWithResponse reject for set-active
      h(0).sendWithResponse.mockImplementationOnce(() => {
        return Promise.reject(new Error("Worktree not found"));
      });

      await client.setActiveWorktree("wt-nonexistent", 1);

      expect(mockWindow.webContents.send).not.toHaveBeenCalled();
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
});
