import { describe, expect, it } from "vitest";
import type {
  HostConnectionState,
  HostDescriptor,
  HostListEntry,
  HostMetricsSummary,
} from "@shared/types/remoteHosts";
import {
  buildHostMenuRows,
  describeHostAgentClis,
  describeHostRowMetrics,
  describeHostRowStatus,
  hostChipStatus,
  hostChipStatusText,
  updateActionLabel,
  updateTargetFor,
} from "../hostModel";

const HANDSHAKE = {
  version: "1.0.0",
  commit: "abc",
  protocolVersion: 1,
  platform: "linux",
  arch: "x64",
} as const;

const CONNECTED: HostConnectionState = { status: "connected", rttMs: 1, handshake: HANDSHAKE };

function descriptor(id: string, name: string, extra: Partial<HostDescriptor> = {}): HostDescriptor {
  return {
    id,
    name,
    sshTarget: `greg@${name}`,
    platform: "linux",
    arch: "x64",
    lastHandshake: null,
    lastSeenAt: null,
    addedAt: 1,
    notificationsEnabled: false,
    ...extra,
  };
}

function summary(hostId: string, extra: Partial<HostMetricsSummary> = {}): HostMetricsSummary {
  return {
    hostId,
    sampledAt: 1,
    platform: "linux",
    cpuPercent: 71.4,
    memoryPressure: "warn",
    memoryUsedBytes: null,
    memoryTotalBytes: null,
    swapUsedBytes: null,
    swapTotalBytes: null,
    thermal: null,
    cpuPressure: null,
    agentsObserved: { working: 6, waiting: 1, idle: 2 },
    projectCount: 2,
    worktreeCount: 3,
    driver: null,
    agentClis: [],
    ...extra,
  };
}

function entry(
  id: string,
  name: string,
  connection: HostConnectionState = CONNECTED,
  s: HostMetricsSummary | null = null,
  extra: Partial<HostDescriptor> = {}
): HostListEntry {
  return { descriptor: descriptor(id, name, extra), connection, summary: s };
}

function rowsFor(entries: HostListEntry[], currentHostId = "local") {
  return buildHostMenuRows(entries, { localPlatform: "darwin", currentHostId, localSummary: null });
}

describe("buildHostMenuRows", () => {
  it("puts this machine first and every other host after it by name", () => {
    const rows = rowsFor([
      entry("h3", "studio-03"),
      entry("h1", "build-linux"),
      entry("h2", "Studio-01"),
      entry("h4", "studio-10"),
      entry("h5", "studio-2"),
    ]);
    expect(rows.map((r) => r.name)).toEqual([
      "This Mac",
      "build-linux",
      "Studio-01",
      "studio-2",
      "studio-03",
      "studio-10",
    ]);
  });

  it("names this machine for what it is on each platform", () => {
    const linux = buildHostMenuRows([], {
      localPlatform: "linux",
      currentHostId: "local",
      localSummary: null,
    });
    expect(linux[0]!.name).toBe("This machine");
  });

  it("marks the window's own host as current", () => {
    const rows = rowsFor([entry("h1", "studio-01"), entry("h2", "studio-02")], "h2");
    expect(rows.filter((r) => r.isCurrent).map((r) => r.hostId)).toEqual(["h2"]);
  });
});

describe("describeHostRowStatus", () => {
  const now = 10 * 60 * 60 * 1000;

  it("reports counts and labels agent states as observed", () => {
    const [, row] = rowsFor([entry("h1", "studio-01", CONNECTED, summary("h1"))]);
    expect(describeHostRowStatus(row!, now)).toBe("2 projects · 6 working · 1 waiting (observed)");
  });

  it("leaves out agent states nobody saw", () => {
    const quiet = summary("h1", {
      projectCount: 1,
      agentsObserved: { working: 0, waiting: 0, idle: 4 },
    });
    const [, row] = rowsFor([entry("h1", "studio-01", CONNECTED, quiet)]);
    expect(describeHostRowStatus(row!, now)).toBe("1 project");
  });

  it("says unreachable with when it was last seen, never why", () => {
    const lastSeen = now - 2 * 60 * 60 * 1000;
    const [, row] = rowsFor([
      entry("h1", "studio-03", { status: "unreachable", lastSeenAt: lastSeen, detail: "timeout" }),
    ]);
    const text = describeHostRowStatus(row!, now);
    expect(text).toMatch(/^Unreachable · last seen /);
    expect(text).toContain("2 hours ago");
    expect(text).not.toMatch(/asleep|timeout/i);
  });

  it("never shows a disconnected host's stale numbers", () => {
    const [, row] = rowsFor([
      entry("h1", "studio-01", { status: "disconnected" }, summary("h1"), { lastSeenAt: null }),
    ]);
    expect(describeHostRowStatus(row!, now)).toBe("Not connected");
    expect(describeHostRowMetrics(row!)).toBeNull();
  });
});

