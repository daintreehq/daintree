import { bench, describe, vi } from "vitest";

// ProjectViewManager's agent-state cache while N terminals are restored or
// batch-launched: each spawn registers the terminal in a modelled pty-host and
// emits `spawn-result`. The host side of each RPC does the work the real handler
// does — project every record, then structured-clone the reply as the
// MessagePort would — and answers a macrotask later, so a burst overlaps.
// Timers are simulated: sequential spawns land 50ms apart, and the run ends
// only after any debounced follow-up work has fired and settled.
//
//   npx vitest bench --run electron/window/__bench__/agentStateReseed.bench.ts

vi.mock("../../services/events.js", () => ({ events: { on: () => () => {} } }));
vi.mock("../../utils/webContentsLifecycle.js", () => ({ unfreezeWebContents: async () => {} }));

import { initAgentStateCache } from "../ProjectViewAgentStateCache.js";

const BASE_TIME = 1_830_000_000_000;

type HostRecord = Record<string, unknown> & { id: string; projectId: string; agentState: string };

function makeRecord(i: number): HostRecord {
  const projectId = `project-${i % 5}`;
  return {
    id: `term-${i}`,
    projectId,
    kind: "terminal",
    launchAgentId: "claude",
    isAssistantTerminal: false,
    title: `Terminal ${i}`,
    titleMode: "auto",
    lastObservedTitle: `claude — ${projectId}`,
    cwd: `/Users/dev/projects/${projectId}`,
    agentState: i % 3 === 0 ? "working" : "idle",
    waitingReason: undefined,
    lastStateChange: BASE_TIME - 30_000,
    lastOutputChangeAt: BASE_TIME - 20_000,
    lastInputTime: BASE_TIME - 40_000,
    lastTypedInputAt: BASE_TIME - 40_000,
    lastOutputTime: BASE_TIME - 20_000,
    spawnedAt: BASE_TIME - 600_000,
    isTrashed: false,
    trashExpiresAt: undefined,
    activityTier: "active",
    hasPty: true,
    isExited: false,
    agentSessionId: "0f3c9f4e-6a0e-4d7b-9d55-4f1b7a2c9e10",
    agentLaunchFlags: ["--dangerously-skip-permissions"],
    agentModelId: "claude-opus",
    worktreeId: `/Users/dev/projects/${projectId}`,
    agentPresetId: "default",
    agentPresetColor: "#7aa2f7",
    originalAgentPresetId: "default",
    everDetectedAgent: true,
    agentIncarnation: 1,
    detectedAgentId: "claude",
    detectedProcessId: "claude",
    lastHandback: undefined,
    submission: undefined,
    ptyCols: 180,
    ptyRows: 48,
  };
}

const macrotask = () => new Promise<void>((resolve) => setImmediate(resolve));

function makeFixture() {
  const records = new Map<string, HostRecord>();
  const tally = { fullListCalls: 0, singleCalls: 0, recordsCloned: 0 };
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const ptyClient = {
    getAllTerminalsAsync: async () => {
      tally.fullListCalls++;
      const reply = structuredClone([...records.values()].map((r) => ({ ...r })));
      tally.recordsCloned += reply.length;
      await macrotask();
      return reply;
    },
    getTerminalAsync: async (id: string) => {
      tally.singleCalls++;
      const record = records.get(id);
      const reply = record ? structuredClone({ ...record }) : null;
      if (reply) tally.recordsCloned++;
      await macrotask();
      return reply;
    },
    getTerminalProjectId: (id: string) => records.get(id)?.projectId ?? null,
    on: (event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    },
    off: (event: string, handler: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(handler);
    },
  };
  const emit = (event: string, ...args: unknown[]) => {
    for (const handler of listeners.get(event) ?? []) handler(...args);
  };
  const host = {
    disposed: false,
    agentCacheCleanup: [] as Array<() => void>,
    projectByTerminal: new Map<string, string>(),
    agentStateByTerminal: new Map<string, string>(),
    efficiencyFreezeEnabled: false,
    activeProjectId: null,
    views: new Map(),
    unfreezeActiveAgentViews: () => {},
  };
  return { records, tally, ptyClient, emit, host };
}

async function settle() {
  for (let i = 0; i < 8; i++) await macrotask();
}

const SEQUENTIAL_GAP_MS = 50;

async function restore(n: number, mode: "sequential" | "burst") {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    return await runRestore(n, mode);
  } finally {
    vi.useRealTimers();
  }
}

async function runRestore(n: number, mode: "sequential" | "burst") {
  const f = makeFixture();
  await initAgentStateCache(f.host as never, f.ptyClient as never);
  f.tally.fullListCalls = 0;
  f.tally.singleCalls = 0;
  f.tally.recordsCloned = 0;
  for (let i = 0; i < n; i++) {
    const record = makeRecord(i);
    f.records.set(record.id, record);
    f.emit("spawn-result", record.id, { success: true, id: record.id });
    if (mode === "sequential") {
      await settle();
      vi.advanceTimersByTime(SEQUENTIAL_GAP_MS);
    }
  }
  await settle();
  vi.advanceTimersByTime(5_000);
  await settle();
  // A faster-but-wrong run must not pass: the cache has to mirror the host.
  if (f.host.projectByTerminal.size !== n || f.host.agentStateByTerminal.size !== n) {
    throw new Error(
      `cache diverged: projects=${f.host.projectByTerminal.size} states=${f.host.agentStateByTerminal.size} n=${n}`
    );
  }
  for (const r of f.records.values()) {
    if (f.host.projectByTerminal.get(r.id) !== r.projectId) throw new Error(`project ${r.id}`);
    if (f.host.agentStateByTerminal.get(r.id) !== r.agentState) throw new Error(`state ${r.id}`);
  }
  for (const cleanup of f.host.agentCacheCleanup) cleanup();
  return f.tally;
}

const CASES = [
  [20, "sequential"],
  [40, "sequential"],
  [20, "burst"],
  [40, "burst"],
] as const;

for (const [n, mode] of CASES) {
  const t = await restore(n, mode);
  const started = performance.now();
  const cpuStart = process.cpuUsage();
  const reps = 20;
  for (let i = 0; i < reps; i++) await restore(n, mode);
  const ms = (performance.now() - started) / reps;
  const cpu = process.cpuUsage(cpuStart);
  const cpuMs = (cpu.user + cpu.system) / 1000 / reps;
  // stdout directly: the suite setup silences console in bench runs.
  process.stdout.write(
    `[agentStateReseed] N=${n} ${mode}: full-list=${t.fullListCalls} single=${t.singleCalls}` +
      ` records-cloned=${t.recordsCloned} ms/restore=${ms.toFixed(2)} cpu-ms/restore=${cpuMs.toFixed(2)}\n`
  );
}

{
  const n = 40;
  const all = Array.from({ length: n }, (_, i) => makeRecord(i));
  const started = performance.now();
  for (let k = 0; k < n; k++) structuredClone(all);
  process.stdout.write(
    `[agentStateReseed] node structuredClone of ${n}x${n} records: ${(performance.now() - started).toFixed(2)}ms\n`
  );
}

describe("agent-state cache during terminal restore", () => {
  for (const [n, mode] of CASES) {
    bench(
      `N=${n} ${mode} spawn-results`,
      async () => {
        await restore(n, mode);
      },
      { time: 2_000 }
    );
  }
});
