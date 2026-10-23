import { describe, expect, it } from "vitest";
import type {
  ProcessInventorySnapshot,
  ProcessTreeSample,
} from "../../../../shared/types/processes.js";
import {
  MAX_PROCESS_CLOSED,
  MAX_PROCESS_LABEL,
  MAX_PROCESS_MEMBERS,
  MAX_PROCESS_PLUGINS,
  MAX_PROCESS_TERMINALS,
  ProcessInventorySchema,
} from "../linkMethods.js";
import { boundProcessInventory } from "../processInventoryWire.js";

function sample(memberCount: number): ProcessTreeSample {
  return {
    cpuPercent: 5,
    memoryKb: 100,
    processCount: memberCount,
    members: Array.from({ length: memberCount }, (_, index) => ({
      pid: 100 + index,
      comm: "x".repeat(MAX_PROCESS_LABEL + 10),
      cpuPercent: 1,
      memoryKb: 1,
    })),
  };
}

function snapshot(
  counts: { terminals?: number; closed?: number; plugins?: number } = {}
): ProcessInventorySnapshot {
  return {
    terminals: Array.from({ length: counts.terminals ?? 1 }, (_, index) => ({
      id: `t${index}`,
      projectId: "p1",
      projectName: "n".repeat(2000),
      title: "t".repeat(2000),
      cwd: "/home/me",
      isAssistantTerminal: false,
      spawnedAt: 1,
      isTrashed: false,
      rootPid: 10,
      sample: sample(MAX_PROCESS_MEMBERS + 3),
      agentTree: "runtime-and-servers",
    })),
    closedTerminalProcesses: Array.from({ length: counts.closed ?? 0 }, (_, index) => ({
      pid: 200 + index,
      startTime: "Mon Oct 20 10:00:00 2026",
      comm: "node",
      memoryKb: null,
      cpuPercent: null,
      origin: { kind: "terminal", id: "t0", title: "o".repeat(2000) },
      closedAt: 2,
      projectName: null,
    })),
    cleanup: { found: 1, ended: 1, stillRunning: 0, unchecked: 0, lastAt: 3 },
    plugins: Array.from({ length: counts.plugins ?? 0 }, (_, index) => ({
      source: "plugin-worker",
      id: `w${index}`,
      pluginId: "acme.tools",
      label: null,
      pid: 300 + index,
      spawnedAt: null,
      sample: null,
    })),
    complete: true,
    samplesAvailable: false,
    sampledAt: 4,
  };
}

describe("boundProcessInventory", () => {
  it("fits within the schema a Shell reads it with, keeping each tree's own totals", () => {
    const bounded = boundProcessInventory(snapshot({ closed: 2, plugins: 2 }));
    const parsed = ProcessInventorySchema.parse(bounded);
    const [terminal] = parsed.terminals;
    expect(terminal.sample?.members).toHaveLength(MAX_PROCESS_MEMBERS);
    expect(terminal.sample?.processCount).toBe(MAX_PROCESS_MEMBERS + 3);
    expect(terminal.sample?.members[0].comm).toHaveLength(MAX_PROCESS_LABEL);
    expect(terminal.title).toHaveLength(1024);
    expect(terminal.projectName).toHaveLength(1024);
    expect(parsed.closedTerminalProcesses[0].origin?.title).toHaveLength(1024);
    expect(parsed).toMatchObject({ samplesAvailable: false, sampledAt: 4, truncated: false });
  });

  it("cuts every list to its bound and says rows were let go", () => {
    const bounded = boundProcessInventory(
      snapshot({
        terminals: MAX_PROCESS_TERMINALS + 1,
        closed: MAX_PROCESS_CLOSED + 1,
        plugins: MAX_PROCESS_PLUGINS + 1,
      })
    );
    expect(bounded.terminals).toHaveLength(MAX_PROCESS_TERMINALS);
    expect(bounded.closedTerminalProcesses).toHaveLength(MAX_PROCESS_CLOSED);
    expect(bounded.plugins).toHaveLength(MAX_PROCESS_PLUGINS);
    expect(bounded.truncated).toBe(true);
    expect(ProcessInventorySchema.safeParse(bounded).success).toBe(true);
  });

  it("counts a closed-process list at the pty-host's own cap as possibly cut", () => {
    expect(boundProcessInventory(snapshot({ closed: MAX_PROCESS_CLOSED - 1 })).truncated).toBe(
      false
    );
    expect(boundProcessInventory(snapshot({ closed: MAX_PROCESS_CLOSED })).truncated).toBe(true);
  });

  it("leaves the snapshot it was given alone", () => {
    const original = snapshot();
    const before = structuredClone(original);
    boundProcessInventory(original);
    expect(original).toEqual(before);
  });
});
