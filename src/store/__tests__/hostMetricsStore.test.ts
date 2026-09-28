import { beforeEach, describe, expect, it } from "vitest";
import type { HostMetricsSummary } from "@shared/types/remoteHosts";
import { latestHostSummary, useHostMetricsStore } from "../hostMetricsStore";

function summary(hostId: string, sampledAt: number): HostMetricsSummary {
  return {
    hostId,
    sampledAt,
    platform: "linux",
    cpuPercent: 5,
    memoryPressure: "normal",
    memoryUsedBytes: null,
    memoryTotalBytes: null,
    swapUsedBytes: null,
    swapTotalBytes: null,
    thermal: null,
    cpuPressure: null,
    agentsObserved: { working: 0, waiting: 0, idle: 0 },
    projectCount: 0,
    worktreeCount: 0,
    driver: null,
    agentClis: [],
  };
}

beforeEach(() => useHostMetricsStore.getState().reset());

describe("hostMetricsStore", () => {
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
    "keeps a host named %s like any other",
    (hostId) => {
      const store = useHostMetricsStore.getState();
      expect(latestHostSummary(store.history, hostId)).toBeNull();
      store.seed([{ hostId, history: [summary(hostId, 1)] }]);
      useHostMetricsStore.getState().apply(summary(hostId, 2));
      const history = useHostMetricsStore.getState().history;
      expect(history.get(hostId)?.map((entry) => entry.sampledAt)).toEqual([2, 1]);
      expect(latestHostSummary(history, hostId)?.sampledAt).toBe(2);
      useHostMetricsStore.getState().forget(hostId);
      expect(useHostMetricsStore.getState().history.has(hostId)).toBe(false);
    }
  );

  it("starts a host's ring from a pushed summary with no seed", () => {
    useHostMetricsStore.getState().apply(summary("constructor", 7));
    expect(
      latestHostSummary(useHostMetricsStore.getState().history, "constructor")?.sampledAt
    ).toBe(7);
  });
});
