// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetFailureStore } from "@/store/fleetFailureStore";
import { useFleetBroadcastProgressStore } from "@/store/fleetBroadcastProgressStore";
import { useFleetResolutionPreviewStore } from "@/store/fleetResolutionPreviewStore";
import {
  useFleetTargetOverridesStore,
  __resetFleetTargetOverridesStoreForTesting,
  subscribeFleetTargetOverridesPruning,
} from "@/store/fleetTargetOverridesStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { useFleetRunStore } from "@/store/fleetRunStore";
import { usePanelStore } from "@/store/panelStore";
import type { PtyPanelData } from "@shared/types/panel";

const submitMock = vi.fn<(id: string, text: string) => Promise<void>>();

vi.mock("@/clients", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/clients")>();
  return {
    ...actual,
    terminalClient: {
      ...actual.terminalClient,
      submit: (id: string, text: string) => submitMock(id, text),
    },
  };
});

import { cancelActiveBroadcast, tryFleetBroadcastFromEditor } from "../fleetEnterBroadcast";

function makeAgent(id: string): PtyPanelData {
  return {
    id,
    title: id,
    kind: "terminal",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    detectedAgentId: "claude",
    worktreeId: "wt-1",
    projectId: "proj-1",
    location: "grid",
    agentState: "idle",
    hasPty: true,
  } as PtyPanelData;
}

function arm(ids: string[]): void {
  const panelsById: Record<string, PtyPanelData> = {};
  for (const id of ids) panelsById[id] = makeAgent(id);
  usePanelStore.setState({ panelsById, panelIds: ids });
  useFleetArmingStore.getState().armIds(ids);
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  submitMock.mockReset();
  submitMock.mockResolvedValue(undefined);
  useFleetArmingStore.setState({
    armedIds: new Set<string>(),
    armOrder: [],
    armOrderById: {},
    lastArmedId: null,
  });
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
  useFleetFailureStore.getState().clear();
  useFleetBroadcastProgressStore.setState({
    completed: 0,
    total: 0,
    failed: 0,
    isActive: false,
    cancelled: false,
  });
  useFleetResolutionPreviewStore.getState().clear();
  __resetFleetTargetOverridesStoreForTesting();
  useFleetRunStore.getState()._reset();
  useAnnouncerStore.setState({ polite: null, assertive: null, nextId: 1 });
  Object.assign(window, {
    electron: {
      notification: {
        playUiEvent: vi.fn().mockResolvedValue(undefined),
      },
      // The broadcast path records the run via runHistory.append (fire-and-forget).
      runHistory: {
        append: vi.fn().mockResolvedValue(undefined),
      },
    },
  });
});