describe("describeHostRowMetrics", () => {
  it("shows CPU and memory pressure when measured", () => {
    const [, row] = rowsFor([entry("h1", "studio-01", CONNECTED, summary("h1"))]);
    expect(describeHostRowMetrics(row!)).toBe("CPU 71%  Memory warn");
  });

  it("shows nothing rather than zeros when the host measured nothing", () => {
    const blank = summary("h1", { cpuPercent: null, memoryPressure: null });
    const [, row] = rowsFor([entry("h1", "studio-01", CONNECTED, blank)]);
    expect(describeHostRowMetrics(row!)).toBeNull();
  });

  it("shows nothing when no summary has arrived", () => {
    const [local, remote] = rowsFor([entry("h1", "studio-01")]);
    expect(describeHostRowMetrics(local!)).toBeNull();
    expect(describeHostRowMetrics(remote!)).toBeNull();
    expect(describeHostRowStatus(local!)).toBeNull();
  });
});

describe("describeHostAgentClis", () => {
  it("lists what the host reports, with versions where known", () => {
    const clis = summary("h1", {
      agentClis: [
        { agentId: "claude", version: "2.1.0" },
        { agentId: "some-unknown-cli", version: null },
      ],
    });
    const [, row] = rowsFor([entry("h1", "studio-01", CONNECTED, clis)]);
    const line = describeHostAgentClis(row!);
    expect(line).toMatch(/2\.1\.0/);
    expect(line).toMatch(/some-unknown-cli$/);
  });

  it("is absent when the host reports none", () => {
    const [, row] = rowsFor([entry("h1", "studio-01", CONNECTED, summary("h1"))]);
    expect(describeHostAgentClis(row!)).toBeNull();
  });
});

describe("hostChipStatus", () => {
  it("follows the link for a remote window", () => {
    expect(hostChipStatus(false, null, null)).toBe("connecting");
    expect(hostChipStatus(false, CONNECTED, null)).toBe("connected");
    expect(
      hostChipStatus(false, { status: "unreachable", lastSeenAt: null, detail: null }, null)
    ).toBe("unreachable");
    expect(hostChipStatus(false, { status: "disconnected" }, null)).toBe("disconnected");
  });

  it("reports a lease held elsewhere only while the link is up", () => {
    expect(hostChipStatus(false, CONNECTED, "greg-mbp")).toBe("driven-elsewhere");
    expect(
      hostChipStatus(false, { status: "unreachable", lastSeenAt: null, detail: null }, "greg-mbp")
    ).toBe("unreachable");
    expect(hostChipStatus(true, null, "greg-mbp")).toBe("driven-elsewhere");
    expect(hostChipStatus(true, null, null)).toBe("local");
  });

  it("adds no trailing text when the name says it all", () => {
    expect(hostChipStatusText("local")).toBeNull();
    expect(hostChipStatusText("connected")).toBeNull();
    expect(hostChipStatusText("unreachable")).not.toBeNull();
  });
});

describe("updateTargetFor", () => {
  it("updates whichever side is behind", () => {
    expect(updateTargetFor({ kind: "version", local: "1.4.0", remote: "1.3.9" })).toBe("host");
    expect(updateTargetFor({ kind: "version", local: "1.3.0", remote: "1.10.0" })).toBe("local");
    expect(updateTargetFor({ kind: "protocol", local: 2, remote: 3 })).toBe("local");
  });

  it("updates the host when the builds can't be ordered", () => {
    expect(updateTargetFor({ kind: "commit", local: "abc", remote: "def" })).toBe("host");
    expect(updateTargetFor({ kind: "version", local: "1.3.0", remote: "1.3.0-nightly" })).toBe(
      "host"
    );
  });

  it("names the side to update", () => {
    expect(
      updateActionLabel({ kind: "version", local: "1.4.0", remote: "1.3.0" }, "studio-01")
    ).toBe("Update studio-01");
    expect(
      updateActionLabel({ kind: "version", local: "1.3.0", remote: "1.4.0" }, "studio-01")
    ).toBe("Update this machine");
  });
});
