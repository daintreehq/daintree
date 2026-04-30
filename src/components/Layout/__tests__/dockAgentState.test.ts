import { describe, expect, it } from "vitest";
import type { AgentState } from "@shared/types/agent";
import {
  getDockDisplayAgentState,
  getGroupAmbientAgentState,
  getGroupBlockedAgentState,
  isGroupDeprioritized,
} from "../useDockBlockedState";

function agent(overrides: {
  launchAgentId?: string;
  detectedAgentId?: string;
  agentState?: AgentState;
  activityStatus?: "working" | "waiting" | "success" | "failure";
}) {
  return {
    launchAgentId: overrides.launchAgentId ?? "claude",
    detectedAgentId: overrides.detectedAgentId,
    agentState: overrides.agentState,
    activityStatus: overrides.activityStatus,
  };
}

describe("dock display agent state", () => {
  it("prefers waiting activity over a stale working agent state", () => {
    expect(
      getDockDisplayAgentState(agent({ agentState: "working", activityStatus: "waiting" }))
    ).toBe("waiting");
  });

  it("keeps terminal-only process activity out of agent dock state", () => {
    expect(getDockDisplayAgentState({ activityStatus: "working" })).toBeUndefined();
  });

  it("does not resurrect explicit-exited launch affinity from stale activity", () => {
    expect(
      getDockDisplayAgentState(agent({ agentState: "exited", activityStatus: "working" }))
    ).toBeUndefined();
    expect(
      getDockDisplayAgentState(agent({ agentState: "completed", activityStatus: "waiting" }))
    ).toBe("completed");
  });

  it("uses the same effective state for dock groups and single dock items", () => {
    const panels = [
      agent({ launchAgentId: "claude", agentState: "working", activityStatus: "waiting" }),
      agent({ launchAgentId: "codex", agentState: "working" }),
    ];

    expect(getGroupBlockedAgentState(panels)).toBe("waiting");
    expect(getGroupAmbientAgentState(panels)).toBe("waiting");
  });

  it("does not deprioritize a group with working activity even before agentState catches up", () => {
    expect(isGroupDeprioritized([agent({ activityStatus: "working" })])).toBe(false);
  });
});
