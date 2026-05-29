import { describe, expect, it } from "vitest";
import type { AgentSettings } from "@shared/types/agentSettings";
import type { AgentAvailabilityState } from "@shared/types";
import { sortAgentsByToolbarPin, type PinnableAgent } from "../agentMenuOrder";

function agent(id: string, availability?: AgentAvailabilityState): PinnableAgent {
  return { id, availability };
}

function settings(agents: AgentSettings["agents"]): AgentSettings {
  return { agents };
}

describe("sortAgentsByToolbarPin", () => {
  it("orders pinned agents by leftButtons index, unpinned trailing in input order", () => {
    const agents = [agent("claude", "missing"), agent("gemini", "ready"), agent("codex", "ready")];
    const { sorted, pinnedCount } = sortAgentsByToolbarPin(
      agents,
      ["codex", "gemini"],
      settings({})
    );
    expect(sorted.map((a) => a.id)).toEqual(["codex", "gemini", "claude"]);
    expect(pinnedCount).toBe(2);
  });

  it("treats explicit pinned:true as pinned regardless of availability", () => {
    const agents = [agent("claude", "missing"), agent("gemini", "missing")];
    const { sorted, pinnedCount } = sortAgentsByToolbarPin(
      agents,
      ["claude"],
      settings({ claude: { pinned: true } })
    );
    expect(sorted.map((a) => a.id)).toEqual(["claude", "gemini"]);
    expect(pinnedCount).toBe(1);
  });

  it("treats explicit pinned:false as unpinned even when installed", () => {
    const agents = [agent("claude", "ready"), agent("gemini", "ready")];
    const { sorted, pinnedCount } = sortAgentsByToolbarPin(
      agents,
      ["claude", "gemini"],
      settings({ claude: { pinned: false } })
    );
    expect(sorted.map((a) => a.id)).toEqual(["gemini", "claude"]);
    expect(pinnedCount).toBe(1);
  });

  it("returns pinnedCount 0 when no agents are pinned", () => {
    const agents = [agent("claude", "missing"), agent("gemini", undefined)];
    const { sorted, pinnedCount } = sortAgentsByToolbarPin(agents, [], settings({}));
    expect(sorted.map((a) => a.id)).toEqual(["claude", "gemini"]);
    expect(pinnedCount).toBe(0);
  });

  it("returns pinnedCount === length when all agents are pinned", () => {
    const agents = [agent("claude", "ready"), agent("gemini", "ready")];
    const { pinnedCount } = sortAgentsByToolbarPin(agents, ["gemini", "claude"], settings({}));
    expect(pinnedCount).toBe(2);
  });

  it("places a pinned agent absent from leftButtons at the end of the pinned group", () => {
    const agents = [agent("claude", "ready"), agent("gemini", "ready")];
    // gemini pinned but not in leftButtons → after claude (index 0), before any unpinned.
    const { sorted, pinnedCount } = sortAgentsByToolbarPin(agents, ["claude"], settings({}));
    expect(sorted.map((a) => a.id)).toEqual(["claude", "gemini"]);
    expect(pinnedCount).toBe(2);
  });

  it("uses the first index for a duplicated id in leftButtons", () => {
    const agents = [agent("claude", "ready"), agent("gemini", "ready")];
    const { sorted } = sortAgentsByToolbarPin(agents, ["gemini", "claude", "gemini"], settings({}));
    expect(sorted.map((a) => a.id)).toEqual(["gemini", "claude"]);
  });

  it("treats a missing settings entry as following availability", () => {
    const agents = [agent("claude", "ready"), agent("gemini", "missing")];
    const { sorted, pinnedCount } = sortAgentsByToolbarPin(agents, ["claude"], null);
    expect(sorted.map((a) => a.id)).toEqual(["claude", "gemini"]);
    expect(pinnedCount).toBe(1);
  });

  it("treats undefined availability with no pin as unpinned", () => {
    const agents = [agent("claude", undefined)];
    const { pinnedCount } = sortAgentsByToolbarPin(agents, [], settings({}));
    expect(pinnedCount).toBe(0);
  });
});