describe("tryFleetBroadcastFromEditor — a11y announcements", () => {
  it("announces 'Broadcast sent to N terminals' on full success (plural)", async () => {
    arm(["a", "b", "c"]);
    const onSent = vi.fn();
    const consumed = tryFleetBroadcastFromEditor("a", "hello", onSent);
    expect(consumed).toBe(true);
    await flush();
    expect(useAnnouncerStore.getState().polite?.msg).toBe("Broadcast sent to 3 terminals");
    expect(onSent).toHaveBeenCalled();
  });

  it("announces singular form when exactly one target succeeds", async () => {
    // Two armed; only one fires successfully (dead pty rejects with EPIPE,
    // which is a permanent classification — the announcer calls it out as
    // "unreachable" so the user can tell auto-disarmed targets apart from
    // retryable transient failures).
    submitMock.mockImplementation(async (id) => {
      if (id === "b") throw new Error("EPIPE");
    });
    arm(["a", "b"]);
    const onSent = vi.fn();
    tryFleetBroadcastFromEditor("a", "hello", onSent);
    await flush();
    expect(useAnnouncerStore.getState().polite?.msg).toBe("Broadcast sent to 1 — 1 unreachable");
  });

  it("announces partial failure with success/failure split (permanent → unreachable)", async () => {
    submitMock.mockImplementation(async (id) => {
      if (id === "c") throw new Error("EPIPE");
    });
    arm(["a", "b", "c"]);
    tryFleetBroadcastFromEditor("a", "hello", vi.fn());
    await flush();
    expect(useAnnouncerStore.getState().polite?.msg).toBe("Broadcast sent to 2 — 1 unreachable");
  });

  it("announces transient-only failures as 'N failed' (retry chip is the recovery)", async () => {
    submitMock.mockImplementation(async (id) => {
      if (id === "c") throw new Error("ENOSPC: disk full");
    });
    arm(["a", "b", "c"]);
    tryFleetBroadcastFromEditor("a", "hello", vi.fn());
    await flush();
    expect(useAnnouncerStore.getState().polite?.msg).toBe("Broadcast sent to 2 — 1 failed");
  });

  it("announces skipped count in batched-cancel path when preempted batches never fire", async () => {
    // FLEET_LARGE_PASTE_BATCH_SIZE is 5. 12 targets with a 120-KB payload
    // triggers the batched path. Cancel after the first batch settles so
    // the remaining 7 are skipped.
    const ids = Array.from({ length: 12 }, (_, i) => `t${i}`);
    const agents = ids.map((id) => makeAgent(id));
    const panelsById: Record<string, PtyPanelData> = {};
    for (const a of agents) panelsById[a.id] = a;
    usePanelStore.setState({ panelsById, panelIds: ids });
    useFleetArmingStore.getState().armIds(ids);

    let batchCount = 0;
    const origAdvance = useFleetBroadcastProgressStore.getState().advance;
    useFleetBroadcastProgressStore.setState({
      advance: (b, f) => {
        batchCount += 1;
        origAdvance(b, f);
        if (batchCount === 1) cancelActiveBroadcast();
      },
    });
    try {
      // Large payload fires immediately (no confirmation); the batched
      // path + cancel produce skippedCount>0.
      tryFleetBroadcastFromEditor(ids[0]!, "x".repeat(120_000), vi.fn());
      for (let i = 0; i < 20; i += 1) await flush();
      expect(useAnnouncerStore.getState().polite?.msg).toBe(
        "Broadcast cancelled — 5 sent, 7 terminals skipped"
      );
    } finally {
      useFleetBroadcastProgressStore.setState({ advance: origAdvance });
    }
  });

  it("announces mixed-kind failure split as 'N retryable, M unreachable'", async () => {
    submitMock.mockImplementation(async (id) => {
      if (id === "c") throw new Error("ENOSPC: disk full");
      if (id === "d") throw new Error("EPIPE");
    });
    arm(["a", "b", "c", "d"]);
    tryFleetBroadcastFromEditor("a", "hello", vi.fn());
    await flush();
    expect(useAnnouncerStore.getState().polite?.msg).toBe(
      "Broadcast sent to 2 — 1 retryable, 1 unreachable"
    );
  });

  it("announces partial cancel with split when permanent failures occurred", async () => {
    // Cancel after a non-batched fan-out where one target rejected with
    // EPIPE: result arrives with cancelled: true, successCount: 1,
    // permanentlyFailedIds: 1. User needs to see both numbers AND the
    // unreachable distinction so they know the dead target was disarmed.
    arm(["a", "b"]);
    const pending: Array<() => void> = [];
    submitMock.mockImplementation(
      (_id: string) =>
        new Promise<void>((resolve, reject) => {
          if (pending.length === 0) {
            // First call resolves cleanly.
            pending.push(() => resolve());
          } else {
            pending.push(() => reject(new Error("EPIPE")));
          }
        })
    );
    tryFleetBroadcastFromEditor("a", "hello", vi.fn());
    while (pending.length < 2) await flush();
    cancelActiveBroadcast();
    for (const fn of pending) fn();
    pending.length = 0;
    for (let i = 0; i < 10; i += 1) await flush();
    expect(useAnnouncerStore.getState().polite?.msg).toBe(
      "Broadcast cancelled — 1 sent, 1 unreachable"
    );
  });
});

