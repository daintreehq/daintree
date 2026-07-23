import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeSnapshot, WorktreeEventVersion } from "@shared/types";

// Mutation-outbox tests (#8405). Covers the lifecycle of `mutationOutbox`
// entries: creation, replay-after-reconnect (target-present vs target-already-gone),
// ack pruning via `pruneAcknowledgedMutations`, error classification
// (permanent / connectivity / generic with retry cap), `retryOutboxEntry` /
// `dismissOutboxEntry`, and survival across `setFatalError`.

const TEST_EPOCH = "test-epoch";
const OTHER_EPOCH = "other-epoch";
let _seq = 0;
function nextV(epoch: string = TEST_EPOCH): WorktreeEventVersion {
  return { epoch, seq: ++_seq };
}

const {
  worktreeClientDeleteMock,
  worktreeClientAttachIssueMock,
  worktreeClientDetachIssueMock,
  closeTerminalsForWorktreeMock,
  restoreClosedTerminalsMock,
  notifyMock,
  devPreviewGetByWorktreeMock,
  devPreviewStopByWorktreeMock,
} = vi.hoisted(() => ({
  worktreeClientDeleteMock:
    vi.fn<
      (id: string, force?: boolean, deleteBranch?: boolean, mutationId?: string) => Promise<void>
    >(),
  worktreeClientAttachIssueMock:
    vi.fn<(payload: import("@shared/types").AttachIssuePayload) => Promise<void>>(),
  worktreeClientDetachIssueMock: vi.fn<(worktreeId: string) => Promise<void>>(),
  closeTerminalsForWorktreeMock: vi.fn<(id: string) => Promise<unknown[]>>(),
  restoreClosedTerminalsMock: vi.fn<(snapshot: readonly unknown[]) => Promise<void>>(),
  notifyMock: vi.fn(),
  devPreviewGetByWorktreeMock: vi.fn().mockResolvedValue(null),
  devPreviewStopByWorktreeMock: vi.fn().mockResolvedValue(undefined),
}));

(globalThis as Record<string, unknown>).window = globalThis.window ?? {};
(window as unknown as Record<string, unknown>).electron = {
  ...((window as unknown as Record<string, unknown>).electron ?? {}),
  devPreview: {
    getByWorktree: devPreviewGetByWorktreeMock,
    stopByWorktree: devPreviewStopByWorktreeMock,
  },
};

vi.mock("@/clients", async () => {
  const actual = await vi.importActual<typeof import("@/clients")>("@/clients");
  return {
    ...actual,
    worktreeClient: {
      ...actual.worktreeClient,
      delete: worktreeClientDeleteMock,
      attachIssue: worktreeClientAttachIssueMock,
      detachIssue: worktreeClientDetachIssueMock,
    },
  };
});

vi.mock("@/components/Worktree/worktreeDeleteHelper", () => ({
  closeTerminalsForWorktree: closeTerminalsForWorktreeMock,
  restoreClosedTerminals: restoreClosedTerminalsMock,
}));

vi.mock("@/lib/notify", () => ({
  notify: notifyMock,
}));

import { createWorktreeStore, OUTBOX_RETRY_CAP } from "@/store/createWorktreeStore";

