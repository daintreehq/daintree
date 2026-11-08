import { describe, expect, it } from "vitest";
import { resolveTerminalRunIcon, TERMINAL_RUN_ICON_MAP } from "../terminalRunIconRegistry";
import { PROCESS_TOOL_REGISTRY } from "@shared/config/processToolRegistry";
import { setPluginAgentRegistry } from "@shared/config/pluginAgentRegistry";
import { getAgentConfig } from "@/config/agents";

describe("resolveTerminalRunIcon", () => {
  it.each(["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__"])(
    "treats the inherited key %s as unregistered",
    (iconId) => {
      // `iconId` reaches here from plugin manifests; a bare index lookup would
      // hand back an `Object.prototype` member as a "component".
      expect(resolveTerminalRunIcon(iconId)).toBeUndefined();
    }
  );

  it("returns undefined for a genuinely unknown id and for no id", () => {
    expect(resolveTerminalRunIcon("not-a-real-tool")).toBeUndefined();
    expect(resolveTerminalRunIcon(null)).toBeUndefined();
    expect(resolveTerminalRunIcon(undefined)).toBeUndefined();
    expect(resolveTerminalRunIcon("")).toBeUndefined();
  });

  it("resolves an agent by registry id even when its icon id differs", () => {
    // A plugin agent can name any brand mark, so its registry id misses the raw
    // lookup. `PanelKindIcon` accepted the registry id via `getAgentConfig`,
    // and panel headers must agree.
    setPluginAgentRegistry({
      "acme-agent": {
        id: "acme-agent",
        name: "Acme Agent",
        command: "acme",
        color: "#3366ff",
        iconId: "codex",
        supportsContextInjection: false,
      },
    });
    try {
      expect(Object.hasOwn(TERMINAL_RUN_ICON_MAP, "acme-agent")).toBe(false);
      expect(resolveTerminalRunIcon("acme-agent")).toBe(TERMINAL_RUN_ICON_MAP.codex);
    } finally {
      setPluginAgentRegistry({});
    }
  });

  it("resolves an agent's own SVG by registry id, but not one it failed to load", () => {
    const key = "plugin-icon:acme.agents:./icons/pi.svg";
    const agent = {
      name: "Pi",
      command: "pi",
      color: "#3366ff",
      supportsContextInjection: false,
    };
    setPluginAgentRegistry({
      pi: { ...agent, id: "pi", iconId: key },
      broken: { ...agent, id: "broken", iconId: "./icons/missing.svg" },
    });
    try {
      expect(resolveTerminalRunIcon("pi")).toBe(getAgentConfig("pi")?.icon);
      expect(resolveTerminalRunIcon("broken")).toBeUndefined();
      // The key alone names no agent: `TerminalIcon` decides how it is tinted.
      expect(resolveTerminalRunIcon(key)).toBeUndefined();
    } finally {
      setPluginAgentRegistry({});
    }
  });

  it("resolves a renderable component for every process tool in the registry", () => {
    // The brand glob is the only icon source now that PROCESS_RUN_ICON_MAP is
    // gone, so a registry key with no matching brand file would silently fall
    // back to the generic terminal glyph. Checking it is a function rather than
    // merely defined also catches a brand file whose default export is not a
    // component — that value is truthy and would reach JSX.
    const unrenderable = Object.keys(PROCESS_TOOL_REGISTRY).filter(
      (iconId) => typeof resolveTerminalRunIcon(iconId) !== "function"
    );
    expect(unrenderable).toEqual([]);
  });

  it("resolves every built-in agent by both its registry id and its icon id", () => {
    for (const agentId of ["claude", "codex", "gemini"]) {
      const config = getAgentConfig(agentId);
      expect(config, `"${agentId}" is not a registered agent`).toBeDefined();
      expect(resolveTerminalRunIcon(agentId), `"${agentId}" by registry id`).toBe(
        resolveTerminalRunIcon(config!.iconId)
      );
    }
  });
});
