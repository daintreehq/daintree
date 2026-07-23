import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("../../GitServiceCache.js", () => ({
  gitServiceCache: { delete: vi.fn() },
}));

import { broadcastToRenderer } from "../../../ipc/utils.js";
import { events } from "../../events.js";
import { gitServiceCache } from "../../GitServiceCache.js";
import { BUILTIN_GITHUB_PROVIDER_ID } from "../../../../shared/utils/forgeProviderIds.js";
import type { RateLimitInfo } from "../../../../shared/types/forge.js";

const FAKE_PROVIDER_ID = "acme.gitlab.gitlab";

function forgeRateLimitEvent(
  providerId: string,
  state: RateLimitInfo
): Extract<WorkspaceHostEvent, { type: "forge-rate-limit-changed" }> {
  return { type: "forge-rate-limit-changed", providerId, state };
}

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
    projectId: "test-project-id",
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
    // `sys:worktree:update` is now coalesced behind a 50ms trailing-edge timer
    // (#10769). Fake timers let tests advance past the window deterministically;
    // the forge guard tests override Date.now with their own spies as needed.
    vi.useFakeTimers();
    copyTreeCallbacks = new Map();
    router = new WorkspaceHostEventRouter({
      emit: vi.fn(),
      worktreePathToProject: new Map(),
      copyTreeProgressCallbacks: copyTreeCallbacks,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Number of ms past the `sys:worktree:update` debounce window.
  const SYS_WORKTREE_DEBOUNCE_MS = 50;

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
    it("emits the full worktree object after the debounce window", () => {
      const entry = makeEntry();
      const event = makeWorktreeUpdateEvent({ branch: "feature/foo", prTitle: "My PR" });

      router.routeHostEvent(entry, event);
      vi.advanceTimersByTime(SYS_WORKTREE_DEBOUNCE_MS);

      expect(events.emit).toHaveBeenCalledWith("sys:worktree:update", event.worktree);
    });
  });

  describe("sys:worktree:update debounce (#10769)", () => {
    function sysUpdateCalls() {
      return (events.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === "sys:worktree:update"
      );
    }

    it("does not emit on the sys bus synchronously — it waits for the window", () => {
      const entry = makeEntry();
      router.routeHostEvent(entry, makeWorktreeUpdateEvent());

      expect(events.emit).not.toHaveBeenCalledWith("sys:worktree:update", expect.anything());

      vi.advanceTimersByTime(SYS_WORKTREE_DEBOUNCE_MS);
      expect(sysUpdateCalls()).toHaveLength(1);
    });

    it("still emits worktree-update on the plugin bus synchronously (not debounced)", () => {
      const entry = makeEntry();
      const event = makeWorktreeUpdateEvent();

      router.routeHostEvent(entry, event);

      const emit = router as unknown as { emit: ReturnType<typeof vi.fn> };
      expect(emit.emit).toHaveBeenCalledWith("worktree-update", {
        worktree: event.worktree,
        projectPath: entry.projectPath,
      });
    });

    it("collapses rapid same-worktree updates into one emit carrying the latest snapshot", () => {
      const entry = makeEntry();
      const first = makeWorktreeUpdateEvent({ branch: "old" });
      const last = makeWorktreeUpdateEvent({ branch: "new" });

      router.routeHostEvent(entry, first);
      router.routeHostEvent(entry, last);
      vi.advanceTimersByTime(SYS_WORKTREE_DEBOUNCE_MS);

      const calls = sysUpdateCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toBe(last.worktree);
    });

    it("emits once per distinct worktree in a burst", () => {
      const entry = makeEntry();
      router.routeHostEvent(entry, makeWorktreeUpdateEvent({ id: "wt-1", worktreeId: "wt-1" }));
      router.routeHostEvent(entry, makeWorktreeUpdateEvent({ id: "wt-2", worktreeId: "wt-2" }));
      vi.advanceTimersByTime(SYS_WORKTREE_DEBOUNCE_MS);

      expect(sysUpdateCalls()).toHaveLength(2);
    });

    it("keys off the resolved path when worktreeId is missing", () => {
      const entry = makeEntry();
      router.routeHostEvent(
        entry,
        makeWorktreeUpdateEvent({ worktreeId: undefined, path: "/p/a" })
      );
      router.routeHostEvent(
        entry,
        makeWorktreeUpdateEvent({ worktreeId: undefined, path: "/p/b" })
      );
      vi.advanceTimersByTime(SYS_WORKTREE_DEBOUNCE_MS);

      expect(sysUpdateCalls()).toHaveLength(2);
    });

    it("dispose() before the window elapses drops the pending emit", () => {
      const entry = makeEntry();
      router.routeHostEvent(entry, makeWorktreeUpdateEvent());
      router.dispose();
      vi.advanceTimersByTime(SYS_WORKTREE_DEBOUNCE_MS);

      expect(events.emit).not.toHaveBeenCalledWith("sys:worktree:update", expect.anything());
    });

    it("ignores worktree-update routed after dispose()", () => {
      const entry = makeEntry();
      router.dispose();
      router.routeHostEvent(entry, makeWorktreeUpdateEvent());
      vi.advanceTimersByTime(SYS_WORKTREE_DEBOUNCE_MS);

      expect(events.emit).not.toHaveBeenCalledWith("sys:worktree:update", expect.anything());
    });

    it("drops a pending update when the worktree is removed within the window", () => {
      const entry = makeEntry();
      router.routeHostEvent(entry, makeWorktreeUpdateEvent({ id: "wt-1", worktreeId: "wt-1" }));
      router.routeHostEvent(entry, {
        type: "worktree-removed",
        worktreeId: "wt-1",
        epoch: "550e8400-e29b-41d4-a716-446655440000",
        seq: 2,
      });
      vi.advanceTimersByTime(SYS_WORKTREE_DEBOUNCE_MS);

      // The remove fires synchronously; the queued update must NOT fire after it.
      expect(events.emit).toHaveBeenCalledWith(
        "sys:worktree:remove",
        expect.objectContaining({ worktreeId: "wt-1" })
      );
      expect(events.emit).not.toHaveBeenCalledWith("sys:worktree:update", expect.anything());
    });
  });

  describe("sys:worktree:remove (#9084)", () => {
    it("emits sys:worktree:remove when a worktree-removed event arrives", () => {
      const entry = makeEntry();
      router.routeHostEvent(entry, {
        type: "worktree-removed",
        worktreeId: "wt-deleted",
        epoch: "550e8400-e29b-41d4-a716-446655440000",
        seq: 1,
      });

      expect(events.emit).toHaveBeenCalledWith(
        "sys:worktree:remove",
        expect.objectContaining({ worktreeId: "wt-deleted" })
      );
    });

    it("evicts the GitService cache entry for the removed worktree path", () => {
      const entry = makeEntry();
      router.routeHostEvent(entry, {
        type: "worktree-removed",
        worktreeId: "/project/test/wt-deleted",
        epoch: "550e8400-e29b-41d4-a716-446655440000",
        seq: 1,
      });

      expect(gitServiceCache.delete).toHaveBeenCalledWith("/project/test/wt-deleted");
    });
  });

  describe("worktree-activated (#9945)", () => {
    it("forwards non-silent activations to the plugin bus", () => {
      const entry = makeEntry({ projectPath: "/project/foo" });
      router.routeHostEvent(entry, {
        type: "worktree-activated",
        worktreeId: "wt-1",
        epoch: "550e8400-e29b-41d4-a716-446655440000",
        seq: 1,
      });

      // The injected `emit` (the `WorkspaceClient` internal bus) is the
      // surface `PluginService.subscribeWorktreeEvent` listens on for
      // host-originated activations. A non-silent Main-originated
      // activation (the `WorkspaceClient.setActiveWorktree` path that
      // forwards silent: false) must still notify plugin subscribers.
      const emit = router as unknown as { emit: ReturnType<typeof vi.fn> };
      expect(emit.emit).toHaveBeenCalledWith("worktree-activated", {
        worktreeId: "wt-1",
        projectPath: "/project/foo",
      });
    });

    it("suppresses the plugin-bus emit when silent=true (#9945 regression guard)", () => {
      // The renderer IPC path calls
      // `WorkspaceClient.setActiveWorktree(id, winId, { silent: true })`
      // (lifecycle.ts:53) so the legacy `CHANNELS.WORKTREE_ACTIVATED` echo
      // and `WorkspaceClient`-level plugin emit are suppressed. The host
      // propagates `silent` onto the `worktree-activated` event; this
      // router case must mirror the suppression or plugin subscribers to
      // `onDidChangeActiveWorktree` would receive notifications the
      // caller explicitly marked silent (and the non-silent path would
      // double-notify).
      const entry = makeEntry({ projectPath: "/project/foo" });
      router.routeHostEvent(entry, {
        type: "worktree-activated",
        worktreeId: "wt-1",
        epoch: "550e8400-e29b-41d4-a716-446655440000",
        seq: 1,
        silent: true,
      });

      const emit = router as unknown as { emit: ReturnType<typeof vi.fn> };
      expect(emit.emit).not.toHaveBeenCalled();
    });
  });

  describe("pr-detected IPC payload (#8870)", () => {
    function makeWebContents() {
      return {
        isDestroyed: () => false,
        send: vi.fn(),
      } as unknown as Electron.WebContents;
    }

    it("includes linked, branchName, and providerId on the renderer payload", () => {
      // Without these fields the renderer's `event.linked ?? existing.linked`
      // falls back to (typically null) existing.linked and the PR sub-row
      // never renders. The regression dropped the fields silently after #8452.
      const wc = makeWebContents();
      const entry = makeEntry();
      entry.directPortViews.set(1, wc);

      const linked = {
        providerId: BUILTIN_GITHUB_PROVIDER_ID,
        pr: {
          ref: {
            providerId: BUILTIN_GITHUB_PROVIDER_ID,
            owner: "acme",
            repo: "demo",
            number: 42,
            rawData: null,
          },
          title: "Fix the thing",
          url: "https://github.com/acme/demo/pull/42",
          state: "open" as const,
        },
      };

      const event: Extract<WorkspaceHostEvent, { type: "pr-detected" }> = {
        type: "pr-detected",
        worktreeId: "wt-1",
        prNumber: 42,
        prUrl: "https://github.com/acme/demo/pull/42",
        prState: "open",
        prTitle: "Fix the thing",
        branchName: "feature/x",
        providerId: BUILTIN_GITHUB_PROVIDER_ID,
        linked,
      };

      router.routeHostEvent(entry, event);

      expect(wc.send).toHaveBeenCalledTimes(1);
      const [channel, payload] = (wc.send as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(channel).toBe(CHANNELS.PR_DETECTED);
      expect(payload).toMatchObject({
        worktreeId: "wt-1",
        prNumber: 42,
        branchName: "feature/x",
        providerId: BUILTIN_GITHUB_PROVIDER_ID,
        linked,
      });
    });
  });

  describe("issue-detected IPC payload (#8870)", () => {
    function makeWebContents() {
      return {
        isDestroyed: () => false,
        send: vi.fn(),
      } as unknown as Electron.WebContents;
    }

    it("includes linked, branchName, and providerId on the renderer payload", () => {
      const wc = makeWebContents();
      const entry = makeEntry();
      entry.directPortViews.set(1, wc);

      const linked = {
        providerId: BUILTIN_GITHUB_PROVIDER_ID,
        issue: {
          ref: {
            providerId: BUILTIN_GITHUB_PROVIDER_ID,
            owner: "acme",
            repo: "demo",
            number: 7,
            rawData: null,
          },
          title: "Reported bug",
        },
      };

      const event: Extract<WorkspaceHostEvent, { type: "issue-detected" }> = {
        type: "issue-detected",
        worktreeId: "wt-1",
        issueNumber: 7,
        issueTitle: "Reported bug",
        branchName: "feature/issue-7",
        providerId: BUILTIN_GITHUB_PROVIDER_ID,
        linked,
      };

      router.routeHostEvent(entry, event);

      expect(wc.send).toHaveBeenCalledTimes(1);
      const [channel, payload] = (wc.send as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(channel).toBe(CHANNELS.ISSUE_DETECTED);
      expect(payload).toMatchObject({
        worktreeId: "wt-1",
        issueNumber: 7,
        branchName: "feature/issue-7",
        providerId: BUILTIN_GITHUB_PROVIDER_ID,
        linked,
      });
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
      vi.advanceTimersByTime(SYS_WORKTREE_DEBOUNCE_MS);

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
      vi.advanceTimersByTime(SYS_WORKTREE_DEBOUNCE_MS);

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
      vi.advanceTimersByTime(SYS_WORKTREE_DEBOUNCE_MS);
      expect(broadcastToRenderer).not.toHaveBeenCalled();
      expect(events.emit).toHaveBeenCalledWith("sys:worktree:update", event.worktree);
    });

    it("prunes the dedup key on worktree-removed so a re-teardown re-fires (#10842)", () => {
      const entry = makeEntry();
      const failure = (worktreeId: string) =>
        makeWorktreeUpdateEvent({
          id: worktreeId,
          worktreeId,
          lifecycleStatus: lifecycleStatus("resource-teardown", "failed", 1000),
        });

      // First failure for wt-1 records the dedup key and toasts once.
      router.routeHostEvent(entry, failure("wt-1"));
      expect(broadcastToRenderer).toHaveBeenCalledTimes(1);

      // Removing the worktree prunes its `${worktreeId}:${startedAt}` keys.
      router.routeHostEvent(entry, {
        type: "worktree-removed",
        worktreeId: "wt-1",
        epoch: "550e8400-e29b-41d4-a716-446655440000",
        seq: 2,
      });

      // A re-created worktree reusing the id with the same startedAt must toast
      // again — the stale key is gone.
      router.routeHostEvent(entry, failure("wt-1"));
      expect(broadcastToRenderer).toHaveBeenCalledTimes(2);
    });

    it("prunes every dedup key for the removed worktree, not just the first (#10842)", () => {
      const entry = makeEntry();
      // Two distinct teardown attempts for wt-1 produce two dedup keys
      // (`wt-1:1000`, `wt-1:2000`).
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

      router.routeHostEvent(entry, {
        type: "worktree-removed",
        worktreeId: "wt-1",
        epoch: "550e8400-e29b-41d4-a716-446655440000",
        seq: 3,
      });

      // Both keys must be gone — a first-match-only prune would leave wt-1:2000.
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
      expect(broadcastToRenderer).toHaveBeenCalledTimes(4);
    });

    it("only prunes dedup keys for the removed worktree (#10842)", () => {
      const entry = makeEntry();
      const failure = (worktreeId: string) =>
        makeWorktreeUpdateEvent({
          id: worktreeId,
          worktreeId,
          lifecycleStatus: lifecycleStatus("resource-teardown", "failed", 1000),
        });

      router.routeHostEvent(entry, failure("wt-1"));
      router.routeHostEvent(entry, failure("wt-2"));
      expect(broadcastToRenderer).toHaveBeenCalledTimes(2);

      // Remove wt-1 only — wt-2's dedup key must survive.
      router.routeHostEvent(entry, {
        type: "worktree-removed",
        worktreeId: "wt-1",
        epoch: "550e8400-e29b-41d4-a716-446655440000",
        seq: 3,
      });

      // wt-2 is still deduped (no new toast); wt-1 re-fires (key pruned).
      router.routeHostEvent(entry, failure("wt-2"));
      expect(broadcastToRenderer).toHaveBeenCalledTimes(2);
      router.routeHostEvent(entry, failure("wt-1"));
      expect(broadcastToRenderer).toHaveBeenCalledTimes(3);
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

  describe("forge-rate-limit-changed (provider-agnostic routing)", () => {
    const blocked: RateLimitInfo = { limit: null, remaining: 0, resetAt: 1_700_000_000_000 };
    const cleared: RateLimitInfo = { limit: null, remaining: null, resetAt: null };

    it("broadcasts GitHub's state on the forge channel tagged with its providerId", () => {
      const entry = makeEntry();
      router.routeHostEvent(entry, forgeRateLimitEvent(BUILTIN_GITHUB_PROVIDER_ID, blocked));

      expect(broadcastToRenderer).toHaveBeenCalledTimes(1);
      expect(broadcastToRenderer).toHaveBeenCalledWith(CHANNELS.FORGE_RATE_LIMIT_CHANGED, {
        providerId: BUILTIN_GITHUB_PROVIDER_ID,
        state: blocked,
      });
    });

    it("broadcasts a non-GitHub provider's state on the same channel with its own providerId", () => {
      const entry = makeEntry();
      router.routeHostEvent(entry, forgeRateLimitEvent(FAKE_PROVIDER_ID, blocked));

      expect(broadcastToRenderer).toHaveBeenCalledTimes(1);
      expect(broadcastToRenderer).toHaveBeenCalledWith(CHANNELS.FORGE_RATE_LIMIT_CHANGED, {
        providerId: FAKE_PROVIDER_ID,
        state: blocked,
      });
    });

    it("never calls gitHubRateLimitService — there is no GitHub fast-path", () => {
      // The router no longer imports gitHubRateLimitService; the only side
      // effect for a forge rate-limit event is the broadcast asserted above.
      const entry = makeEntry();
      router.routeHostEvent(entry, forgeRateLimitEvent(BUILTIN_GITHUB_PROVIDER_ID, blocked));

      expect(broadcastToRenderer).toHaveBeenCalledTimes(1);
      expect(broadcastToRenderer).toHaveBeenCalledWith(
        CHANNELS.FORGE_RATE_LIMIT_CHANGED,
        expect.objectContaining({ providerId: BUILTIN_GITHUB_PROVIDER_ID })
      );
    });

    it("forwards cleared state through the same channel", () => {
      const entry = makeEntry();
      router.routeHostEvent(entry, forgeRateLimitEvent(FAKE_PROVIDER_ID, cleared));

      expect(broadcastToRenderer).toHaveBeenCalledWith(CHANNELS.FORGE_RATE_LIMIT_CHANGED, {
        providerId: FAKE_PROVIDER_ID,
        state: cleared,
      });
    });

    it("suppresses an exhausted-quota block within the credential-change guard window", () => {
      const now = 10_000_000;
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        const entry = makeEntry();
        router.updateForgeCredentials(BUILTIN_GITHUB_PROVIDER_ID, {
          kind: "bearer",
          value: "tok",
        });
        router.routeHostEvent(entry, forgeRateLimitEvent(BUILTIN_GITHUB_PROVIDER_ID, blocked));

        expect(broadcastToRenderer).not.toHaveBeenCalled();
      } finally {
        nowSpy.mockRestore();
      }
    });

    it("applies the guard per-provider — a different provider is unaffected", () => {
      const now = 10_000_000;
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        const entry = makeEntry();
        router.updateForgeCredentials(BUILTIN_GITHUB_PROVIDER_ID, {
          kind: "bearer",
          value: "tok",
        });
        // Fake provider had no credential change — its block is not suppressed.
        router.routeHostEvent(entry, forgeRateLimitEvent(FAKE_PROVIDER_ID, blocked));

        expect(broadcastToRenderer).toHaveBeenCalledTimes(1);
        expect(broadcastToRenderer).toHaveBeenCalledWith(CHANNELS.FORGE_RATE_LIMIT_CHANGED, {
          providerId: FAKE_PROVIDER_ID,
          state: blocked,
        });
      } finally {
        nowSpy.mockRestore();
      }
    });

    it("respects the exact guard-window fence-post (4999 suppress, 5000 pass)", () => {
      const nowSpy = vi.spyOn(Date, "now");
      try {
        nowSpy.mockReturnValue(1_000_000);
        const entry = makeEntry();
        router.updateForgeCredentials(BUILTIN_GITHUB_PROVIDER_ID, {
          kind: "bearer",
          value: "tok",
        });

        // 4999ms after the credential change — still inside the window.
        nowSpy.mockReturnValue(1_004_999);
        router.routeHostEvent(entry, forgeRateLimitEvent(BUILTIN_GITHUB_PROVIDER_ID, blocked));
        expect(broadcastToRenderer).not.toHaveBeenCalled();

        // Exactly 5000ms — `delta < GUARD_MS` is false, so it passes.
        nowSpy.mockReturnValue(1_005_000);
        router.routeHostEvent(entry, forgeRateLimitEvent(BUILTIN_GITHUB_PROVIDER_ID, blocked));
        expect(broadcastToRenderer).toHaveBeenCalledTimes(1);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it("broadcasts the exact ForgeRateLimitChangedPayload shape", () => {
      const entry = makeEntry();
      const state: RateLimitInfo = {
        limit: 5000,
        remaining: 0,
        resetAt: 1_700_000_000_000,
        secondaryThrottled: true,
      };
      router.routeHostEvent(entry, forgeRateLimitEvent(FAKE_PROVIDER_ID, state));

      expect(broadcastToRenderer).toHaveBeenCalledWith(CHANNELS.FORGE_RATE_LIMIT_CHANGED, {
        providerId: FAKE_PROVIDER_ID,
        state: { limit: 5000, remaining: 0, resetAt: 1_700_000_000_000, secondaryThrottled: true },
      });
    });

    it("broadcasts again once the guard window elapses", () => {
      const nowSpy = vi.spyOn(Date, "now");
      try {
        nowSpy.mockReturnValue(10_000_000);
        const entry = makeEntry();
        router.updateForgeCredentials(BUILTIN_GITHUB_PROVIDER_ID, {
          kind: "bearer",
          value: "tok",
        });
        router.routeHostEvent(entry, forgeRateLimitEvent(BUILTIN_GITHUB_PROVIDER_ID, blocked));
        expect(broadcastToRenderer).not.toHaveBeenCalled();

        // 6s later — past the 5s guard window.
        nowSpy.mockReturnValue(10_006_000);
        router.routeHostEvent(entry, forgeRateLimitEvent(BUILTIN_GITHUB_PROVIDER_ID, blocked));
        expect(broadcastToRenderer).toHaveBeenCalledTimes(1);
      } finally {
        nowSpy.mockRestore();
      }
    });
  });

  describe("forge-token-health-changed", () => {
    it("broadcasts provider-keyed token health on the forge channel", () => {
      const entry = makeEntry();
      router.routeHostEvent(entry, {
        type: "forge-token-health-changed",
        providerId: FAKE_PROVIDER_ID,
        isUnhealthy: true,
      });

      expect(broadcastToRenderer).toHaveBeenCalledTimes(1);
      expect(broadcastToRenderer).toHaveBeenCalledWith(CHANNELS.FORGE_TOKEN_HEALTH_CHANGED, {
        providerId: FAKE_PROVIDER_ID,
        isUnhealthy: true,
      });
    });
  });

  describe("forge-remote-changed (#11155)", () => {
    it("broadcasts a project-scoped signal so the renderer re-resolves its provider", () => {
      const entry = makeEntry({ projectPath: "/project/test", projectId: "test-project-id" });
      router.routeHostEvent(entry, { type: "forge-remote-changed" });

      expect(broadcastToRenderer).toHaveBeenCalledTimes(1);
      expect(broadcastToRenderer).toHaveBeenCalledWith(CHANNELS.EVENTS_PUSH, {
        name: "forge:remote-changed",
        payload: { projectId: "test-project-id" },
      });
    });

    it("scopes the signal to the emitting host's project", () => {
      router.routeHostEvent(makeEntry({ projectPath: "/a", projectId: "project-a-id" }), {
        type: "forge-remote-changed",
      });
      router.routeHostEvent(makeEntry({ projectPath: "/b", projectId: "project-b-id" }), {
        type: "forge-remote-changed",
      });

      const projectIds = vi
        .mocked(broadcastToRenderer)
        .mock.calls.map(([, payload]) => (payload as { payload: { projectId: string } }).payload);
      expect(projectIds).toEqual([{ projectId: "project-a-id" }, { projectId: "project-b-id" }]);
    });

    it("carries no remote URL — https remotes can embed credentials", () => {
      router.routeHostEvent(makeEntry(), { type: "forge-remote-changed" });

      const [, payload] = vi.mocked(broadcastToRenderer).mock.calls[0]!;
      expect(Object.keys((payload as { payload: Record<string, unknown> }).payload)).toEqual([
        "projectId",
      ]);
    });
  });
});
