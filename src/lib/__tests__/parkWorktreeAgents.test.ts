// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetRunRow, FleetSnapshot } from "@shared/types/ipc/fleet";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";

interface NotifyCall {
  type: string;
  priority?: string;
  title?: string;
  message: string;
  context?: { worktreeId?: string };
  action?: { label: string; onClick: () => void | Promise<void> };
}
const notify = vi.hoisted(() => vi.fn((_payload: NotifyCall) => {}));
vi.mock("@/lib/notify", () => ({ notify }));

import {
  bulkParkAgents,
  resetBulkParkPacing,
  runBulkPark,
  selectParkTargets,
} from "../parkWorktreeAgents";

const parkRun = vi.fn();
const unparkRun = vi.fn();

function snap(
  runs: Array<Partial<FleetRunRow> & { runId: string }>,
  degraded = false
): FleetSnapshot {
  return {
    runs: runs.map((run) => ({ workspaceId: "p1", spawnedAt: 0, cwd: "/tmp", ...run })),
    changedAt: 1,
    degraded,
    lastSuccessfulAt: null,
  };
}

function setSnapshot(snapshot: FleetSnapshot | null) {
  useFleetSnapshotStore.setState({ snapshot });
}

beforeEach(() => {
  resetBulkParkPacing();
  parkRun.mockReset().mockResolvedValue({ parkedAt: 1 });
  unparkRun.mockReset().mockResolvedValue(true);
  Object.defineProperty(window, "electron", {
    value: { fleet: { parkRun, unparkRun } },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  setSnapshot(null);
  notify.mockReset();
});

describe("selectParkTargets", () => {
  const snapshot = snap([
    { runId: "a" },
    { runId: "b", park: { parkedAt: 1 } },
    { runId: "other" },
  ]);

  it("parks only the worktree's unparked runs the fleet can see", () => {
    // "shell" is a plain terminal: never on the snapshot, so never a target.
    expect(selectParkTargets(snapshot, ["a", "b", "shell"], "park")).toEqual(["a"]);
  });

  it("unparks only the worktree's parked runs", () => {
    expect(selectParkTargets(snapshot, ["a", "b", "shell"], "unpark")).toEqual(["b"]);
  });

  it("parks nothing over a degraded snapshot but still unparks", () => {
    // Main rejects a park against retained data, so sending one only burns budget.
    const degraded = snap([{ runId: "a" }, { runId: "b", park: { parkedAt: 1 } }], true);
    expect(selectParkTargets(degraded, ["a", "b"], "park")).toEqual([]);
    expect(selectParkTargets(degraded, ["a", "b"], "unpark")).toEqual(["b"]);
  });

  it("selects nothing before a snapshot has landed", () => {
    expect(selectParkTargets(null, ["a"], "park")).toEqual([]);
  });
});

describe("runBulkPark", () => {
  it("re-checks each run before its call and skips one that no longer needs it", async () => {
    setSnapshot(snap([{ runId: "a" }, { runId: "b", park: { parkedAt: 1 } }]));

    const result = await runBulkPark("park", ["a", "b", "gone"]);

    expect(parkRun).toHaveBeenCalledTimes(1);
    expect(parkRun).toHaveBeenCalledWith("a", {});
    expect(result).toEqual({ succeeded: 1, failed: [], firstError: undefined });
  });

  it("keeps going past a failure and reports which runs didn't take", async () => {
    setSnapshot(snap([{ runId: "a" }, { runId: "b" }, { runId: "c" }]));
    const boom = new Error("nope");
    parkRun.mockImplementation((id: string) =>
      id === "b" ? Promise.reject(boom) : Promise.resolve({ parkedAt: 1 })
    );

    const result = await runBulkPark("park", ["a", "b", "c"]);

    expect(parkRun).toHaveBeenCalledTimes(3);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toEqual(["b"]);
    expect(result.firstError).toBe(boom);
  });

  it("paces calls past main's 20-per-10s limit instead of tripping it", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `r${i}`);
    setSnapshot(snap(ids.map((runId) => ({ runId, park: { parkedAt: 1 } }))));
    let clock = 1_000;
    const sleeps: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    });

    const result = await runBulkPark("unpark", ids, { now: () => clock, sleep });

    expect(unparkRun).toHaveBeenCalledTimes(25);
    expect(result.succeeded).toBe(25);
    // All 20 of the first window landed at t=1000, so the 21st waits it out.
    expect(sleeps).toEqual([10_000]);
  });

  it("shares one pacing window across back-to-back runs, as main's limit does", async () => {
    const first = Array.from({ length: 15 }, (_, i) => `a${i}`);
    const second = Array.from({ length: 10 }, (_, i) => `b${i}`);
    setSnapshot(snap([...first, ...second].map((runId) => ({ runId }))));
    let clock = 1_000;
    const sleeps: number[] = [];
    const deps = {
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
    };

    await runBulkPark("park", first, deps);
    await runBulkPark("park", second, deps);

    // 15 + 5 fill the window; the 21st call overall waits it out.
    expect(parkRun).toHaveBeenCalledTimes(25);
    expect(sleeps).toEqual([10_000]);
  });
});

describe("bulkParkAgents", () => {
  it("stays quiet when every run took", async () => {
    setSnapshot(snap([{ runId: "a" }]));

    await bulkParkAgents("park", ["a"], { worktreeId: "wt-1" });

    expect(notify).not.toHaveBeenCalled();
  });

  it("reports a failure once, with a retry scoped to the runs that failed", async () => {
    setSnapshot(snap([{ runId: "a" }, { runId: "b" }]));
    parkRun.mockImplementation((id: string) =>
      id === "b" ? Promise.reject(new Error("Fleet state is unavailable")) : Promise.resolve({})
    );

    await bulkParkAgents("park", ["a", "b"], { worktreeId: "wt-1" });

    expect(notify).toHaveBeenCalledTimes(1);
    const payload = notify.mock.calls[0]![0];
    expect(payload.type).toBe("error");
    // A passive eventKind alone would route this to the inbox and hide Retry.
    expect(payload.priority).toBe("high");
    expect(payload.title).toBe("Couldn't park 1 agent");
    expect(payload.message).toContain("Fleet state is unavailable");
    expect(payload.context?.worktreeId).toBe("wt-1");

    parkRun.mockClear();
    parkRun.mockResolvedValue({});
    expect(payload.action?.label).toBe("Retry");
    await payload.action?.onClick();
    expect(parkRun).toHaveBeenCalledTimes(1);
    expect(parkRun).toHaveBeenCalledWith("b", {});
  });

  it("does nothing for an empty selection", async () => {
    await bulkParkAgents("unpark", []);

    expect(unparkRun).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
