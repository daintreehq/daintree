import { describe, expect, it } from "vitest";
import type { AgentSettings } from "@shared/types/agentSettings";
import type { AgentAvailabilityState } from "@shared/types";
import { launcherItemToolbarButtonId } from "@shared/types/toolbar";
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
      settings({}),
      [],
      {}
    );
    expect(sorted.map((a) => a.id)).toEqual(["codex", "gemini", "claude"]);
    expect(pinnedCount).toBe(2);
  });

  it("treats explicit pinned:true as pinned regardless of availability", () => {
    const agents = [agent("claude", "missing"), agent("gemini", "missing")];
    const { sorted, pinnedCount } = sortAgentsByToolbarPin(
      agents,
      ["claude"],
      settings({ claude: { pinned: true } }),
      [],
      {}
    );
    expect(sorted.map((a) => a.id)).toEqual(["claude", "gemini"]);
    expect(pinnedCount).toBe(1);
  });

  it("treats explicit pinned:false as unpinned even when installed", () => {
    const agents = [agent("claude", "ready"), agent("gemini", "ready")];
    const { sorted, pinnedCount } = sortAgentsByToolbarPin(
      agents,
      ["claude", "gemini"],
      settings({ claude: { pinned: false } }),
      [],
      {}
    );
    expect(sorted.map((a) => a.id)).toEqual(["gemini", "claude"]);
    expect(pinnedCount).toBe(1);
  });

  it("returns pinnedCount 0 when no agents are pinned", () => {
    const agents = [agent("claude", "missing"), agent("gemini", undefined)];
    const { sorted, pinnedCount } = sortAgentsByToolbarPin(agents, [], settings({}), [], {});
    expect(sorted.map((a) => a.id)).toEqual(["claude", "gemini"]);
    expect(pinnedCount).toBe(0);
  });

  it("returns pinnedCount === length and applies leftButtons order when all agents are pinned", () => {
    const agents = [agent("claude", "ready"), agent("gemini", "ready")];
    const { sorted, pinnedCount } = sortAgentsByToolbarPin(
      agents,
      ["gemini", "claude"],
      settings({}),
      [],
      {}
    );
    // leftButtons reverses the input order — guards against a sort that counts
    // pinned agents correctly but ignores the toolbar ordering.
    expect(sorted.map((a) => a.id)).toEqual(["gemini", "claude"]);
    expect(pinnedCount).toBe(2);
  });

  it("orders [inLeftButtons, explicitly-pinned-absent, unpinned] across all three groups", () => {
    const agents = [
      agent("gemini", "ready"), // explicitly pinned, no position → end of pinned group
      agent("codex", "missing"), // unpinned
      agent("claude", "ready"), // positioned, leftButtons index 0
    ];
    const { sorted, pinnedCount } = sortAgentsByToolbarPin(
      agents,
      ["claude"],
      settings({ gemini: { pinned: true } }),
      [],
      {}
    );
    expect(sorted.map((a) => a.id)).toEqual(["claude", "gemini", "codex"]);
    expect(pinnedCount).toBe(2);
  });

  it("places a pinned agent absent from both side arrays at the end of the pinned group", () => {
    const agents = [agent("claude", "ready"), agent("gemini", "ready")];
    // gemini pinned but positioned nowhere → after claude (index 0), before any unpinned.
    const { sorted, pinnedCount } = sortAgentsByToolbarPin(
      agents,
      ["claude"],
      settings({ gemini: { pinned: true } }),
      [],
      {}
    );
    expect(sorted.map((a) => a.id)).toEqual(["claude", "gemini"]);
    expect(pinnedCount).toBe(2);
  });

  it("uses the first index for a duplicated id in leftButtons", () => {
    const agents = [agent("claude", "ready"), agent("gemini", "ready")];
    const { sorted } = sortAgentsByToolbarPin(
      agents,
      ["gemini", "claude", "gemini"],
      settings({}),
      [],
      {}
    );
    expect(sorted.map((a) => a.id)).toEqual(["gemini", "claude"]);
  });

  it("treats a missing settings entry as following position and availability", () => {
    const agents = [agent("claude", "ready"), agent("gemini", "missing")];
    const { sorted, pinnedCount } = sortAgentsByToolbarPin(agents, ["claude"], null, [], {});
    expect(sorted.map((a) => a.id)).toEqual(["claude", "gemini"]);
    expect(pinnedCount).toBe(1);
  });

  it("treats undefined availability with no pin as unpinned", () => {
    const agents = [agent("claude", undefined)];
    const { pinnedCount } = sortAgentsByToolbarPin(agents, [], settings({}), [], {});
    expect(pinnedCount).toBe(0);
  });

  it("leaves an installed agent with no position out of the pinned group", () => {
    // The #11680 regression this predicate change exists for: installing a CLI
    // stopped implying a toolbar slot, so grouping on availability alone put an
    // agent under "Pinned" while its own pin affordance read as unpinned.
    const agents = [agent("claude", "ready"), agent("gemini", "ready")];
    const { pinnedCount } = sortAgentsByToolbarPin(agents, [], settings({}), [], {});
    expect(pinnedCount).toBe(0);
  });

  it("counts a position on the right side as pinned", () => {
    const agents = [agent("claude", "ready"), agent("gemini", "ready")];
    const { sorted, pinnedCount } = sortAgentsByToolbarPin(
      agents,
      [],
      settings({}),
      ["gemini"],
      {}
    );
    expect(sorted.map((a) => a.id)).toEqual(["gemini", "claude"]);
    expect(pinnedCount).toBe(1);
  });

  it("orders left-side agents ahead of right-side ones", () => {
    // `leftButtons` supplies the order; a right-side agent has no index there,
    // so it sorts to the end of the pinned group rather than interleaving.
    const agents = [agent("gemini", "ready"), agent("claude", "ready")];
    const { sorted, pinnedCount } = sortAgentsByToolbarPin(
      agents,
      ["claude"],
      settings({}),
      ["gemini"],
      {}
    );
    expect(sorted.map((a) => a.id)).toEqual(["claude", "gemini"]);
    expect(pinnedCount).toBe(2);
  });

  it("reads a non-built-in agent's pin from pinnedButtons, not agentSettings", () => {
    // A plugin or user-defined agent has no `agentSettingsStore` button, so its
    // pin lives under a launcher-item id (#12217). An entry sitting in
    // `agentSettings` under its raw id is not that pin and must not count.
    const agents = [agent("my-plugin-agent", "ready"), agent("claude", "ready")];
    const { pinnedCount } = sortAgentsByToolbarPin(
      agents,
      ["my-plugin-agent", "claude"],
      settings({ "my-plugin-agent": { pinned: true } }),
      [],
      {}
    );
    expect(pinnedCount).toBe(1);
  });

  it("counts a non-built-in agent the launcher pinned (#12217)", () => {
    // Before this, a plugin agent could carry a filled pin icon while sitting
    // under "Other" — the launcher contradicting itself in one list.
    const agents = [agent("my-plugin-agent", "ready"), agent("claude", "ready")];
    const { sorted, pinnedCount } = sortAgentsByToolbarPin(agents, ["claude"], settings({}), [], {
      [launcherItemToolbarButtonId("agent", "my-plugin-agent")]: true,
    });
    // `claude` holds index 0 in leftButtons; the plugin agent has no position
    // yet, so it trails within the pinned group like any unpositioned pin.
    expect(sorted.map((a) => a.id)).toEqual(["claude", "my-plugin-agent"]);
    expect(pinnedCount).toBe(2);
  });

  it("does not read a position alone as a non-built-in agent's pin", () => {
    // A launcher item has no default slot, so array membership can only ever be
    // the residue of a pin — only the explicit `true` counts.
    const agents = [agent("my-plugin-agent", "ready")];
    const { pinnedCount } = sortAgentsByToolbarPin(
      agents,
      ["my-plugin-agent"],
      settings({}),
      [],
      {}
    );
    expect(pinnedCount).toBe(0);
  });
});
