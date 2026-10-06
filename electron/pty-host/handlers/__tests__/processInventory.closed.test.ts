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
import type { ClosedLineageSurvivor } from "../../../services/TerminalLineageLedger.js";
import type { HostContext } from "../types.js";

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

function makeCtx(
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
    const { ctx } = makeCtx([survivor(201), survivor(202)], {
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
    expect(buildProcessInventory(makeCtx([survivor(201)]).ctx, []).closedTerminalProcesses).toEqual(
      [expect.objectContaining({ pid: 201 })]
    );
    expect(buildProcessInventory(makeCtx(null).ctx, []).closedTerminalProcesses).toEqual([]);
  });

  it("signals only identities the ledger holds, matched on pid and start time", async () => {
    mockReap.mockResolvedValue({
      survivors: [],
      found: 1,
      ended: 1,
      stillRunning: 0,
      unchecked: 0,
    });
    const { ctx, getClosedSurvivors } = makeCtx([survivor(201), survivor(202)]);

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
    const { ctx } = makeCtx([survivor(201)]);

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
    const { ctx } = makeCtx([survivor(201), survivor(202), survivor(203)]);

    const result = await killClosedTerminalProcesses(ctx, [
      { pid: 201, startTime: "start-201" },
      { pid: 202, startTime: "start-202" },
      { pid: 203, startTime: "start-203" },
    ]);

    expect(result).toEqual({ ended: 1, stillRunning: 1, unchecked: 1, notTracked: 0 });
  });
});
