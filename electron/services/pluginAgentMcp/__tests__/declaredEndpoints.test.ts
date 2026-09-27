import { describe, expect, it } from "vitest";
import {
  makeProjectPluginInstanceKey,
  type LoadedPluginInfo,
  type PluginManifest,
} from "../../../../shared/types/plugin.js";
import { agentMcpSurfaceOf, listDeclaredAgentMcpPlugins } from "../declaredEndpoints.js";

const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);
const loaded = () => true;
const DATABASES = [{ id: "ledger", location: "local", journalMode: "delete" }];

function plugin(overrides: {
  name?: string;
  displayName?: string;
  mcpName?: string;
  instanceId?: string;
  origin?: "global" | "project";
  projectId?: string | null;
  disabled?: boolean;
  blocklisted?: boolean;
  capabilities?: PluginManifest["capabilities"];
  agentMcp?: unknown[];
  databases?: unknown[];
}): LoadedPluginInfo {
  const name = overrides.name ?? "acme.ledger";
  return {
    manifest: {
      name,
      version: "1.0.0",
      ...("displayName" in overrides
        ? overrides.displayName === undefined
          ? {}
          : { displayName: overrides.displayName }
        : { displayName: "Ledger" }),
      ...(overrides.mcpName !== undefined ? { mcpName: overrides.mcpName } : {}),
      capabilities: overrides.capabilities ?? ["mcp:expose"],
      contributes: {
        agentMcp: overrides.agentMcp ?? [{ id: "data", name: "Household ledger", mode: "tools" }],
        databases: overrides.databases ?? [],
      },
    } as unknown as PluginManifest,
    instanceId: overrides.instanceId ?? name,
    origin: overrides.origin ?? "global",
    projectId: overrides.projectId ?? null,
    disabled: overrides.disabled ?? false,
    ...(overrides.blocklisted !== undefined ? { blocklisted: overrides.blocklisted } : {}),
  } as unknown as LoadedPluginInfo;
}