function makeSnapshot(id: string): WorktreeSnapshot {
  return {
    id,
    name: id,
    branch: "main",
    path: `/repo/${id}`,
    isCurrent: false,
    isMainWorktree: false,
    modifiedCount: 0,
    changes: [],
    summary: "",
    mood: null,
    gitDir: "",
  } as unknown as WorktreeSnapshot;
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createWorktreeStore — mutation outbox (#8405)", () => {
  beforeEach(() => {
    worktreeClientDeleteMock.mockReset();
    worktreeClientAttachIssueMock.mockReset();
    worktreeClientDetachIssueMock.mockReset();
    closeTerminalsForWorktreeMock.mockReset();
    restoreClosedTerminalsMock.mockReset();
    notifyMock.mockReset();
    worktreeClientDeleteMock.mockResolvedValue();
    worktreeClientAttachIssueMock.mockResolvedValue();
    worktreeClientDetachIssueMock.mockResolvedValue();
    closeTerminalsForWorktreeMock.mockResolvedValue([]);
    restoreClosedTerminalsMock.mockResolvedValue();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("entry creation + success path", () => {
    it("initializes with an empty outbox", () => {
      const store = createWorktreeStore();
      expect(store.getState().mutationOutbox.size).toBe(0);
    });

    it("startDelete creates one in-flight entry with a fresh mutationId", async () => {
      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      store.getState().startDelete("wt-1", { force: true, deleteBranch: false });

      const outbox = store.getState().mutationOutbox;
      expect(outbox.size).toBe(1);
      const entry = [...outbox.values()][0]!;
      expect(entry.worktreeId).toBe("wt-1");
      expect(entry.type).toBe("delete-worktree");
      expect(entry.status).toBe("in-flight");
      expect(entry.retryCount).toBe(0);
      if (entry.type !== "delete-worktree") throw new Error("expected delete entry");
      expect(entry.options).toEqual({ force: true, deleteBranch: false });
      expect(typeof entry.mutationId).toBe("string");
      expect(entry.mutationId.length).toBeGreaterThan(0);

      // Drain the IPC promise so it doesn't leak across tests.
      await flushPromises();
      await flushPromises();
    });

    it("applyRemove prunes the matching outbox entry on the success path", async () => {
      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      store.getState().startDelete("wt-1", { force: false });
      expect(store.getState().mutationOutbox.size).toBe(1);

      // Simulate the `worktree-removed` event firing applyRemove.
      store.getState().applyRemove("wt-1", nextV());

      expect(store.getState().mutationOutbox.size).toBe(0);
      // Drain IPC.
      await flushPromises();
      await flushPromises();
    });

    it("on resolved IPC, success branch prunes the outbox entry", async () => {
      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      store.getState().startDelete("wt-1", { force: false });
      await flushPromises();
      await flushPromises();

      // No worktree-removed event yet, but IPC resolved successfully:
      // pruneOutboxEntry should have removed the entry.
      expect(store.getState().mutationOutbox.size).toBe(0);
    });

    it("retryDelete reuses the same mutationId so the host can dedupe", async () => {
      worktreeClientDeleteMock.mockRejectedValueOnce(new Error("transient failure"));

      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      store.getState().startDelete("wt-1", { force: true, deleteBranch: true });
      const firstMutationId = [...store.getState().mutationOutbox.values()][0]!.mutationId;

      await flushPromises();
      await flushPromises();

      worktreeClientDeleteMock.mockResolvedValueOnce();
      store.getState().retryDelete("wt-1");
      // Drain the pre-delete awaits (getByWorktree, stopByWorktree) so the
      // second worktreeClient.delete fires before we inspect mock.calls.
      await flushPromises();
      await flushPromises();

      const callMutationIds = worktreeClientDeleteMock.mock.calls.map((c) => c[3]);
      expect(callMutationIds[0]).toBe(firstMutationId);
      expect(callMutationIds[1]).toBe(firstMutationId);
    });
  });

  describe("error classification", () => {
    it("permanent errors flip the entry to failed in a single attempt", async () => {
      worktreeClientDeleteMock.mockRejectedValueOnce(
        new Error("Worktree has uncommitted changes. Use force delete to proceed.")
      );

      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      store.getState().startDelete("wt-1", { force: false });
      await flushPromises();
      await flushPromises();

      const entry = [...store.getState().mutationOutbox.values()][0]!;
      expect(entry.status).toBe("failed");
      // Permanent classification does NOT charge the retry counter — the failure
      // is deterministic, not a flake.
      expect(entry.retryCount).toBe(0);
      expect(entry.lastError).toContain("uncommitted changes");
      expect(store.getState().deleteErrors.get("wt-1")).toContain("uncommitted changes");
    });

    it("generic errors retry up to the cap before failing", async () => {
      worktreeClientDeleteMock.mockRejectedValue(new Error("git error: ref already exists"));

      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      store.getState().startDelete("wt-1", { force: false });
      await flushPromises();
      await flushPromises();

      let entry = [...store.getState().mutationOutbox.values()][0]!;
      expect(entry.status).toBe("pending");
      expect(entry.retryCount).toBe(1);

      // Re-fire via retryDelete (path the card's Retry button uses today).
      store.getState().retryDelete("wt-1");
      await flushPromises();
      await flushPromises();
      entry = [...store.getState().mutationOutbox.values()][0]!;
      expect(entry.retryCount).toBe(2);
      expect(entry.status).toBe("pending");

      store.getState().retryDelete("wt-1");
      await flushPromises();
      await flushPromises();
      entry = [...store.getState().mutationOutbox.values()][0]!;
      // Cap is OUTBOX_RETRY_CAP — third generic failure flips to failed.
      expect(entry.retryCount).toBe(OUTBOX_RETRY_CAP);
      expect(entry.status).toBe("failed");
    });

    it("restores closed terminals only when generic retries exhaust the cap, using the first snapshot (#11344)", async () => {
      worktreeClientDeleteMock.mockRejectedValue(new Error("git error: ref already exists"));
      const SNAPSHOT = [{ id: "t-1", location: "grid" }];
      // Only the first attempt has live terminals to snapshot; every replay
      // finds none (default `[]`), which must NOT clobber the held snapshot.
      closeTerminalsForWorktreeMock.mockResolvedValueOnce(SNAPSHOT);

      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      store.getState().startDelete("wt-1", { closeTerminals: true, force: false });
      await flushPromises();
      await flushPromises();
      // Still pending (retry 1) — do not relaunch yet.
      expect(restoreClosedTerminalsMock).not.toHaveBeenCalled();

      store.getState().retryDelete("wt-1");
      await flushPromises();
      await flushPromises();
      expect(restoreClosedTerminalsMock).not.toHaveBeenCalled();

      store.getState().retryDelete("wt-1");
      await flushPromises();
      await flushPromises();

      // Cap reached → failed → relaunch exactly once, with the original capture
      // (the empty replays never overwrote it).
      expect([...store.getState().mutationOutbox.values()][0]!.status).toBe("failed");
      expect(restoreClosedTerminalsMock).toHaveBeenCalledTimes(1);
      expect(restoreClosedTerminalsMock).toHaveBeenCalledWith(SNAPSHOT);
    });

    it("connectivity errors leave entry pending and DO NOT charge the retry cap", async () => {
      worktreeClientDeleteMock.mockRejectedValueOnce(
        new Error("HOST_EXITED: Worktree port disconnected")
      );

      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      store.getState().startDelete("wt-1", { force: false });
      await flushPromises();
      await flushPromises();

      const entry = [...store.getState().mutationOutbox.values()][0]!;
      expect(entry.status).toBe("pending");
      expect(entry.retryCount).toBe(0);
      // Card stays clean — global reconnect indicator covers the failure.
      expect(store.getState().deletingIds.has("wt-1")).toBe(false);
      expect(store.getState().deleteErrors.has("wt-1")).toBe(false);
    });
  });

  describe("setFatalError preservation", () => {
    it("setFatalError preserves the mutation outbox", async () => {
      worktreeClientDeleteMock.mockRejectedValueOnce(
        new Error("HOST_EXITED: Worktree port disconnected")
      );

      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      store.getState().startDelete("wt-1", { force: false });
      await flushPromises();
      await flushPromises();

      const beforeEntry = [...store.getState().mutationOutbox.values()][0]!;
      expect(beforeEntry).toBeDefined();

      store.getState().setFatalError("Workspace service crashed and could not recover");

      // Outbox survives the fatal error so a manual restart can replay it.
      const afterEntry = store.getState().mutationOutbox.get(beforeEntry.mutationId);
      expect(afterEntry).toBeDefined();
      expect(afterEntry?.mutationId).toBe(beforeEntry.mutationId);
      expect(afterEntry?.status).toBe("pending");
      // manualAssociations is still cleared (regression guard against the
      // existing setFatalError behavior).
      expect(store.getState().manualAssociations.size).toBe(0);
    });

    it("replay fires after setFatalError + manual restart even though isInitialized is false (#8405 review #2)", async () => {
      // Reproduce the post-fatal-restart sequence: outbox entry stays
      // `pending` through `setFatalError`; the WorktreeStoreContext's
      // post-restart `fetchInitialState` then captures `isWake = false`
      // (because setFatalError reset isInitialized). The replay path must
      // still fire when there are outbox entries to drain — otherwise the
      // preserved outbox is inert and the user's pending delete is silently
      // abandoned.
      worktreeClientDeleteMock.mockRejectedValueOnce(
        new Error("HOST_EXITED: Worktree port disconnected")
      );

      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());
      store.getState().startDelete("wt-1", { force: false });
      await flushPromises();
      await flushPromises();

      const entry = [...store.getState().mutationOutbox.values()][0]!;
      expect(entry.status).toBe("pending");

      // Simulate the fatal-disconnect + manual restart cycle.
      store.getState().setFatalError("Workspace service crashed");
      expect(store.getState().isInitialized).toBe(false);
      expect(store.getState().mutationOutbox.size).toBe(1);

      // Post-restart hydration: snapshot still has wt-1 because the original
      // delete never actually ran.
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV(OTHER_EPOCH));

      // The replay must fire — the gate in WorktreeStoreContext is
      // `isWake || mutationOutbox.size > 0`, so even with isWake=false the
      // pending entry replays.
      worktreeClientDeleteMock.mockResolvedValueOnce();
      store.getState().replayOutboxAfterReconnect();
      await flushPromises();
      await flushPromises();

      const lastCallId = worktreeClientDeleteMock.mock.calls.at(-1)![3];
      expect(lastCallId).toBe(entry.mutationId);
    });
  });

  describe("pruneAcknowledgedMutations", () => {
    it("removes matching entries by mutationId", async () => {
      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1"), makeSnapshot("wt-2")], nextV());

      worktreeClientDeleteMock.mockRejectedValue(
        new Error("HOST_EXITED: Worktree port disconnected")
      );
      store.getState().startDelete("wt-1", { force: false });
      store.getState().startDelete("wt-2", { force: false });
      await flushPromises();
      await flushPromises();

      const entries = [...store.getState().mutationOutbox.values()];
      expect(entries.length).toBe(2);
      const wt1Id = entries.find((e) => e.worktreeId === "wt-1")!.mutationId;

      store.getState().pruneAcknowledgedMutations([wt1Id]);

      expect(store.getState().mutationOutbox.size).toBe(1);
      expect([...store.getState().mutationOutbox.values()][0]!.worktreeId).toBe("wt-2");
    });

    it("an empty ack list is a no-op", async () => {
      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      worktreeClientDeleteMock.mockRejectedValueOnce(
        new Error("HOST_EXITED: Worktree port disconnected")
      );
      store.getState().startDelete("wt-1", { force: false });
      await flushPromises();
      await flushPromises();

      const before = store.getState().mutationOutbox;
      store.getState().pruneAcknowledgedMutations([]);
      // Identity-equal — no churn.
      expect(store.getState().mutationOutbox).toBe(before);
    });

    it("clears deletingIds for every pruned worktree, not just the last (#8405 review #3)", async () => {
      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1"), makeSnapshot("wt-2")], nextV());

      // Hold both IPCs open so both cards stay in `deletingIds` when we ack.
      const resolvers: Array<() => void> = [];
      worktreeClientDeleteMock.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolvers.push(resolve);
          })
      );
      store.getState().startDelete("wt-1", { force: false });
      store.getState().startDelete("wt-2", { force: false });
      await flushPromises();
      const entries = [...store.getState().mutationOutbox.values()];
      const ids = entries.map((e) => e.mutationId);
      expect(store.getState().deletingIds.has("wt-1")).toBe(true);
      expect(store.getState().deletingIds.has("wt-2")).toBe(true);

      store.getState().pruneAcknowledgedMutations(ids);

      // Both cards must be cleaned up — not just the last one in iteration order.
      expect(store.getState().mutationOutbox.size).toBe(0);
      expect(store.getState().deletingIds.has("wt-1")).toBe(false);
      expect(store.getState().deletingIds.has("wt-2")).toBe(false);

      // Drain the open IPCs.
      for (const r of resolvers) r();
      await flushPromises();
    });

    it("clears deletingIds for the pruned worktree as a safety sweep", async () => {
      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      // Hold the IPC open so the card stays in `deletingIds` while we ack.
      let resolveDelete: () => void = () => {};
      worktreeClientDeleteMock.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveDelete = resolve;
          })
      );
      store.getState().startDelete("wt-1", { force: false });
      await flushPromises();
      const entry = [...store.getState().mutationOutbox.values()][0]!;
      expect(store.getState().deletingIds.has("wt-1")).toBe(true);

      store.getState().pruneAcknowledgedMutations([entry.mutationId]);

      expect(store.getState().mutationOutbox.size).toBe(0);
      expect(store.getState().deletingIds.has("wt-1")).toBe(false);

      // Drain the open IPC.
      resolveDelete();
      await flushPromises();
    });
  });

  describe("replayOutboxAfterReconnect", () => {
    it("re-fires pending entries whose target still exists in the snapshot", async () => {
      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      worktreeClientDeleteMock.mockRejectedValueOnce(
        new Error("HOST_EXITED: Worktree port disconnected")
      );
      store.getState().startDelete("wt-1", { force: false });
      await flushPromises();
      await flushPromises();

      const entry = [...store.getState().mutationOutbox.values()][0]!;
      expect(entry.status).toBe("pending");

      // Simulate the reconnect snapshot — wt-1 is still on disk.
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV(OTHER_EPOCH));

      worktreeClientDeleteMock.mockResolvedValueOnce();
      store.getState().replayOutboxAfterReconnect();

      // Replay flipped to in-flight before firing.
      const flipped = [...store.getState().mutationOutbox.values()][0]!;
      expect(flipped.status).toBe("in-flight");
      expect(flipped.mutationId).toBe(entry.mutationId);

      await flushPromises();
      await flushPromises();

      // The replay used the original mutationId.
      const lastCallId = worktreeClientDeleteMock.mock.calls.at(-1)![3];
      expect(lastCallId).toBe(entry.mutationId);
    });

    it("reconciles pending entries whose target is absent from the snapshot (success-but-ack-lost)", async () => {
      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      worktreeClientDeleteMock.mockRejectedValueOnce(
        new Error("HOST_EXITED: Worktree port disconnected")
      );
      store.getState().startDelete("wt-1", { force: false });
      await flushPromises();
      await flushPromises();

      const entry = [...store.getState().mutationOutbox.values()][0]!;
      expect(entry.status).toBe("pending");

      // Host restarted — fresh epoch and wt-1 is gone (delete completed before
      // the crash but the ack never reached the renderer).
      store.getState().applySnapshot([], nextV(OTHER_EPOCH));
      store.getState().replayOutboxAfterReconnect();

      // The entry is pruned, no replay was fired.
      expect(store.getState().mutationOutbox.size).toBe(0);
      // No new IPC call from the replay path — only the original failure.
      expect(worktreeClientDeleteMock).toHaveBeenCalledTimes(1);
    });

    it("does not re-fire `in-flight` entries (#8405 review #4 — double-replay suppression)", async () => {
      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      // Hold the IPC open so the entry stays `in-flight` while we trigger a
      // second replay sweep.
      let resolveFirst: () => void = () => {};
      worktreeClientDeleteMock.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve;
          })
      );
      store.getState().startDelete("wt-1", { force: false });
      await flushPromises();
      expect([...store.getState().mutationOutbox.values()][0]!.status).toBe("in-flight");

      // A spurious second sweep before the first IPC settles must not fire a
      // duplicate delete.
      store.getState().replayOutboxAfterReconnect();
      await flushPromises();
      expect(worktreeClientDeleteMock).toHaveBeenCalledTimes(1);

      // Drain.
      resolveFirst();
      await flushPromises();
    });

    it("does not re-fire `failed` entries", async () => {
      worktreeClientDeleteMock.mockRejectedValueOnce(
        new Error("Worktree has uncommitted changes. Use force delete to proceed.")
      );

      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      store.getState().startDelete("wt-1", { force: false });
      await flushPromises();
      await flushPromises();
      expect([...store.getState().mutationOutbox.values()][0]!.status).toBe("failed");

      worktreeClientDeleteMock.mockClear();
      store.getState().replayOutboxAfterReconnect();
      await flushPromises();
      await flushPromises();

      expect(worktreeClientDeleteMock).not.toHaveBeenCalled();
      expect([...store.getState().mutationOutbox.values()][0]!.status).toBe("failed");
    });
  });

  describe("retryOutboxEntry / dismissOutboxEntry", () => {
    it("retryOutboxEntry resets retryCount and re-fires", async () => {
      worktreeClientDeleteMock.mockRejectedValueOnce(
        new Error("Worktree has uncommitted changes. Use force delete to proceed.")
      );

      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      store.getState().startDelete("wt-1", { force: false });
      await flushPromises();
      await flushPromises();
      const entry = [...store.getState().mutationOutbox.values()][0]!;
      expect(entry.status).toBe("failed");

      worktreeClientDeleteMock.mockResolvedValueOnce();
      store.getState().retryOutboxEntry(entry.mutationId);

      const flipped = store.getState().mutationOutbox.get(entry.mutationId)!;
      expect(flipped.status).toBe("in-flight");
      expect(flipped.retryCount).toBe(0);
      expect(flipped.lastError).toBeUndefined();

      await flushPromises();
      await flushPromises();
      expect(worktreeClientDeleteMock).toHaveBeenLastCalledWith(
        "wt-1",
        false,
        undefined,
        entry.mutationId
      );
    });

    it("retryOutboxEntry on an unknown mutationId is a no-op", () => {
      const store = createWorktreeStore();
      store.getState().retryOutboxEntry("does-not-exist");
      expect(store.getState().mutationOutbox.size).toBe(0);
      expect(worktreeClientDeleteMock).not.toHaveBeenCalled();
    });

    it("dismissOutboxEntry removes the entry and clears the card error", async () => {
      worktreeClientDeleteMock.mockRejectedValueOnce(
        new Error("Worktree has uncommitted changes. Use force delete to proceed.")
      );

      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      store.getState().startDelete("wt-1", { force: false });
      await flushPromises();
      await flushPromises();
      const entry = [...store.getState().mutationOutbox.values()][0]!;
      expect(store.getState().deleteErrors.get("wt-1")).toContain("uncommitted changes");

      store.getState().dismissOutboxEntry(entry.mutationId);

      expect(store.getState().mutationOutbox.size).toBe(0);
      expect(store.getState().deleteErrors.has("wt-1")).toBe(false);
      expect(store.getState().deleteErrorArgs.has("wt-1")).toBe(false);
    });
  });

  describe("issue-association mutations (#9163)", () => {
    const attachPayload = (worktreeId: string, issueNumber = 42) => ({
      worktreeId,
      issueNumber,
      issueTitle: `Issue ${issueNumber}`,
    });

    describe("entry creation + success path", () => {
      it("startAttachIssue creates one in-flight attach entry", () => {
        const store = createWorktreeStore();
        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

        store.getState().startAttachIssue(attachPayload("wt-1"));

        const outbox = store.getState().mutationOutbox;
        expect(outbox.size).toBe(1);
        const entry = [...outbox.values()][0]!;
        expect(entry.type).toBe("attach-issue");
        expect(entry.worktreeId).toBe("wt-1");
        expect(entry.status).toBe("in-flight");
        expect(store.getState().issueMutatingIds.has("wt-1")).toBe(true);
        // The local association is NOT applied yet — pessimistic ordering means
        // the renderer never gets ahead of the Electron-store write.
        expect(store.getState().manualAssociations.has("wt-1")).toBe(false);
      });

      it("on resolved attach IPC, applies the association and prunes the entry", async () => {
        const store = createWorktreeStore();
        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

        store.getState().startAttachIssue(attachPayload("wt-1", 7));
        await flushPromises();
        await flushPromises();

        expect(worktreeClientAttachIssueMock).toHaveBeenCalledWith(attachPayload("wt-1", 7));
        expect(store.getState().mutationOutbox.size).toBe(0);
        expect(store.getState().issueMutatingIds.has("wt-1")).toBe(false);
        // Now the association is applied (post-success).
        expect(store.getState().manualAssociations.get("wt-1")).toEqual({
          issueNumber: 7,
          issueTitle: "Issue 7",
        });
        expect(store.getState().worktrees.get("wt-1")?.issueNumber).toBe(7);
      });

      it("on resolved detach IPC, clears the association and prunes the entry", async () => {
        const store = createWorktreeStore();
        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());
        // Seed an attached issue.
        store.getState().startAttachIssue(attachPayload("wt-1", 9));
        await flushPromises();
        await flushPromises();
        expect(store.getState().worktrees.get("wt-1")?.issueNumber).toBe(9);

        store.getState().startDetachIssue("wt-1");
        await flushPromises();
        await flushPromises();

        expect(worktreeClientDetachIssueMock).toHaveBeenCalledWith("wt-1");
        expect(store.getState().mutationOutbox.size).toBe(0);
        expect(store.getState().manualAssociations.has("wt-1")).toBe(false);
        expect(store.getState().worktrees.get("wt-1")?.issueNumber).toBeUndefined();
      });
    });

    describe("single-flight guard", () => {
      it("blocks a second attach while one is in flight", async () => {
        const store = createWorktreeStore();
        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

        let resolveFirst: () => void = () => {};
        worktreeClientAttachIssueMock.mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              resolveFirst = resolve;
            })
        );
        store.getState().startAttachIssue(attachPayload("wt-1", 1));
        await flushPromises();
        store.getState().startAttachIssue(attachPayload("wt-1", 2));

        // Second call is a no-op — still one in-flight entry, one IPC.
        expect(store.getState().mutationOutbox.size).toBe(1);
        expect(worktreeClientAttachIssueMock).toHaveBeenCalledTimes(1);

        resolveFirst();
        await flushPromises();
      });

      it("shares the key with detach so attach then detach can't interleave", async () => {
        const store = createWorktreeStore();
        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

        let resolveAttach: () => void = () => {};
        worktreeClientAttachIssueMock.mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              resolveAttach = resolve;
            })
        );
        store.getState().startAttachIssue(attachPayload("wt-1"));
        await flushPromises();
        store.getState().startDetachIssue("wt-1");

        // Detach is blocked while the attach is in flight.
        expect(worktreeClientDetachIssueMock).not.toHaveBeenCalled();
        const entry = [...store.getState().mutationOutbox.values()][0]!;
        expect(entry.type).toBe("attach-issue");

        resolveAttach();
        await flushPromises();
      });
    });

    describe("error classification", () => {
      it("connectivity errors leave the entry pending with no banner", async () => {
        worktreeClientAttachIssueMock.mockRejectedValueOnce(
          new Error("HOST_EXITED: Worktree port disconnected")
        );

        const store = createWorktreeStore();
        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

        store.getState().startAttachIssue(attachPayload("wt-1"));
        await flushPromises();
        await flushPromises();

        const entry = [...store.getState().mutationOutbox.values()][0]!;
        expect(entry.status).toBe("pending");
        expect(entry.retryCount).toBe(0);
        expect(store.getState().issueMutatingIds.has("wt-1")).toBe(false);
        expect(store.getState().issueErrors.has("wt-1")).toBe(false);
      });

      it("generic errors retry up to the cap then flip to failed with a banner", async () => {
        worktreeClientAttachIssueMock.mockRejectedValue(new Error("network blip"));

        const store = createWorktreeStore();
        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

        store.getState().startAttachIssue(attachPayload("wt-1"));
        await flushPromises();
        await flushPromises();

        let entry = [...store.getState().mutationOutbox.values()][0]!;
        expect(entry.status).toBe("pending");
        expect(entry.retryCount).toBe(1);
        // Banner shows immediately, even while still retry-eligible.
        expect(store.getState().issueErrors.get("wt-1")?.type).toBe("attach-issue");

        store.getState().retryOutboxEntry(entry.mutationId);
        await flushPromises();
        await flushPromises();
        // Banner-driven retry resets the budget to 0, so this counts as 1.
        entry = [...store.getState().mutationOutbox.values()][0]!;
        expect(entry.retryCount).toBe(1);
        expect(entry.status).toBe("pending");
      });

      it("flips to failed once the retry cap is reached", async () => {
        worktreeClientAttachIssueMock.mockRejectedValue(new Error("network blip"));

        const store = createWorktreeStore();
        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

        // Drive cap consecutive failures via reconnect replays (which keep the
        // budget — only user retries reset it).
        store.getState().startAttachIssue(attachPayload("wt-1"));
        await flushPromises();
        await flushPromises();
        for (let i = 1; i < OUTBOX_RETRY_CAP; i++) {
          store.getState().replayOutboxAfterReconnect();
          await flushPromises();
          await flushPromises();
        }

        const entry = [...store.getState().mutationOutbox.values()][0]!;
        expect(entry.retryCount).toBe(OUTBOX_RETRY_CAP);
        expect(entry.status).toBe("failed");
        expect(store.getState().issueErrors.get("wt-1")?.message).toContain("network blip");
      });
    });

    describe("setFatalError + replay", () => {
      it("preserves issue entries across setFatalError", async () => {
        worktreeClientAttachIssueMock.mockRejectedValueOnce(
          new Error("HOST_EXITED: Worktree port disconnected")
        );

        const store = createWorktreeStore();
        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());
        store.getState().startAttachIssue(attachPayload("wt-1"));
        await flushPromises();
        await flushPromises();

        const before = [...store.getState().mutationOutbox.values()][0]!;
        store.getState().setFatalError("Workspace service crashed");

        const after = store.getState().mutationOutbox.get(before.mutationId);
        expect(after).toBeDefined();
        expect(after?.type).toBe("attach-issue");
        expect(after?.status).toBe("pending");
      });

      it("replays a pending issue entry whose target still exists", async () => {
        worktreeClientAttachIssueMock.mockRejectedValueOnce(
          new Error("HOST_EXITED: Worktree port disconnected")
        );

        const store = createWorktreeStore();
        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());
        store.getState().startAttachIssue(attachPayload("wt-1", 5));
        await flushPromises();
        await flushPromises();
        expect([...store.getState().mutationOutbox.values()][0]!.status).toBe("pending");

        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV(OTHER_EPOCH));
        worktreeClientAttachIssueMock.mockResolvedValueOnce();
        store.getState().replayOutboxAfterReconnect();
        await flushPromises();
        await flushPromises();

        // Replay succeeded — entry pruned, association applied.
        expect(store.getState().mutationOutbox.size).toBe(0);
        expect(store.getState().worktrees.get("wt-1")?.issueNumber).toBe(5);
      });

      it("reconciles (prunes) a pending issue entry whose target is gone", async () => {
        worktreeClientAttachIssueMock.mockRejectedValueOnce(
          new Error("HOST_EXITED: Worktree port disconnected")
        );

        const store = createWorktreeStore();
        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());
        store.getState().startAttachIssue(attachPayload("wt-1"));
        await flushPromises();
        await flushPromises();

        store.getState().applySnapshot([], nextV(OTHER_EPOCH));
        store.getState().replayOutboxAfterReconnect();

        expect(store.getState().mutationOutbox.size).toBe(0);
        // Only the original failed call — no replay was fired for the gone target.
        expect(worktreeClientAttachIssueMock).toHaveBeenCalledTimes(1);
      });
    });

    describe("retry / dismiss / removal", () => {
      it("retryOutboxEntry re-fires a failed issue entry", async () => {
        worktreeClientAttachIssueMock.mockRejectedValue(new Error("network blip"));

        const store = createWorktreeStore();
        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());
        store.getState().startAttachIssue(attachPayload("wt-1"));
        await flushPromises();
        await flushPromises();
        const entry = [...store.getState().mutationOutbox.values()][0]!;

        worktreeClientAttachIssueMock.mockResolvedValueOnce();
        store.getState().retryOutboxEntry(entry.mutationId);
        expect(store.getState().mutationOutbox.get(entry.mutationId)?.status).toBe("in-flight");
        await flushPromises();
        await flushPromises();

        expect(store.getState().mutationOutbox.size).toBe(0);
        expect(store.getState().issueErrors.has("wt-1")).toBe(false);
      });

      it("dismissOutboxEntry removes the issue entry and clears the banner", async () => {
        worktreeClientAttachIssueMock.mockRejectedValue(new Error("network blip"));

        const store = createWorktreeStore();
        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());
        store.getState().startAttachIssue(attachPayload("wt-1"));
        await flushPromises();
        await flushPromises();
        const entry = [...store.getState().mutationOutbox.values()][0]!;
        expect(store.getState().issueErrors.has("wt-1")).toBe(true);

        store.getState().dismissOutboxEntry(entry.mutationId);

        expect(store.getState().mutationOutbox.size).toBe(0);
        expect(store.getState().issueErrors.has("wt-1")).toBe(false);
        expect(store.getState().issueMutatingIds.has("wt-1")).toBe(false);
      });

      it("applyRemove prunes issue entries and clears issue state", async () => {
        worktreeClientAttachIssueMock.mockRejectedValueOnce(new Error("network blip"));

        const store = createWorktreeStore();
        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());
        store.getState().startAttachIssue(attachPayload("wt-1"));
        await flushPromises();
        await flushPromises();
        expect(store.getState().issueErrors.has("wt-1")).toBe(true);

        store.getState().applyRemove("wt-1", nextV());

        expect(store.getState().mutationOutbox.size).toBe(0);
        expect(store.getState().issueErrors.has("wt-1")).toBe(false);
        expect(store.getState().issueMutatingIds.has("wt-1")).toBe(false);
      });

      it("prunes both a delete and an issue entry for the same worktree", async () => {
        const store = createWorktreeStore();
        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

        // A connectivity-failed attach left pending, plus an in-flight delete.
        worktreeClientAttachIssueMock.mockRejectedValueOnce(
          new Error("HOST_EXITED: Worktree port disconnected")
        );
        store.getState().startAttachIssue(attachPayload("wt-1"));
        await flushPromises();
        await flushPromises();
        let resolveDelete: () => void = () => {};
        worktreeClientDeleteMock.mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              resolveDelete = resolve;
            })
        );
        store.getState().startDelete("wt-1", { force: false });
        await flushPromises();
        expect(store.getState().mutationOutbox.size).toBe(2);

        store.getState().applyRemove("wt-1", nextV());

        expect(store.getState().mutationOutbox.size).toBe(0);
        expect(store.getState().deletingIds.has("wt-1")).toBe(false);
        expect(store.getState().issueMutatingIds.has("wt-1")).toBe(false);

        resolveDelete();
        await flushPromises();
      });
    });

    describe("supersession race (#9163 review)", () => {
      it("attach resolving after applyRemove leaves no orphaned manualAssociation", async () => {
        const store = createWorktreeStore();
        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

        let resolveAttach: () => void = () => {};
        worktreeClientAttachIssueMock.mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              resolveAttach = resolve;
            })
        );
        store.getState().startAttachIssue(attachPayload("wt-1"));
        await flushPromises();

        // Worktree removed while the attach IPC is still outstanding.
        store.getState().applyRemove("wt-1", nextV());
        expect(store.getState().mutationOutbox.size).toBe(0);

        // The IPC now resolves — the success path must NOT resurrect state.
        resolveAttach();
        await flushPromises();
        await flushPromises();

        expect(store.getState().manualAssociations.has("wt-1")).toBe(false);
        expect(store.getState().mutationOutbox.size).toBe(0);
        expect(store.getState().issueMutatingIds.has("wt-1")).toBe(false);
      });

      it("attach rejecting after applyRemove leaves no orphaned issueError", async () => {
        const store = createWorktreeStore();
        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

        let rejectAttach: (e: Error) => void = () => {};
        worktreeClientAttachIssueMock.mockImplementationOnce(
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectAttach = reject;
            })
        );
        store.getState().startAttachIssue(attachPayload("wt-1"));
        await flushPromises();

        store.getState().applyRemove("wt-1", nextV());
        expect(store.getState().mutationOutbox.size).toBe(0);

        rejectAttach(new Error("network blip"));
        await flushPromises();
        await flushPromises();

        expect(store.getState().issueErrors.has("wt-1")).toBe(false);
        expect(store.getState().mutationOutbox.size).toBe(0);
        expect(store.getState().issueMutatingIds.has("wt-1")).toBe(false);
      });
    });
  });
});
