import { describe, expect, it } from "vitest";
import {
  makeProjectPluginInstanceKey,
  type LoadedPluginInfo,
  type PluginManifest,
} from "../../../../shared/types/plugin.js";
import { listDeclaredAgentMcpEndpoints } from "../declaredEndpoints.js";

const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);
const loaded = () => true;

function plugin(overrides: {
  name?: string;
  instanceId?: string;
  origin?: "global" | "project";
  projectId?: string | null;
  disabled?: boolean;
  capabilities?: PluginManifest["capabilities"];
  agentMcp?: PluginManifest["contributes"]["agentMcp"];
}): LoadedPluginInfo {
  const name = overrides.name ?? "acme.ledger";
  return {
    manifest: {
      name,
      version: "1.0.0",
      displayName: "Ledger",
      capabilities: overrides.capabilities ?? ["mcp:expose"],
      contributes: {
        agentMcp: overrides.agentMcp ?? [{ id: "data", name: "Household ledger", mode: "tools" }],
      },
    } as unknown as PluginManifest,
    instanceId: overrides.instanceId ?? name,
    origin: overrides.origin ?? "global",
    projectId: overrides.projectId ?? null,
    disabled: overrides.disabled ?? false,
  } as unknown as LoadedPluginInfo;
}

describe("listDeclaredAgentMcpEndpoints", () => {
  it("lists an installed plugin's endpoints for any project", () => {
    const endpoints = listDeclaredAgentMcpEndpoints([plugin({})], PROJECT_A, loaded);

    expect(endpoints).toEqual([
      {
        pluginInstanceId: "acme.ledger",
        pluginManifestId: "acme.ledger",
        pluginDisplayName: "Ledger",
        endpointId: "data",
        name: "Household ledger",
      },
    ]);
  });

  it("lists a project plugin only for the project it was loaded for", () => {
    const instanceId = makeProjectPluginInstanceKey(PROJECT_A, "acme.ledger");
    const projectPlugin = plugin({ instanceId, origin: "project", projectId: PROJECT_A });

    expect(listDeclaredAgentMcpEndpoints([projectPlugin], PROJECT_B, loaded)).toEqual([]);
    const [endpoint] = listDeclaredAgentMcpEndpoints([projectPlugin], PROJECT_A, loaded);
    expect(endpoint.pluginInstanceId).toBe(instanceId);
    expect(endpoint.pluginManifestId).toBe("acme.ledger");
  });

  it("skips disabled plugins and plugins without mcp:expose", () => {
    expect(
      listDeclaredAgentMcpEndpoints(
        [plugin({ disabled: true }), plugin({ name: "acme.other", capabilities: [] })],
        PROJECT_A,
        loaded
      )
    ).toEqual([]);
  });

  it("skips plugins listed but not running", () => {
    expect(listDeclaredAgentMcpEndpoints([plugin({})], PROJECT_A, () => false)).toEqual([]);
  });
});
