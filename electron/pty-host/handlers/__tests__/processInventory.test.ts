import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockReap } = vi.hoisted(() => ({ mockReap: vi.fn() }));

vi.mock("../../../services/TerminalLineageLedger.js", () => ({
  reapLineageEntries: mockReap,
}));

import {
  buildProcessInventory,
  killClosedTerminalProcesses,
  listClosedTerminalProcesses,
} from "../processInventory.js";
import { createStateConfigHandlers } from "../stateConfig.js";
import type { ClosedLineageSurvivor } from "../../../services/TerminalLineageLedger.js";
import type { HostContext } from "../types.js";

interface FakeTerminal {
  id: string;
  projectId?: string;
  kind?: string;
  title?: string;
  cwd: string;
  launchAgentId?: string;
  detectedAgentId?: string;
  isAssistantTerminal?: boolean;
  spawnedAt: number;
  isExited?: boolean;
  wasKilled?: boolean;
  ptyProcess?: { pid: number };
}

function summary(pid: number, memoryKb: number) {
  return {
    cpuPercent: 1.5,
    memoryKb,
    processCount: 2,
    breakdown: [{ pid, comm: "zsh", cpuPercent: 1.5, memoryKb }],
  };
}

function makeCtx(
  terminals: FakeTerminal[],
  opts: {
    trashed?: Record<string, number>;
    summaries?: Record<number, ReturnType<typeof summary>>;
    lastError?: Error | null;
    lastRefresh?: number;
  } = {}
) {
  const trashed = opts.trashed ?? {};
  const summaries = opts.summaries ?? {};
  const getTreeResourceSummary = vi.fn((pid: number) => summaries[pid] ?? null);
  const ctx = {
    ptyManager: {
      getAll: () => terminals,
      isInTrash: (id: string) => id in trashed,
      getTerminal: (id: string) => ({ trashExpiresAt: trashed[id] }),
    },
    processTreeCache: {
      getTreeResourceSummary,
      getLastError: () => opts.lastError ?? null,
      getLastRefreshTime: () => opts.lastRefresh ?? 1_000,
    },
  } as unknown as HostContext;
  return { ctx, getTreeResourceSummary };
}

