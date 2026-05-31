import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  registerPluginAgents,
  unregisterPluginAgents,
  getPluginAgentRegistry,
  setPluginAgentRegistry,
  clearPluginAgentRegistryForTests,
} from "../pluginAgentRegistry.js";
import {
  getEffectiveAgentConfig,
  getEffectiveRegistry,
  isEffectivelyRegisteredAgent,
  isBuiltInAgent,
  setUserRegistry,
} from "../agentRegistry.js";
import { isBuiltInAgentId } from "../agentIds.js";
import type { PluginAgentContribution } from "../../types/plugin.js";

const ACME_AGENT: PluginAgentContribution = {
  id: "acme-agent",
  name: "Acme Agent",
  command: "acme",
  args: ["--flag"],
  color: "#3366ff",
  iconId: "terminal",
};

describe("pluginAgentRegistry (issue #9560)", () => {
  beforeEach(() => {
    clearPluginAgentRegistryForTests();
    setUserRegistry({});
  });
  afterEach(() => {
    clearPluginAgentRegistryForTests();
    setUserRegistry({});
  });

  it("registers a plugin agent into the effective registry as an AgentConfig", () => {
    registerPluginAgents("acme.plugin", [ACME_AGENT]);
    const config = getEffectiveAgentConfig("acme-agent");
    expect(config).toBeDefined();
    expect(config?.name).toBe("Acme Agent");
    expect(config?.command).toBe("acme");
    expect(config?.args).toEqual(["--flag"]);
    expect(config?.supportsContextInjection).toBe(false);
    expect(isEffectivelyRegisteredAgent("acme-agent")).toBe(true);
    // Plugin agents are not built-ins
    expect(isBuiltInAgentId("acme-agent")).toBe(false);
    expect(isBuiltInAgent("acme-agent")).toBe(false);
  });

  it("removes the agent on unregister", () => {
    registerPluginAgents("acme.plugin", [ACME_AGENT]);
    unregisterPluginAgents("acme.plugin");
    expect(getEffectiveAgentConfig("acme-agent")).toBeUndefined();
    expect(isEffectivelyRegisteredAgent("acme-agent")).toBe(false);
  });

  it("isolates per-plugin: unloading one plugin keeps another's agent", () => {
    registerPluginAgents("acme.plugin", [ACME_AGENT]);
    registerPluginAgents("other.plugin", [{ ...ACME_AGENT, id: "other-agent" }]);
    unregisterPluginAgents("acme.plugin");
    expect(getEffectiveAgentConfig("acme-agent")).toBeUndefined();
    expect(getEffectiveAgentConfig("other-agent")).toBeDefined();
  });

  it("resolves a cross-plugin id collision first-registered-wins with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerPluginAgents("acme.plugin", [{ ...ACME_AGENT, name: "First" }]);
    registerPluginAgents("dup.plugin", [{ ...ACME_AGENT, name: "Second" }]);
    expect(getEffectiveAgentConfig("acme-agent")?.name).toBe("First");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("never shadows a built-in even if a plugin registers the same id", () => {
    // The schema rejects this at the manifest gate, but the registry must be
    // defensive too: built-ins win in getEffectiveRegistry's merge order.
    registerPluginAgents("acme.plugin", [{ ...ACME_AGENT, id: "claude", name: "Fake Claude" }]);
    expect(getEffectiveAgentConfig("claude")?.name).not.toBe("Fake Claude");
  });

  it("ranks plugin agents below user-registry entries with the same id", () => {
    registerPluginAgents("acme.plugin", [{ ...ACME_AGENT, name: "Plugin Wins?" }]);
    setUserRegistry({
      "acme-agent": {
        id: "acme-agent",
        name: "User Wins",
        command: "acme",
        color: "#ffffff",
        iconId: "terminal",
        supportsContextInjection: false,
      },
    });
    expect(getEffectiveAgentConfig("acme-agent")?.name).toBe("User Wins");
  });

  it("replaces a plugin's agents on re-register (idempotent reload)", () => {
    registerPluginAgents("acme.plugin", [ACME_AGENT, { ...ACME_AGENT, id: "acme-two" }]);
    registerPluginAgents("acme.plugin", [ACME_AGENT]);
    expect(getEffectiveAgentConfig("acme-agent")).toBeDefined();
    expect(getEffectiveAgentConfig("acme-two")).toBeUndefined();
  });

  it("setPluginAgentRegistry replaces the snapshot wholesale (renderer mirror path)", () => {
    setPluginAgentRegistry({
      "mirror-agent": {
        id: "mirror-agent",
        name: "Mirror",
        command: "mirror",
        color: "#000000",
        iconId: "terminal",
        supportsContextInjection: false,
      },
    });
    expect(getEffectiveAgentConfig("mirror-agent")).toBeDefined();
    expect(getPluginAgentRegistry()["mirror-agent"]?.name).toBe("Mirror");
  });

  it("getEffectiveRegistry includes plugin agents alongside built-ins", () => {
    registerPluginAgents("acme.plugin", [ACME_AGENT]);
    const registry = getEffectiveRegistry();
    expect(registry["acme-agent"]).toBeDefined();
    expect(registry["claude"]).toBeDefined();
  });
});
