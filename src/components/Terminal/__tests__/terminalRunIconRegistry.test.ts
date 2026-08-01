import { describe, expect, it } from "vitest";
import { resolveTerminalRunIcon, TERMINAL_RUN_ICON_MAP } from "../terminalRunIconRegistry";
import { PROCESS_TOOL_REGISTRY } from "@shared/config/processToolRegistry";
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
    // `daintree-assistant` registers under that id but keys its brand mark
    // `daintreeassistant`, so the raw lookup misses. `PanelKindIcon` accepted
    // the registry id via `getAgentConfig`, and panel headers must agree.
    const config = getAgentConfig("daintree-assistant");
    expect(config?.iconId).not.toBe("daintree-assistant");
    expect(resolveTerminalRunIcon("daintree-assistant")).toBe(
      TERMINAL_RUN_ICON_MAP[config!.iconId]
    );
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
    for (const agentId of ["claude", "codex", "gemini", "daintree-assistant"]) {
      const config = getAgentConfig(agentId);
      expect(config, `"${agentId}" is not a registered agent`).toBeDefined();
      expect(resolveTerminalRunIcon(agentId), `"${agentId}" by registry id`).toBe(
        resolveTerminalRunIcon(config!.iconId)
      );
    }
  });
});
