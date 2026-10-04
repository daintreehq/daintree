import { describe, expect, it, vi } from "vitest";
import { buildProcessInventory } from "../processInventory.js";
import { createStateConfigHandlers } from "../stateConfig.js";
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
