// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { broadcastFleetLiteralPaste, executeFleetBroadcast } from "../fleetExecution";
import { FLEET_LARGE_PASTE_BATCH_SIZE } from "../fleetBroadcast";
import { terminalClient } from "@/clients";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { usePanelStore } from "@/store/panelStore";
import { useFleetBroadcastProgressStore } from "@/store/fleetBroadcastProgressStore";
import type { TerminalInstance } from "@shared/types";

const submitMock = vi.fn<(id: string, text: string) => Promise<void>>();
const notifyUserInputMock = vi.hoisted(() => vi.fn<(id: string, data?: string) => void>());
const notifyEnterPressedMock = vi.hoisted(() => vi.fn<(id: string) => void>());
const clearDirectingStateMock = vi.hoisted(() => vi.fn<(id: string) => void>());

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

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    notifyUserInput: notifyUserInputMock,
    notifyEnterPressed: notifyEnterPressedMock,
    clearDirectingState: clearDirectingStateMock,
  },
}));

function makeAgent(id: string, overrides: Partial<TerminalInstance> = {}): TerminalInstance {
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
    ...(overrides as object),
  } as TerminalInstance;
}

function seedPanels(terminals: TerminalInstance[]): void {
  const panelsById: Record<string, TerminalInstance> = {};
  const panelIds: string[] = [];
  for (const t of terminals) {
    panelsById[t.id] = t;
    panelIds.push(t.id);
  }
  usePanelStore.setState({ panelsById, panelIds });
}

function armTwo() {
  usePanelStore.setState({
    panelsById: { t1: makeAgent("t1"), t2: makeAgent("t2") },
    panelIds: ["t1", "t2"],
  });
  useFleetArmingStore.getState().armIds(["t1", "t2"]);
}

function reset() {
  submitMock.mockReset();
  submitMock.mockResolvedValue(undefined);
  notifyUserInputMock.mockReset();
  notifyEnterPressedMock.mockReset();
  clearDirectingStateMock.mockReset();
  useFleetArmingStore.setState({
    armedIds: new Set<string>(),
    armOrder: [],
    armOrderById: {},
    lastArmedId: null,
  });
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
}

describe("broadcastFleetLiteralPaste", () => {
  beforeEach(() => {
    reset();
  });

  it("submits verbatim paste text to each target (no recipe substitution)", async () => {
    armTwo();
    const result = await broadcastFleetLiteralPaste("hello {{branch_name}}");
    expect(submitMock).toHaveBeenCalledTimes(2);
    expect(submitMock.mock.calls.map(([, text]) => text)).toEqual([
      "hello {{branch_name}}",
      "hello {{branch_name}}",
    ]);
    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(0);
  });

  it("collects failures into failedIds without rejecting the aggregate", async () => {
    submitMock.mockReset();
    submitMock.mockResolvedValueOnce(undefined);
    submitMock.mockRejectedValueOnce(new Error("nope"));
    armTwo();

    const result = await broadcastFleetLiteralPaste("x");
    expect(result.successCount).toBe(1);
    expect(result.failureCount).toBe(1);
    expect(result.failedIds).toEqual(["t2"]);
  });

  it("classifies rejections by errno token into permanent / transient buckets", async () => {
    submitMock.mockReset();
    submitMock.mockImplementation(async (id: string) => {
      if (id === "dead") throw new Error("EPIPE: terminal dead has no live PTY (exited)");
      if (id === "slow") throw new Error("ENOSPC: device full");
    });
    seedPanels([makeAgent("ok"), makeAgent("dead"), makeAgent("slow")]);
    const result = await broadcastFleetLiteralPaste("x", ["ok", "dead", "slow"]);
    expect(result.failedIds.sort()).toEqual(["dead", "slow"]);
    expect(result.permanentlyFailedIds).toEqual(["dead"]);
    expect(result.transientlyFailedIds).toEqual(["slow"]);
    const deadEntry = result.perTarget.find((t) => t.terminalId === "dead");
    const slowEntry = result.perTarget.find((t) => t.terminalId === "slow");
    expect(deadEntry?.kind).toBe("permanent");
    expect(slowEntry?.kind).toBe("transient");
  });

  it("treats rejections without a recognized errno as transient (retry chip wins over silent disarm)", async () => {
    // Submit rejections come from many sources (IPC framework, handler
    // errors). Disarming on unknown would silently drop fleet membership
    // for an infra blip — leave arming alone and let the user retry.
    submitMock.mockReset();
    submitMock.mockImplementation(async (id: string) => {
      if (id === "mystery") throw new Error("submit blew up for reasons unknown");
    });
    seedPanels([makeAgent("ok"), makeAgent("mystery")]);
    const result = await broadcastFleetLiteralPaste("x", ["ok", "mystery"]);
    expect(result.transientlyFailedIds).toEqual(["mystery"]);
    expect(result.permanentlyFailedIds).toEqual([]);
  });

  it("returns an empty result on zero targets", async () => {
    const result = await broadcastFleetLiteralPaste("x");
    expect(submitMock).not.toHaveBeenCalled();
    expect(result.total).toBe(0);
    expect(result.successCount).toBe(0);
  });

  it("filters explicit targetIds through fleet eligibility (drops dock/trash)", async () => {
    seedPanels([
      makeAgent("ok"),
      makeAgent("docked", { location: "dock" }),
      makeAgent("trashed", { location: "trash" }),
    ]);
    const result = await broadcastFleetLiteralPaste("x", ["ok", "docked", "trashed"]);
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(submitMock).toHaveBeenCalledWith("ok", "x");
    expect(result.successCount).toBe(1);
    expect(result.failureCount).toBe(0);
  });
});

