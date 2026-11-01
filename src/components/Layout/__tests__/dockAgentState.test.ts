import { describe, expect, it } from "vitest";
import type { AgentState } from "@shared/types/agent";
import {
  getDockDisplayAgentState,
  getGroupAmbientAgentState,
  getGroupBlockedAgentState,
  isGroupDeprioritized,
} from "../useDockBlockedState";

function agent(overrides: {
  id?: string;
  launchAgentId?: string;
  detectedAgentId?: string;
  agentState?: AgentState;
  activityStatus?: "working" | "waiting" | "success" | "failure";
}) {
  return {
    id: overrides.id,
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

  it("edges dock and grid groups from the fleet band alone, never an observed wait", () => {
    const panels = [
      agent({ id: "a", launchAgentId: "claude", agentState: "working", activityStatus: "waiting" }),
      agent({ id: "b", launchAgentId: "codex", agentState: "working" }),
    ];
    // Amber is the fleet band's needs-you alone (#16054), so an observed wait
    // with no band behind it leaves the dock chip plain and the grid edge on
    // the work.
    expect(getGroupBlockedAgentState(panels, new Set())).toBeUndefined();
    expect(getGroupAmbientAgentState(panels, new Set())).toBe("working");

    const asking = [
      agent({ id: "a", launchAgentId: "claude", agentState: "waiting" }),
      agent({ id: "b", launchAgentId: "codex", agentState: "working" }),
    ];
    expect(getGroupBlockedAgentState(asking, new Set(["a"]))).toBe("waiting");
    expect(getGroupAmbientAgentState(asking, new Set(["a"]))).toBe("waiting");
  });

  it("does not deprioritize a group with working activity even before agentState catches up", () => {
    expect(isGroupDeprioritized([agent({ activityStatus: "working" })])).toBe(false);
  });

  // #6650 — Identity-less terminals with active agentState must surface the
  // dock indicator. The backend only emits "working"/"waiting"/"directing"
  // from agent-sourced events, so we trust the state during the boot window.
  describe("identity-less active states (#6650)", () => {
    it("returns 'working' for a panel with no identity fields and agentState='working'", () => {
      expect(getDockDisplayAgentState({ agentState: "working" })).toBe("working");
    });

    it("returns 'waiting' for a panel with no identity fields and agentState='waiting'", () => {
      expect(getDockDisplayAgentState({ agentState: "waiting" })).toBe("waiting");
    });

    it("returns 'directing' for a panel with no identity fields and agentState='directing'", () => {
      expect(getDockDisplayAgentState({ agentState: "directing" })).toBe("directing");
    });

    it("returns undefined for an identity-less panel with agentState='idle'", () => {
      expect(
        getDockDisplayAgentState({
          launchAgentId: undefined,
          detectedAgentId: undefined,
          agentState: "idle",
        })
      ).toBeUndefined();
    });

    it("returns undefined for an identity-less panel with agentState='exited'", () => {
      expect(
        getDockDisplayAgentState({
          launchAgentId: undefined,
          detectedAgentId: undefined,
          agentState: "exited",
        })
      ).toBeUndefined();
    });

    it("does not bleed plain-shell activity into agent state", () => {
      expect(
        getDockDisplayAgentState({
          launchAgentId: undefined,
          detectedAgentId: undefined,
          activityStatus: "working",
        })
      ).toBeUndefined();
    });

    it("preserves canonical-agent path when launchAgentId is set", () => {
      expect(getDockDisplayAgentState(agent({ agentState: "working" }))).toBe("working");
    });
  });
});