describe("tryFleetBroadcastFromEditor — permanent failure auto-disarm (#8706)", () => {
  it("auto-disarms targets whose submit rejects with a permanent errno", async () => {
    // Dead PTY: submit rejection carries EPIPE → fleet must disarm the
    // target so the next broadcast doesn't fire into the gone pipe.
    submitMock.mockImplementation(async (id) => {
      if (id === "dead") throw new Error("EPIPE: terminal dead has no live PTY (exited)");
    });
    arm(["alive", "dead"]);
    expect(useFleetArmingStore.getState().armedIds.has("dead")).toBe(true);
    tryFleetBroadcastFromEditor("alive", "hello", vi.fn());
    await flush();
    expect(useFleetArmingStore.getState().armedIds.has("dead")).toBe(false);
    // Alive target stays armed.
    expect(useFleetArmingStore.getState().armedIds.has("alive")).toBe(true);
  });

  it("does NOT record a failure chip for permanently-failed targets (would auto-dismiss anyway)", async () => {
    submitMock.mockImplementation(async (id) => {
      if (id === "dead") throw new Error("EPIPE");
    });
    arm(["alive", "dead"]);
    tryFleetBroadcastFromEditor("alive", "hello", vi.fn());
    await flush();
    // The dead target was disarmed; no transient chip should exist for it.
    expect(useFleetFailureStore.getState().failedIds.has("dead")).toBe(false);
    // No payload retained either — transient set is empty, so there's
    // nothing for the retry chip to fire on.
    expect(useFleetFailureStore.getState().payload).toBe(null);
  });

  it("records a failure chip for transient errors and leaves arming intact", async () => {
    submitMock.mockImplementation(async (id) => {
      if (id === "slow") throw new Error("ENOSPC: disk full");
    });
    arm(["alive", "slow"]);
    tryFleetBroadcastFromEditor("alive", "hello", vi.fn());
    await flush();
    // Transient → chip recorded so user can retry, arming unchanged.
    expect(useFleetFailureStore.getState().failedIds.has("slow")).toBe(true);
    expect(useFleetFailureStore.getState().payload).toBe("hello");
    expect(useFleetArmingStore.getState().armedIds.has("slow")).toBe(true);
  });

  it("announces mixed-kind failure with zero successful sends", async () => {
    // No fulfilled targets, both kinds rejected — the announcement still
    // needs the split so the user can tell which targets were auto-disarmed
    // from which still appear as retryable chips.
    submitMock.mockImplementation(async (id) => {
      if (id === "perm") throw new Error("EPIPE");
      if (id === "tran") throw new Error("ENOSPC");
    });
    arm(["perm", "tran"]);
    tryFleetBroadcastFromEditor("perm", "hello", vi.fn());
    await flush();
    expect(useAnnouncerStore.getState().polite?.msg).toBe(
      "Broadcast sent to 0 — 1 retryable, 1 unreachable"
    );
  });

  it("splits a mixed run: disarms permanent, records transient, keeps fulfilled clean", async () => {
    submitMock.mockImplementation(async (id) => {
      if (id === "dead") throw new Error("EPIPE");
      if (id === "slow") throw new Error("ENOSPC");
    });
    arm(["alive", "dead", "slow"]);
    tryFleetBroadcastFromEditor("alive", "hello", vi.fn());
    await flush();

    // Permanent → disarmed, no chip.
    expect(useFleetArmingStore.getState().armedIds.has("dead")).toBe(false);
    expect(useFleetFailureStore.getState().failedIds.has("dead")).toBe(false);

    // Transient → still armed, chip recorded for retry.
    expect(useFleetArmingStore.getState().armedIds.has("slow")).toBe(true);
    expect(useFleetFailureStore.getState().failedIds.has("slow")).toBe(true);

    // Fulfilled → still armed, no chip.
    expect(useFleetArmingStore.getState().armedIds.has("alive")).toBe(true);
    expect(useFleetFailureStore.getState().failedIds.has("alive")).toBe(false);
  });
});

