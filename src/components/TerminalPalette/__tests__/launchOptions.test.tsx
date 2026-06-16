import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getLaunchOptions } from "../launchOptions";
import {
  setPluginAgentRegistry,
  clearPluginAgentRegistryForTests,
} from "@shared/config/pluginAgentRegistry";

describe("getLaunchOptions (issue #10560)", () => {
  beforeEach(() => {
    clearPluginAgentRegistryForTests();
  });
  afterEach(() => {
    clearPluginAgentRegistryForTests();
  });

  it("includes built-in agents plus terminal and browser entries", () => {
    const options = getLaunchOptions();
    const ids = options.map((o) => o.id);
    expect(ids).toContain("claude");
    expect(ids).toContain("terminal");
    expect(ids).toContain("browser");
  });

  it("includes a plugin-contributed agent as a launchable option", () => {
    setPluginAgentRegistry({
      "acme-agent": {
        id: "acme-agent",
        name: "Acme Agent",
        command: "/plugins/acme/bin/agent",
        color: "#3366ff",
        iconId: "terminal",
        supportsContextInjection: false,
      },
    });

    const option = getLaunchOptions().find((o) => o.id === "acme-agent");
    expect(option).toBeDefined();
    // The launch hint must carry the plugin agent id so agent.launch can resolve it.
    expect(option?.launchAgentId).toBe("acme-agent");
    expect(option?.label).toBe("Acme Agent");
  });

  it("drops a plugin agent from the options once its registry entry is removed", () => {
    setPluginAgentRegistry({
      "acme-agent": {
        id: "acme-agent",
        name: "Acme Agent",
        command: "acme",
        color: "#3366ff",
        iconId: "terminal",
        supportsContextInjection: false,
      },
    });
    expect(getLaunchOptions().some((o) => o.id === "acme-agent")).toBe(true);

    setPluginAgentRegistry({});
    expect(getLaunchOptions().some((o) => o.id === "acme-agent")).toBe(false);
  });
});
