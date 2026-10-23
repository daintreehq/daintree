import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storeMock = vi.hoisted(() => {
  const data = new Map<string, unknown>();
  return {
    data,
    get: vi.fn((key: string) => data.get(key)),
    set: vi.fn((key: string, value: unknown) => {
      data.set(key, value);
    }),
  };
});

vi.mock("../../../store.js", () => ({ store: storeMock }));

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeProjectPluginInstanceKey } from "../../../../shared/types/plugin.js";
import { pluginMcpGrantRegistry } from "../grantRegistry.js";
import {
  agentMcpGroupChoices,
  agentMcpScopeFor,
  assistantAgentMcpScopeFor,
  hasAnyAgentMcpEnablement,
  isPluginMcpGrantAllowed,
  listAgentMcpAccessInstances,
  setAllProjectsAgentMcpAccess,
  setProjectAgentMcpAccess,
  setProjectAssistantAgentMcpAccess,
} from "../projectEnablement.js";
import { _resetProjectMcpDefaultsForTests, refreshProjectMcpDefaults } from "../projectDefaults.js";
import type { AgentMcpToolGroupRef, AgentMcpToolScope, DeclaredAgentMcpPlugin } from "../types.js";

const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);
const CRM = "acme.crm";
const CRM_A = makeProjectPluginInstanceKey(PROJECT_A, CRM);
const SEARCH: AgentMcpToolGroupRef = { id: "search", access: "read" };
const CHANGES: AgentMcpToolGroupRef = { id: "changes", access: "write" };

beforeEach(() => {
  storeMock.data.clear();
  storeMock.get.mockReset().mockImplementation((key: string) => storeMock.data.get(key));
  storeMock.set.mockReset().mockImplementation((key: string, value: unknown) => {
    storeMock.data.set(key, value);
  });
  pluginMcpGrantRegistry.revokeAll();
  _resetProjectMcpDefaultsForTests();
});

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function withDefaults(projectId: string, content: unknown): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-mcp-groups-"));
  roots.push(root);
  await fs.mkdir(path.join(root, ".daintree"));
  await fs.writeFile(path.join(root, ".daintree", "mcp.json"), JSON.stringify(content));
  await refreshProjectMcpDefaults(projectId, root);
}

function crm(overrides: Partial<DeclaredAgentMcpPlugin> = {}): DeclaredAgentMcpPlugin {
  return {
    pluginInstanceId: CRM,
    pluginManifestId: CRM,
    pluginDisplayName: "CRM",
    origin: "global",
    hasDatabases: true,
    pluginEndpoint: {
      id: "crm",
      name: "Acme CRM",
      groups: [
        { ...SEARCH, name: "Search contacts" },
        { ...CHANGES, name: "Change contacts" },
      ],
    },
    ...overrides,
  };
}

function issue(scope: AgentMcpToolScope, consumer?: "assistant", projectId = PROJECT_A) {
  return pluginMcpGrantRegistry.issue({
    pluginInstanceId: CRM,
    scope,
    serverName: "daintree-crm",
    projectId,
    terminalId: "t1",
    ...(consumer !== undefined ? { consumer } : {}),
  }).grant;
}

