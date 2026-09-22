import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Importing PluginService constructs its module singleton, which reads
// `app.getVersion()` and transitively the eager ProjectStore (`getPath`).
vi.mock("electron", () => ({
  app: {
    getVersion: vi.fn(() => "0.0.0"),
    getPath: vi.fn(() => "/tmp/daintree-agent-mcp-unload"),
    getAppPath: vi.fn(() => "/tmp/daintree-agent-mcp-unload"),
  },
}));
vi.mock("../../ipc/utils.js", () => ({
  broadcastToRenderer: vi.fn(),
  broadcastToProjectRenderers: vi.fn(),
}));

import { PluginService } from "../PluginService.js";
import type { LoadedPlugin } from "../plugin/PluginServiceTypes.js";
import { makeProjectPluginInstanceKey } from "../../../shared/types/plugin.js";
import { agentMcpEndpointRegistry } from "../pluginAgentMcp/endpointRegistry.js";
import { pluginMcpGrantRegistry } from "../pluginAgentMcp/grantRegistry.js";

const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);
const KEY_A = makeProjectPluginInstanceKey(PROJECT_A, "acme.ledger");
const KEY_B = makeProjectPluginInstanceKey(PROJECT_B, "acme.ledger");

function fakePlugin(): LoadedPlugin {
  return {
    manifest: {
      name: "acme.ledger",
      version: "1.0.0",
      displayName: "Ledger",
      capabilities: ["mcp:expose"],
      contributes: {
        commands: [],
        panels: [],
        views: [],
        toolbarButtons: [],
        processTools: [],
        forgeProviders: [],
        fileDecorationProviders: [],
        agentMcp: [{ id: "data", name: "Ledger data", mode: "tools" }],
      },
    } as unknown as LoadedPlugin["manifest"],
    dir: "/tmp/acme.ledger",
    isBuiltin: false,
    loadedAt: 1,
    viewGeneration: 0,
  };
}

/** Load one instance per project, each with a registered roster and a live grant. */
async function loadTwoInstances() {
  const service = new PluginService("/tmp/daintree-agent-mcp-unload-root", "0.0.0");
  const grants: Record<string, string> = {};
  for (const [key, projectId] of [
    [KEY_A, PROJECT_A],
    [KEY_B, PROJECT_B],
  ] as const) {
    service._registerFakePluginForTests(fakePlugin(), key);
    const host = service._createHostForTests(key);
    await host.mcp.registerTools("data", {
      list_rows: {
        description: "Lists rows.",
        inputSchema: { type: "object" },
        execute: () => [],
      },
    });
    grants[key] = pluginMcpGrantRegistry.issue({
      pluginInstanceId: key,
      endpointId: "data",
      projectId,
      terminalId: `term-${projectId.slice(0, 1)}`,
    }).grant.credentialId;
  }
  return { service, grants };
}

beforeEach(() => {
  agentMcpEndpointRegistry.clear();
  pluginMcpGrantRegistry.revokeAll();
});
afterEach(() => {
  agentMcpEndpointRegistry.clear();
  pluginMcpGrantRegistry.revokeAll();
});

describe("PluginService agent MCP teardown", () => {
  it("revokes an unloading instance's grants before its roster goes", async () => {
    const { service, grants } = await loadTwoInstances();
    const rosterAtRevoke: Array<boolean> = [];
    const stop = pluginMcpGrantRegistry.onRevoked((revoked, reason) => {
      expect(reason).toBe("plugin-unloaded");
      expect(revoked.map((g) => g.credentialId)).toEqual([grants[KEY_A]]);
      rosterAtRevoke.push(agentMcpEndpointRegistry.get(KEY_A, "data") !== undefined);
    });

    service.unloadPlugin(KEY_A);
    stop();

    // The roster was still bound when the grant died — grants go first.
    expect(rosterAtRevoke).toEqual([true]);
    expect(pluginMcpGrantRegistry.isLive(grants[KEY_A])).toBe(false);
    expect(agentMcpEndpointRegistry.get(KEY_A, "data")).toBeUndefined();
  });

  it("leaves another project's instance of the same manifest untouched", async () => {
    const { service, grants } = await loadTwoInstances();

    service.unloadPlugin(KEY_A);

    expect(pluginMcpGrantRegistry.isLive(grants[KEY_B])).toBe(true);
    expect(agentMcpEndpointRegistry.get(KEY_B, "data")?.tools.map((t) => t.name)).toEqual([
      "list_rows",
    ]);
  });

  it("keeps grants across idle worker disposal while the roster drops", async () => {
    const { service, grants } = await loadTwoInstances();
    const seam = service as unknown as {
      pluginWorkers: Map<string, unknown>;
      deactivateWorker(pluginId: string): boolean;
    };
    seam.pluginWorkers.set(KEY_A, {
      bridge: { pendingInvokeCount: 0, pendingHostCallCount: 0 },
      cleanup: vi.fn(),
      activation: { ok: true },
    });

    expect(seam.deactivateWorker(KEY_A)).toBe(true);

    // The instance is still loaded: its credentials stay valid, and the roster
    // comes back when the worker next activates and re-registers it.
    expect(pluginMcpGrantRegistry.isLive(grants[KEY_A])).toBe(true);
    expect(agentMcpEndpointRegistry.get(KEY_A, "data")).toBeUndefined();
  });
});
