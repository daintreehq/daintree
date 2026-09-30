import { bench, describe, vi } from "vitest";

// Main-process terminal pollers against a modelled PTY host: 10 projects,
// 30 terminals, both background pollers running for one simulated minute with
// four agent transitions. The host side of each RPC is modelled as the work the
// real handler does — project every record, then structured-clone the reply as
// the MessagePort would.
//
//   npx vitest bench --run electron/services/__bench__/terminalPollers.bench.ts

const broadcastMock = vi.hoisted(() => vi.fn());
const eventEmitter = vi.hoisted(() => {
  const listeners = new Map<string, Set<(payload?: unknown) => void>>();
  return {
    on: (event: string, cb: (payload?: unknown) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
      return () => listeners.get(event)?.delete(cb);
    },
    emit: (event: string, payload?: unknown) => {
      for (const cb of listeners.get(event) ?? []) cb(payload);
    },
  };
});
const PROJECTS = vi.hoisted(() => Array.from({ length: 10 }, (_, i) => ({ id: `project-${i}` })));

vi.mock("../../ipc/utils.js", () => ({ typedBroadcast: broadcastMock }));
vi.mock("../events.js", () => ({ events: eventEmitter }));
vi.mock("../ProjectStore.js", () => ({ projectStore: { getAllProjects: () => PROJECTS } }));
vi.mock("../ScratchStore.js", () => ({ scratchStore: { getAllScratches: () => [] } }));
vi.mock("../AgentAvailabilityStore.js", () => ({
  getAgentAvailabilityStore: () => ({ isHelpTerminal: () => false }),
}));
vi.mock("../HelpSessionService.js", () => ({
  helpSessionService: { isPanelVisible: () => true, getSlotForTerminal: () => null },
}));

import { ProjectStatsService } from "../ProjectStatsService.js";
import { FleetSnapshotService } from "../FleetSnapshotService.js";

const TERMINALS_PER_PROJECT = 3;
const MINUTE_MS = 60_000;
const TRANSITIONS_AT_MS = [7_300, 19_100, 33_700, 48_200];
const BASE_TIME = 1_830_000_000_000;

type HostRecord = Record<string, unknown> & { id: string; projectId: string; agentState: string };

function makeHost() {
  const records: HostRecord[] = [];
  for (const project of PROJECTS) {
    for (let i = 0; i < TERMINALS_PER_PROJECT; i++) {
      records.push({
        id: `${project.id}-term-${i}`,
        projectId: project.id,
        kind: "terminal",
        launchAgentId: i === 0 ? undefined : "claude",
        title: `Terminal ${i}`,
        titleMode: "auto",
        lastObservedTitle: `claude — ${project.id}`,
        cwd: `/Users/dev/projects/${project.id}`,
        agentState: i === 0 ? "idle" : i === 1 ? "working" : "waiting",
        waitingReason: i === 2 ? "prompt" : undefined,
        lastStateChange: BASE_TIME - 30_000,
        lastOutputChangeAt: BASE_TIME - 20_000,
        lastInputTime: BASE_TIME - 40_000,
        lastTypedInputAt: BASE_TIME - 40_000,
        lastOutputTime: BASE_TIME - 20_000,
        spawnedAt: BASE_TIME - 600_000,
        isTrashed: false,
        activityTier: "active",
        hasPty: true,
        isExited: false,
        agentSessionId: "0f3c9f4e-6a0e-4d7b-9d55-4f1b7a2c9e10",
        agentLaunchFlags: ["--dangerously-skip-permissions"],
        agentModelId: "claude-opus",
        worktreeId: `/Users/dev/projects/${project.id}`,
        everDetectedAgent: i !== 0,
        agentIncarnation: 1,
        detectedAgentId: i === 0 ? undefined : "claude",
        ptyCols: 180,
        ptyRows: 48,
      });
    }
  }

  const rpcs = { "get-all-terminals": 0, "get-project-stats": 0 };

  const getAllTerminalsWithCompletenessAsync = async () => {
    rpcs["get-all-terminals"]++;
    const terminals = structuredClone(records.map((r) => ({ ...r })));
    await Promise.resolve();
    return { terminals, degraded: false, shardsTotal: 1, shardsFailed: 0 };
  };
  const client = {
    getAllTerminalsWithCompletenessAsync,
    getAllTerminalsAsync: async () => (await getAllTerminalsWithCompletenessAsync()).terminals,
    getProjectStats: async (projectId: string) => {
      rpcs["get-project-stats"]++;
      const matching = records.filter(
        (r) => !r.isExited && !r.isTrashed && r.projectId === projectId
      );
      const stats = structuredClone({
        terminalCount: matching.length,
        processIds: matching.map((_, i) => 1000 + i),
        terminalTypes: { claude: matching.length },
      });
      await Promise.resolve();
      return stats;
    },
  };
  return { records, rpcs, client };
}

async function simulateMinute() {
  const host = makeHost();
  const stats = new ProjectStatsService(host.client as never);
  const fleet = new FleetSnapshotService(host.client as never);
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.setSystemTime(BASE_TIME);
  broadcastMock.mockClear();
  try {
    stats.start();
    fleet.start();
    let elapsed = 0;
    for (const [n, at] of TRANSITIONS_AT_MS.entries()) {
      await vi.advanceTimersByTimeAsync(at - elapsed);
      elapsed = at;
      host.records[n * 3 + 1].agentState = "waiting";
      host.records[n * 3 + 1].lastStateChange = Date.now();
      eventEmitter.emit("agent:state-changed");
    }
    await vi.advanceTimersByTimeAsync(MINUTE_MS - elapsed);
  } finally {
    stats.stop();
    fleet.stop();
    vi.useRealTimers();
  }
  // Guard against a faster-but-wrong run: after the four transitions the last
  // stats push must report every project's final waiting tally and process count.
  const lastStats = broadcastMock.mock.calls
    .filter(([channel]) => channel === "project:stats-updated")
    .at(-1)?.[1] as Record<string, { waitingAgentCount: number; processCount: number }>;
  const waiting = Object.values(lastStats ?? {}).reduce((n, p) => n + p.waitingAgentCount, 0);
  const processes = Object.values(lastStats ?? {}).reduce((n, p) => n + p.processCount, 0);
  const expectedWaiting = host.records.filter((r) => r.agentState === "waiting").length;
  if (waiting !== expectedWaiting || processes !== host.records.length) {
    throw new Error(
      `stats diverged: waiting ${waiting}/${expectedWaiting}, processes ${processes}/${host.records.length}`
    );
  }
  return { rpcs: host.rpcs, broadcasts: broadcastMock.mock.calls.length };
}

const tally = await simulateMinute();
// stdout directly: the suite setup silences console in bench runs.
process.stdout.write(
  `[terminalPollers] per simulated minute: get-all-terminals=${tally.rpcs["get-all-terminals"]}` +
    ` get-project-stats=${tally.rpcs["get-project-stats"]} broadcasts=${tally.broadcasts}\n`
);

describe("terminal pollers (10 projects, 30 terminals)", () => {
  bench(
    "one simulated minute, both pollers + 4 transitions",
    async () => {
      await simulateMinute();
    },
    { time: 3_000 }
  );

  bench(
    "ProjectStatsService.computeAndBroadcast (cold read)",
    async () => {
      // A fresh client per call keeps any shared read cache cold, so this times
      // a full fan-out rather than a cache hit.
      const host = makeHost();
      const svc = new ProjectStatsService(host.client as never);
      await (svc as unknown as { computeAndBroadcast(): Promise<void> }).computeAndBroadcast();
    },
    { time: 3_000 }
  );
});