describe("buildProcessInventory (#13175)", () => {
  it("lists live PTYs of every kind, including trashed, hidden and assistant ones", () => {
    const { ctx } = makeCtx(
      [
        { id: "t1", projectId: "p1", cwd: "/a", spawnedAt: 1, ptyProcess: { pid: 101 } },
        {
          id: "dev",
          projectId: "p1",
          kind: "dev-preview",
          cwd: "/a",
          spawnedAt: 2,
          ptyProcess: { pid: 102 },
        },
        { id: "trash", projectId: "p2", cwd: "/b", spawnedAt: 3, ptyProcess: { pid: 103 } },
        {
          id: "asst",
          isAssistantTerminal: true,
          cwd: "/c",
          spawnedAt: 4,
          ptyProcess: { pid: 104 },
        },
      ],
      { trashed: { trash: 5_000 }, summaries: { 101: summary(101, 2048) } }
    );

    const inventory = buildProcessInventory(ctx, []);

    expect(inventory.terminals.map((t) => t.id)).toEqual(["t1", "dev", "trash", "asst"]);
    const [t1, dev, trash, asst] = inventory.terminals;
    expect(t1.sample).toEqual({
      cpuPercent: 1.5,
      memoryKb: 2048,
      processCount: 2,
      members: [{ pid: 101, comm: "zsh", cpuPercent: 1.5, memoryKb: 2048 }],
    });
    expect(t1.rootPid).toBe(101);
    expect(dev.kind).toBe("dev-preview");
    expect(dev.sample).toBeNull();
    expect(trash.isTrashed).toBe(true);
    expect(trash.trashExpiresAt).toBe(5_000);
    expect(t1.isTrashed).toBe(false);
    expect(t1.trashExpiresAt).toBeUndefined();
    expect(asst.isAssistantTerminal).toBe(true);
    expect(asst.projectId).toBeNull();
  });

  it("names tree members by executable, never by path", () => {
    const { ctx } = makeCtx([{ id: "t", cwd: "/", spawnedAt: 1, ptyProcess: { pid: 7 } }], {
      summaries: {
        7: {
          cpuPercent: 0,
          memoryKb: 10,
          processCount: 1,
          breakdown: [
            { pid: 7, comm: "/Users/alice/private-tools/node", cpuPercent: 0, memoryKb: 10 },
          ],
        },
      },
    });

    const [terminal] = buildProcessInventory(ctx, []).terminals;

    expect(terminal.sample?.members.map((m) => m.comm)).toEqual(["node"]);
  });

  it("leaves out exited and killed records kept for their scrollback", () => {
    const { ctx } = makeCtx([
      { id: "live", cwd: "/", spawnedAt: 1, ptyProcess: { pid: 1 } },
      { id: "exited", cwd: "/", spawnedAt: 1, isExited: true, ptyProcess: { pid: 2 } },
      { id: "killed", cwd: "/", spawnedAt: 1, wasKilled: true, ptyProcess: { pid: 3 } },
    ]);

    expect(buildProcessInventory(ctx, []).terminals.map((t) => t.id)).toEqual(["live"]);
  });

  it("reports an unknown root pid as null rather than sampling it", () => {
    const { ctx, getTreeResourceSummary } = makeCtx([{ id: "t", cwd: "/", spawnedAt: 1 }]);

    const [terminal] = buildProcessInventory(ctx, []).terminals;

    expect(terminal.rootPid).toBeNull();
    expect(terminal.sample).toBeNull();
    expect(getTreeResourceSummary).not.toHaveBeenCalled();
  });

  it("samples the extra pids it is asked about and skips malformed ones", () => {
    const { ctx } = makeCtx([], { summaries: { 500: summary(500, 4096) } });

    const inventory = buildProcessInventory(ctx, [500, 501, -1, "x", 1.5]);

    expect(Object.keys(inventory.pidSamples)).toEqual(["500"]);
    expect(inventory.pidSamples[500].memoryKb).toBe(4096);
  });

  it("carries the census's own freshness, not the time of the request", () => {
    const { ctx } = makeCtx([], { lastError: new Error("ps failed"), lastRefresh: 42 });

    const inventory = buildProcessInventory(ctx, []);

    expect(inventory.available).toBe(false);
    expect(inventory.sampledAt).toBe(42);
  });

  it("answers get-process-inventory with the request id", () => {
    const { ctx } = makeCtx([{ id: "t", cwd: "/", spawnedAt: 1, ptyProcess: { pid: 9 } }]);
    const sendEvent = vi.fn();
    const handlers = createStateConfigHandlers({ ...ctx, sendEvent } as unknown as HostContext);

    handlers["get-process-inventory"]({ requestId: "r1", pids: "not-an-array" });

    expect(sendEvent).toHaveBeenCalledTimes(1);
    const event = sendEvent.mock.calls[0][0];
    expect(event.type).toBe("process-inventory");
    expect(event.requestId).toBe("r1");
    expect(event.inventory.terminals.map((t: { id: string }) => t.id)).toEqual(["t"]);
    expect(event.inventory.pidSamples).toEqual({});
  });
});

const origin = {
  kind: "terminal" as const,
  id: "term-1",
  projectId: "proj-1",
  title: "npm run dev",
  spawnedAt: 10,
};

function survivor(pid: number, startTime = `start-${pid}`): ClosedLineageSurvivor {
  return { pid, startTime, rootPid: 100, origin, closedAtMs: 5_000 };
}

