import type { HostMetricsSummary } from "@shared/types/remoteHosts";
import type { HostMenuRow } from "../../hostModel";

export function makeSummary(overrides: Partial<HostMetricsSummary> = {}): HostMetricsSummary {
  return {
    hostId: "studio-01",
    sampledAt: 1,
    platform: "linux",
    cpuPercent: 20,
    memoryPressure: "normal",
    memoryUsedBytes: 4 * 1024 ** 3,
    memoryTotalBytes: 16 * 1024 ** 3,
    swapUsedBytes: 0,
    swapTotalBytes: 2 * 1024 ** 3,
    thermal: "nominal",
    cpuPressure: null,
    agentsObserved: { working: 1, waiting: 2, idle: 3 },
    projectCount: 2,
    worktreeCount: 5,
    driver: null,
    agentClis: [],
    ...overrides,
  };
}

export const HANDSHAKE = {
  version: "0.38.0",
  commit: "abc",
  protocolVersion: 1,
  platform: "linux" as const,
  arch: "x64" as const,
};

export function makeRow(overrides: Partial<HostMenuRow> = {}): HostMenuRow {
  return {
    hostId: "studio-01",
    name: "studio-01",
    isLocal: false,
    platform: "linux",
    connection: { status: "connected", rttMs: 12, handshake: HANDSHAKE },
    lastSeenAt: null,
    summary: makeSummary(),
    isCurrent: false,
    ...overrides,
  };
}
