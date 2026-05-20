// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetFailureStore } from "@/store/fleetFailureStore";
import {
  useFleetBroadcastConfirmStore,
  resolveFleetBroadcastConfirmation,
} from "@/store/fleetBroadcastConfirmStore";
import { useFleetBroadcastProgressStore } from "@/store/fleetBroadcastProgressStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { usePanelStore } from "@/store/panelStore";
import type { TerminalInstance } from "@shared/types";

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

function makeAgent(id: string): TerminalInstance {
  return {
    id,
    title: id,
    kind: "terminal",
    detectedAgentId: "claude",
    worktreeId: "wt-1",
    projectId: "proj-1",
    location: "grid",
    agentState: "idle",
    hasPty: true,
  } as TerminalInstance;
}

function arm(ids: string[]): void {
  const panelsById: Record<string, TerminalInstance> = {};
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
  useFleetBroadcastConfirmStore.setState({ pending: null });
  useFleetBroadcastProgressStore.setState({
    completed: 0,
    total: 0,
    failed: 0,
    isActive: false,
    cancelled: false,
  });
  useAnnouncerStore.setState({ polite: null, assertive: null, nextId: 1 });
  Object.assign(window, {
    electron: {
      notification: {
        playUiEvent: vi.fn().mockResolvedValue(undefined),
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
    const panelsById: Record<string, TerminalInstance> = {};
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
      // Large payload triggers confirmation flow — resolve it so the
      // broadcast fires, then the batched path + cancel produce skippedCount>0.
      resolveFleetBroadcastConfirmation();
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
