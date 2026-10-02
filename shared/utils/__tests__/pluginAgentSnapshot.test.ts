import { describe, it, expect } from "vitest";
import { toPluginAgentSnapshot, type AgentStateChangePayload } from "../pluginAgentSnapshot.js";

const base: AgentStateChangePayload = {
  state: "waiting",
  previousState: "working",
  waitingReason: "approval",
  timestamp: 5,
};

describe("toPluginAgentSnapshot", () => {
  it("carries the terminal id and the host-resolved workspace id", () => {
    const snapshot = toPluginAgentSnapshot(
      { ...base, terminalId: "term-1" },
      { workspaceId: "project-1" }
    );
    expect(snapshot).toEqual({
      state: "waiting",
      previousState: "working",
      running: true,
      waitingReason: "approval",
      terminalId: "term-1",
      workspaceId: "project-1",
      timestamp: 5,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("omits ids that are missing, empty or not strings", () => {
    for (const [terminalId, workspaceId] of [
      [undefined, undefined],
      ["", ""],
      [42, null],
    ] as const) {
      const snapshot = toPluginAgentSnapshot({ ...base, terminalId } as AgentStateChangePayload, {
        workspaceId: workspaceId as string | null | undefined,
      });
      expect("terminalId" in snapshot).toBe(false);
      expect("workspaceId" in snapshot).toBe(false);
    }
    expect("workspaceId" in toPluginAgentSnapshot(base)).toBe(false);
  });

  it("never copies a payload-supplied workspace id or other internals", () => {
    const snapshot = toPluginAgentSnapshot({
      ...base,
      terminalId: "term-1",
      workspaceId: "spoofed",
      worktreeId: "wt-1",
      cwd: "/secret",
      trigger: "output",
      confidence: 0.9,
    } as AgentStateChangePayload);
    expect(Object.keys(snapshot).sort()).toEqual([
      "previousState",
      "running",
      "state",
      "terminalId",
      "timestamp",
      "waitingReason",
    ]);
  });
});
