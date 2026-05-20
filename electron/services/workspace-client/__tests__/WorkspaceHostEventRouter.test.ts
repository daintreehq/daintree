import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceHostEventRouter } from "../WorkspaceHostEventRouter.js";
import { CHANNELS } from "../../../ipc/channels.js";
import type { WorkspaceHostEvent } from "../../../../shared/types/workspace-host.js";
import type {
  WorktreeLifecyclePhase,
  WorktreeLifecycleState,
} from "../../../../shared/types/worktree.js";
import type { ProcessEntry, CopyTreeProgressCallback } from "../types.js";
import type { WorkspaceHostProcess } from "../../WorkspaceHostProcess.js";

vi.mock("../../../ipc/utils.js", () => ({
  broadcastToRenderer: vi.fn(),
}));

vi.mock("../../events.js", () => ({
  events: { emit: vi.fn() },
}));

vi.mock("../../github/index.js", () => ({
  gitHubRateLimitService: { applyRemoteState: vi.fn() },
}));

import { broadcastToRenderer } from "../../../ipc/utils.js";
import { events } from "../../events.js";

function makeEntry(overrides: Partial<ProcessEntry> = {}): ProcessEntry {
  return {
    host: {
      generateRequestId: () => "r",
      send: vi.fn(),
      sendWithResponse: vi.fn(),
      dispose: vi.fn(),
    } as unknown as WorkspaceHostProcess,
    refCount: 1,
    initPromise: Promise.resolve(),
    currentReadyPromise: Promise.resolve(),
    cleanupTimeout: null,
    windowIds: new Set(),
    projectPath: "/project/test",
    directPortViews: new Map(),
    ...overrides,
  };
}

function makeWorktreeUpdateEvent(
  overrides: Record<string, unknown> = {}
): Extract<WorkspaceHostEvent, { type: "worktree-update" }> {
  return {
    type: "worktree-update",
    worktree: {
      id: "wt-1",
      path: "/project/test",
      name: "test-worktree",
      isCurrent: true,
      worktreeId: "wt-1",
      ...overrides,
    },
    epoch: "550e8400-e29b-41d4-a716-446655440000",
    seq: 1,
  };
}