function makeClosedCtx(
  survivors: ClosedLineageSurvivor[] | null,
  procs: Record<number, { comm: string; rssKb: number; cpuPercent: number }> = {}
) {
  const getClosedSurvivors = vi.fn((_graceMs?: number) => survivors ?? []);
  const ctx = {
    ptyManager: { getAll: () => [], isInTrash: () => false, getTerminal: () => undefined },
    processTreeCache: {
      getTreeResourceSummary: () => null,
      getProcess: (pid: number) => (procs[pid] ? { pid, ppid: 1, ...procs[pid] } : undefined),
      getLastError: () => null,
      getLastRefreshTime: () => 1_000,
    },
    lineageLedger: survivors === null ? undefined : { getClosedSurvivors },
  } as unknown as HostContext;
  return { ctx, getClosedSurvivors };
}

describe("closed-terminal processes in the host inventory (#13174)", () => {
  beforeEach(() => {
    mockReap.mockReset();
  });

  it("joins each survivor with the census by basename and memory, never a command line", () => {
    const { ctx } = makeClosedCtx([survivor(201), survivor(202)], {
      201: { comm: "/usr/local/bin/node", rssKb: 4096, cpuPercent: 3 },
    });

    expect(listClosedTerminalProcesses(ctx)).toEqual([
      {
        pid: 201,
        startTime: "start-201",
        comm: "node",
        memoryKb: 4096,
        cpuPercent: 3,
        origin,
        closedAt: 5_000,
      },
      {
        pid: 202,
        startTime: "start-202",
        comm: "",
        memoryKb: null,
        cpuPercent: null,
        origin,
        closedAt: 5_000,
      },
    ]);
  });

  it("carries survivors on the inventory, and none from a host without a ledger", () => {
    expect(
      buildProcessInventory(makeClosedCtx([survivor(201)]).ctx, []).closedTerminalProcesses
    ).toEqual([expect.objectContaining({ pid: 201 })]);
    expect(buildProcessInventory(makeClosedCtx(null).ctx, []).closedTerminalProcesses).toEqual([]);
  });

  it("signals only identities the ledger holds, matched on pid and start time", async () => {
    mockReap.mockResolvedValue({
      survivors: [],
      found: 1,
      ended: 1,
      stillRunning: 0,
      unchecked: 0,
    });
    const { ctx, getClosedSurvivors } = makeClosedCtx([survivor(201), survivor(202)]);

    const result = await killClosedTerminalProcesses(ctx, [
      { pid: 201, startTime: "start-201" },
      // Right pid, wrong identity — a recycled PID or a forged request.
      { pid: 202, startTime: "someone else" },
      // Never recorded at all.
      { pid: 999, startTime: "start-999" },
      // Malformed.
      { pid: "203" },
      null,
    ]);

    expect(getClosedSurvivors).toHaveBeenCalledWith(0);
    expect(mockReap).toHaveBeenCalledTimes(1);
    expect(mockReap.mock.calls[0][0]).toEqual([{ pid: 201, startTime: "start-201", rootPid: 100 }]);
    expect(result).toEqual({ ended: 1, stillRunning: 0, unchecked: 0, notTracked: 2 });
  });

  it("signals nothing when no target is owned", async () => {
    const { ctx } = makeClosedCtx([survivor(201)]);

    const result = await killClosedTerminalProcesses(ctx, [{ pid: 999, startTime: "x" }]);

    expect(mockReap).not.toHaveBeenCalled();
    expect(result).toEqual({ ended: 0, stillRunning: 0, unchecked: 0, notTracked: 1 });
  });

  it("counts a target already gone at the first probe as ended, and passes through what it couldn't check", async () => {
    mockReap.mockResolvedValue({
      survivors: [],
      found: 1,
      ended: 0,
      stillRunning: 1,
      unchecked: 1,
    });
    const { ctx } = makeClosedCtx([survivor(201), survivor(202), survivor(203)]);

    const result = await killClosedTerminalProcesses(ctx, [
      { pid: 201, startTime: "start-201" },
      { pid: 202, startTime: "start-202" },
      { pid: 203, startTime: "start-203" },
    ]);

    expect(result).toEqual({ ended: 1, stillRunning: 1, unchecked: 1, notTracked: 0 });
  });
});
