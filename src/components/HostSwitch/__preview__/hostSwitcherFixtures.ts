import type {
  HostConnectionState,
  HostHandshakeInfo,
  HostListEntry,
  HostMetricsSummary,
  HostPlatform,
  HostRecentUse,
} from "@shared/types/remoteHosts";

/**
 * Host lists for the host switcher harness. Every connection state the row
 * can name appears somewhere, with names long enough to clip and counts wide
 * enough to test the number columns.
 */

const NOW = Date.now();
const minutesAgo = (n: number) => NOW - n * 60_000;

const handshake = (platform: HostPlatform, version = "0.42.0"): HostHandshakeInfo => ({
  version,
  commit: "bc80755",
  protocolVersion: 7,
  platform,
  arch: "arm64",
});

function summary(
  hostId: string,
  platform: HostPlatform,
  partial: Partial<HostMetricsSummary>
): HostMetricsSummary {
  return {
    hostId,
    sampledAt: NOW - 2_000,
    platform,
    cpuPercent: null,
    memoryPressure: null,
    memoryUsedBytes: null,
    memoryTotalBytes: null,
    swapUsedBytes: null,
    swapTotalBytes: null,
    thermal: null,
    cpuPressure: null,
    agentsObserved: null,
    projectCount: null,
    worktreeCount: null,
    driver: null,
    agentClis: [],
    ...partial,
  };
}

interface HostSpec {
  id: string;
  name: string;
  platform: HostPlatform | null;
  connection: HostConnectionState;
  lastSeenAt: number | null;
  lastUsedAt: number | null;
  summary?: Partial<HostMetricsSummary>;
}

function entry(spec: HostSpec): HostListEntry {
  const platform = spec.platform ?? "linux";
  return {
    descriptor: {
      id: spec.id,
      name: spec.name,
      connection: { kind: "ssh", target: `greg@${spec.name}` },
      platform: spec.platform,
      arch: "arm64",
      lastHandshake: spec.platform ? handshake(spec.platform) : null,
      lastSeenAt: spec.lastSeenAt,
      addedAt: minutesAgo(60 * 24 * 30),
      notificationsEnabled: false,
      assistantMessagingEnabled: false,
      assistantStartEnabled: false,
      assistantControlEnabled: false,
    },
    connection: spec.connection,
    summary: spec.summary ? summary(spec.id, platform, spec.summary) : null,
  };
}

const connected = (
  platform: HostPlatform,
  rttMs: number,
  extra: Partial<Extract<HostConnectionState, { status: "connected" }>> = {}
): HostConnectionState => ({
  status: "connected",
  rttMs,
  rttSampledAt: NOW - 1_000,
  handshake: handshake(platform),
  ...extra,
});

const GiB = 1024 ** 3;

export const LOCAL_SUMMARY = summary("local", "darwin", {
  cpuPercent: 20,
  memoryPressure: "normal",
  memoryUsedBytes: 21 * GiB,
  memoryTotalBytes: 64 * GiB,
  agentsObserved: { working: 3, waiting: 7, idle: 4 },
  projectCount: 30,
  worktreeCount: 52,
});

const FLEET: HostSpec[] = [
  {
    id: "studio-01",
    name: "studio-01",
    platform: "darwin",
    connection: connected("darwin", 14),
    lastSeenAt: NOW - 3_000,
    lastUsedAt: minutesAgo(12),
    summary: {
      cpuPercent: 68,
      memoryPressure: "warn",
      memoryUsedBytes: 98 * GiB,
      memoryTotalBytes: 128 * GiB,
      agentsObserved: { working: 4, waiting: 2, idle: 1 },
      projectCount: 6,
      worktreeCount: 18,
    },
  },
  {
    id: "studio-02",
    name: "studio-02",
    platform: "darwin",
    connection: connected("darwin", 31, {
      buildMismatch: { kind: "commit", local: "bc80755", remote: "ac3d8be" },
    }),
    lastSeenAt: NOW - 3_000,
    lastUsedAt: minutesAgo(60 * 3),
    summary: {
      cpuPercent: 8,
      memoryPressure: "normal",
      memoryUsedBytes: 30 * GiB,
      memoryTotalBytes: 128 * GiB,
      agentsObserved: { working: 0, waiting: 6, idle: 2 },
      projectCount: 2,
      worktreeCount: 5,
    },
  },
  {
    id: "studio-03",
    name: "studio-03",
    platform: "darwin",
    connection: { status: "disconnected" },
    lastSeenAt: minutesAgo(60),
    lastUsedAt: minutesAgo(60 * 26),
  },
  {
    id: "build-eu-west-worker-04",
    name: "build-linux-eu-west-1-worker-04",
    platform: "linux",
    connection: connected("linux", 142, { quietSince: NOW - 9_000 }),
    lastSeenAt: NOW - 9_000,
    lastUsedAt: minutesAgo(60 * 50),
    summary: {
      cpuPercent: 97,
      memoryPressure: "critical",
      agentsObserved: { working: 12, waiting: 0, idle: 0 },
      projectCount: 1,
      worktreeCount: 12,
    },
  },
  {
    id: "studio-04",
    name: "studio-04",
    platform: "darwin",
    connection: { status: "unreachable", lastSeenAt: minutesAgo(60 * 7), detail: "timed out" },
    lastSeenAt: minutesAgo(60 * 7),
    lastUsedAt: minutesAgo(60 * 24 * 4),
  },
  {
    id: "gpu-box",
    name: "gpu-box",
    platform: "linux",
    connection: {
      status: "version-mismatch",
      mismatch: { kind: "protocol", local: 7, remote: 6 },
      remote: handshake("linux", "0.39.2"),
    },
    lastSeenAt: minutesAgo(60 * 24 * 2),
    lastUsedAt: null,
  },
  {
    id: "mac-mini",
    name: "mac-mini",
    platform: "darwin",
    connection: { status: "connecting", attempt: 2 },
    lastSeenAt: minutesAgo(60 * 24 * 9),
    lastUsedAt: null,
  },
  {
    id: "office-imac",
    name: "office-imac",
    platform: null,
    connection: {
      status: "unreachable",
      lastSeenAt: null,
      detail: null,
      hostModeOff: true,
      stoppedRetrying: true,
    },
    lastSeenAt: null,
    lastUsedAt: null,
  },
];

