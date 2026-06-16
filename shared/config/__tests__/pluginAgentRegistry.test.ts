import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  registerPluginAgents,
  unregisterPluginAgents,
  getPluginAgentRegistry,
  setPluginAgentRegistry,
  clearPluginAgentRegistryForTests,
  subscribeToPluginAgentRegistry,
  getPluginAgentRegistrySnapshot,
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

  it("never carries a detection field onto the resolved config (cut in 1.0, #10460)", () => {
    // contributionToAgentConfig maps fields explicitly rather than spreading,
    // so even a stray `detection` on the input must not reach the registry.
    registerPluginAgents("acme.plugin", [
      { ...ACME_AGENT, detection: { primaryPatterns: ["thinking"] } } as PluginAgentContribution,
    ]);
    const config = getEffectiveAgentConfig("acme-agent");
    expect(config).toBeDefined();
    expect("detection" in (config as object)).toBe(false);
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

  it("resolves a ./-prefixed command to an absolute path against pluginDir (#10560)", () => {
    registerPluginAgents(
      "acme.plugin",
      [{ ...ACME_AGENT, command: "./bin/agent.mjs" }],
      "/plugins/acme"
    );
    expect(getEffectiveAgentConfig("acme-agent")?.command).toBe("/plugins/acme/bin/agent.mjs");
  });

  it("leaves a bare PATH command unchanged even when pluginDir is provided (#10560)", () => {
    registerPluginAgents("acme.plugin", [ACME_AGENT], "/plugins/acme");
    expect(getEffectiveAgentConfig("acme-agent")?.command).toBe("acme");
  });

  it("leaves a ./-prefixed command unresolved when no pluginDir is provided (#10560)", () => {
    registerPluginAgents("acme.plugin", [{ ...ACME_AGENT, command: "./bin/agent.mjs" }]);
    expect(getEffectiveAgentConfig("acme-agent")?.command).toBe("./bin/agent.mjs");
  });

  it("joins a Windows-style pluginDir with backslashes (#10560)", () => {
    registerPluginAgents(
      "acme.plugin",
      [{ ...ACME_AGENT, command: "./bin/agent.cmd" }],
      String.raw`C:\plugins\acme`
    );
    expect(getEffectiveAgentConfig("acme-agent")?.command).toBe(
      String.raw`C:\plugins\acme\bin\agent.cmd`
    );
  });

  it("does not double a trailing separator on pluginDir (#10560)", () => {
    registerPluginAgents("acme.plugin", [{ ...ACME_AGENT, command: "./agent" }], "/plugins/acme/");
    expect(getEffectiveAgentConfig("acme-agent")?.command).toBe("/plugins/acme/agent");
  });

  it("does not let a reserved id pollute the snapshot prototype", () => {
    // The manifest schema rejects reserved ids, but the registry must also be
    // defensive: a `__proto__` id must not reassign the snapshot's prototype.
    registerPluginAgents("acme.plugin", [{ ...ACME_AGENT, id: "__proto__" }]);
    const snapshot = getPluginAgentRegistry();
    expect(Object.getPrototypeOf(snapshot)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("pluginAgentRegistry subscription (issue #9879)", () => {
  beforeEach(() => {
    clearPluginAgentRegistryForTests();
  });
  afterEach(() => {
    clearPluginAgentRegistryForTests();
  });

  it("notifies subscribers when registerPluginAgents mutates the registry", () => {
    const listener = vi.fn();
    subscribeToPluginAgentRegistry(listener);
    registerPluginAgents("acme.plugin", [ACME_AGENT]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("notifies subscribers when unregisterPluginAgents removes a plugin", () => {
    registerPluginAgents("acme.plugin", [ACME_AGENT]);
    const listener = vi.fn();
    subscribeToPluginAgentRegistry(listener);
    unregisterPluginAgents("acme.plugin");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("notifies subscribers when setPluginAgentRegistry replaces the snapshot", () => {
    const listener = vi.fn();
    subscribeToPluginAgentRegistry(listener);
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
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not notify when setPluginAgentRegistry is called with the same reference", () => {
    const listener = vi.fn();
    subscribeToPluginAgentRegistry(listener);
    const snapshot = getPluginAgentRegistrySnapshot();
    setPluginAgentRegistry(snapshot);
    expect(listener).not.toHaveBeenCalled();
  });

  it("getPluginAgentRegistrySnapshot returns a stable reference until a mutation", () => {
    const before = getPluginAgentRegistrySnapshot();
    expect(getPluginAgentRegistrySnapshot()).toBe(before);
    registerPluginAgents("acme.plugin", [ACME_AGENT]);
    const after = getPluginAgentRegistrySnapshot();
    expect(after).not.toBe(before);
    // Stable again until the next mutation — never a fresh object per call.
    expect(getPluginAgentRegistrySnapshot()).toBe(after);
  });

  it("getPluginAgentRegistrySnapshot returns the set record as-is, not a clone", () => {
    const record = {
      "mirror-agent": {
        id: "mirror-agent",
        name: "Mirror",
        command: "mirror",
        color: "#000000",
        iconId: "terminal",
        supportsContextInjection: false,
      },
    };
    setPluginAgentRegistry(record);
    expect(getPluginAgentRegistrySnapshot()).toBe(record);
  });

  it("stops notifying after the returned cleanup is called", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToPluginAgentRegistry(listener);
    unsubscribe();
    registerPluginAgents("acme.plugin", [ACME_AGENT]);
    expect(listener).not.toHaveBeenCalled();
  });

  it("clearPluginAgentRegistryForTests drops subscribers (no cross-test leakage)", () => {
    const listener = vi.fn();
    subscribeToPluginAgentRegistry(listener);
    clearPluginAgentRegistryForTests();
    registerPluginAgents("acme.plugin", [ACME_AGENT]);
    expect(listener).not.toHaveBeenCalled();
  });

  it("isolates a throwing listener so later subscribers still run", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const throwing = vi.fn(() => {
      throw new Error("listener boom");
    });
    const healthy = vi.fn();
    subscribeToPluginAgentRegistry(throwing);
    subscribeToPluginAgentRegistry(healthy);
    registerPluginAgents("acme.plugin", [ACME_AGENT]);
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
