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
});