describe("tryFleetBroadcastFromEditor — fires immediately without confirmation (#9722)", () => {
  it("fans a destructive draft out to every armed target with no confirm step", async () => {
    arm(["a", "b", "c"]);
    const consumed = tryFleetBroadcastFromEditor("a", "rm -rf /tmp", vi.fn());
    expect(consumed).toBe(true);
    await flush();
    await flush();

    const submittedIds = submitMock.mock.calls.map((call) => call[0]).sort();
    expect(submittedIds).toEqual(["a", "b", "c"]);
  });

  it("fans short, single-line, safe text out immediately", async () => {
    arm(["a", "b"]);
    tryFleetBroadcastFromEditor("a", "npm test", vi.fn());
    await flush();
    expect(submitMock).toHaveBeenCalled();
  });

  it("fires the ribbon commit flash on a successful broadcast", async () => {
    arm(["a", "b"]);
    const before = useFleetArmingStore.getState().broadcastSignal;
    tryFleetBroadcastFromEditor("a", "hello", vi.fn());
    await flush();
    await flush();
    expect(useFleetArmingStore.getState().broadcastSignal).toBe(before + 1);
  });

  it("does NOT fire the ribbon commit flash on a partial failure", async () => {
    // Symmetric guard for the noteBroadcastCommit placement: it lives in the
    // full-success branch only, so a run with any failure must not flash.
    submitMock.mockImplementation(async (id) => {
      if (id === "c") throw new Error("ENOSPC: disk full");
    });
    arm(["a", "b", "c"]);
    const before = useFleetArmingStore.getState().broadcastSignal;
    tryFleetBroadcastFromEditor("a", "hello", vi.fn());
    await flush();
    await flush();
    expect(useFleetArmingStore.getState().broadcastSignal).toBe(before);
  });

  it("returns false so the caller does its own submit when every armed pane is ineligible", async () => {
    arm(["a", "b"]);
    // Both armed panes are trashed → resolveFleetBroadcastTargetIds yields
    // no eligible targets, so the fleet path declines and the caller falls
    // back to its normal single-pane submit.
    usePanelStore.setState({
      panelsById: {
        a: { ...makeAgent("a"), location: "trash" } as PtyPanelData,
        b: { ...makeAgent("b"), location: "trash" } as PtyPanelData,
      },
      panelIds: ["a", "b"],
    });
    const before = useFleetArmingStore.getState().broadcastSignal;
    const consumed = tryFleetBroadcastFromEditor("a", "hello", vi.fn());
    expect(consumed).toBe(false);
    await flush();
    expect(submitMock).not.toHaveBeenCalled();
    expect(useFleetArmingStore.getState().broadcastSignal).toBe(before);
  });

  it("drops targets that became ineligible between Enter-press and dispatch", async () => {
    arm(["a", "b", "c"]);
    // Pane B is trashed before the async dispatch re-checks eligibility.
    usePanelStore.setState({
      panelsById: {
        a: makeAgent("a"),
        b: { ...makeAgent("b"), location: "trash" } as PtyPanelData,
        c: makeAgent("c"),
      },
      panelIds: ["a", "b", "c"],
    });

    tryFleetBroadcastFromEditor("a", "rm -rf /tmp", vi.fn());
    await flush();
    await flush();

    const submittedIds = submitMock.mock.calls.map((call) => call[0]).sort();
    expect(submittedIds).toEqual(["a", "c"]);
  });
});

describe("cancelActiveBroadcast", () => {
  it("aborts the in-flight controller so the run finalizes as cancelled", async () => {
    arm(["a", "b", "c"]);

    // Hold each submit open until we explicitly resolve it. Cancelling
    // while submits are parked guarantees the executor sees signal.aborted
    // when the non-batched allSettled finally resolves.
    const pending: Array<() => void> = [];
    submitMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          pending.push(resolve);
        })
    );

    const onSent = vi.fn();
    const consumed = tryFleetBroadcastFromEditor("a", "hello", onSent);
    expect(consumed).toBe(true);

    // Yield until the submits are in-flight.
    while (pending.length === 0) await flush();

    cancelActiveBroadcast();
    expect(useFleetBroadcastProgressStore.getState().cancelled).toBe(true);

    // Resolve the parked submits so allSettled completes; the executor
    // then evaluates signal.aborted and returns a cancelled result.
    for (const resolve of pending) resolve();
    pending.length = 0;
    for (let i = 0; i < 10; i += 1) await flush();

    expect(useFleetBroadcastProgressStore.getState().isActive).toBe(false);
    expect(useAnnouncerStore.getState().polite?.msg).toMatch(/Broadcast cancelled/);
    expect(onSent).toHaveBeenCalled();
  });

  it("is a no-op when no broadcast is active", () => {
    expect(() => cancelActiveBroadcast()).not.toThrow();
    expect(useFleetBroadcastProgressStore.getState().isActive).toBe(false);
  });
});

