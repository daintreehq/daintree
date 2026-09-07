import { describe, it, expect, vi, beforeEach } from "vitest";
import { PRIntegrationService, type PRIntegrationCallbacks } from "../PRIntegrationService.js";
import type { TypedEventBus } from "../../services/events.js";

function makeEventBus(): TypedEventBus {
  type Handler = (...args: unknown[]) => void;
  const listeners = new Map<string, Set<Handler>>();
  return {
    on(event: string, handler: Handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
      return () => {
        listeners.get(event)?.delete(handler);
      };
    },
    emit(event: string, ...args: unknown[]) {
      listeners.get(event)?.forEach((h) => h(...args));
    },
  } as unknown as TypedEventBus;
}

function makeCallbacks(): PRIntegrationCallbacks {
  return {
    onPRDetected: vi.fn(),
    onPRCleared: vi.fn(),
    onIssueDetected: vi.fn(),
    onIssueNotFound: vi.fn(),
  };
}

describe("PRIntegrationService", () => {
  let eventBus: TypedEventBus;
  let callbacks: PRIntegrationCallbacks;
  interface PullRequestServiceLike {
    initialize(rootPath: string, projectId: string): void;
    start(startupDelayMs?: number): Promise<void>;
    stop(): void;
    reset(): void;
    refresh(): Promise<void>;
    getStatus(): {
      isPolling: boolean;
      candidateCount: number;
      resolvedCount: number;
      isEnabled: boolean;
      detectionStateTripped: boolean;
    };
    getProviderContext(): { providerId: string; owner: string; repo: string } | null;
  }

  let prServiceMock: PullRequestServiceLike;

  beforeEach(() => {
    eventBus = makeEventBus();
    callbacks = makeCallbacks();
    prServiceMock = {
      initialize: vi.fn(),
      start: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      stop: vi.fn(),
      reset: vi.fn(),
      refresh: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      getStatus: vi.fn(() => ({
        isPolling: false,
        candidateCount: 0,
        resolvedCount: 0,
        isEnabled: true,
        detectionStateTripped: false,
      })),
      getProviderContext: vi.fn(() => null),
    };
  });

  it("seeds non-main worktrees via sys:worktree:update events", async () => {
    const emitSpy = vi.spyOn(eventBus, "emit");
    const service = new PRIntegrationService(prServiceMock, eventBus, callbacks);

    await service.initialize("/repo", "test-project-id", () => [
      { worktreeId: "wt-linked", branch: "feature/foo", issueNumber: 42, isMainWorktree: false },
    ]);

    const updateCalls = emitSpy.mock.calls.filter(([ev]) => ev === "sys:worktree:update");
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0][1]).toMatchObject({
      worktreeId: "wt-linked",
      branch: "feature/foo",
      issueNumber: 42,
      isMainWorktree: false,
    });
  });

  it("passes isMainWorktree: true so PullRequestService can filter root worktree", async () => {
    const emitSpy = vi.spyOn(eventBus, "emit");
    const service = new PRIntegrationService(prServiceMock, eventBus, callbacks);

    await service.initialize("/repo", "test-project-id", () => [
      { worktreeId: "wt-root", branch: "develop", issueNumber: undefined, isMainWorktree: true },
      { worktreeId: "wt-linked", branch: "feature/bar", issueNumber: 10, isMainWorktree: false },
    ]);

    const updateCalls = emitSpy.mock.calls.filter(([ev]) => ev === "sys:worktree:update");
    // Both candidates are emitted (the seed loop's branch filter still applies,
    // but develop passes that filter). PullRequestService's handleWorktreeUpdate
    // will reject the root worktree via the isMainWorktree guard.
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[0][1]).toMatchObject({ worktreeId: "wt-root", isMainWorktree: true });
    expect(updateCalls[1][1]).toMatchObject({ worktreeId: "wt-linked", isMainWorktree: false });
  });

  describe("forwards canonical owner/repo (#8452)", () => {
    it("threads owner/repo from a non-GitHub sys:pr:detected event to onPRDetected", async () => {
      const service = new PRIntegrationService(prServiceMock, eventBus, callbacks);
      await service.initialize("/repo", "test-project-id", () => []);

      eventBus.emit("sys:pr:detected", {
        worktreeId: "wt-1",
        prNumber: 1234,
        prUrl: "https://gitlab.acme.com/acme-corp/my-project/-/merge_requests/1234",
        prState: "open",
        prTitle: "Add widget",
        branchName: "feature/widget",
        providerId: "acme.gitlab",
        owner: "acme-corp",
        repo: "my-project",
        timestamp: Date.now(),
      });

      expect(callbacks.onPRDetected).toHaveBeenCalledWith(
        "wt-1",
        expect.objectContaining({
          providerId: "acme.gitlab",
          owner: "acme-corp",
          repo: "my-project",
          prNumber: 1234,
        })
      );
    });

    it("forwards isCiStatusLoading from a phase-1 sys:pr:detected event to onPRDetected (#9551)", async () => {
      const service = new PRIntegrationService(prServiceMock, eventBus, callbacks);
      await service.initialize("/repo", "test-project-id", () => []);

      eventBus.emit("sys:pr:detected", {
        worktreeId: "wt-1",
        prNumber: 42,
        prUrl: "https://example.test/pr/42",
        prState: "open",
        isCiStatusLoading: true,
        branchName: "feature/x",
        providerId: "daintree.github.github",
        owner: "o",
        repo: "r",
        timestamp: Date.now(),
      });

      expect(callbacks.onPRDetected).toHaveBeenCalledWith(
        "wt-1",
        expect.objectContaining({ isCiStatusLoading: true })
      );
    });

    it("threads owner/repo from a non-GitHub sys:issue:detected event to onIssueDetected", async () => {
      const service = new PRIntegrationService(prServiceMock, eventBus, callbacks);
      await service.initialize("/repo", "test-project-id", () => []);

      eventBus.emit("sys:issue:detected", {
        worktreeId: "wt-2",
        issueNumber: 88,
        issueTitle: "Widget request",
        branchName: "feature/widget",
        providerId: "acme.gitlab",
        owner: "acme-corp",
        repo: "my-project",
        timestamp: Date.now(),
      });

      expect(callbacks.onIssueDetected).toHaveBeenCalledWith(
        "wt-2",
        expect.objectContaining({
          providerId: "acme.gitlab",
          owner: "acme-corp",
          repo: "my-project",
          issueNumber: 88,
        })
      );
    });
  });

  describe("getStatus", () => {
    it("maps PullRequestService status to PRServiceStatus shape", () => {
      prServiceMock.getStatus = vi.fn(() => ({
        isPolling: true,
        candidateCount: 7,
        resolvedCount: 3,
        isEnabled: true,
        detectionStateTripped: false,
      }));
      const service = new PRIntegrationService(prServiceMock, eventBus, callbacks);

      const status = service.getStatus();

      expect(status).toEqual({
        isRunning: true,
        candidateCount: 7,
        resolvedPRCount: 3,
      });
    });

    it("reports circuitBreakerTripped when the breaker has tripped", () => {
      prServiceMock.getStatus = vi.fn(() => ({
        isPolling: false,
        candidateCount: 0,
        resolvedCount: 0,
        isEnabled: false,
        detectionStateTripped: true,
      }));
      const service = new PRIntegrationService(prServiceMock, eventBus, callbacks);

      const status = service.getStatus();

      expect(status.circuitBreakerTripped).toBe(true);
      expect(status.isRunning).toBe(false);
    });

    it("does NOT report circuitBreakerTripped during a rate-limit pause (isEnabled false, breaker not tripped)", () => {
      // A 429 sets nextRetryAt (isEnabled → false) but never trips the
      // 3-error breaker, so the badge "detection paused" signal must stay off.
      prServiceMock.getStatus = vi.fn(() => ({
        isPolling: true,
        candidateCount: 2,
        resolvedCount: 1,
        isEnabled: false,
        detectionStateTripped: false,
      }));
      const service = new PRIntegrationService(prServiceMock, eventBus, callbacks);

      const status = service.getStatus();

      expect(status.circuitBreakerTripped).toBeUndefined();
    });
  });

  describe("onDetectionStateChanged", () => {
    it("invokes the callback with the tripped flag from sys:pr:detection-state", async () => {
      const onDetectionStateChanged = vi.fn();
      const service = new PRIntegrationService(prServiceMock, eventBus, {
        ...callbacks,
        onDetectionStateChanged,
      });

      await service.initialize("/repo", "test-project-id", () => []);

      eventBus.emit("sys:pr:detection-state", { tripped: true, timestamp: Date.now() });
      expect(onDetectionStateChanged).toHaveBeenCalledWith(true);

      eventBus.emit("sys:pr:detection-state", { tripped: false, timestamp: Date.now() });
      expect(onDetectionStateChanged).toHaveBeenCalledWith(false);
      expect(onDetectionStateChanged).toHaveBeenCalledTimes(2);
    });

    it("does not throw when the optional callback is omitted", async () => {
      const service = new PRIntegrationService(prServiceMock, eventBus, callbacks);
      await service.initialize("/repo", "test-project-id", () => []);

      expect(() =>
        eventBus.emit("sys:pr:detection-state", { tripped: true, timestamp: Date.now() })
      ).not.toThrow();
    });
  });

  describe("resetPRState", () => {
    it("calls reset, then initialize, then start when projectRootPath is provided", () => {
      const callOrder: string[] = [];
      prServiceMock.reset = vi.fn(() => callOrder.push("reset"));
      prServiceMock.initialize = vi.fn(() => callOrder.push("initialize"));
      prServiceMock.start = vi.fn<() => Promise<void>>().mockImplementation(async () => {
        callOrder.push("start");
      });
      const service = new PRIntegrationService(prServiceMock, eventBus, callbacks);

      service.resetPRState("/repo", "test-project-id");

      expect(callOrder.slice(0, 2)).toEqual(["reset", "initialize"]);
      expect(prServiceMock.initialize).toHaveBeenCalledWith("/repo", "test-project-id");
      expect(prServiceMock.start).toHaveBeenCalled();
    });

    it("only calls reset when projectRootPath is null", () => {
      const service = new PRIntegrationService(prServiceMock, eventBus, callbacks);

      service.resetPRState(null, null);

      expect(prServiceMock.reset).toHaveBeenCalled();
      expect(prServiceMock.initialize).not.toHaveBeenCalled();
      expect(prServiceMock.start).not.toHaveBeenCalled();
    });
  });

  describe("pause / resume", () => {
    it("pause() stops the underlying service", () => {
      const service = new PRIntegrationService(prServiceMock, eventBus, callbacks);
      service.pause();
      expect(prServiceMock.stop).toHaveBeenCalledTimes(1);
    });

    it("resume() starts the underlying service with no startup jitter", () => {
      const service = new PRIntegrationService(prServiceMock, eventBus, callbacks);
      service.resume();
      expect(prServiceMock.start).toHaveBeenCalledTimes(1);
      // Focus-restore is not a crash-recovery path — jitter is skipped.
      expect(prServiceMock.start).toHaveBeenCalledWith(0);
    });
  });

  describe("updateForgeCredentials", () => {
    it("refreshes when credentials are truthy", () => {
      const service = new PRIntegrationService(prServiceMock, eventBus, callbacks);

      service.updateForgeCredentials(
        "builtin.github",
        { kind: "bearer", value: "ghp_abc123" },
        "/repo",
        "test-project-id"
      );

      expect(prServiceMock.refresh).toHaveBeenCalledTimes(1);
      expect(prServiceMock.reset).not.toHaveBeenCalled();
    });

    it("resets and reinitializes when credentials is null and path is provided", () => {
      const callOrder: string[] = [];
      prServiceMock.reset = vi.fn(() => callOrder.push("reset"));
      prServiceMock.initialize = vi.fn(() => callOrder.push("initialize"));
      prServiceMock.start = vi.fn<() => Promise<void>>().mockImplementation(async () => {
        callOrder.push("start");
      });
      const service = new PRIntegrationService(prServiceMock, eventBus, callbacks);

      service.updateForgeCredentials("builtin.github", null, "/repo", "test-project-id");

      expect(prServiceMock.refresh).not.toHaveBeenCalled();
      expect(callOrder.slice(0, 2)).toEqual(["reset", "initialize"]);
      expect(prServiceMock.initialize).toHaveBeenCalledWith("/repo", "test-project-id");
    });

    it("only resets when credentials and path are null", () => {
      const service = new PRIntegrationService(prServiceMock, eventBus, callbacks);

      service.updateForgeCredentials("builtin.github", null, null, null);

      expect(prServiceMock.reset).toHaveBeenCalledTimes(1);
      expect(prServiceMock.initialize).not.toHaveBeenCalled();
      expect(prServiceMock.start).not.toHaveBeenCalled();
    });

    it("refreshes for any providerId since the relay only signals presence", () => {
      const service = new PRIntegrationService(prServiceMock, eventBus, callbacks);

      service.updateForgeCredentials(
        "builtin.unknown",
        { kind: "bearer", value: "abc" },
        "/repo",
        "test-project-id"
      );

      expect(prServiceMock.refresh).toHaveBeenCalledTimes(1);
    });
  });

  describe("worker role (#10123)", () => {
    function makeWorkerService() {
      return new PRIntegrationService(prServiceMock, eventBus, callbacks, { isWorker: true });
    }

    it("initialize() wires detection but never starts the polling loop", async () => {
      const emitSpy = vi.spyOn(eventBus, "emit");
      const service = makeWorkerService();

      await service.initialize("/repo", "test-project-id", () => [
        { worktreeId: "wt-1", branch: "feature/foo", issueNumber: 7, isMainWorktree: false },
      ]);

      // Detection wiring is intact: candidates are still seeded…
      expect(prServiceMock.initialize).toHaveBeenCalledWith("/repo", "test-project-id");
      const updateCalls = emitSpy.mock.calls.filter(([ev]) => ev === "sys:worktree:update");
      expect(updateCalls).toHaveLength(1);
      // …but the automatic polling loop never starts.
      expect(prServiceMock.start).not.toHaveBeenCalled();
    });

    it("resume() is a no-op", () => {
      const service = makeWorkerService();
      service.resume();
      expect(prServiceMock.start).not.toHaveBeenCalled();
    });

    it("resetPRState() reinitializes without restarting polling", () => {
      const service = makeWorkerService();
      service.resetPRState("/repo", "test-project-id");
      expect(prServiceMock.reset).toHaveBeenCalled();
      expect(prServiceMock.initialize).toHaveBeenCalledWith("/repo", "test-project-id");
      expect(prServiceMock.start).not.toHaveBeenCalled();
    });

    it("updateForgeCredentials(null) reinitializes without restarting polling", () => {
      const service = makeWorkerService();
      service.updateForgeCredentials("builtin.github", null, "/repo", "test-project-id");
      expect(prServiceMock.initialize).toHaveBeenCalledWith("/repo", "test-project-id");
      expect(prServiceMock.start).not.toHaveBeenCalled();
    });

    it("keeps the on-demand refresh path functional", () => {
      const service = makeWorkerService();
      service.updateForgeCredentials(
        "builtin.github",
        { kind: "bearer", value: "ghp_x" },
        "/repo",
        "test-project-id"
      );
      expect(prServiceMock.refresh).toHaveBeenCalledTimes(1);
    });

    it("attended remains the default when options are omitted", async () => {
      const service = new PRIntegrationService(prServiceMock, eventBus, callbacks);
      await service.initialize("/repo", "test-project-id", () => []);
      expect(prServiceMock.start).toHaveBeenCalledTimes(1);
    });
  });
});
