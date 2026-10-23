import { describe, expect, it } from "vitest";
import { ClientAppError } from "../clientAppError";
import { requiredPluginToolsSpawnError } from "../requiredPluginToolsSpawnError";

describe("requiredPluginToolsSpawnError", () => {
  it("keeps the refusal's per-plugin states and the message the person reads", () => {
    const tools = [
      {
        pluginInstanceId: "acme.ledger",
        pluginDisplayName: "Ledger",
        state: "pending-load" as const,
      },
    ];
    const error = new ClientAppError(
      "REQUIRED_PLUGIN_TOOLS_UNAVAILABLE",
      "Agent launch refused",
      "This agent needs plugin tools that aren't ready.",
      { code: "REQUIRED_PLUGIN_TOOLS_UNAVAILABLE", tools }
    );
    expect(requiredPluginToolsSpawnError(error)).toEqual({
      code: "REQUIRED_PLUGIN_TOOLS",
      message: "This agent needs plugin tools that aren't ready.",
      pluginTools: tools,
    });
  });

  it("leaves every other failure to the ordinary spawn error", () => {
    expect(requiredPluginToolsSpawnError(new ClientAppError("PERMISSION", "no"))).toBeNull();
    expect(requiredPluginToolsSpawnError(new Error("ENOENT"))).toBeNull();
  });
});
