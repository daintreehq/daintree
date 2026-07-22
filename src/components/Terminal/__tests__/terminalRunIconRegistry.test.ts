import { describe, expect, it } from "vitest";
import { resolveTerminalRunIcon, TERMINAL_RUN_ICON_MAP } from "../terminalRunIconRegistry";
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
