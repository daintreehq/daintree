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
  describeHostMenuState,
  describeHostRowStatus,
  hostChipStatus,
  hostChipStatusText,
  hostMenuNoteAge,
  hostMenuRowHasTrouble,
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
const CONNECTED_OTHER_BUILD: HostConnectionState = {
  ...CONNECTED,
  buildMismatch: { kind: "version", local: "1.0.0", remote: "1.1.0" },
};

function descriptor(id: string, name: string, extra: Partial<HostDescriptor> = {}): HostDescriptor {
  return {
    id,
    name,
    connection: { kind: "ssh", target: `greg@${name}` },
    platform: "linux",
    arch: "x64",
    lastHandshake: null,
    lastSeenAt: null,
    addedAt: 1,
    notificationsEnabled: false,
    assistantControlEnabled: false,
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
    agentAttention: { waiting: 1, blocked: 0, idle: 2 },
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

  it("never takes Windows from a remote host's summary, and keeps a Windows Shell's own", () => {
    const windows = { ...summary("h1"), platform: "win32" as const };
    const rows = buildHostMenuRows(
      [entry("h1", "studio-01", CONNECTED, windows, { platform: "darwin" })],
      { localPlatform: "win32", currentHostId: "local", localSummary: windows }
    );
    expect(rows[0]).toMatchObject({ platform: null, summary: windows });
    expect(rows[1]!.platform).toBe("darwin");
    const [, reported] = rowsFor([
      entry("h1", "studio-01", CONNECTED, summary("h1", { platform: "linux" }), {
        platform: "darwin",
      }),
    ]);
    expect(reported!.platform).toBe("linux");
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
      agentAttention: { waiting: 0, blocked: 0, idle: 4 },
    });
    const [, row] = rowsFor([entry("h1", "studio-01", CONNECTED, quiet)]);
    expect(describeHostRowStatus(row!, now)).toBe("1 project");
  });

  it("says waiting and blocked from the host's bands, never its raw waits (#16058)", () => {
    const status = (extra: Partial<HostMetricsSummary>) => {
      const [, row] = rowsFor([
        entry("h1", "studio-01", CONNECTED, summary("h1", { projectCount: 1, ...extra })),
      ]);
      return describeHostRowStatus(row!, now);
    };
    // Three agents at their prompts, one of them blocked on an error.
    const observed = { working: 0, waiting: 3, idle: 0 };
    expect(
      status({ agentsObserved: observed, agentAttention: { waiting: 0, blocked: 1, idle: 2 } })
    ).toBe("1 project · 1 blocked (observed)");
    // A host too old to band its runs says nothing about them rather than guess.
    expect(status({ agentsObserved: observed, agentAttention: undefined })).toBe("1 project");
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

  it("says a host that announced its shutdown is restarting, through every dial", () => {
    const restartDial: HostConnectionState = {
      status: "unreachable",
      lastSeenAt: 1,
      detail: "Daintree isn't running in Host mode there (no host.json).",
      restarting: true,
    };
    const [, failed] = rowsFor([entry("h1", "studio-03", restartDial, null, { lastSeenAt: 1 })]);
    const [, dialling] = rowsFor([
      entry("h1", "studio-03", { status: "connecting", attempt: 3, restarting: true }),
    ]);
    for (const row of [failed!, dialling!]) {
      expect(describeHostRowStatus(row, now)).toBe("Restarting…");
      expect(describeHostMenuState(row, now)).toEqual({ state: "Restarting…", note: null });
      expect(hostMenuNoteAge(row)).toBeNull();
      expect(hostMenuRowHasTrouble(row)).toBe(false);
    }
    expect(hostChipStatus(false, restartDial, null)).toBe("connecting");
  });

  it("says no Daintree is listening on a host that answered, rather than unreachable", () => {
    const [, row] = rowsFor([
      entry("h1", "studio-03", {
        status: "unreachable",
        lastSeenAt: null,
        detail: "Daintree isn't running in Host mode there (no host.json).",
        hostModeOff: true,
      }),
    ]);
    expect(describeHostRowStatus(row!, now)).toBe("Not listening");
    expect(describeHostMenuState(row!, now)).toEqual({ state: "Not listening", note: null });

    // A host it has reached before (rebooted, Daintree quit there) says when.
    const lastSeen = now - 20 * 60 * 1000;
    const [, seen] = rowsFor([
      entry(
        "h1",
        "studio-03",
        {
          status: "unreachable",
          lastSeenAt: lastSeen,
          detail: "Daintree isn't running in Host mode there (no host.json).",
          hostModeOff: true,
        },
        null,
        { lastSeenAt: lastSeen }
      ),
    ]);
    expect(describeHostRowStatus(seen!, now)).toBe("Not listening · last seen 20 minutes ago");
    expect(describeHostMenuState(seen!, now)).toEqual({
      state: "Not listening",
      note: "Last seen 20 minutes ago",
    });
    // Drawn as a live time like an unreachable host's, never as frozen text.
    expect(hostMenuNoteAge(seen!)).toEqual({ prefix: "Last seen ", at: lastSeen });
    expect(hostMenuNoteAge(row!)).toBeNull();
  });

  it("says a host connected best effort runs a different build, with or without numbers", () => {
    const [, bare] = rowsFor([entry("h1", "studio-01", CONNECTED_OTHER_BUILD)]);
    expect(describeHostRowStatus(bare!, now)).toBe("Connected · different build (1.1.0)");
    const [, counted] = rowsFor([entry("h1", "studio-01", CONNECTED_OTHER_BUILD, summary("h1"))]);
    expect(describeHostRowStatus(counted!, now)).toBe(
      "2 projects · 6 working · 1 waiting (observed) · different build (1.1.0)"
    );
  });

  it("never shows a disconnected host's stale numbers", () => {
    const [, row] = rowsFor([
      entry("h1", "studio-01", { status: "disconnected" }, summary("h1"), { lastSeenAt: null }),
    ]);
    expect(describeHostRowStatus(row!, now)).toBe("Not connected");
  });
});

