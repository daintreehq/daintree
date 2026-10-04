import { describe, expect, it, vi } from "vitest";
import { collectProcessInventory, type ProcessInventoryDeps } from "../processInventory.js";
import type {
  HostProcessInventory,
  HostProcessInventoryTerminal,
  ProcessTreeSample,
} from "../../../shared/types/processes.js";
import type { PluginProcessInfo } from "../../../shared/types/ipc/pluginProcess.js";
import type { WorkerResourceSnapshot } from "../../../shared/types/workerGovernance.js";

function terminal(
  id: string,
  projectId: string | null,
  extra: Partial<HostProcessInventoryTerminal> = {}
): HostProcessInventoryTerminal {
  return {
    id,
    projectId,
    cwd: "/",
    isAssistantTerminal: false,
    spawnedAt: 1,
    isTrashed: false,
    rootPid: 100,
    sample: null,
    ...extra,
  };
}

function inventory(
  terminals: HostProcessInventoryTerminal[],
  extra: Partial<HostProcessInventory> = {}
): HostProcessInventory {
  return { terminals, pidSamples: {}, available: true, sampledAt: 1_000, ...extra };
}

function sample(memoryKb: number): ProcessTreeSample {
  return { cpuPercent: 2, memoryKb, processCount: 1, members: [] };
}

function child(overrides: Partial<PluginProcessInfo> = {}): PluginProcessInfo {
  return {
    id: "proc-1",
    pluginId: "acme.devtools",
    command: "/usr/local/bin/node",
    args: ["server.js", "--token=SECRET"],
    cwd: "/secret/path",
    status: "running",
    pid: 700,
    exitCode: null,
    signal: null,
    spawnedAt: 50,
    restartCount: 0,
    ...overrides,
  };
}

function worker(id: string, pid: number | null): WorkerResourceSnapshot {
  return { kind: "plugin-worker", id, pid, state: "running" } as unknown as WorkerResourceSnapshot;
}

function deps(overrides: Partial<ProcessInventoryDeps> = {}): ProcessInventoryDeps {
  return {
    getHostInventory: vi.fn(async () => ({ inventories: [], shardsTotal: 1, shardsFailed: 0 })),
    getWorkspaceNames: () => [],
    getPluginProcesses: async () => null,
    getAppMetrics: () => [],
    ...overrides,
  };
}

