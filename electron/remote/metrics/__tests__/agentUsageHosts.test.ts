import { describe, expect, it, vi } from "vitest";
import type {
  HostConnectionState,
  HostMetricsSummary,
} from "../../../../shared/types/remoteHosts.js";
import type { AgentUsageReading } from "../../../../shared/types/ipc/agentUsage.js";
import type { LinkSession } from "../../link/session.js";
import type { SummaryReceipt } from "../summaryReceipt.js";
import {
  createAgentUsageHostsSource,
  onShellClock,
  type AgentUsageHostsDeps,
} from "../agentUsageHosts.js";

const codex: AgentUsageReading = {
  agentId: "codex",
  accountNames: ["Work"],
  isDefault: false,
  windowDurationMins: 300,
  usedPercent: 82,
  resetsAt: 10_000_000,
  observedAt: 9_000_000,
};

function receipt(receivedAt: number, hostAgeMs: number | null): SummaryReceipt {
  return {
    receivedAt,
    at: { wall: receivedAt, mono: 0 } as SummaryReceipt["at"],
    hostAgeMs,
    maxAgeMs: null,
    timed: true,
  };
}

describe("onShellClock", () => {
  it("places a host's times on this machine's clock by differences taken on the host alone", () => {
    // The host's clock runs an hour ahead; its sample was 2s old when posted.
    const hourAhead = 3_600_000;
    const summary = { sampledAt: 9_060_000 + hourAhead };
    const placed = onShellClock(summary, receipt(9_062_000, 2_000), [
      { ...codex, observedAt: 9_000_000 + hourAhead, resetsAt: 10_000_000 + hourAhead },
    ]);
    expect(placed[0]).toMatchObject({ observedAt: 9_000_000, resetsAt: 10_000_000 });
    expect(
      onShellClock(summary, receipt(9_062_000, 2_000), [{ ...codex, resetsAt: null }])[0]!.resetsAt
    ).toBeNull();
  });
});

function harness() {
  const session = {} as LinkSession;
  const states = new Map<string, HostConnectionState>([
    ["vps", { status: "connected" } as HostConnectionState],
    ["mini", { status: "disconnected" }],
  ]);
  const summaries = new Map<string, HostMetricsSummary>();
  const onCurrentLink = new Set<HostMetricsSummary>();
  let stateListener: (() => void) | null = null;
  let summaryListener: (() => void) | null = null;
  let metricsUp = true;
  const deps: AgentUsageHostsDeps = {
    registry: {
      list: () =>
        [
          { id: "local", name: "This Mac" },
          { id: "vps", name: "Build‮ VPS" },
          { id: "mini", name: "Mini" },
        ] as never,
      onChange: () => () => {},
    },
    manager: {
      connectionState: (hostId: string) => states.get(hostId) ?? { status: "disconnected" },
      onStateChange: (listener: () => void) => {
        stateListener = listener;
        return () => (stateListener = null);
      },
    } as never,
    sessionFor: () => session,
    metrics: () =>
      metricsUp
        ? ({
            latest: (hostId: string) => summaries.get(hostId) ?? null,
            receiptOf: () => receipt(9_100_000, 0),
            cameOn: (summary: HostMetricsSummary) => onCurrentLink.has(summary),
            onSummary: (listener: () => void) => {
              summaryListener = listener;
              return () => (summaryListener = null);
            },
          } as never)
        : undefined,
  };
  const report = (hostId: string, agentUsage: AgentUsageReading[] | undefined, current = true) => {
    const summary = {
      hostId,
      sampledAt: 9_100_000,
      ...(agentUsage ? { agentUsage } : {}),
    } as HostMetricsSummary;
    summaries.set(hostId, summary);
    if (current) onCurrentLink.add(summary);
  };
  return {
    deps,
    states,
    report,
    setMetricsUp: (up: boolean) => (metricsUp = up),
    fireState: () => stateListener?.(),
    fireSummary: () => summaryListener?.(),
    hearing: () => summaryListener !== null,
  };
}

describe("createAgentUsageHostsSource", () => {
  it("lists only connected hosts' reports from their current link, with the host named safely", () => {
    const h = harness();
    h.report("vps", [codex]);
    h.report("mini", [codex]);
    const source = createAgentUsageHostsSource(h.deps);
    expect(source.list()).toEqual([{ hostId: "vps", hostName: "Build VPS", readings: [codex] }]);

    // A summary from a link that has since closed says nothing about the host now.
    h.report("vps", [codex], false);
    expect(source.list()).toEqual([]);

    h.report("vps", []);
    expect(source.list()).toEqual([]);
    h.report("vps", undefined);
    expect(source.list()).toEqual([]);
  });

  it("drops a host the moment its link goes", () => {
    const h = harness();
    h.report("vps", [codex]);
    const source = createAgentUsageHostsSource(h.deps);
    expect(source.list()).toHaveLength(1);
    h.states.set("vps", { status: "disconnected" });
    expect(source.list()).toEqual([]);
  });

  it("hears summaries once Remote Hosts' metrics start, even when they start after the watch", () => {
    const h = harness();
    h.setMetricsUp(false);
    const source = createAgentUsageHostsSource(h.deps);
    const listener = vi.fn();
    const off = source.watch(listener);
    expect(h.hearing()).toBe(false);
    h.setMetricsUp(true);
    h.fireState();
    expect(h.hearing()).toBe(true);
    h.fireSummary();
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    expect(h.hearing()).toBe(false);
  });
});
