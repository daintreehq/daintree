import { describe, it, expect, beforeEach } from "vitest";
import { resolveSavedScopeIds } from "../fleetSavedScope";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import type { FleetSavedScope } from "@shared/types";
import type { PanelInstance } from "@shared/types/panel";

function agent(id: string, overrides: Record<string, unknown> = {}): PanelInstance {
  return {
    id,
    title: id,
    kind: "terminal",
    detectedAgentId: "claude",
    everDetectedAgent: true,
    worktreeId: "wt-1",
    location: "grid",
    agentState: "waiting",
    hasPty: true,
    ...overrides,
  } as PanelInstance;
}

function seed(panels: PanelInstance[]): void {
  usePanelStore.setState({
    panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
    panelIds: panels.map((p) => p.id),
  });
}

describe("resolveSavedScopeIds", () => {
  beforeEach(() => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
  });

  it("includes plugin-contributed agents for a state-filtered live rule (#14961)", () => {
    seed([
      agent("builtin"),
      agent("plugin", {
        detectedAgentId: undefined,
        launchAgentId: "acme-plugin-agent",
        everDetectedAgent: false,
      }),
      agent("busy", { agentState: "working" }),
    ]);
    const scope = {
      kind: "live",
      scope: "current",
      stateFilter: "waiting",
    } as unknown as FleetSavedScope;
    expect(resolveSavedScopeIds(scope).sort()).toEqual(["builtin", "plugin"]);
  });
});