describe("collectProcessInventory (#13175)", () => {
  it("joins every shard's terminals with their project names", async () => {
    const snapshot = await collectProcessInventory(
      deps({
        getHostInventory: async () => ({
          inventories: [
            inventory([terminal("a", "p1")]),
            inventory([terminal("b", "p2"), terminal("c", null)]),
          ],
          shardsTotal: 2,
          shardsFailed: 0,
        }),
        getWorkspaceNames: () => [
          { id: "p1", name: "Cedar" },
          { id: "p2", name: "Birch" },
        ],
      })
    );

    expect(snapshot.terminals.map((t) => [t.id, t.projectName])).toEqual([
      ["a", "Cedar"],
      ["b", "Birch"],
      ["c", null],
    ]);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.samplesAvailable).toBe(true);
  });

  it("reports a shard that did not answer as incomplete, not as an empty project", async () => {
    const snapshot = await collectProcessInventory(
      deps({
        getHostInventory: async () => ({
          inventories: [inventory([terminal("a", "p1")])],
          shardsTotal: 2,
          shardsFailed: 1,
        }),
      })
    );

    expect(snapshot.complete).toBe(false);
    expect(snapshot.terminals).toHaveLength(1);
  });

  it("flags a failed census and reports the oldest successful one", async () => {
    const snapshot = await collectProcessInventory(
      deps({
        getHostInventory: async () => ({
          inventories: [
            inventory([], { sampledAt: 5_000 }),
            inventory([], { sampledAt: 3_000, available: false }),
            inventory([], { sampledAt: 0 }),
          ],
          shardsTotal: 3,
          shardsFailed: 0,
        }),
      })
    );

    expect(snapshot.samplesAvailable).toBe(false);
    expect(snapshot.sampledAt).toBe(3_000);
  });

  it("treats a host with terminals whose census never ran as unavailable", async () => {
    const withIdleHost = await collectProcessInventory(
      deps({
        getHostInventory: async () => ({
          inventories: [inventory([terminal("a", "p1")]), inventory([], { sampledAt: 0 })],
          shardsTotal: 2,
          shardsFailed: 0,
        }),
      })
    );
    expect(withIdleHost.samplesAvailable).toBe(true);

    const withColdHost = await collectProcessInventory(
      deps({
        getHostInventory: async () => ({
          inventories: [
            inventory([terminal("a", "p1")]),
            inventory([terminal("b", "p2")], { sampledAt: 0 }),
          ],
          shardsTotal: 2,
          shardsFailed: 0,
        }),
      })
    );
    expect(withColdHost.samplesAvailable).toBe(false);
  });

  it("takes each plugin pid's reading from the freshest working census, never a sum", async () => {
    const snapshot = await collectProcessInventory(
      deps({
        getHostInventory: async () => ({
          inventories: [
            inventory([], { sampledAt: 9_000, pidSamples: { 700: sample(300) } }),
            inventory([], { sampledAt: 5_000, pidSamples: { 700: sample(100) } }),
            inventory([], { sampledAt: 9_500, available: false, pidSamples: { 700: sample(999) } }),
          ],
          shardsTotal: 3,
          shardsFailed: 0,
        }),
        getPluginProcesses: async () => ({ children: [child()], workers: [] }),
      })
    );

    expect(snapshot.plugins[0].sample).toEqual(sample(300));
  });

  it("projects plugin children without their args, env or full command path", async () => {
    const getHostInventory = vi.fn(async () => ({
      inventories: [inventory([], { pidSamples: { 700: sample(1024) } })],
      shardsTotal: 1,
      shardsFailed: 0,
    }));
    const snapshot = await collectProcessInventory(
      deps({
        getHostInventory,
        getPluginProcesses: async () => ({
          children: [child(), child({ id: "gone", status: "exited", pid: null })],
          workers: [],
        }),
      })
    );

    expect(getHostInventory).toHaveBeenCalledWith([700]);
    expect(snapshot.plugins).toEqual([
      {
        source: "plugin-process",
        id: "proc-1",
        pluginId: "acme.devtools",
        label: "node",
        pid: 700,
        spawnedAt: 50,
        sample: sample(1024),
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("SECRET");
    expect(JSON.stringify(snapshot)).not.toContain("/secret/path");
  });

  it("samples plugin workers from the shared app metrics by pid", async () => {
    const snapshot = await collectProcessInventory(
      deps({
        getPluginProcesses: async () => ({
          children: [],
          workers: [worker("acme.devtools", 800), worker("not-forked", null)],
        }),
        getAppMetrics: () =>
          [
            { pid: 800, cpu: { percentCPUUsage: 3 }, memory: { workingSetSize: 51_200 } },
          ] as unknown as Electron.ProcessMetric[],
      })
    );

    expect(snapshot.plugins).toEqual([
      {
        source: "plugin-worker",
        id: "acme.devtools",
        pluginId: "acme.devtools",
        label: null,
        pid: 800,
        spawnedAt: null,
        sample: { cpuPercent: 3, memoryKb: 51_200, processCount: 1, members: [] },
      },
    ]);
  });

  it("still lists terminals when the plugin system and name lookup fail", async () => {
    const snapshot = await collectProcessInventory(
      deps({
        getHostInventory: async () => ({
          inventories: [inventory([terminal("a", "p1")])],
          shardsTotal: 1,
          shardsFailed: 0,
        }),
        getPluginProcesses: async () => {
          throw new Error("not loaded");
        },
        getWorkspaceNames: () => {
          throw new Error("db closed");
        },
      })
    );

    expect(snapshot.terminals.map((t) => [t.id, t.projectName])).toEqual([["a", null]]);
    expect(snapshot.plugins).toEqual([]);
  });
});