describe("listDeclaredAgentMcpPlugins", () => {
  it("lists an installed plugin with its own endpoint for any project", () => {
    expect(listDeclaredAgentMcpPlugins([plugin({})], PROJECT_A, loaded)).toEqual([
      {
        pluginInstanceId: "acme.ledger",
        pluginManifestId: "acme.ledger",
        pluginDisplayName: "Ledger",
        origin: "global",
        hasDatabases: false,
        pluginEndpoint: { id: "data", name: "Household ledger" },
      },
    ]);
  });

  it("carries mcpName and the endpoint description when declared", () => {
    const [entry] = listDeclaredAgentMcpPlugins(
      [
        plugin({
          mcpName: "books",
          agentMcp: [{ id: "data", name: "Ledger", description: "Entries", mode: "tools" }],
        }),
      ],
      PROJECT_A,
      loaded
    );
    expect(entry.mcpName).toBe("books");
    expect(entry.pluginEndpoint).toEqual({ id: "data", name: "Ledger", description: "Entries" });
  });

  it("falls back to the manifest name when there is no display name", () => {
    const [entry] = listDeclaredAgentMcpPlugins(
      [plugin({ displayName: undefined })],
      PROJECT_A,
      loaded
    );
    expect(entry.pluginDisplayName).toBe("acme.ledger");
    expect(entry).not.toHaveProperty("mcpName");
  });

  it("lists a project plugin only for the project it was loaded for", () => {
    const instanceId = makeProjectPluginInstanceKey(PROJECT_A, "acme.ledger");
    const projectPlugin = plugin({ instanceId, origin: "project", projectId: PROJECT_A });

    expect(listDeclaredAgentMcpPlugins([projectPlugin], PROJECT_B, loaded)).toEqual([]);
    const [entry] = listDeclaredAgentMcpPlugins([projectPlugin], PROJECT_A, loaded);
    expect(entry.pluginInstanceId).toBe(instanceId);
    expect(entry.pluginManifestId).toBe("acme.ledger");
    expect(entry.origin).toBe("project");
  });

  it("skips disabled, blocklisted and not-running plugins, and plugins without mcp:expose", () => {
    expect(
      listDeclaredAgentMcpPlugins(
        [
          plugin({ disabled: true }),
          plugin({ name: "acme.blocked", blocklisted: true }),
          plugin({ name: "acme.other", capabilities: [] }),
        ],
        PROJECT_A,
        loaded
      )
    ).toEqual([]);
    expect(listDeclaredAgentMcpPlugins([plugin({})], PROJECT_A, () => false)).toEqual([]);
  });

  it("asks isLoaded by instance key", () => {
    const instanceId = makeProjectPluginInstanceKey(PROJECT_A, "acme.ledger");
    const seen: string[] = [];
    listDeclaredAgentMcpPlugins(
      [plugin({ instanceId, origin: "project", projectId: PROJECT_A })],
      PROJECT_A,
      (id) => {
        seen.push(id);
        return true;
      }
    );
    expect(seen).toEqual([instanceId]);
  });

  it("offers databases for a plugin declaring them, without mcp:expose", () => {
    expect(
      listDeclaredAgentMcpPlugins(
        [plugin({ capabilities: [], agentMcp: [{ id: "data", name: "x" }], databases: DATABASES })],
        PROJECT_A,
        loaded
      )
    ).toEqual([
      {
        pluginInstanceId: "acme.ledger",
        pluginManifestId: "acme.ledger",
        pluginDisplayName: "Ledger",
        origin: "global",
        hasDatabases: true,
      },
    ]);
  });

  it("lists a plugin with both databases and an endpoint as one entry", () => {
    const entries = listDeclaredAgentMcpPlugins(
      [plugin({ databases: DATABASES })],
      PROJECT_A,
      loaded
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      hasDatabases: true,
      pluginEndpoint: { id: "data", name: "Household ledger" },
    });
  });

  it("uses only the first agentMcp endpoint", () => {
    const [entry] = listDeclaredAgentMcpPlugins(
      [
        plugin({
          agentMcp: [
            { id: "first", name: "First" },
            { id: "second", name: "Second" },
          ],
        }),
      ],
      PROJECT_A,
      loaded
    );
    expect(entry.pluginEndpoint?.id).toBe("first");
  });

  it("offers nothing for a plugin with neither, or one with databases that is not running here", () => {
    expect(
      listDeclaredAgentMcpPlugins([plugin({ capabilities: [], agentMcp: [] })], PROJECT_A, loaded)
    ).toEqual([]);
    expect(
      listDeclaredAgentMcpPlugins(
        [plugin({ databases: DATABASES, disabled: true })],
        PROJECT_A,
        loaded
      )
    ).toEqual([]);
    expect(
      listDeclaredAgentMcpPlugins([plugin({ databases: DATABASES })], PROJECT_A, () => false)
    ).toEqual([]);
    const foreign = plugin({
      instanceId: makeProjectPluginInstanceKey(PROJECT_B, "acme.ledger"),
      origin: "project",
      projectId: PROJECT_B,
      databases: DATABASES,
    });
    expect(listDeclaredAgentMcpPlugins([foreign], PROJECT_A, loaded)).toEqual([]);
  });
});

describe("agentMcpSurfaceOf", () => {
  const surface = (overrides: Parameters<typeof plugin>[0] = {}) =>
    agentMcpSurfaceOf(plugin(overrides).manifest);

  it("is stable for the same declarations and ignores capability order", () => {
    expect(surface()).toBe(surface());
    expect(surface({ capabilities: ["mcp:expose", "network"] as never })).toBe(
      surface({ capabilities: ["network", "mcp:expose"] as never })
    );
  });

  it("changes with capabilities, endpoints or databases", () => {
    const base = surface();
    expect(surface({ capabilities: [] })).not.toBe(base);
    expect(
      surface({ agentMcp: [{ id: "other", name: "Other", mode: "tools" }] as never })
    ).not.toBe(base);
    expect(surface({ databases: [{ id: "main", name: "Main" }] as never })).not.toBe(base);
  });

  it("changes with the declared capability scopes", () => {
    const withScopes = (allowedPaths: string[]) => {
      const info = plugin({});
      (info.manifest as { scopes?: unknown }).scopes = { fs: { allowedPaths } };
      return agentMcpSurfaceOf(info.manifest);
    };
    expect(withScopes(["/repo/public"])).not.toBe(withScopes(["/repo"]));
    expect(withScopes(["/repo"])).not.toBe(surface());
  });
});
