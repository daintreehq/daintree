import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPluginAgentRegistryForTests,
  getPluginAgentRegistry,
  registerPluginAgents,
} from "@shared/config/pluginAgentRegistry";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import type { TerminalState } from "@shared/types/ipc/terminal";
import type { PluginAgentContribution } from "@shared/types/plugin";
import { loadSavedPanesPluginAgents } from "../savedPluginAgents";

const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }));
vi.mock("@/utils/logger", () => ({ logWarn, logInfo: vi.fn(), logDebug: vi.fn() }));
vi.mock("@/store/ccrPresetsStore", () => ({
  useCcrPresetsStore: { getState: vi.fn(() => ({ ccrPresetsByAgent: {} })) },
}));

const PI: PluginAgentContribution = {
  id: "pi",
  name: "Pi",
  command: "pi",
  color: "#3366ff",
  iconId: "terminal",
  resume: { kind: "session-id", args: ["--session-id", "{sessionId}"] },
};

const OTHER: PluginAgentContribution = { ...PI, id: "other", name: "Other", command: "other" };

function pane(launchAgentId?: string): TerminalState {
  return {
    id: `pane-${launchAgentId}`,
    title: "Pane",
    kind: "terminal",
    cwd: "/repo",
    launchAgentId,
  };
}

/** A registry snapshot as main answers with it, without leaving it registered here. */
function mainRegistryHolding(agent: PluginAgentContribution) {
  registerPluginAgents("digitalfrontier.agents", [agent]);
  const snapshot = structuredClone(getPluginAgentRegistry());
  clearPluginAgentRegistryForTests();
  return snapshot;
}

describe("loadSavedPanesPluginAgents (#16470)", () => {
  let getAgents: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logWarn.mockClear();
    getAgents = vi.fn();
    vi.stubGlobal("window", { electron: { plugin: { getAgents } } });
  });

  afterEach(() => {
    clearPluginAgentRegistryForTests();
    vi.unstubAllGlobals();
  });

  it("has a saved pane's resume declaration ready by the time it returns", async () => {
    getAgents.mockResolvedValue(mainRegistryHolding(PI));

    await loadSavedPanesPluginAgents([pane("pi")], "project-1");

    expect(getAgents).toHaveBeenCalledWith({ forRestore: true });
    expect(getEffectiveAgentConfig("pi")?.resume?.kind).toBe("session-id");
  });

  it("asks nothing of a workspace with no plugin panes", async () => {
    await loadSavedPanesPluginAgents([pane("claude"), pane(undefined), undefined], "project-1");
    await loadSavedPanesPluginAgents([], "project-1");
    await loadSavedPanesPluginAgents(undefined, "project-1");

    expect(getAgents).not.toHaveBeenCalled();
  });

  it("asks nothing when the agent is already known", async () => {
    registerPluginAgents("digitalfrontier.agents", [PI]);

    await loadSavedPanesPluginAgents([pane("pi")], "project-1");

    expect(getAgents).not.toHaveBeenCalled();
  });

  it("keeps a broadcast heard while the answer was on its way", async () => {
    const stale = mainRegistryHolding(OTHER);
    getAgents.mockImplementation(async () => {
      registerPluginAgents("digitalfrontier.agents", [PI]);
      return stale;
    });

    await loadSavedPanesPluginAgents([pane("pi")], "project-1");

    expect(getEffectiveAgentConfig("pi")).toBeDefined();
    expect(getEffectiveAgentConfig("other")).toBeUndefined();
  });

  it("goes on without the agents when the read fails, and says so", async () => {
    getAgents.mockRejectedValue(new Error("no host"));

    await expect(loadSavedPanesPluginAgents([pane("pi")], "project-1")).resolves.toBeUndefined();

    expect(logWarn).toHaveBeenCalledOnce();
    expect(getEffectiveAgentConfig("pi")).toBeUndefined();
  });

  it("does nothing where the bridge isn't there", async () => {
    vi.stubGlobal("window", { electron: undefined });

    await expect(loadSavedPanesPluginAgents([pane("pi")], "project-1")).resolves.toBeUndefined();
  });
});
