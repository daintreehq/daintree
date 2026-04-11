import { describe, it, expect, vi, beforeEach } from "vitest";
import { PRIntegrationService, type PRIntegrationCallbacks } from "../PRIntegrationService.js";
import type { TypedEventBus } from "../../services/events.js";

function makeEventBus(): TypedEventBus {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  return {
    on(event: string, handler: (...args: any[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
      return () => {
        listeners.get(event)?.delete(handler);
      };
    },
    emit(event: string, ...args: any[]) {
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
  let prServiceMock: {
    initialize: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    getStatus: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    eventBus = makeEventBus();
    callbacks = makeCallbacks();
    prServiceMock = {
      initialize: vi.fn(),
      start: vi.fn().mockResolvedValue(undefined),
      reset: vi.fn(),
      refresh: vi.fn(),
      getStatus: vi.fn(() => ({
        isPolling: false,
        candidateCount: 0,
        resolvedCount: 0,
        isEnabled: true,
      })),
    };
  });

  it("seeds non-main worktrees via sys:worktree:update events", async () => {
    const emitSpy = vi.spyOn(eventBus, "emit");
    const service = new PRIntegrationService(prServiceMock, eventBus, callbacks);

    await service.initialize("/repo", () => [
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

    await service.initialize("/repo", () => [
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
});
