import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

const forkMock = vi.hoisted(() => vi.fn());
const getAllWindowsMock = vi.hoisted(() => vi.fn(() => []));
const showMessageBoxMock = vi.hoisted(() => vi.fn().mockResolvedValue({ response: 0 }));

class MockUtilityProcess extends EventEmitter {
  postMessage = vi.fn();
  kill = vi.fn();
  pid = 12345;
}

vi.mock("electron", () => ({
  utilityProcess: {
    fork: forkMock,
  },
  UtilityProcess: class {},
  dialog: {
    showMessageBox: showMessageBoxMock,
  },
  app: {
    getPath: vi.fn(() => "/tmp"),
  },
  BrowserWindow: {
    getAllWindows: getAllWindowsMock,
  },
}));

vi.mock("../github/GitHubAuth.js", () => ({
  GitHubAuth: {
    getToken: vi.fn(() => undefined),
  },
}));

import { WorkspaceClient } from "../WorkspaceClient.js";

describe("WorkspaceClient resilience", () => {
  let client: WorkspaceClient;
  let child: MockUtilityProcess;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    child = new MockUtilityProcess();
    forkMock.mockReturnValue(child);

    client = new WorkspaceClient({
      maxRestartAttempts: 0,
      showCrashDialog: false,
      healthCheckIntervalMs: 1000,
    });

    void client.waitForReady().catch(() => {
      // ignore host-ready failures for resilience tests
    });
  });

  afterEach(() => {
    client.dispose();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("rejects immediately when host is not running", async () => {
    child.emit("exit", 1);

    await expect(client.listBranches("/repo")).rejects.toThrow("Workspace Host not running");
    expect(
      (client as never as { pendingRequests: Map<string, unknown> }).pendingRequests.size
    ).toBe(0);
  });

  it("cleans up pending request when postMessage throws", async () => {
    child.postMessage.mockImplementation((request: { type?: string }) => {
      if (request?.type === "dispose") {
        return;
      }
      throw new Error("post failed");
    });

    await expect(client.listBranches("/repo")).rejects.toThrow("post failed");
    expect(
      (client as never as { pendingRequests: Map<string, unknown> }).pendingRequests.size
    ).toBe(0);
  });

  it("rejects waitForReady when disposed before ready", async () => {
    const readyPromise = client.waitForReady();

    client.dispose();

    await expect(readyPromise).rejects.toThrow("disposed");
  });

  it("resumes health checks after ready when resumed before host initialization completes", async () => {
    client.pauseHealthCheck();
    client.resumeHealthCheck();

    child.emit("message", { type: "ready" });
    child.postMessage.mockClear();

    vi.advanceTimersByTime(1001);

    expect(
      child.postMessage.mock.calls.some(
        ([request]) => (request as { type?: string })?.type === "health-check"
      )
    ).toBe(true);
  });

  it("swallows child kill errors during dispose", () => {
    const badChild = child;
    badChild.kill.mockImplementation(() => {
      throw new Error("kill failed");
    });

    expect(() => client.dispose()).not.toThrow();
    expect(() => vi.runAllTimers()).not.toThrow();
  });

  it("times out stalled requests and clears pending state", async () => {
    const request = client.listBranches("/repo");

    vi.advanceTimersByTime(30001);

    await expect(request).rejects.toThrow("Request timeout");
    expect(
      (client as never as { pendingRequests: Map<string, unknown> }).pendingRequests.size
    ).toBe(0);
  });

  it("discards getAllStatesAsync response when project scope changed before response arrives", async () => {
    const clientPrivate = client as never as {
      currentProjectScopeId: string | null;
    };

    clientPrivate.currentProjectScopeId = "scope-project-a";

    // getAllStatesAsync calls sendWithResponse which synchronously calls postMessage
    const getAllPromise = client.getAllStatesAsync();

    // Capture the requestId from the postMessage call
    const lastCall = child.postMessage.mock.calls.at(-1)!;
    const requestId = (lastCall[0] as { requestId: string }).requestId;

    // Simulate project switch: scope is cleared
    clientPrivate.currentProjectScopeId = null;

    // Deliver the stale all-states response
    child.emit("message", {
      type: "all-states",
      requestId,
      states: [{ id: "stale-worktree", name: "Stale Worktree" }],
    });

    const result = await getAllPromise;
    expect(result).toEqual([]);
  });

  it("discards getAllStatesAsync response when scope was null at call time (no project loaded)", async () => {
    const clientPrivate = client as never as {
      currentProjectScopeId: string | null;
    };

    // Scope is null both before and after the request (switch window)
    clientPrivate.currentProjectScopeId = null;

    const getAllPromise = client.getAllStatesAsync();

    const lastCall = child.postMessage.mock.calls.at(-1)!;
    const requestId = (lastCall[0] as { requestId: string }).requestId;

    child.emit("message", {
      type: "all-states",
      requestId,
      states: [{ id: "no-scope-worktree", name: "No Scope Worktree" }],
    });

    const result = await getAllPromise;
    expect(result).toEqual([]);
  });

  it("returns getAllStatesAsync results when project scope is unchanged", async () => {
    const clientPrivate = client as never as {
      currentProjectScopeId: string | null;
    };

    clientPrivate.currentProjectScopeId = "scope-project-a";

    const getAllPromise = client.getAllStatesAsync();

    const lastCall = child.postMessage.mock.calls.at(-1)!;
    const requestId = (lastCall[0] as { requestId: string }).requestId;

    // Scope has NOT changed - deliver a valid response
    child.emit("message", {
      type: "all-states",
      requestId,
      states: [{ id: "valid-worktree", name: "Valid Worktree" }],
    });

    const result = await getAllPromise;
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("valid-worktree");
  });

  describe("loadProject race serialization", () => {
    beforeEach(() => {
      child.emit("message", { type: "ready" });
    });

    it("second loadProject supersedes the first (latest wins)", async () => {
      const p1 = client.loadProject("/project-a");
      const p2 = client.loadProject("/project-b");

      // Capture the scope IDs sent in each request
      const call1 = child.postMessage.mock.calls.at(-2)!;
      const call2 = child.postMessage.mock.calls.at(-1)!;
      const scopeA = (call1[0] as { projectScopeId: string }).projectScopeId;
      const scopeB = (call2[0] as { projectScopeId: string }).projectScopeId;

      // Resolve first call (stale), then second call (current)
      child.emit("message", {
        type: "load-project-result",
        requestId: (call1[0] as { requestId: string }).requestId,
      });
      child.emit("message", {
        type: "load-project-result",
        requestId: (call2[0] as { requestId: string }).requestId,
      });

      await p1;
      await p2;

      const clientPrivate = client as never as {
        currentRootPath: string | null;
        currentProjectScopeId: string | null;
        loadProjectGeneration: number;
      };
      expect(clientPrivate.currentRootPath).toBe("/project-b");
      expect(clientPrivate.currentProjectScopeId).toBe(scopeB);
      expect(clientPrivate.currentProjectScopeId).not.toBe(scopeA);
      expect(clientPrivate.loadProjectGeneration).toBe(2);
    });

    it("restart auto-reload is skipped when superseded by user loadProject", async () => {
      // Give restartClient its own dedicated mock to avoid cross-contamination
      const dedicatedChild = new MockUtilityProcess();
      forkMock.mockReturnValue(dedicatedChild);

      const restartClient = new WorkspaceClient({
        maxRestartAttempts: 1,
        showCrashDialog: false,
        healthCheckIntervalMs: 1000,
      });

      // Make it ready and load a project
      dedicatedChild.emit("message", { type: "ready" });
      const loadCall = restartClient.loadProject("/original-project");
      const origCall = dedicatedChild.postMessage.mock.calls.at(-1)!;
      dedicatedChild.emit("message", {
        type: "load-project-result",
        requestId: (origCall[0] as { requestId: string }).requestId,
      });
      await loadCall;

      // Simulate host crash
      const restartChild2 = new MockUtilityProcess();
      forkMock.mockReturnValue(restartChild2);
      dedicatedChild.emit("exit", 1);

      // User switches project before the restart timer fires
      // We need to advance past the delay first, but the user call happens
      // after the restart timer captures the generation but before waitForReady resolves

      // Advance timer to trigger restart
      vi.advanceTimersByTime(2001);

      // The restart path has captured generationAtRestart and is waiting for ready.
      // Now user switches project before the new host is ready.
      const userLoad = restartClient.loadProject("/user-project");
      const userCall = restartChild2.postMessage.mock.calls.at(-1)!;

      // Make the restarted host ready — this resolves waitForReady in the restart path
      restartChild2.emit("message", { type: "ready" });

      // Resolve the user's loadProject
      restartChild2.emit("message", {
        type: "load-project-result",
        requestId: (userCall[0] as { requestId: string }).requestId,
      });
      await userLoad;

      // Flush microtasks so the restart path .then() runs
      await Promise.resolve();
      await Promise.resolve();

      const clientPrivate = restartClient as never as {
        currentRootPath: string | null;
      };
      // The restart path should have been skipped — user's project wins
      expect(clientPrivate.currentRootPath).toBe("/user-project");

      // The restart path should NOT have issued another loadProject call
      // (only the original load + user load = 2 loadProject calls total)
      const loadProjectCalls = [
        ...dedicatedChild.postMessage.mock.calls,
        ...restartChild2.postMessage.mock.calls,
      ].filter(([msg]) => (msg as { type: string }).type === "load-project");
      expect(loadProjectCalls).toHaveLength(2);

      restartClient.dispose();
    });

    it("restart auto-reload proceeds when not superseded", async () => {
      // Give restartClient its own dedicated mock to avoid cross-contamination
      const dedicatedChild = new MockUtilityProcess();
      forkMock.mockReturnValue(dedicatedChild);

      const restartClient = new WorkspaceClient({
        maxRestartAttempts: 1,
        showCrashDialog: false,
        healthCheckIntervalMs: 1000,
      });

      // Make it ready and load a project
      dedicatedChild.emit("message", { type: "ready" });
      const loadCall = restartClient.loadProject("/my-project");
      const origCall = dedicatedChild.postMessage.mock.calls.at(-1)!;
      dedicatedChild.emit("message", {
        type: "load-project-result",
        requestId: (origCall[0] as { requestId: string }).requestId,
      });
      await loadCall;

      // Simulate host crash
      const restartChild2 = new MockUtilityProcess();
      forkMock.mockReturnValue(restartChild2);
      dedicatedChild.emit("exit", 1);

      // Advance timer to trigger restart
      vi.advanceTimersByTime(2001);

      // Make the restarted host ready
      restartChild2.emit("message", { type: "ready" });

      // Flush microtasks for the .then() chain
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // The restart path should have issued a loadProject call
      const reloadCall = restartChild2.postMessage.mock.calls.find(
        ([msg]) => (msg as { type: string }).type === "load-project"
      );
      expect(reloadCall).toBeDefined();
      expect((reloadCall![0] as { rootPath: string }).rootPath).toBe("/my-project");

      // Resolve the reload
      restartChild2.emit("message", {
        type: "load-project-result",
        requestId: (reloadCall![0] as { requestId: string }).requestId,
      });

      await Promise.resolve();

      restartClient.dispose();
    });
  });

  describe("watchdog", () => {
    let killSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      child.emit("message", { type: "ready" });
      child.postMessage.mockClear();
    });

    afterEach(() => {
      killSpy.mockRestore();
    });

    it("force-kills host after 3 missed heartbeats", () => {
      // Advance through 3 health check intervals without sending pong
      vi.advanceTimersByTime(1001); // tick 1: missedHeartbeats = 1
      vi.advanceTimersByTime(1000); // tick 2: missedHeartbeats = 2
      vi.advanceTimersByTime(1000); // tick 3: missedHeartbeats = 3
      vi.advanceTimersByTime(1000); // tick 4: threshold hit, force-kill

      expect(killSpy).toHaveBeenCalledWith(12345, "SIGKILL");
    });

    it("pong resets missed heartbeat counter preventing force-kill", () => {
      vi.advanceTimersByTime(1001); // tick 1: missedHeartbeats = 1
      vi.advanceTimersByTime(1000); // tick 2: missedHeartbeats = 2

      child.emit("message", { type: "pong" }); // reset to 0

      vi.advanceTimersByTime(1000); // tick: missedHeartbeats = 1
      vi.advanceTimersByTime(1000); // tick: missedHeartbeats = 2

      expect(killSpy).not.toHaveBeenCalled();
    });

    it("skips kill when pid is undefined", () => {
      child.pid = undefined as unknown as number;

      vi.advanceTimersByTime(1001);
      vi.advanceTimersByTime(1000);
      vi.advanceTimersByTime(1000);
      vi.advanceTimersByTime(1000);

      expect(killSpy).not.toHaveBeenCalled();
    });

    it("watchdog kill triggers exit handler and restart flow", () => {
      const crashHandler = vi.fn();
      client.on("host-crash", crashHandler);

      vi.advanceTimersByTime(4001); // 4 ticks, triggers kill on tick 4

      expect(killSpy).toHaveBeenCalledWith(12345, "SIGKILL");

      // Simulate the OS delivering the exit event after SIGKILL
      child.emit("exit", null);

      // With maxRestartAttempts: 0, host-crash should be emitted
      expect(crashHandler).toHaveBeenCalled();
    });
  });

  describe("handshake", () => {
    let killSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      child.emit("message", { type: "ready" });
      child.postMessage.mockClear();
    });

    afterEach(() => {
      killSpy.mockRestore();
    });

    it("resume sends immediate handshake ping", () => {
      client.pauseHealthCheck();
      client.resumeHealthCheck();

      expect(
        child.postMessage.mock.calls.some(
          ([msg]) => (msg as { type?: string })?.type === "health-check"
        )
      ).toBe(true);
    });

    it("pong completes handshake and starts interval", () => {
      client.pauseHealthCheck();
      client.resumeHealthCheck();
      child.postMessage.mockClear();

      // Send pong to complete handshake
      child.emit("message", { type: "pong" });

      // Now advance past one interval — health check should fire
      vi.advanceTimersByTime(1001);

      expect(
        child.postMessage.mock.calls.some(
          ([msg]) => (msg as { type?: string })?.type === "health-check"
        )
      ).toBe(true);
    });

    it("5s timeout falls back to starting interval", () => {
      client.pauseHealthCheck();
      client.resumeHealthCheck();
      child.postMessage.mockClear();

      // Advance past 5s handshake timeout
      vi.advanceTimersByTime(5001);

      // Handshake timed out, interval should have started — advance one more interval
      vi.advanceTimersByTime(1001);

      expect(
        child.postMessage.mock.calls.some(
          ([msg]) => (msg as { type?: string })?.type === "health-check"
        )
      ).toBe(true);
    });

    it("late pong after timeout is harmless", () => {
      client.pauseHealthCheck();
      client.resumeHealthCheck();

      // Timeout fires
      vi.advanceTimersByTime(5001);

      // Late pong arrives — should not crash or start duplicate interval
      expect(() => child.emit("message", { type: "pong" })).not.toThrow();
    });

    it("pause clears handshake timeout", () => {
      client.pauseHealthCheck();
      client.resumeHealthCheck();
      child.postMessage.mockClear();

      // Re-pause before handshake completes
      client.pauseHealthCheck();

      // Advance past where handshake timeout would fire
      vi.advanceTimersByTime(6000);

      // No health checks should have been sent
      expect(
        child.postMessage.mock.calls.some(
          ([msg]) => (msg as { type?: string })?.type === "health-check"
        )
      ).toBe(false);
    });

    it("dispose during handshake is clean", () => {
      client.pauseHealthCheck();
      client.resumeHealthCheck();

      client.dispose();

      // Advance past handshake timeout — should not crash
      expect(() => vi.advanceTimersByTime(6000)).not.toThrow();
    });

    it("resume before host ready returns early without handshake", () => {
      // Create a fresh client where host is not yet ready
      const freshChild = new MockUtilityProcess();
      forkMock.mockReturnValue(freshChild);
      const freshClient = new WorkspaceClient({
        maxRestartAttempts: 0,
        showCrashDialog: false,
        healthCheckIntervalMs: 1000,
      });
      void freshClient.waitForReady().catch(() => {});

      freshClient.pauseHealthCheck();
      freshChild.postMessage.mockClear();
      freshClient.resumeHealthCheck();

      // No handshake ping should be sent since host is not ready
      expect(
        freshChild.postMessage.mock.calls.some(
          ([msg]) => (msg as { type?: string })?.type === "health-check"
        )
      ).toBe(false);

      // But after ready, health checks should start
      freshChild.emit("message", { type: "ready" });
      freshChild.postMessage.mockClear();
      vi.advanceTimersByTime(1001);

      expect(
        freshChild.postMessage.mock.calls.some(
          ([msg]) => (msg as { type?: string })?.type === "health-check"
        )
      ).toBe(true);

      freshClient.dispose();
    });
  });

  describe("setActiveWorktree echo suppression", () => {
    let mockWindow: {
      isDestroyed: ReturnType<typeof vi.fn>;
      webContents: { isDestroyed: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> };
    };

    beforeEach(() => {
      mockWindow = {
        isDestroyed: vi.fn(() => false),
        webContents: { isDestroyed: vi.fn(() => false), send: vi.fn() },
      };
      getAllWindowsMock.mockReturnValue([mockWindow] as never[]);

      // Make the host "ready" so requests go through
      child.emit("message", { type: "ready" });
    });

    function resolveSetActive() {
      const lastCall = child.postMessage.mock.calls.at(-1)!;
      const requestId = (lastCall[0] as { requestId: string }).requestId;
      child.emit("message", { type: "set-active-result", requestId });
    }

    it("emits WORKTREE_ACTIVATED by default (backend-initiated)", async () => {
      const clientPrivate = client as never as { currentProjectScopeId: string | null };
      clientPrivate.currentProjectScopeId = "scope-a";

      const promise = client.setActiveWorktree("wt-1");
      resolveSetActive();
      await promise;

      expect(mockWindow.webContents.send).toHaveBeenCalledTimes(1);
      expect(mockWindow.webContents.send).toHaveBeenCalledWith("worktree:activated", {
        worktreeId: "wt-1",
      });
    });

    it("does NOT emit WORKTREE_ACTIVATED when silent: true (renderer-initiated)", async () => {
      const clientPrivate = client as never as { currentProjectScopeId: string | null };
      clientPrivate.currentProjectScopeId = "scope-a";

      const promise = client.setActiveWorktree("wt-1", { silent: true });
      resolveSetActive();
      await promise;

      expect(mockWindow.webContents.send).not.toHaveBeenCalled();
    });

    it("does NOT emit WORKTREE_ACTIVATED when project scope changed mid-flight", async () => {
      const clientPrivate = client as never as { currentProjectScopeId: string | null };
      clientPrivate.currentProjectScopeId = "scope-a";

      const promise = client.setActiveWorktree("wt-1");

      // Simulate scope change before response arrives
      clientPrivate.currentProjectScopeId = "scope-b";

      resolveSetActive();
      await promise;

      expect(mockWindow.webContents.send).not.toHaveBeenCalled();
    });
  });
});