describe("tryFleetBroadcastFromEditor — per-target overrides and skips (#8691)", () => {
  it("threads payload overrides into executeFleetBroadcast", async () => {
    arm(["a", "b", "c"]);
    useFleetTargetOverridesStore.getState().setPayloadOverride("b", "custom for b");

    tryFleetBroadcastFromEditor("a", "hello", vi.fn());
    await flush();
    await flush();

    expect(submitMock).toHaveBeenCalledWith("a", "hello");
    expect(submitMock).toHaveBeenCalledWith("b", "custom for b");
    expect(submitMock).toHaveBeenCalledWith("c", "hello");
  });

  it("excludes skipped targets from the broadcast", async () => {
    arm(["a", "b", "c"]);
    useFleetTargetOverridesStore.getState().setSkipped("c", true);

    tryFleetBroadcastFromEditor("a", "hello", vi.fn());
    await flush();
    await flush();

    expect(submitMock).toHaveBeenCalledWith("a", "hello");
    expect(submitMock).toHaveBeenCalledWith("b", "hello");
    expect(submitMock).not.toHaveBeenCalledWith("c", expect.anything());
  });

  it("returns true and skips dispatch when every armed target is skipped", () => {
    arm(["a", "b"]);
    useFleetTargetOverridesStore.getState().setSkipped("a", true);
    useFleetTargetOverridesStore.getState().setSkipped("b", true);
    const onSent = vi.fn();
    const consumed = tryFleetBroadcastFromEditor("a", "hello", onSent);
    expect(consumed).toBe(true);
    expect(submitMock).not.toHaveBeenCalled();
    expect(onSent).toHaveBeenCalled();
    expect(useAnnouncerStore.getState().polite?.msg).toMatch(/all targets/i);
  });

  it("submits the snapshot — overrides cleared mid-send are ignored", async () => {
    // Regression (#8691, #9722): the broadcast snapshots overrides at
    // Enter-press time. A popover-close effect that clears the overrides
    // store while the async fan-out is in flight must not change what the
    // user already committed — the snapshot is the source of truth.
    arm(["a", "b", "c"]);
    useFleetTargetOverridesStore.getState().setPayloadOverride("b", "reviewed");
    tryFleetBroadcastFromEditor("a", "hello", vi.fn());

    // Simulate the popover-close clear racing the in-flight broadcast.
    useFleetTargetOverridesStore.getState().clear();

    await flush();
    await flush();

    // The submission must use the snapshot ("reviewed"), not the cleared
    // live store ("hello" — the default).
    expect(submitMock).toHaveBeenCalledWith("b", "reviewed");
  });

  it("clears the overrides store in the finally block after broadcast", async () => {
    arm(["a", "b"]);
    useFleetTargetOverridesStore.getState().setPayloadOverride("b", "x");
    tryFleetBroadcastFromEditor("a", "hello", vi.fn());
    await flush();
    await flush();
    expect(useFleetTargetOverridesStore.getState().payloadOverrides).toEqual({});
    expect(useFleetTargetOverridesStore.getState().skippedIds.size).toBe(0);
  });

  it("clears overrides and calls onSent when all initial targets are skipped", () => {
    arm(["a", "b"]);
    useFleetTargetOverridesStore.getState().setPayloadOverride("a", "x");
    useFleetTargetOverridesStore.getState().setSkipped("a", true);
    useFleetTargetOverridesStore.getState().setSkipped("b", true);
    const onSent = vi.fn();
    tryFleetBroadcastFromEditor("a", "hello", onSent);
    expect(onSent).toHaveBeenCalled();
    expect(useFleetTargetOverridesStore.getState().payloadOverrides).toEqual({});
    expect(useFleetTargetOverridesStore.getState().skippedIds.size).toBe(0);
  });

  it("fans out cleanly with a stale override left for a disarmed terminal", async () => {
    // A user could leave a stale override for a terminal that later
    // disarmed — it must not affect the broadcast to the remaining fleet.
    useFleetTargetOverridesStore.getState().setPayloadOverride("ghost", "stale");
    arm(["a", "b"]);
    const onSent = vi.fn();
    tryFleetBroadcastFromEditor("a", "hello", onSent);
    await flush();
    expect(submitMock).toHaveBeenCalledTimes(2);
    expect(onSent).toHaveBeenCalled();
  });

  it("re-includes a disarmed-then-rearmed pane once pruning is wired (#9973)", async () => {
    // Exact regression: skip "b", disarm it while the drafting popover is
    // open, then re-arm it before Enter. Without the pruning subscription the
    // stale `skippedIds` entry survives and the snapshot at Enter-press
    // silently excludes "b" forever. With pruning wired, disarm clears the
    // skip so the re-armed pane receives the broadcast.
    arm(["a", "b"]);
    const unsub = subscribeFleetTargetOverridesPruning();
    try {
      useFleetTargetOverridesStore.getState().setSkipped("b", true);
      useFleetArmingStore.getState().disarmId("b");
      useFleetArmingStore.getState().armId("b");

      expect(useFleetTargetOverridesStore.getState().skippedIds.has("b")).toBe(false);

      tryFleetBroadcastFromEditor("a", "hello", vi.fn());
      await flush();
      await flush();

      expect(submitMock).toHaveBeenCalledWith("a", "hello");
      expect(submitMock).toHaveBeenCalledWith("b", "hello");
    } finally {
      unsub();
    }
  });
});