function recents(specs: HostSpec[], localAt: number | null): HostRecentUse[] {
  const out: HostRecentUse[] = specs.flatMap((spec) =>
    spec.lastUsedAt === null ? [] : [{ hostId: spec.id, lastUsedAt: spec.lastUsedAt }]
  );
  if (localAt !== null) out.push({ hostId: "local", lastUsedAt: localAt });
  return out.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

export interface HostSwitcherFixture {
  hosts: HostListEntry[];
  recent: HostRecentUse[];
  localSummary: HostMetricsSummary | null;
  /** The window's host; null for this machine. */
  currentHostId: string | null;
  query?: string;
}

const FIXTURES: Record<string, HostSwitcherFixture> = {
  fleet: {
    hosts: FLEET.map(entry),
    recent: recents(FLEET, minutesAgo(2)),
    localSummary: LOCAL_SUMMARY,
    currentHostId: null,
  },
  remote: {
    hosts: FLEET.map(entry),
    // On studio-01 since a moment ago, having come from studio-02.
    recent: recents(
      FLEET.map((spec) =>
        spec.id === "studio-01"
          ? { ...spec, lastUsedAt: minutesAgo(1) }
          : spec.id === "studio-02"
            ? { ...spec, lastUsedAt: minutesAgo(40) }
            : spec
      ),
      minutesAgo(90)
    ),
    // Another laptop is driving a project on this Mac meanwhile.
    localSummary: {
      ...LOCAL_SUMMARY,
      driver: {
        leaseId: 4,
        endpointId: "endpoint-office",
        clientId: "client-office",
        clientName: "office-mbp",
        isHostLocal: false,
        acquiredAt: NOW - 600_000,
      },
    },
    currentHostId: "studio-01",
  },
  search: {
    hosts: FLEET.map(entry),
    recent: recents(FLEET, minutesAgo(2)),
    localSummary: LOCAL_SUMMARY,
    currentHostId: null,
    query: "studio",
  },
  nomatch: {
    hosts: FLEET.map(entry),
    recent: recents(FLEET, minutesAgo(2)),
    localSummary: LOCAL_SUMMARY,
    currentHostId: null,
    query: "kubernetes",
  },
  pair: {
    hosts: FLEET.slice(0, 1).map(entry),
    recent: recents(FLEET.slice(0, 1), minutesAgo(2)),
    localSummary: LOCAL_SUMMARY,
    currentHostId: null,
  },
};

export function requireFixture(name: string): HostSwitcherFixture {
  const fixture = FIXTURES[name];
  if (!fixture) throw new Error(`Unknown host switcher fixture: ${name}`);
  return fixture;
}

/** A metrics history, newest first, rising and falling around a level. */
export function historyFor(
  base: HostMetricsSummary,
  samples: number,
  wobble: number
): HostMetricsSummary[] {
  const out: HostMetricsSummary[] = [];
  const cpu = base.cpuPercent ?? 0;
  for (let i = 0; i < samples; i += 1) {
    const swing = Math.sin(i / 4) * wobble + Math.cos(i / 9) * wobble * 0.6;
    out.push({
      ...base,
      sampledAt: base.sampledAt - i * 5_000,
      cpuPercent: Math.max(0, Math.min(100, cpu + (i === 0 ? 0 : swing))),
    });
  }
  return out;
}