describe("executeFleetBroadcast", () => {
  beforeEach(() => {
    reset();
  });

  it("submits to each target exactly once for small payloads", async () => {
    seedPanels([makeAgent("a"), makeAgent("b"), makeAgent("c")]);
    const result = await executeFleetBroadcast("hello", ["a", "b", "c"]);
    expect(submitMock).toHaveBeenCalledTimes(3);
    expect(result.total).toBe(3);
    expect(result.successCount).toBe(3);
    expect(result.failureCount).toBe(0);
    expect(result.failedIds).toEqual([]);
  });

  it("reports per-target rejection without aborting other targets (EPIPE drop)", async () => {
    submitMock.mockReset();
    submitMock.mockImplementation(async (id: string) => {
      if (id === "dead") throw new Error("EPIPE");
    });
    seedPanels([makeAgent("a"), makeAgent("dead"), makeAgent("b")]);
    const result = await executeFleetBroadcast("hello", ["a", "dead", "b"]);
    expect(submitMock).toHaveBeenCalledTimes(3);
    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(1);
    expect(result.failedIds).toEqual(["dead"]);
    // EPIPE is a permanent classification — caller can disarm.
    expect(result.permanentlyFailedIds).toEqual(["dead"]);
    expect(result.transientlyFailedIds).toEqual([]);
  });

  it("classifies permanent (EBADF/EPIPE) and transient (ENOSPC) failures into split buckets", async () => {
    submitMock.mockReset();
    submitMock.mockImplementation(async (id: string) => {
      if (id === "gone") throw new Error("EBADF: terminal gone not found");
      if (id === "full") throw new Error("ENOSPC: disk full");
    });
    seedPanels([makeAgent("ok"), makeAgent("gone"), makeAgent("full")]);
    const result = await executeFleetBroadcast("hello", ["ok", "gone", "full"]);
    expect(result.permanentlyFailedIds).toEqual(["gone"]);
    expect(result.transientlyFailedIds).toEqual(["full"]);
    const goneEntry = result.perTarget.find((t) => t.terminalId === "gone");
    const fullEntry = result.perTarget.find((t) => t.terminalId === "full");
    expect(goneEntry?.kind).toBe("permanent");
    expect(fullEntry?.kind).toBe("transient");
  });

  it("batches target fan-out when payload ≥100KB and targets exceed batch size", async () => {
    // Track the maximum number of in-flight submit() calls to confirm that
    // the executor does NOT issue all 12 submissions in one shot.
    let inFlight = 0;
    let maxInFlight = 0;
    submitMock.mockReset();
    submitMock.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
    });

    const ids = Array.from({ length: 12 }, (_, i) => `t${i}`);
    seedPanels(ids.map((id) => makeAgent(id)));
    const bigPayload = "x".repeat(120_000);
    const result = await executeFleetBroadcast(bigPayload, ids);

    expect(submitMock).toHaveBeenCalledTimes(12);
    expect(maxInFlight).toBeLessThanOrEqual(FLEET_LARGE_PASTE_BATCH_SIZE);
    expect(result.total).toBe(12);
    expect(result.successCount).toBe(12);
  });

  it("does not batch when payload is below the large-paste threshold", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    submitMock.mockReset();
    submitMock.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
    });
    const ids = Array.from({ length: 12 }, (_, i) => `t${i}`);
    seedPanels(ids.map((id) => makeAgent(id)));
    await executeFleetBroadcast("small payload", ids);
    expect(submitMock).toHaveBeenCalledTimes(12);
    // All 12 fire in parallel when under the threshold.
    expect(maxInFlight).toBe(12);
  });

  it("preserves target order in perTarget results when batching", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `t${i}`);
    seedPanels(ids.map((id) => makeAgent(id)));
    const result = await executeFleetBroadcast("x".repeat(120_000), ids);
    expect(result.perTarget.map((r) => r.terminalId)).toEqual(ids);
  });

  it("applies perTargetOverrides verbatim", async () => {
    seedPanels([makeAgent("a"), makeAgent("b")]);
    await executeFleetBroadcast("default", ["a", "b"], { b: "custom-for-b" });
    expect(submitMock).toHaveBeenCalledWith("a", "default");
    expect(submitMock).toHaveBeenCalledWith("b", "custom-for-b");
  });

  it("does NOT batch when target count is within the batch size (even at threshold)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(terminalClient, "submit").mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
    });
    const ids = Array.from({ length: FLEET_LARGE_PASTE_BATCH_SIZE }, (_, i) => `t${i}`);
    seedPanels(ids.map((id) => makeAgent(id)));
    await executeFleetBroadcast("x".repeat(200_000), ids);
    // With exactly batch-size targets, there is no fan-out benefit — all
    // fire in parallel via a single allSettled.
    expect(maxInFlight).toBe(FLEET_LARGE_PASTE_BATCH_SIZE);
  });

  it("batches when a perTargetOverride pushes just one target over the threshold", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(terminalClient, "submit").mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
    });
    const ids = Array.from({ length: 12 }, (_, i) => `t${i}`);
    seedPanels(ids.map((id) => makeAgent(id)));
    // Small base draft, one target overridden with a 150KB payload —
    // batching should still engage because the gate reads resolved bytes.
    await executeFleetBroadcast("small", ids, { t3: "x".repeat(150_000) });
    expect(maxInFlight).toBeLessThanOrEqual(FLEET_LARGE_PASTE_BATCH_SIZE);
  });

  describe("progress instrumentation", () => {
    beforeEach(() => {
      useFleetBroadcastProgressStore.setState({
        completed: 0,
        total: 0,
        failed: 0,
        isActive: false,
        cancelled: false,
      });
      reset();
    });

    it("sets total to target count and calls finish (isActive becomes false)", async () => {
      seedPanels([makeAgent("a"), makeAgent("b"), makeAgent("c")]);
      await executeFleetBroadcast("hello", ["a", "b", "c"]);
      const s = useFleetBroadcastProgressStore.getState();
      expect(s.total).toBe(3);
      expect(s.completed).toBe(3);
      expect(s.isActive).toBe(false);
    });

    it("accumulates completed across batches and lands at total", async () => {
      const ids = Array.from({ length: 12 }, (_, i) => `t${i}`);
      seedPanels(ids.map((id) => makeAgent(id)));
      await executeFleetBroadcast("x".repeat(120_000), ids);
      const s = useFleetBroadcastProgressStore.getState();
      expect(s.total).toBe(12);
      expect(s.completed).toBe(12);
      expect(s.failed).toBe(0);
      expect(s.isActive).toBe(false);
    });

    it("tracks per-batch failures through advance calls", async () => {
      // Advance tracks failures correctly when checked via the real store.
      // Verified by directly calling advance with batch failures.
      useFleetBroadcastProgressStore.getState().init(12);
      useFleetBroadcastProgressStore.getState().advance(5, 1); // batch 1: t3 failed
      useFleetBroadcastProgressStore.getState().advance(5, 1); // batch 2: t8 failed
      useFleetBroadcastProgressStore.getState().advance(2, 0); // batch 3: clean
      const s = useFleetBroadcastProgressStore.getState();
      expect(s.failed).toBe(2);
      expect(s.completed).toBe(12);
    });

    it("calls finish even when all submissions reject (isActive becomes false)", async () => {
      submitMock.mockReset();
      submitMock.mockRejectedValue(new Error("boom"));
      seedPanels([makeAgent("a"), makeAgent("b")]);
      await executeFleetBroadcast("hello", ["a", "b"]);
      expect(useFleetBroadcastProgressStore.getState().isActive).toBe(false);
    });

    it("calls finish even with empty targets (isActive becomes false)", async () => {
      await executeFleetBroadcast("hello", []);
      expect(useFleetBroadcastProgressStore.getState().isActive).toBe(false);
    });

    it("existing post-hoc result shape is unchanged by progress tracking", async () => {
      seedPanels([makeAgent("a"), makeAgent("b"), makeAgent("c")]);
      const result = await executeFleetBroadcast("hello", ["a", "b", "c"]);
      expect(result.total).toBe(3);
      expect(result.successCount).toBe(3);
      expect(result.failureCount).toBe(0);
      expect(result.failedIds).toEqual([]);
      expect(result.perTarget.length).toBe(3);
    });
  });

  describe("cancellation via AbortSignal", () => {
    beforeEach(() => {
      // Earlier tests in this file use vi.spyOn(terminalClient, "submit")
      // without restoring; restore here so our submitMock wrapper is the
      // active implementation again.
      vi.restoreAllMocks();
      useFleetBroadcastProgressStore.setState({
        completed: 0,
        total: 0,
        failed: 0,
        isActive: false,
        cancelled: false,
      });
      reset();
    });

    it("returns cancelled result without firing any IPC when signal is pre-aborted", async () => {
      seedPanels([makeAgent("a"), makeAgent("b"), makeAgent("c")]);
      const controller = new AbortController();
      controller.abort();
      const result = await executeFleetBroadcast(
        "hello",
        ["a", "b", "c"],
        undefined,
        controller.signal
      );
      expect(submitMock).not.toHaveBeenCalled();
      expect(result.cancelled).toBe(true);
      expect(result.successCount).toBe(0);
      expect(result.skippedCount).toBe(3);
      const s = useFleetBroadcastProgressStore.getState();
      expect(s.isActive).toBe(false);
      expect(s.cancelled).toBe(true);
    });

    it("aborts mid-batch run: completed batch fires, remaining batches skipped", async () => {
      const ids = Array.from({ length: 12 }, (_, i) => `t${i}`);
      seedPanels(ids.map((id) => makeAgent(id)));
      const controller = new AbortController();
      let completedBatches = 0;
      submitMock.mockReset();
      submitMock.mockImplementation(async () => {
        // Trigger abort after the first batch (5 calls) settles.
        await Promise.resolve();
      });
      // Trigger abort after the first batch settles by hooking advance.
      const origAdvance = useFleetBroadcastProgressStore.getState().advance;
      useFleetBroadcastProgressStore.setState({
        advance: (b, f) => {
          completedBatches += 1;
          origAdvance(b, f);
          if (completedBatches === 1) controller.abort();
        },
      });
      try {
        const result = await executeFleetBroadcast(
          "x".repeat(120_000),
          ids,
          undefined,
          controller.signal
        );
        expect(result.cancelled).toBe(true);
        // First batch fired (FLEET_LARGE_PASTE_BATCH_SIZE = 5), remaining 7 skipped.
        expect(submitMock).toHaveBeenCalledTimes(FLEET_LARGE_PASTE_BATCH_SIZE);
        expect(result.successCount).toBe(FLEET_LARGE_PASTE_BATCH_SIZE);
        expect(result.skippedCount).toBe(ids.length - FLEET_LARGE_PASTE_BATCH_SIZE);
      } finally {
        useFleetBroadcastProgressStore.setState({ advance: origAdvance });
      }
      const s = useFleetBroadcastProgressStore.getState();
      expect(s.isActive).toBe(false);
      expect(s.cancelled).toBe(true);
    });

    it("non-batched path: abort during in-flight allSettled marks cancelled but reports actual fan-out", async () => {
      seedPanels([makeAgent("a"), makeAgent("b")]);
      const controller = new AbortController();
      submitMock.mockReset();
      submitMock.mockImplementation(async () => {
        controller.abort();
      });
      const result = await executeFleetBroadcast("small", ["a", "b"], undefined, controller.signal);
      expect(submitMock).toHaveBeenCalledTimes(2);
      expect(result.cancelled).toBe(true);
      // Non-batched path is atomic — both writes already fired.
      expect(result.successCount).toBe(2);
      expect(result.skippedCount).toBe(0);
      // Still finalizes — ribbon must not be stuck in "sending".
      expect(useFleetBroadcastProgressStore.getState().isActive).toBe(false);
    });

    it("non-aborted broadcast reports cancelled: false and skippedCount: 0", async () => {
      seedPanels([makeAgent("a"), makeAgent("b")]);
      const result = await executeFleetBroadcast("hi", ["a", "b"]);
      expect(result.cancelled).toBe(false);
      expect(result.skippedCount).toBe(0);
    });
  });

  describe("directing-state notification (#7799)", () => {
    beforeEach(() => {
      reset();
    });

    it("enters directing on every target before submit dispatches (non-batched)", async () => {
      // Track call order to assert notifyUserInput precedes submit so the
      // blue directing indicator renders fleet-wide before PTY echo flips
      // the canonical state machine to working.
      seedPanels([makeAgent("a"), makeAgent("b"), makeAgent("c")]);
      const order: string[] = [];
      notifyUserInputMock.mockImplementation((id: string) => order.push(`notify:${id}`));
      submitMock.mockReset();
      submitMock.mockImplementation(async (id: string) => {
        order.push(`submit:${id}`);
      });

      await executeFleetBroadcast("hello", ["a", "b", "c"]);

      expect(notifyUserInputMock).toHaveBeenCalledTimes(3);
      expect(notifyUserInputMock.mock.calls.map(([id]) => id).sort()).toEqual(["a", "b", "c"]);
      // Real payload is passed (not "") so Phase 2 escalation engages for
      // large pastes — see #3565.
      expect(notifyUserInputMock.mock.calls.every(([, data]) => data === "hello")).toBe(true);
      // Every notify lands before the first submit dispatches.
      const lastNotify = order.lastIndexOf("notify:c");
      const firstSubmit = order.findIndex((e) => e.startsWith("submit:"));
      expect(lastNotify).toBeLessThan(firstSubmit);
    });

    it("transitions directing → working via notifyEnterPressed for fulfilled targets", async () => {
      seedPanels([makeAgent("a"), makeAgent("b"), makeAgent("c")]);
      await executeFleetBroadcast("hello", ["a", "b", "c"]);

      expect(notifyEnterPressedMock).toHaveBeenCalledTimes(3);
      expect(notifyEnterPressedMock.mock.calls.map(([id]) => id).sort()).toEqual(["a", "b", "c"]);
      // No rejections → no rollback path.
      expect(clearDirectingStateMock).not.toHaveBeenCalled();
    });

    it("rolls back directing via clearDirectingState only for rejected targets (non-batched)", async () => {
      submitMock.mockReset();
      submitMock.mockImplementation(async (id: string) => {
        if (id === "dead") throw new Error("EPIPE");
      });
      seedPanels([makeAgent("a"), makeAgent("dead"), makeAgent("b")]);
      await executeFleetBroadcast("hello", ["a", "dead", "b"]);

      // All three enter directing pre-allSettled.
      expect(notifyUserInputMock.mock.calls.map(([id]) => id).sort()).toEqual(["a", "b", "dead"]);
      // Only the fulfilled targets advance to working.
      expect(notifyEnterPressedMock.mock.calls.map(([id]) => id).sort()).toEqual(["a", "b"]);
      // Only the rejected target is rolled back from directing.
      expect(clearDirectingStateMock).toHaveBeenCalledTimes(1);
      expect(clearDirectingStateMock).toHaveBeenCalledWith("dead");
    });

    it("enters directing on every target across batches (batched path)", async () => {
      const ids = Array.from({ length: 12 }, (_, i) => `t${i}`);
      seedPanels(ids.map((id) => makeAgent(id)));
      await executeFleetBroadcast("x".repeat(120_000), ids);

      expect(notifyUserInputMock).toHaveBeenCalledTimes(12);
      expect(notifyUserInputMock.mock.calls.map(([id]) => id).sort()).toEqual([...ids].sort());
      expect(notifyEnterPressedMock).toHaveBeenCalledTimes(12);
      expect(clearDirectingStateMock).not.toHaveBeenCalled();
    });

    it("rolls back directing per-batch for rejected targets (batched path)", async () => {
      const ids = Array.from({ length: 12 }, (_, i) => `t${i}`);
      seedPanels(ids.map((id) => makeAgent(id)));
      submitMock.mockReset();
      submitMock.mockImplementation(async (id: string) => {
        // One failure in batch 1 (t2) and one in batch 3 (t10).
        if (id === "t2" || id === "t10") throw new Error("EPIPE");
      });
      await executeFleetBroadcast("x".repeat(120_000), ids);

      expect(clearDirectingStateMock).toHaveBeenCalledTimes(2);
      expect(clearDirectingStateMock.mock.calls.map(([id]) => id).sort()).toEqual(["t10", "t2"]);
      // The 10 fulfilled targets all moved through to working.
      expect(notifyEnterPressedMock).toHaveBeenCalledTimes(10);
    });

    it("does not notify when the executor returns early on pre-aborted signal", async () => {
      seedPanels([makeAgent("a"), makeAgent("b")]);
      const controller = new AbortController();
      controller.abort();
      await executeFleetBroadcast("hi", ["a", "b"], undefined, controller.signal);
      expect(notifyUserInputMock).not.toHaveBeenCalled();
      expect(notifyEnterPressedMock).not.toHaveBeenCalled();
      expect(clearDirectingStateMock).not.toHaveBeenCalled();
    });
  });
});