describe("WorkspaceHostEventRouter", () => {
  let router: WorkspaceHostEventRouter;
  let copyTreeCallbacks: Map<string, CopyTreeProgressCallback>;

  beforeEach(() => {
    vi.clearAllMocks();
    copyTreeCallbacks = new Map();
    router = new WorkspaceHostEventRouter({
      emit: vi.fn(),
      worktreePathToProject: new Map(),
      copyTreeProgressCallbacks: copyTreeCallbacks,
    });
  });

  describe("inotify-limit-reached dedup", () => {
    it("fires toast on first emit", () => {
      const entry = makeEntry();
      router.routeHostEvent(entry, { type: "inotify-limit-reached" });

      expect(broadcastToRenderer).toHaveBeenCalledTimes(1);
      expect(broadcastToRenderer).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ type: "warning" })
      );
    });

    it("suppresses duplicate toasts from subsequent hosts", () => {
      const entryA = makeEntry({ projectPath: "/a" });
      const entryB = makeEntry({ projectPath: "/b" });

      router.routeHostEvent(entryA, { type: "inotify-limit-reached" });
      router.routeHostEvent(entryB, { type: "inotify-limit-reached" });

      expect(broadcastToRenderer).toHaveBeenCalledTimes(1);
    });

    it("suppresses duplicate toasts from the same host", () => {
      const entry = makeEntry();

      router.routeHostEvent(entry, { type: "inotify-limit-reached" });
      router.routeHostEvent(entry, { type: "inotify-limit-reached" });

      expect(broadcastToRenderer).toHaveBeenCalledTimes(1);
    });
  });

  describe("emfile-limit-reached dedup", () => {
    it("fires toast on first emit", () => {
      const entry = makeEntry();
      router.routeHostEvent(entry, { type: "emfile-limit-reached" });

      expect(broadcastToRenderer).toHaveBeenCalledTimes(1);
      expect(broadcastToRenderer).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ type: "warning" })
      );
    });

    it("suppresses duplicate toasts from subsequent hosts", () => {
      const entryA = makeEntry({ projectPath: "/a" });
      const entryB = makeEntry({ projectPath: "/b" });

      router.routeHostEvent(entryA, { type: "emfile-limit-reached" });
      router.routeHostEvent(entryB, { type: "emfile-limit-reached" });

      expect(broadcastToRenderer).toHaveBeenCalledTimes(1);
    });
  });

  describe("watcher-recovered resets one-shot toast guards", () => {
    it("does not emit a toast itself", () => {
      const entry = makeEntry();
      router.routeHostEvent(entry, { type: "watcher-recovered" });

      expect(broadcastToRenderer).not.toHaveBeenCalled();
    });

    it("re-arms the inotify toast so a relapse re-notifies", () => {
      const entry = makeEntry();

      router.routeHostEvent(entry, { type: "inotify-limit-reached" });
      router.routeHostEvent(entry, { type: "inotify-limit-reached" });
      expect(broadcastToRenderer).toHaveBeenCalledTimes(1);

      router.routeHostEvent(entry, { type: "watcher-recovered" });
      router.routeHostEvent(entry, { type: "inotify-limit-reached" });
      expect(broadcastToRenderer).toHaveBeenCalledTimes(2);
    });

    it("re-arms the emfile toast so a relapse re-notifies", () => {
      const entry = makeEntry();

      router.routeHostEvent(entry, { type: "emfile-limit-reached" });
      expect(broadcastToRenderer).toHaveBeenCalledTimes(1);

      router.routeHostEvent(entry, { type: "watcher-recovered" });
      router.routeHostEvent(entry, { type: "emfile-limit-reached" });
      expect(broadcastToRenderer).toHaveBeenCalledTimes(2);
    });
  });

  describe("inotify and emfile are independent", () => {
    it("allows both limit types to fire independently", () => {
      const entry = makeEntry();

      router.routeHostEvent(entry, { type: "inotify-limit-reached" });
      router.routeHostEvent(entry, { type: "emfile-limit-reached" });

      expect(broadcastToRenderer).toHaveBeenCalledTimes(2);
    });
  });

  describe("sys:worktree:update", () => {
    it("emits the full worktree object directly", () => {
      const entry = makeEntry();
      const event = makeWorktreeUpdateEvent({ branch: "feature/foo", prTitle: "My PR" });

      router.routeHostEvent(entry, event);

      expect(events.emit).toHaveBeenCalledWith("sys:worktree:update", event.worktree);
    });
  });

  describe("cloud resource teardown failure notifications", () => {
    const lifecycleStatus = (
      phase: WorktreeLifecyclePhase,
      state: WorktreeLifecycleState,
      startedAt: number
    ) => ({ phase, state, startedAt });

    const expectedToast = {
      type: "error",
      title: "Cloud resource may still be running",
      message:
        "The teardown script didn't complete — your cloud resource may still be active and billing",
      rateLimitKey: "cloud-teardown-failure",
    };

    it("fires inbox notification when resource-teardown fails", () => {
      const entry = makeEntry();
      const event = makeWorktreeUpdateEvent({
        lifecycleStatus: lifecycleStatus("resource-teardown", "failed", 1000),
      });

      router.routeHostEvent(entry, event);

      expect(broadcastToRenderer).toHaveBeenCalledTimes(1);
      expect(broadcastToRenderer).toHaveBeenCalledWith(
        CHANNELS.NOTIFICATION_SHOW_TOAST,
        expectedToast
      );
    });

    it("fires inbox notification when resource-teardown times out", () => {
      const entry = makeEntry();
      const event = makeWorktreeUpdateEvent({
        lifecycleStatus: lifecycleStatus("resource-teardown", "timed-out", 1000),
      });

      router.routeHostEvent(entry, event);

      expect(broadcastToRenderer).toHaveBeenCalledTimes(1);
      expect(broadcastToRenderer).toHaveBeenCalledWith(
        CHANNELS.NOTIFICATION_SHOW_TOAST,
        expectedToast
      );
    });

    it("still emits the normal worktree-update side-effects when a toast fires", () => {
      const entry = makeEntry();
      const event = makeWorktreeUpdateEvent({
        lifecycleStatus: lifecycleStatus("resource-teardown", "failed", 1000),
      });

      router.routeHostEvent(entry, event);

      expect(events.emit).toHaveBeenCalledWith("sys:worktree:update", event.worktree);
    });

    it("does not fire on resource-teardown running snapshot", () => {
      const entry = makeEntry();
      router.routeHostEvent(
        entry,
        makeWorktreeUpdateEvent({
          lifecycleStatus: lifecycleStatus("resource-teardown", "running", 1000),
        })
      );

      expect(broadcastToRenderer).not.toHaveBeenCalled();
    });

    it("does not fire on resource-teardown success", () => {
      const entry = makeEntry();
      router.routeHostEvent(
        entry,
        makeWorktreeUpdateEvent({
          lifecycleStatus: lifecycleStatus("resource-teardown", "success", 1000),
        })
      );

      expect(broadcastToRenderer).not.toHaveBeenCalled();
    });

    it("does not fire on local config-teardown failure (asymmetric rule)", () => {
      const entry = makeEntry();
      const event = makeWorktreeUpdateEvent({
        lifecycleStatus: lifecycleStatus("teardown", "failed", 1000),
      });

      router.routeHostEvent(entry, event);

      expect(broadcastToRenderer).not.toHaveBeenCalled();
      // Normal routing must still happen even when the toast is skipped.
      expect(events.emit).toHaveBeenCalledWith("sys:worktree:update", event.worktree);
    });

    it("does not fire on local config-teardown timeout (asymmetric rule)", () => {
      const entry = makeEntry();
      router.routeHostEvent(
        entry,
        makeWorktreeUpdateEvent({
          lifecycleStatus: lifecycleStatus("teardown", "timed-out", 1000),
        })
      );

      expect(broadcastToRenderer).not.toHaveBeenCalled();
    });

    it("debounces duplicate snapshots of the same (worktreeId, startedAt)", () => {
      const entry = makeEntry();
      const event = makeWorktreeUpdateEvent({
        lifecycleStatus: lifecycleStatus("resource-teardown", "failed", 1000),
      });

      router.routeHostEvent(entry, event);
      router.routeHostEvent(entry, event);
      router.routeHostEvent(entry, event);

      expect(broadcastToRenderer).toHaveBeenCalledTimes(1);
    });

    it("fires again for a new teardown attempt with a different startedAt", () => {
      const entry = makeEntry();
      router.routeHostEvent(
        entry,
        makeWorktreeUpdateEvent({
          lifecycleStatus: lifecycleStatus("resource-teardown", "failed", 1000),
        })
      );
      router.routeHostEvent(
        entry,
        makeWorktreeUpdateEvent({
          lifecycleStatus: lifecycleStatus("resource-teardown", "failed", 2000),
        })
      );

      expect(broadcastToRenderer).toHaveBeenCalledTimes(2);
    });

    it("fires independently for different worktrees with the same startedAt", () => {
      const entry = makeEntry();
      router.routeHostEvent(
        entry,
        makeWorktreeUpdateEvent({
          id: "wt-1",
          worktreeId: "wt-1",
          lifecycleStatus: lifecycleStatus("resource-teardown", "failed", 1000),
        })
      );
      router.routeHostEvent(
        entry,
        makeWorktreeUpdateEvent({
          id: "wt-2",
          worktreeId: "wt-2",
          lifecycleStatus: lifecycleStatus("resource-teardown", "failed", 1000),
        })
      );

      expect(broadcastToRenderer).toHaveBeenCalledTimes(2);
    });

    it("debounce covers different terminal states of the same attempt", () => {
      const entry = makeEntry();
      router.routeHostEvent(
        entry,
        makeWorktreeUpdateEvent({
          lifecycleStatus: lifecycleStatus("resource-teardown", "failed", 1000),
        })
      );
      router.routeHostEvent(
        entry,
        makeWorktreeUpdateEvent({
          lifecycleStatus: lifecycleStatus("resource-teardown", "timed-out", 1000),
        })
      );

      expect(broadcastToRenderer).toHaveBeenCalledTimes(1);
    });

    it("does not throw when lifecycleStatus is absent", () => {
      const entry = makeEntry();
      const event = makeWorktreeUpdateEvent();

      expect(() => router.routeHostEvent(entry, event)).not.toThrow();
      expect(broadcastToRenderer).not.toHaveBeenCalled();
      expect(events.emit).toHaveBeenCalledWith("sys:worktree:update", event.worktree);
    });
  });

  describe("linked is the source of truth on re-emit (#8452)", () => {
    it("derives canonical providerId/owner/repo from linked on sys:pr:detected", () => {
      const entry = makeEntry();
      router.routeHostEvent(entry, {
        type: "pr-detected",
        worktreeId: "wt-1",
        prNumber: 1234,
        prUrl: "https://gitlab.acme.com/acme-corp/my-project/-/merge_requests/1234",
        prState: "open",
        prTitle: "Add widget",
        providerId: "acme.gitlab",
        linked: {
          providerId: "acme.gitlab",
          pr: {
            ref: {
              providerId: "acme.gitlab",
              owner: "acme-corp",
              repo: "my-project",
              number: 1234,
              rawData: null,
            },
            url: "https://gitlab.acme.com/acme-corp/my-project/-/merge_requests/1234",
            state: "open",
          },
        },
      });

      expect(events.emit).toHaveBeenCalledWith(
        "sys:pr:detected",
        expect.objectContaining({
          worktreeId: "wt-1",
          prNumber: 1234,
          providerId: "acme.gitlab",
          owner: "acme-corp",
          repo: "my-project",
        })
      );
    });

    it("derives canonical providerId/owner/repo from linked on sys:issue:detected", () => {
      const entry = makeEntry();
      router.routeHostEvent(entry, {
        type: "issue-detected",
        worktreeId: "wt-2",
        issueNumber: 88,
        issueTitle: "Widget request",
        providerId: "acme.gitlab",
        linked: {
          providerId: "acme.gitlab",
          issue: {
            ref: {
              providerId: "acme.gitlab",
              owner: "acme-corp",
              repo: "my-project",
              number: 88,
              rawData: null,
            },
            title: "Widget request",
          },
        },
      });

      expect(events.emit).toHaveBeenCalledWith(
        "sys:issue:detected",
        expect.objectContaining({
          worktreeId: "wt-2",
          issueNumber: 88,
          providerId: "acme.gitlab",
          owner: "acme-corp",
          repo: "my-project",
        })
      );
    });
  });
});
