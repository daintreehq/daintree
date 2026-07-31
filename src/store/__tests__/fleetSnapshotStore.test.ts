// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetSnapshot } from "@shared/types/ipc/fleet";

type SnapshotCallback = (snapshot: FleetSnapshot) => void;

let capturedCallback: SnapshotCallback | null = null;
const unsubMock = vi.fn();
const onSnapshotUpdatedMock = vi.fn((cb: SnapshotCallback) => {
  capturedCallback = cb;
  return unsubMock;
});

const getSnapshotMock = vi.fn(async (): Promise<FleetSnapshot | null> => null);

vi.stubGlobal("window", {
  electron: {
    fleet: {
      onSnapshotUpdated: onSnapshotUpdatedMock,
      getSnapshot: getSnapshotMock,
    },
  },
});

const { useFleetSnapshotStore, setupFleetSnapshotListeners, cleanupFleetSnapshotListeners } =
  await import("../fleetSnapshotStore");

const NOW = 1_830_001;

function snapshot(runs: FleetSnapshot["runs"] = [], changedAt = NOW): FleetSnapshot {
  return { runs, changedAt };
}

function makeRun(runId: string): FleetSnapshot["runs"][number] {
  return { runId, workspaceId: "p1", spawnedAt: NOW - 60_000, cwd: "/repo" };
}

describe("fleetSnapshotStore", () => {
  beforeEach(() => {
    cleanupFleetSnapshotListeners();
    useFleetSnapshotStore.setState({ snapshot: null });
    vi.clearAllMocks();
    getSnapshotMock.mockResolvedValue(null);
    capturedCallback = null;
  });

  afterEach(() => {
    cleanupFleetSnapshotListeners();
  });

  it("starts null so 'nothing reported yet' is distinguishable from 'fleet clear'", () => {
    // The whole all-clear presentation hangs on this: a surface may only claim
    // the fleet is clear on a delivered empty snapshot, never on initial state.
    expect(useFleetSnapshotStore.getState().snapshot).toBeNull();
  });

  it("stores a delivered empty fleet as a real snapshot, not as null", () => {
    setupFleetSnapshotListeners();
    capturedCallback!(snapshot([]));

    const stored = useFleetSnapshotStore.getState().snapshot;
    expect(stored).not.toBeNull();
    expect(stored!.runs).toEqual([]);
  });

  it("replaces the previous fleet rather than merging into it", () => {
    setupFleetSnapshotListeners();
    capturedCallback!(snapshot([makeRun("a"), makeRun("b")]));
    expect(useFleetSnapshotStore.getState().snapshot!.runs).toHaveLength(2);

    capturedCallback!(snapshot([makeRun("c")]));

    const stored = useFleetSnapshotStore.getState().snapshot!;
    expect(stored.runs.map((r) => r.runId)).toEqual(["c"]);
  });

  it("clears a previously populated fleet when an empty one arrives", () => {
    setupFleetSnapshotListeners();
    capturedCallback!(snapshot([makeRun("a")]));
    capturedCallback!(snapshot([]));

    expect(useFleetSnapshotStore.getState().snapshot!.runs).toEqual([]);
  });

  it("pulls a snapshot on setup so a dropped push can't leave the view blank", async () => {
    // Main suppresses unchanged broadcasts, so a view that only subscribes can
    // wait forever — and waiting/blocked/awaiting-review are exactly the states
    // that stop changing.
    getSnapshotMock.mockResolvedValue(snapshot([makeRun("a")]));
    setupFleetSnapshotListeners();
    await vi.waitFor(() => expect(useFleetSnapshotStore.getState().snapshot).not.toBeNull());

    expect(useFleetSnapshotStore.getState().snapshot!.runs).toHaveLength(1);
  });

  it("subscribes before pulling so no push can slip through the gap", () => {
    setupFleetSnapshotListeners();

    expect(onSnapshotUpdatedMock).toHaveBeenCalled();
    expect(onSnapshotUpdatedMock.mock.invocationCallOrder[0]!).toBeLessThan(
      getSnapshotMock.mock.invocationCallOrder[0]!
    );
  });

  it("lets a newer push win over a slower pull that resolves after it", async () => {
    let releasePull: (v: FleetSnapshot | null) => void = () => {};
    getSnapshotMock.mockReturnValue(new Promise((r) => (releasePull = r)));
    setupFleetSnapshotListeners();

    capturedCallback!(snapshot([makeRun("fresh")], NOW + 10_000));
    releasePull(snapshot([makeRun("stale")], NOW));
    await vi.waitFor(() => expect(getSnapshotMock.mock.results[0]!.value).resolves.toBeDefined());

    expect(useFleetSnapshotStore.getState().snapshot!.runs[0]!.runId).toBe("fresh");
  });

  it("keeps the store null when main has computed nothing yet", async () => {
    getSnapshotMock.mockResolvedValue(null);
    setupFleetSnapshotListeners();
    await vi.waitFor(() => expect(getSnapshotMock).toHaveBeenCalled());

    expect(useFleetSnapshotStore.getState().snapshot).toBeNull();
  });

  it("survives a failed hydrate and still applies later pushes", async () => {
    getSnapshotMock.mockRejectedValue(new Error("ipc down"));
    setupFleetSnapshotListeners();
    await vi.waitFor(() => expect(getSnapshotMock).toHaveBeenCalled());

    capturedCallback!(snapshot([makeRun("a")]));
    expect(useFleetSnapshotStore.getState().snapshot!.runs).toHaveLength(1);
  });

  it("subscribes once across repeated setup calls", () => {
    setupFleetSnapshotListeners();
    setupFleetSnapshotListeners();
    setupFleetSnapshotListeners();

    expect(onSnapshotUpdatedMock).toHaveBeenCalledOnce();
  });

  it("unsubscribes once across repeated cleanup calls", () => {
    setupFleetSnapshotListeners();
    cleanupFleetSnapshotListeners();
    cleanupFleetSnapshotListeners();

    expect(unsubMock).toHaveBeenCalledOnce();
  });

  it("re-subscribes after a cleanup so a remounted view still receives pushes", () => {
    setupFleetSnapshotListeners();
    cleanupFleetSnapshotListeners();
    setupFleetSnapshotListeners();

    expect(onSnapshotUpdatedMock).toHaveBeenCalledTimes(2);
    capturedCallback!(snapshot([makeRun("a")]));
    expect(useFleetSnapshotStore.getState().snapshot!.runs).toHaveLength(1);
  });

  it("returns a cleanup from setup that unsubscribes", () => {
    const cleanup = setupFleetSnapshotListeners();
    cleanup();

    expect(unsubMock).toHaveBeenCalledOnce();
  });
});