describe("tryFleetBroadcastFromEditor — supervised run integration (#10930)", () => {
  it("records a supervised run and appends run history once it settles", async () => {
    // makeAgent seeds agentState "idle", so every sent target settles on the
    // immediate post-submission reconcile — the run finalizes as completed
    // and the durable history append fires without a watcher subscription.
    arm(["a", "b"]);
    tryFleetBroadcastFromEditor("a", "hello", vi.fn());
    await flush();
    await flush();

    const run = useFleetRunStore.getState().run!;
    expect(run.status).toBe("completed");
    expect(run.targets.map((t) => t.submission)).toEqual(["sent", "sent"]);

    const appendMock = window.electron.runHistory.append as ReturnType<typeof vi.fn>;
    expect(appendMock).toHaveBeenCalledTimes(1);
    const record = appendMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(record).toMatchObject({
      kind: "fleet",
      status: "completed",
      runId: run.runId,
      draftPreview: "hello",
      targetCount: 2,
      successCount: 2,
      failureCount: 0,
      cancelled: false,
    });
  });

  it("classifies submission failures on the run's targets", async () => {
    submitMock.mockImplementation(async (id) => {
      if (id === "dead") throw new Error("EPIPE");
      if (id === "slow") throw new Error("ENOSPC");
    });
    arm(["alive", "dead", "slow"]);
    tryFleetBroadcastFromEditor("alive", "hello", vi.fn());
    await flush();
    await flush();

    const run = useFleetRunStore.getState().run!;
    const byId = new Map(run.targets.map((t) => [t.terminalId, t]));
    expect(byId.get("alive")!.submission).toBe("sent");
    expect(byId.get("dead")!.failureKind).toBe("permanent");
    expect(byId.get("slow")!.failureKind).toBe("transient");
  });

  it("finalizes the run as cancelled with skipped targets on mid-run cancel", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `t${i}`);
    const agents = ids.map((id) => makeAgent(id));
    const panelsById: Record<string, PtyPanelData> = {};
    for (const a of agents) panelsById[a.id] = a;
    usePanelStore.setState({ panelsById, panelIds: ids });
    useFleetArmingStore.getState().armIds(ids);

    let batchCount = 0;
    const origAdvance = useFleetBroadcastProgressStore.getState().advance;
    useFleetBroadcastProgressStore.setState({
      advance: (b, f) => {
        batchCount += 1;
        origAdvance(b, f);
        if (batchCount === 1) cancelActiveBroadcast();
      },
    });
    try {
      tryFleetBroadcastFromEditor(ids[0]!, "x".repeat(120_000), vi.fn());
      for (let i = 0; i < 20; i += 1) await flush();

      const run = useFleetRunStore.getState().run!;
      expect(run.status).toBe("cancelled");
      const skipped = run.targets.filter((t) => t.submission === "skipped");
      expect(skipped).toHaveLength(7);
      const record = (window.electron.runHistory.append as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as Record<string, unknown>;
      expect(record.status).toBe("cancelled");
      expect(record.cancelled).toBe(true);
    } finally {
      useFleetBroadcastProgressStore.setState({ advance: origAdvance });
    }
  });
});
