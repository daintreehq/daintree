import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpAnomalySignal, McpAuditStats } from "@shared/types/ipc/mcpServer";
import { __resetMcpAnomalyStoreForTesting, useMcpAnomalyStore } from "../mcpAnomalyStore";

function signalFixture(id: string): McpAnomalySignal {
  return {
    id,
    kind: "latency-drift",
    toolId: "help.search",
    severity: "danger",
    timestamp: 1_000,
    recordIds: [id],
  };
}

function statsFixture(overrides: Partial<McpAuditStats> = {}): McpAuditStats {
  return {
    auth401Count: 0,
    anomalySignals: [],
    anomalySuppressed: false,
    anomalyRecordFloor: 50,
    ...overrides,
  };
}

describe("mcpAnomalyStore", () => {
  beforeEach(() => {
    __resetMcpAnomalyStoreForTesting();
  });

  afterEach(() => {
    __resetMcpAnomalyStoreForTesting();
  });

  it("starts with no anomaly", () => {
    const state = useMcpAnomalyStore.getState();
    expect(state.hasAnomaly).toBe(false);
    expect(state.anomalyCount).toBe(0);
  });

  it("flags anomalies and tracks the count when signals are present and unsuppressed", () => {
    useMcpAnomalyStore
      .getState()
      .setFromStats(statsFixture({ anomalySignals: [signalFixture("a"), signalFixture("b")] }));
    const state = useMcpAnomalyStore.getState();
    expect(state.hasAnomaly).toBe(true);
    expect(state.anomalyCount).toBe(2);
  });

  it("stays quiet while suppressed even with signals present", () => {
    useMcpAnomalyStore
      .getState()
      .setFromStats(
        statsFixture({ anomalySignals: [signalFixture("a")], anomalySuppressed: true })
      );
    expect(useMcpAnomalyStore.getState().hasAnomaly).toBe(false);
  });

  it("stays quiet when there are no signals", () => {
    useMcpAnomalyStore.getState().setFromStats(statsFixture({ anomalySignals: [] }));
    expect(useMcpAnomalyStore.getState().hasAnomaly).toBe(false);
  });

  it("clears the flag when a later poll reports no anomalies", () => {
    const store = useMcpAnomalyStore.getState();
    store.setFromStats(statsFixture({ anomalySignals: [signalFixture("a")] }));
    expect(useMcpAnomalyStore.getState().hasAnomaly).toBe(true);

    store.setFromStats(statsFixture({ anomalySignals: [] }));
    expect(useMcpAnomalyStore.getState().hasAnomaly).toBe(false);
    expect(useMcpAnomalyStore.getState().anomalyCount).toBe(0);
  });

  it("clears the flag when stats are null (failed fetch — fail closed)", () => {
    const store = useMcpAnomalyStore.getState();
    store.setFromStats(statsFixture({ anomalySignals: [signalFixture("a")] }));
    expect(useMcpAnomalyStore.getState().hasAnomaly).toBe(true);

    store.setFromStats(null);
    expect(useMcpAnomalyStore.getState().hasAnomaly).toBe(false);
  });

  it("reset() returns to the initial state", () => {
    const store = useMcpAnomalyStore.getState();
    store.setFromStats(statsFixture({ anomalySignals: [signalFixture("a")] }));
    store.reset();
    expect(useMcpAnomalyStore.getState().hasAnomaly).toBe(false);
    expect(useMcpAnomalyStore.getState().anomalyCount).toBe(0);
  });

  it("does not produce a new state object when nothing changes (referential stability)", () => {
    const store = useMcpAnomalyStore.getState();
    store.setFromStats(statsFixture({ anomalySignals: [] }));
    const before = useMcpAnomalyStore.getState();
    store.setFromStats(statsFixture({ anomalySignals: [] }));
    const after = useMcpAnomalyStore.getState();
    expect(after.hasAnomaly).toBe(before.hasAnomaly);
    expect(after.anomalyCount).toBe(before.anomalyCount);
  });
});
