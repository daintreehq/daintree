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
  shellClockOffset,
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

function receipt(
  receivedAt: number,
  hostAgeMs: number | null,
  maxAgeMs: number | null = null
): SummaryReceipt {
  return {
    receivedAt,
    at: { wall: receivedAt, mono: 0 } as SummaryReceipt["at"],
    hostAgeMs,
    maxAgeMs,
    timed: true,
  };
}

describe("shellClockOffset and onShellClock", () => {
  it("places a host's reading age on this machine's clock by differences taken on the host alone", () => {
    // The host's clock runs an hour ahead; its sample was 2s old when posted.
    const hourAhead = 3_600_000;
    const offset = shellClockOffset(
      { sampledAt: 9_060_000 + hourAhead },
      receipt(9_062_000, 2_000)
    );
    const placed = onShellClock({ ...codex, observedAt: 9_000_000 + hourAhead }, offset);
    expect(placed.observedAt).toBe(9_000_000);
    // A reset comes from Codex's server or the message's own words, never the host's clock.
    expect(placed.resetsAt).toBe(codex.resetsAt);
  });

  it("counts the trip as well when the frame bounds it, so a delayed summary never reads younger", () => {
    const offset = shellClockOffset({ sampledAt: 5_000_000 }, receipt(5_000_000, 2_000, 12_000));
    expect(onShellClock({ ...codex, observedAt: 4_940_000 }, offset).observedAt).toBe(4_928_000);
  });

  it("keeps a host's name for its default login only on a default reading, made safe to show (#17080)", () => {
    const defaultReading: AgentUsageReading = { ...codex, isDefault: true, accountNames: [] };
    expect(
      onShellClock({ ...defaultReading, defaultLoginName: "  Work\u202e\u0007Lab " }, 0)
        .defaultLoginName
    ).toBe("Work Lab");
    // Cleaned as main cleans it, so the same name reads the same on both machines.
    expect(
      onShellClock({ ...defaultReading, defaultLoginName: "Work\u0007\u0008Lab" }, 0)
        .defaultLoginName
    ).toBe("Work Lab");
    expect(
      onShellClock({ ...defaultReading, defaultLoginName: "\u200b\u0001" }, 0)
    ).not.toHaveProperty("defaultLoginName");
    expect(onShellClock({ ...codex, defaultLoginName: "Work" }, 0)).not.toHaveProperty(
      "defaultLoginName"
    );
  });

  it("takes the host's own times when a summary came with no receipt", () => {
    expect(shellClockOffset({ sampledAt: 5_000_000 }, null)).toBe(0);
  });
});

function harness() {
  let session = {} as LinkSession;
  let currentReceipt = receipt(9_100_000, 0);
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
            receiptOf: () => currentReceipt,
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
    setReceipt: (next: SummaryReceipt) => (currentReceipt = next),
    newSession: () => (session = {} as LinkSession),
    fireState: () => stateListener?.(),
    fireSummary: () => summaryListener?.(),
    hearing: () => summaryListener !== null,
  };
}

describe("createAgentUsageHostsSource", () => {
  it("never reads usage again from the summary a host last sent before tracking came back on (#17981)", () => {
    const h = harness();
    h.report("vps", [codex]);
    const source = createAgentUsageHostsSource(h.deps);
    source.setAside();
    expect(source.list()).toEqual([]);
    // The next summary the host sends is read as ever.
    h.report("vps", [{ ...codex, usedPercent: 12 }]);
    expect(source.list()[0]!.readings[0]!.usedPercent).toBe(12);
    // With no metrics running there's nothing to set aside.
    h.setMetricsUp(false);
    expect(() => source.setAside()).not.toThrow();
  });

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

  it("keeps one placement per link, so a host's readings hold their order and their age, and re-places on a new link", () => {
    const h = harness();
    const claude: AgentUsageReading = {
      agentId: "claude",
      accountNames: [],
      isDefault: true,
      window: "weekly limit",
      statement: "used",
      usedPercent: 30,
      resetsAt: null,
      observedAt: 9_050_000,
    };
    h.report("vps", [codex, claude]);
    const source = createAgentUsageHostsSource(h.deps);
    const [first, beside] = source.list()[0]!.readings;
    // A later frame on the same link, with a new reading beside it, moves neither.
    h.setReceipt(receipt(9_200_000, 0));
    h.report("vps", [codex, { ...claude, usedPercent: 40 }]);
    const [again, changed] = source.list()[0]!.readings;
    expect(again!.observedAt).toBe(first!.observedAt);
    expect(changed!.observedAt - again!.observedAt).toBe(beside!.observedAt - first!.observedAt);
    // A new link is a new placement.
    h.newSession();
    h.report("vps", [codex]);
    expect(source.list()[0]!.readings[0]!.observedAt).toBe(first!.observedAt + 100_000);
  });

  it("takes the offset again once a frame first bounds its trip", () => {
    const h = harness();
    h.setReceipt(receipt(9_100_000, 0));
    h.report("vps", [codex]);
    const source = createAgentUsageHostsSource(h.deps);
    const unbounded = source.list()[0]!.readings[0]!.observedAt;
    h.setReceipt(receipt(9_100_000, 0, 30_000));
    h.report("vps", [codex]);
    expect(source.list()[0]!.readings[0]!.observedAt).toBe(unbounded - 30_000);
  });

  it("drops a host the moment its link goes, and tells the watcher", () => {
    const h = harness();
    h.report("vps", [codex]);
    const source = createAgentUsageHostsSource(h.deps);
    const listener = vi.fn();
    source.watch(listener);
    expect(source.list()).toHaveLength(1);
    h.states.set("vps", { status: "disconnected" });
    h.fireState();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(source.list()).toEqual([]);
  });

  it("never lists this machine's own summary as a host's", () => {
    const h = harness();
    h.states.set("local", { status: "connected" } as HostConnectionState);
    h.report("local", [codex]);
    expect(createAgentUsageHostsSource(h.deps).list()).toEqual([]);
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
    expect(listener).toHaveBeenCalledTimes(1);
    h.fireSummary();
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    expect(h.hearing()).toBe(false);
  });
});
