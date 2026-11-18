import { describe, it, expect } from "vitest";
import { appendArrivals, orderRuns } from "../reviewHubRunOrder";

/** Runs whose id reads are counted: one read stands for one id comparison. */
function countedRuns(ids: readonly string[]) {
  const reads = { count: 0 };
  const runs = ids.map((id) => ({
    get panelId() {
      reads.count += 1;
      return id;
    },
  }));
  return { runs, reads };
}

/** A visit order whose entries are read through a counter, as the runs' ids are. */
function countedOrder(entries: readonly string[]) {
  const reads = { count: 0 };
  const order = new Proxy(entries, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads.count += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  return { order, reads };
}

const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `run-${from + i}`);

describe("appendArrivals", () => {
  it("returns the same order when every run is already placed", () => {
    const order = ids(3);
    const { runs } = countedRuns([...order].reverse());
    expect(appendArrivals(order, runs)).toBe(order);
  });

  it("returns the same order for an empty run list", () => {
    const order = ids(2);
    expect(appendArrivals(order, [])).toBe(order);
  });

  it("appends arrivals after the order in the order given, leaving the input alone", () => {
    const order = ids(3);
    const { runs } = countedRuns(["run-9", "run-1", "run-7", "run-0"]);
    const next = appendArrivals(order, runs);
    expect(next).toEqual(["run-0", "run-1", "run-2", "run-9", "run-7"]);
    expect(order).toEqual(["run-0", "run-1", "run-2"]);
  });

  it("places a run that appears twice once", () => {
    const { runs } = countedRuns(["a", "b", "a"]);
    expect(appendArrivals([], runs)).toEqual(["a", "b"]);
  });

  it("keeps the ids of runs that left", () => {
    const order = ids(3);
    const { runs } = countedRuns(["run-1", "run-5"]);
    expect(appendArrivals(order, runs)).toEqual(["run-0", "run-1", "run-2", "run-5"]);
  });

  it("reads each run once and each placed id at most twice on a long visit, where a scan per run reads n squared", () => {
    const n = 1000;
    const { order, reads: orderReads } = countedOrder(ids(n));
    const { runs, reads } = countedRuns([...ids(200, n - 200), ...ids(20, n)]);
    const next = appendArrivals(order, runs);
    const runReads = reads.count;
    const placedReads = orderReads.count;
    expect(next).toEqual(ids(n + 20));
    expect(runReads).toBeLessThanOrEqual(runs.length);
    expect(placedReads).toBeLessThanOrEqual(2 * n);
  });
});

describe("orderRuns", () => {
  it("follows the visit order, whatever order the runs arrive in", () => {
    const { runs } = countedRuns(["run-2", "run-0", "run-1"]);
    expect(orderRuns(ids(3), runs).map((run) => run.panelId)).toEqual(["run-0", "run-1", "run-2"]);
  });

  it("skips ids whose run left, and takes a returning run back to its old place", () => {
    const order = ids(4);
    const present = countedRuns(["run-3", "run-0", "run-2"]).runs;
    expect(orderRuns(order, present).map((run) => run.panelId)).toEqual([
      "run-0",
      "run-2",
      "run-3",
    ]);
    const back = countedRuns(["run-3", "run-1", "run-0", "run-2"]).runs;
    expect(orderRuns(order, back).map((run) => run.panelId)).toEqual([
      "run-0",
      "run-1",
      "run-2",
      "run-3",
    ]);
  });

  it("returns the run objects themselves", () => {
    const first = { panelId: "a", extra: 1 };
    const second = { panelId: "b", extra: 2 };
    const [one, two] = orderRuns(["b", "a"], [first, second]);
    expect(one).toBe(second);
    expect(two).toBe(first);
  });

  it("returns nothing without runs or without an order", () => {
    expect(orderRuns(ids(3), [])).toEqual([]);
    expect(orderRuns([], countedRuns(ids(3)).runs)).toEqual([]);
  });

  it("reads each run and each placed id once on a long visit, where a scan per id reads n squared", () => {
    const n = 200;
    const visited = 1000;
    const { runs, reads } = countedRuns(ids(n, visited - n));
    const { order, reads: orderReads } = countedOrder(ids(visited));
    const ordered = orderRuns(order, runs);
    const runReads = reads.count;
    const placedReads = orderReads.count;
    expect(ordered.map((run) => run.panelId)).toEqual(ids(n, visited - n));
    expect(runReads).toBeLessThanOrEqual(n);
    expect(placedReads).toBeLessThanOrEqual(visited);
  });
});
