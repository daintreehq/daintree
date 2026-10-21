import { describe, expect, it, vi } from "vitest";

const screens = new Map<string, string | null>();
vi.mock("../../plugin/pluginTerminalScreenRead.js", () => ({
  readPluginTerminalScreen: vi.fn(async (_pty: unknown, runId: string) => {
    const text = screens.get(runId);
    return text == null
      ? { status: "not-found" }
      : { status: "ok", text, lineCount: 1, truncated: false };
  }),
}));

import type { FleetRunRow, FleetSnapshot } from "../../../../shared/types/ipc/fleet.js";
import { isRunStillWaiting, listWaitingRuns } from "../deviceAnswerRuns.js";

function row(overrides: Partial<FleetRunRow>): FleetRunRow {
  return {
    runId: "run",
    workspaceId: "ws-1",
    spawnedAt: 100,
    cwd: "/repo",
    ...overrides,
  } as FleetRunRow;
}

function snapshot(runs: FleetRunRow[]): FleetSnapshot {
  return { runs, changedAt: 0 } as unknown as FleetSnapshot;
}

describe("listWaitingRuns", () => {
  it("lists every project's waiting runs, longest waiting first, with what was observed", async () => {
    screens.set("a", "❯ 1. Yes\n  2. No");
    screens.set("b", null);
    const runs = await listWaitingRuns({
      fleet: () =>
        snapshot([
          row({
            runId: "a",
            agentState: "waiting",
            waitingReason: "approval",
            since: 20,
            workspaceId: "ws-1",
          }),
          row({ runId: "busy", agentState: "working", since: 1 }),
          row({
            runId: "b",
            agentState: "waiting",
            waitingReason: "error",
            since: 10,
            workspaceId: "ws-2",
            park: {} as never,
          }),
        ]),
      pty: () => null,
      projectName: (id) => (id === "ws-1" ? "daintree" : null),
    });
    expect(runs.map((r) => r.runId)).toEqual(["b", "a"]);
    expect(runs[0]).toMatchObject({
      waitingReason: "error",
      parked: true,
      project: null,
      screen: null,
      choices: [],
    });
    expect(runs[1]).toMatchObject({
      waitingReason: "approval",
      parked: false,
      project: "daintree",
      choices: ["Yes", "No"],
    });
  });

  it("lists nothing when the fleet has no snapshot yet", async () => {
    expect(
      await listWaitingRuns({ fleet: () => null, pty: () => null, projectName: () => null })
    ).toEqual([]);
  });
});

describe("isRunStillWaiting", () => {
  it("holds only for the same run, the same spawn, still waiting", () => {
    const fleet = snapshot([row({ runId: "a", spawnedAt: 100, agentState: "waiting" })]);
    expect(isRunStillWaiting(fleet, "a", 100)).toBe(true);
    expect(isRunStillWaiting(fleet, "a", 99)).toBe(false);
    expect(
      isRunStillWaiting(snapshot([row({ runId: "a", agentState: "working" })]), "a", 100)
    ).toBe(false);
    expect(isRunStillWaiting(null, "a", 100)).toBe(false);
  });
});