describe("describeHostRowStatus without a summary", () => {
  it("says nothing for this machine before its first report", () => {
    const [local] = rowsFor([entry("h1", "studio-01")]);
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

describe("describeHostMenuState", () => {
  it("names a quiet host's last word in the menu instead of calling it connected", () => {
    const [, row] = rowsFor([entry("h1", "studio-01", { ...CONNECTED, quietSince: 50_000 })]);
    const state = describeHostMenuState(row!, 62_000);
    expect(state.state).toBe("No reply");
    expect(state.note).toMatch(/^Last heard /);
    const [, steady] = rowsFor([entry("h1", "studio-01")]);
    expect(describeHostMenuState(steady!, 62_000)).toEqual({ state: "Connected", note: null });
  });
});

describe("hostChipStatus", () => {
  it("follows the link for a remote window", () => {
    expect(hostChipStatus(false, null, null)).toBe("connecting");
    expect(hostChipStatus(false, CONNECTED, null)).toBe("connected");
    expect(hostChipStatus(false, CONNECTED_OTHER_BUILD, null)).toBe("build-differs");
    // A build that connected anyway is noted in the host's details, not on the chip.
    expect(hostChipStatusText("build-differs")).toBeNull();
    expect(hostChipStatusText("version-mismatch")).toBe("can't connect");
    expect(
      hostChipStatus(false, { status: "unreachable", lastSeenAt: null, detail: null }, null)
    ).toBe("unreachable");
    expect(hostChipStatus(false, { status: "disconnected" }, null)).toBe("disconnected");
  });

  it("names what the host answered instead of calling it unreachable", () => {
    const hostModeOff: HostConnectionState = {
      status: "unreachable",
      lastSeenAt: null,
      detail: null,
      hostModeOff: true,
      stoppedRetrying: true,
    };
    const refused: HostConnectionState = {
      status: "unreachable",
      lastSeenAt: null,
      detail: "Permission denied (publickey).",
      stoppedRetrying: true,
    };
    expect(hostChipStatus(false, hostModeOff, null)).toBe("host-mode-off");
    expect(hostChipStatusText(hostChipStatus(false, hostModeOff, null))).toBe("not listening");
    expect(hostChipStatus(false, refused, null)).toBe("access-denied");
    expect(hostChipStatusText(hostChipStatus(false, refused, null))).toBe("can't log in");
  });

  it("reports a lease held elsewhere only while the link is up", () => {
    expect(hostChipStatus(false, CONNECTED, "greg-mbp")).toBe("driven-elsewhere");
    expect(
      hostChipStatus(false, { status: "unreachable", lastSeenAt: null, detail: null }, "greg-mbp")
    ).toBe("unreachable");
    expect(hostChipStatus(true, null, "greg-mbp")).toBe("driven-elsewhere");
    expect(hostChipStatus(true, null, null)).toBe("local");
  });

  it("says when a connected host has gone quiet, before a lease held elsewhere", () => {
    const quiet: HostConnectionState = { ...CONNECTED, quietSince: 1_000 };
    expect(hostChipStatus(false, quiet, null)).toBe("quiet");
    expect(hostChipStatus(false, quiet, "greg-mbp")).toBe("quiet");
    expect(hostChipStatusText("quiet")).toBe("no reply");
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
