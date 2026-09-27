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
import type { ProjectPluginControllerDeps } from "../plugin/ProjectPluginController.js";

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
      scope: { databases: false, pluginEndpointId: "data" },
      serverName: "daintree-ledger",
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

  describe("across a reload", () => {
    function settle(service: PluginService, instanceKey: string, kept: boolean): void {
      (
        service as unknown as { projectPluginDeps: ProjectPluginControllerDeps }
      ).projectPluginDeps.settleProjectPluginReload(instanceKey, kept);
    }

    it("holds the grants instead of revoking them, while the roster still goes", async () => {
      const { service, grants } = await loadTwoInstances();
      const revoked = vi.fn();
      const stop = pluginMcpGrantRegistry.onRevoked(revoked);

      service.unloadPlugin(KEY_A, { reload: true });
      stop();

      expect(revoked).not.toHaveBeenCalled();
      expect(pluginMcpGrantRegistry.isLive(grants[KEY_A])).toBe(true);
      expect(pluginMcpGrantRegistry.isHeld(grants[KEY_A])).toBe(true);
      expect(pluginMcpGrantRegistry.isHeld(grants[KEY_B])).toBe(false);
      expect(agentMcpEndpointRegistry.get(KEY_A, "data")).toBeUndefined();
    });

    it("keeps held grants when the reloaded generation declares the same surface", async () => {
      const { service, grants } = await loadTwoInstances();
      service.unloadPlugin(KEY_A, { reload: true });
      service._registerFakePluginForTests(fakePlugin(), KEY_A);

      settle(service, KEY_A, true);

      expect(pluginMcpGrantRegistry.isLive(grants[KEY_A])).toBe(true);
      expect(pluginMcpGrantRegistry.isHeld(grants[KEY_A])).toBe(false);
    });

    it("revokes held grants when the reloaded generation declares something new", async () => {
      const { service, grants } = await loadTwoInstances();
      service.unloadPlugin(KEY_A, { reload: true });
      const next = fakePlugin();
      (next.manifest as { capabilities: string[] }).capabilities = ["mcp:expose", "network"];
      service._registerFakePluginForTests(next, KEY_A);

      settle(service, KEY_A, true);

      expect(pluginMcpGrantRegistry.isLive(grants[KEY_A])).toBe(false);
    });

    it("revokes a project's held grants as soon as it closes, not when its reload settles", async () => {
      const { service, grants } = await loadTwoInstances();
      service.unloadPlugin(KEY_A, { reload: true });
      service.unloadPlugin(KEY_B, { reload: true });

      void service.onProjectClosed(PROJECT_A);

      expect(pluginMcpGrantRegistry.isLive(grants[KEY_A])).toBe(false);
      expect(pluginMcpGrantRegistry.isHeld(grants[KEY_B])).toBe(true);
      service.dispose();
    });

    it("revokes every held grant when the service is disposed", async () => {
      const { service, grants } = await loadTwoInstances();
      service.unloadPlugin(KEY_A, { reload: true });

      service.dispose();

      expect(pluginMcpGrantRegistry.isLive(grants[KEY_A])).toBe(false);
    });

    it("revokes held grants when nothing came back, or the reload was overtaken", async () => {
      const { service, grants } = await loadTwoInstances();
      service.unloadPlugin(KEY_A, { reload: true });
      service.unloadPlugin(KEY_B, { reload: true });
      service._registerFakePluginForTests(fakePlugin(), KEY_B);

      settle(service, KEY_A, true);
      settle(service, KEY_B, false);

      expect(pluginMcpGrantRegistry.isLive(grants[KEY_A])).toBe(false);
      expect(pluginMcpGrantRegistry.isLive(grants[KEY_B])).toBe(false);
    });
  });

  describe("waitForProjectPlugins", () => {
    interface FakeController {
      queued: Set<string>;
      settle: () => void;
      controller: {
        hasQueuedWork: (projectId: string) => boolean;
        whenSettled: (projectId: string) => Promise<void>;
        onProjectOpened: (projectId: string, root: string) => Promise<void>;
        dispose: () => void;
      };
    }

    function fakeController(): FakeController {
      const queued = new Set<string>();
      let settle!: () => void;
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      return {
        queued,
        settle: () => settle(),
        controller: {
          hasQueuedWork: (projectId) => queued.has(projectId),
          whenSettled: () => settled,
          onProjectOpened: async (projectId) => {
            queued.add(projectId);
            await settled;
          },
          dispose: () => {},
        },
      };
    }

    function serviceWith(fake: FakeController): PluginService {
      const service = new PluginService("/tmp/daintree-agent-mcp-unload-root", "0.0.0");
      (service as unknown as { projectPluginController: unknown }).projectPluginController =
        fake.controller;
      (service as unknown as { pushSnapshotToProject: () => Promise<void> }).pushSnapshotToProject =
        async () => {};
      (
        service as unknown as { syncProjectPluginWatcher: () => Promise<void> }
      ).syncProjectPluginWatcher = async () => {};
      return service;
    }

    it("waits for a project that has not opened yet, then for its queued work", async () => {
      const fake = fakeController();
      const service = serviceWith(fake);
      let result: boolean | undefined;
      const waiting = service.waitForProjectPlugins(PROJECT_A, 60_000).then((ready) => {
        result = ready;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(result).toBeUndefined();

      const opening = service.onProjectOpened(PROJECT_A, "/tmp/project-a");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(result).toBeUndefined();
      fake.settle();
      await waiting;
      await opening;
      expect(result).toBe(true);
    });

    it("wakes a waiting launch as not ready when the service is disposed", async () => {
      const fake = fakeController();
      const service = serviceWith(fake);
      const waiting = service.waitForProjectPlugins(PROJECT_A, 60_000);

      service.dispose();

      await expect(waiting).resolves.toBe(false);
      await expect(service.waitForProjectPlugins(PROJECT_A, 60_000)).resolves.toBe(false);
    });

    it("reports not ready when the service is disposed while queued work runs", async () => {
      const fake = fakeController();
      const service = serviceWith(fake);
      fake.queued.add(PROJECT_A);
      const waiting = service.waitForProjectPlugins(PROJECT_A, 60_000);

      service.dispose();
      fake.settle();

      await expect(waiting).resolves.toBe(false);
    });

    it("gives up after the timeout and forgets the waiter", async () => {
      const fake = fakeController();
      const service = serviceWith(fake);

      await expect(service.waitForProjectPlugins(PROJECT_A, 5)).resolves.toBe(false);
      expect(
        (service as unknown as { projectOpenWaiters: Map<string, unknown> }).projectOpenWaiters.size
      ).toBe(0);
    });
  });
});