describe("tool groups", () => {
  it("allows no group from a level, read and write included", () => {
    setProjectAgentMcpAccess(PROJECT_A, CRM, "read-write");

    expect(agentMcpScopeFor(PROJECT_A, crm())).toEqual({ databases: true });
  });

  it("serves a read group on its own, apart from the write group", () => {
    setProjectAgentMcpAccess(PROJECT_A, CRM, "off", undefined, [SEARCH]);

    expect(agentMcpScopeFor(PROJECT_A, crm())).toEqual({
      databases: false,
      pluginEndpointId: "crm",
      pluginGroups: [SEARCH],
    });
    expect(listAgentMcpAccessInstances(PROJECT_A)).toEqual([CRM]);
    expect(hasAnyAgentMcpEnablement(PROJECT_A)).toBe(true);
    expect(agentMcpScopeFor(PROJECT_B, crm())).toBeNull();
  });

  it("keeps an installed plugin's shared databases off when only a group is allowed", () => {
    setProjectAgentMcpAccess(PROJECT_A, CRM, "off", undefined, [SEARCH]);

    expect(agentMcpScopeFor(PROJECT_A, crm())?.databases).toBe(false);
  });

  it("drops a group the plugin recast from reading to writing", () => {
    setProjectAgentMcpAccess(PROJECT_A, CRM, "off", undefined, [SEARCH]);
    const recast = crm({
      pluginEndpoint: {
        id: "crm",
        name: "Acme CRM",
        groups: [{ ...SEARCH, access: "write", name: "Search" }],
      },
    });

    expect(agentMcpScopeFor(PROJECT_A, recast)).toBeNull();
  });

  it("keeps the groups when only the level changes", () => {
    setProjectAgentMcpAccess(PROJECT_A, CRM, "off", undefined, [SEARCH, CHANGES]);
    setProjectAgentMcpAccess(PROJECT_A, CRM, "read-only");

    expect(agentMcpScopeFor(PROJECT_A, crm())).toEqual({
      databases: true,
      pluginEndpointId: "crm",
      pluginGroups: [SEARCH, CHANGES],
    });
  });

  it("revokes a grant reaching a group that is turned off, and keeps one that doesn't", () => {
    setProjectAgentMcpAccess(PROJECT_A, CRM, "off", undefined, [SEARCH, CHANGES]);
    const both = issue({
      databases: false,
      pluginEndpointId: "crm",
      pluginGroups: [SEARCH, CHANGES],
    });
    const search = issue({ databases: false, pluginEndpointId: "crm", pluginGroups: [SEARCH] });

    setProjectAgentMcpAccess(PROJECT_A, CRM, "off", undefined, [SEARCH]);

    expect(pluginMcpGrantRegistry.isLive(both.credentialId)).toBe(false);
    expect(pluginMcpGrantRegistry.isLive(search.credentialId)).toBe(true);
    expect(isPluginMcpGrantAllowed(search)).toBe(true);
  });

  it("follows an installed plugin's every-project groups until the project answers", () => {
    setAllProjectsAgentMcpAccess(CRM, "off", undefined, [SEARCH]);
    expect(agentMcpGroupChoices(PROJECT_B, CRM)).toEqual([SEARCH]);

    const grant = issue(
      { databases: false, pluginEndpointId: "crm", pluginGroups: [SEARCH] },
      undefined,
      PROJECT_B
    );
    setProjectAgentMcpAccess(PROJECT_B, CRM, "read-only", undefined, []);

    expect(agentMcpGroupChoices(PROJECT_B, CRM)).toEqual([]);
    expect(pluginMcpGrantRegistry.isLive(grant.credentialId)).toBe(false);
  });

  it("reads a repository's named groups for its own plugin, and none from a level", async () => {
    const plugin = crm({ pluginInstanceId: CRM_A, origin: "project" });
    await withDefaults(PROJECT_A, { plugins: { [CRM]: "read-write" } });
    expect(agentMcpScopeFor(PROJECT_A, plugin)).toEqual({ databases: true });

    await withDefaults(PROJECT_A, {
      plugins: { [CRM]: { access: "read-only", groups: ["search"] } },
    });
    expect(agentMcpScopeFor(PROJECT_A, plugin)).toEqual({
      databases: true,
      pluginEndpointId: "crm",
      pluginGroups: [SEARCH],
    });
    // Never an installed plugin.
    expect(agentMcpScopeFor(PROJECT_A, crm())).toBeNull();
  });

  describe("the Assistant", () => {
    it("gets no group from its level, only the groups allowed for it", () => {
      setProjectAgentMcpAccess(PROJECT_A, CRM, "read-only", undefined, [SEARCH, CHANGES]);
      setProjectAssistantAgentMcpAccess(PROJECT_A, CRM, "read-write");
      expect(assistantAgentMcpScopeFor(PROJECT_A, crm())).toEqual({ databases: true });

      setProjectAssistantAgentMcpAccess(PROJECT_A, CRM, "read-only", undefined, [SEARCH]);
      expect(assistantAgentMcpScopeFor(PROJECT_A, crm())).toEqual({
        databases: true,
        pluginEndpointId: "crm",
        pluginGroups: [SEARCH],
      });
    });

    it("never reaches a group this project's agents don't have", () => {
      setProjectAgentMcpAccess(PROJECT_A, CRM, "off", undefined, [SEARCH]);
      setProjectAssistantAgentMcpAccess(PROJECT_A, CRM, "read-only", undefined, [SEARCH, CHANGES]);

      expect(assistantAgentMcpScopeFor(PROJECT_A, crm())).toEqual({
        databases: false,
        pluginEndpointId: "crm",
        pluginGroups: [SEARCH],
      });
    });

    it("loses a group's credential when the group is taken from it", () => {
      setProjectAgentMcpAccess(PROJECT_A, CRM, "off", undefined, [SEARCH]);
      setProjectAssistantAgentMcpAccess(PROJECT_A, CRM, "read-only", undefined, [SEARCH]);
      const grant = issue(
        { databases: false, pluginEndpointId: "crm", pluginGroups: [SEARCH] },
        "assistant"
      );

      setProjectAssistantAgentMcpAccess(PROJECT_A, CRM, "read-only", undefined, []);

      expect(pluginMcpGrantRegistry.isLive(grant.credentialId)).toBe(false);
    });
  });
});
