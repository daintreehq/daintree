import type {
  HostConnectionState,
  HostHandshakeInfo,
  HostListEntry,
  HostPlatform,
} from "@shared/types/remoteHosts";
import type { HostProjectSummary, RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";
import {
  retryHostProjects,
  setHostProjectsLoader,
  useOtherHostTargets,
} from "@/components/Hosts/hostProjects";
import { getHostListSnapshot } from "@/components/Hosts/hostList";
import { clientPlatform } from "@/components/Hosts/hostModel";

/**
 * Other hosts for the project switcher harness: the "Other hosts" band in each
 * state a host's listing can be in. `?hosts=` picks the set; without it the
 * palette has no other hosts and draws no band.
 *
 * The listings are staged through the real catalogue rather than faked around
 * it: a host is listed while connected and then drops, so a stale list carries
 * the "listed N min ago" the band really prints. The clock runs six minutes
 * behind while the lists are taken and is put right before the palette mounts.
 */

export type HostsFixture = "offline" | "mixed" | "rich" | "edge" | "search";

type Plan =
  /** Not connected this session (disconnected unless `connection` says otherwise): nothing listed. */
  | { kind: "offline"; connection?: HostConnectionState }
  /** Connected, and still giving its first list. */
  | { kind: "first-listing" }
  /** Connected; its listing failed with nothing cached, and Retry was pressed. */
  | { kind: "retrying" }
  /** Connected; lists these projects. */
  | { kind: "connected"; projects: HostProjectSummary[] }
  /** Listed these, then dropped. */
  | { kind: "dropped"; projects: HostProjectSummary[] }
  /** Connected, but every listing fails. `lastGood` lists first, then the failure. */
  | { kind: "failed"; lastGood?: HostProjectSummary[] }
  /** Connected, listed these, and is being asked again. */
  | { kind: "relisting"; projects: HostProjectSummary[] };

interface HostSpec {
  id: string;
  name: string;
  platform: HostPlatform;
  plan: Plan;
}

const STALE_BY_MS = 6 * 60_000;

function project(id: string, name: string, path: string, emoji?: string): HostProjectSummary {
  return emoji ? { id, name, path, emoji } : { id, name, path };
}

const DAINTREE = project("p-daintree", "Daintree", "/Users/gpriday/Projects/daintree", "🌳");
const HUB_MSG = project("p-hub-msg", "hub-msg-01", "/Users/gpriday/daintree-e2e/hub-msg-01", "🌲");

const offline = (id: string): HostSpec => ({
  id,
  name: id,
  platform: "darwin",
  plan: { kind: "offline" },
});

const FIXTURES: Record<HostsFixture, HostSpec[]> = {
  offline: ["studio-01", "studio-02", "studio-03", "studio-04"].map(offline),
  mixed: [
    {
      id: "studio-01",
      name: "studio-01",
      platform: "darwin",
      plan: { kind: "connected", projects: [DAINTREE, HUB_MSG] },
    },
    offline("studio-02"),
    offline("studio-03"),
    offline("studio-04"),
  ],
  rich: [
    {
      id: "build-runner",
      name: "build-runner-eu-west-07.ci.internal",
      platform: "linux",
      plan: { kind: "failed" },
    },
    {
      id: "studio-01",
      name: "studio-01",
      platform: "darwin",
      plan: {
        kind: "connected",
        projects: [
          DAINTREE,
          HUB_MSG,
          project(
            "p-assistant",
            "assistant",
            "/Users/gpriday/Projects/daintree-assistant-with-a-long-folder-name",
            "🤖"
          ),
          project("p-scratch", "untitled-experiment", "/Users/gpriday/tmp/untitled-experiment"),
        ],
      },
    },
    {
      id: "studio-02",
      name: "studio-02",
      platform: "darwin",
      plan: {
        kind: "dropped",
        projects: [
          project("p-site", "marketing-site", "/Users/gpriday/Projects/marketing-site", "📣"),
          project("p-api", "payments-api", "/Users/gpriday/Projects/payments-api", "💳"),
        ],
      },
    },
    {
      id: "studio-03",
      name: "studio-03",
      platform: "darwin",
      plan: {
        kind: "failed",
        lastGood: [project("p-docs", "docs", "/Users/gpriday/Projects/docs", "📚")],
      },
    },
    {
      id: "studio-04",
      name: "studio-04",
      platform: "darwin",
      plan: {
        kind: "relisting",
        projects: [project("p-tokens", "design-tokens", "/Users/gpriday/Projects/tokens", "🎨")],
      },
    },
    offline("studio-05"),
  ],
  // The states a host passes through on its way to a list, or instead of one.
  edge: [
    {
      id: "studio-06",
      name: "studio-06",
      platform: "darwin",
      plan: { kind: "connected", projects: [] },
    },
    { id: "studio-07", name: "studio-07", platform: "darwin", plan: { kind: "first-listing" } },
    {
      id: "studio-08",
      name: "studio-08",
      platform: "darwin",
      plan: {
        kind: "offline",
        connection: { status: "unreachable", lastSeenAt: null, detail: null },
      },
    },
    {
      id: "dev-box",
      name: "dev-box",
      platform: "linux",
      plan: { kind: "offline", connection: { status: "connecting", attempt: 1 } },
    },
    { id: "studio-09", name: "studio-09", platform: "darwin", plan: { kind: "retrying" } },
  ],
  // Same hosts as `mixed`; the query does the work.
  search: [],
};
FIXTURES.search = FIXTURES.mixed;

export function isHostsFixture(value: string | null): value is HostsFixture {
  return value !== null && value in FIXTURES;
}

const handshake = (platform: HostPlatform): HostHandshakeInfo => ({
  version: "0.42.0",
  commit: "bc80755",
  protocolVersion: 7,
  platform,
  arch: "arm64",
});

const connectedState = (platform: HostPlatform): HostConnectionState => ({
  status: "connected",
  rttMs: 12,
  rttSampledAt: Date.now(),
  handshake: handshake(platform),
});

function entry(spec: HostSpec, connection: HostConnectionState): HostListEntry {
  return {
    descriptor: {
      id: spec.id,
      name: spec.name,
      connection: { kind: "ssh", target: `greg@${spec.name}` },
      platform: spec.platform,
      arch: "arm64",
      lastHandshake: handshake(spec.platform),
      lastSeenAt: Date.now() - 3_600_000,
      addedAt: Date.now() - 30 * 86_400_000,
      notificationsEnabled: false,
      assistantMessagingEnabled: false,
      assistantStartEnabled: false,
      assistantControlEnabled: false,
    },
    connection,
    summary: null,
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** How often staging re-checks the host list while it waits, and for how long. */
const STAGE_POLL_MS = 10;
const STAGE_POLL_LIMIT = 300;

async function until(test: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < STAGE_POLL_LIMIT; i += 1) {
    if (test()) return;
    await new Promise((resolve) => setTimeout(resolve, STAGE_POLL_MS));
  }
  throw new Error(`other-hosts harness: timed out waiting for ${what}`);
}

let staged: { specs: HostSpec[]; calls: Map<string, number>; restoreClock: () => void } | null =
  null;
const connections = new Map<string, HostConnectionState>();
const listeners = new Set<(event: RemoteHostsEvent) => void>();

/**
 * Puts `window.electron.remoteHosts` and the project loader in place and sets
 * the clock back. Call before anything renders; `settleOtherHosts` finishes
 * the job once a reader of the targets is mounted, since the catalogue asks
 * hosts for projects only while something reads them.
 */
export function installOtherHosts(fixture: HostsFixture): void {
  const specs = FIXTURES[fixture];
  for (const spec of specs) {
    connections.set(
      spec.id,
      spec.plan.kind === "offline"
        ? (spec.plan.connection ?? { status: "disconnected" })
        : connectedState(spec.platform)
    );
  }

  // Writes through the shim's Proxy onto its overrides, so `remoteHosts`
  // answers for real while every other namespace stays inert. The list reads
  // the live connections, so a host that dropped stays dropped on a re-read.
  Reflect.set(Reflect.get(window, "electron") as object, "remoteHosts", {
    list: async () => specs.map((spec) => entry(spec, connections.get(spec.id)!)),
    listRecent: async () => [],
    onEvent: (listener: (event: RemoteHostsEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isInUse: async () => true,
  });

  // Each host's answers in order; the last one repeats.
  const answers = new Map<string, Array<() => Promise<HostProjectSummary[]>>>();
  const calls = new Map<string, number>();
  const never = () => new Promise<HostProjectSummary[]>(() => {});
  const fail = () => Promise.reject(new Error("harness: listing failed"));
  for (const spec of specs) {
    const plan = spec.plan;
    switch (plan.kind) {
      case "connected":
      case "dropped":
        answers.set(spec.id, [async () => plan.projects]);
        break;
      case "failed":
        answers.set(spec.id, plan.lastGood ? [async () => plan.lastGood!, fail] : [fail]);
        break;
      case "relisting":
        answers.set(spec.id, [async () => plan.projects, never]);
        break;
      case "first-listing":
        answers.set(spec.id, [never]);
        break;
      case "retrying":
        answers.set(spec.id, [fail, never]);
        break;
      case "offline":
        break;
    }
  }
  setHostProjectsLoader((hostId) => {
    const list = answers.get(hostId) ?? [];
    const n = calls.get(hostId) ?? 0;
    calls.set(hostId, n + 1);
    const answer = list[Math.min(n, list.length - 1)];
    return answer ? answer() : Promise.resolve([]);
  });

  const realNow = Date.now.bind(Date);
  Date.now = () => realNow() - STALE_BY_MS;
  staged = { specs, calls, restoreClock: () => (Date.now = realNow) };
}

let settling: Promise<void> | null = null;

/** Walks every host to its planned state and puts the clock right. Runs once. */
export function settleOtherHosts(): Promise<void> {
  settling ??= settle();
  return settling;
}

async function settle(): Promise<void> {
  if (!staged) throw new Error("other-hosts harness: installOtherHosts first");
  const { specs, calls, restoreClock } = staged;
  try {
    await until(() => getHostListSnapshot().hosts.length === specs.length, "the host list");
    await until(
      () => specs.every((spec) => spec.plan.kind === "offline" || (calls.get(spec.id) ?? 0) >= 1),
      "the first listings"
    );
    await tick();
    await tick();
    for (const spec of specs) {
      if (spec.plan.kind === "dropped") {
        const connection: HostConnectionState = { status: "disconnected" };
        connections.set(spec.id, connection);
        for (const listener of listeners) {
          listener({ type: "connection-changed", hostId: spec.id, connection });
        }
      }
      if (
        spec.plan.kind === "relisting" ||
        spec.plan.kind === "retrying" ||
        (spec.plan.kind === "failed" && spec.plan.lastGood)
      ) {
        retryHostProjects(spec.id);
      }
    }
    await tick();
    await tick();
  } finally {
    restoreClock();
  }
}

/** Mounted beside the palette: keeps the host list and its listings live from the start. */
export function useOtherHostsReader(): number {
  return useOtherHostTargets(clientPlatform()).length;
}
