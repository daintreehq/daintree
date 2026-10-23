import { describe, expect, it } from "vitest";
import type {
  ProcessInventorySnapshot,
  ProcessTreeSample,
} from "../../../../shared/types/processes.js";
import {
  MAX_PROCESS_CLOSED,
  MAX_PROCESS_INVENTORY_BYTES,
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

  it.each([
    ["terminals", { terminals: MAX_PROCESS_TERMINALS }, MAX_PROCESS_TERMINALS],
    ["plugins", { plugins: MAX_PROCESS_PLUGINS }, MAX_PROCESS_PLUGINS],
    ["closedTerminalProcesses", { closed: MAX_PROCESS_CLOSED + 1 }, MAX_PROCESS_CLOSED],
  ] as const)("cuts %s to its bound and says rows were let go", (list, counts, cap) => {
    const atCap = boundProcessInventory(snapshot(counts));
    if (list !== "closedTerminalProcesses") {
      expect(atCap[list]).toHaveLength(cap);
      expect(atCap.truncated).toBe(false);
    }
    const over = boundProcessInventory(
      snapshot({
        ...counts,
        [list === "closedTerminalProcesses" ? "closed" : list]: cap + 1,
      })
    );
    expect(over[list]).toHaveLength(cap);
    expect(over.truncated).toBe(true);
    expect(ProcessInventorySchema.safeParse(over).success).toBe(true);
  });

  it("keeps a full answer of long multibyte text inside the byte budget, terminals first", () => {
    // Three bytes a character, at every length the schema allows.
    const wide = "\u4e2d".repeat(1024);
    const big = snapshot({
      terminals: MAX_PROCESS_TERMINALS,
      closed: MAX_PROCESS_CLOSED - 1,
      plugins: MAX_PROCESS_PLUGINS,
    });
    for (const terminal of big.terminals) {
      terminal.cwd = wide.repeat(4);
      terminal.title = wide;
      terminal.projectName = wide;
    }
    const bounded = boundProcessInventory(big);
    const bytes = Buffer.byteLength(JSON.stringify(bounded), "utf8");
    expect(bytes).toBeLessThanOrEqual(MAX_PROCESS_INVENTORY_BYTES + 1024);
    expect(bounded.terminals.length).toBeGreaterThan(0);
    expect(bounded.terminals.length).toBeLessThan(MAX_PROCESS_TERMINALS);
    expect(bounded.plugins).toHaveLength(0);
    expect(bounded.closedTerminalProcesses).toHaveLength(0);
    expect(bounded.truncated).toBe(true);
    expect(ProcessInventorySchema.safeParse(bounded).success).toBe(true);
  });

  it("zeroes readings the Shell's schema would refuse, rather than failing the whole answer", () => {
    const odd = snapshot({ closed: 1, plugins: 1 });
    odd.plugins[0].sample = { cpuPercent: Number.NaN, memoryKb: -1, processCount: 1, members: [] };
    odd.closedTerminalProcesses[0].cpuPercent = Number.NaN;
    odd.closedTerminalProcesses[0].memoryKb = -5;
    odd.cleanup = { found: 5_000_000, ended: 0, stillRunning: 0, unchecked: 0, lastAt: 1 };
    odd.terminals[0].worktreeId = "";
    const parsed = ProcessInventorySchema.parse(boundProcessInventory(odd));
    expect(parsed.plugins[0].sample).toMatchObject({ cpuPercent: 0, memoryKb: 0 });
    expect(parsed.closedTerminalProcesses[0]).toMatchObject({ cpuPercent: null, memoryKb: null });
    expect(parsed.cleanup?.found).toBe(5_000_000);
    expect(parsed.terminals).toHaveLength(1);
    expect(parsed.truncated).toBe(false);
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
