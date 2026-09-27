import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeProjectPluginInstanceKey,
  type LoadedPluginInfo,
  type PluginManifest,
} from "../../../../shared/types/plugin.js";
import type { ProjectAgentToolsSnapshot } from "../../../../shared/types/ipc/pluginAgentMcp.js";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

const mocks = vi.hoisted(() => ({
  getProjectForWebContents: vi.fn<(id: number) => string | null>(() => null),
  listPlugins: vi.fn<() => LoadedPluginInfo[]>(() => []),
  hasPlugin: vi.fn<(id: string) => boolean>(() => true),
  waitForInit: vi.fn(() => Promise.resolve()),
  isMcpEnabled: vi.fn(() => true),
  projectRoot: { current: "" },
}));

const storeData = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../../../store.js", () => ({
  store: {
    get: (key: string) => storeData.get(key),
    set: (key: string, value: unknown) => {
      storeData.set(key, value);
    },
  },
}));

vi.mock("../../../window/webContentsRegistry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../window/webContentsRegistry.js")>()),
  getProjectForWebContents: (id: number) => mocks.getProjectForWebContents(id),
  getWindowForWebContents: () => null,
}));

vi.mock("../../../services/PluginService.js", () => ({
  pluginService: {
    listPlugins: () => mocks.listPlugins(),
    hasPlugin: (id: string) => mocks.hasPlugin(id),
    waitForInit: () => mocks.waitForInit(),
  },
}));

vi.mock("../../../services/McpServerService.js", () => ({
  mcpServerService: { isEnabled: () => mocks.isMcpEnabled() },
}));

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: {
    getProjectById: (id: string) => ({ id, path: mocks.projectRoot.current }),
  },
}));

import { ipcMain } from "electron";
import { registerPluginAgentMcpHandlers } from "../pluginAgentMcp.js";
import { _resetIpcGuardForTesting, markIpcSecurityReady } from "../../ipcGuard.js";
import { pluginMcpGrantRegistry } from "../../../services/pluginAgentMcp/grantRegistry.js";
import { _resetProjectMcpDefaultsForTests } from "../../../services/pluginAgentMcp/projectDefaults.js";
import {
  allProjectsAgentMcpAccess,
  projectAgentMcpAccessAnswer,
  setAllProjectsAgentMcpAccess,
  setProjectAgentMcpAccess,
} from "../../../services/pluginAgentMcp/projectEnablement.js";

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

function getHandler(channel: string): Handler {
  const match = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === channel);
  if (!match) throw new Error(`No handler registered for ${channel}`);
  return match[1] as Handler;
}

const LIST = "plugin-agent-mcp:list-project-plugins";
const SET = "plugin-agent-mcp:set-plugin-access";
const PROJECT = "a".repeat(64);
const OTHER_PROJECT = "b".repeat(64);
const PROJECT_LEDGER = makeProjectPluginInstanceKey(PROJECT, "acme.ledger");
const EVENT = { sender: { id: 7 } } as unknown as Electron.IpcMainInvokeEvent;

function plugin(
  over: {
    instanceId?: string;
    name?: string;
    displayName?: string;
    origin?: "global" | "project";
    projectId?: string | null;
    disabled?: boolean;
    databases?: boolean;
    agentMcp?: PluginManifest["contributes"]["agentMcp"] | null;
  } = {}
): LoadedPluginInfo {
  const name = over.name ?? "acme.ledger";
  const agentMcp =
    over.agentMcp === undefined
      ? [{ id: "data", name: "Household ledger", description: "Reads entries", mode: "tools" }]
      : over.agentMcp;
  return {
    manifest: {
      name,
      version: "1.0.0",
      displayName: over.displayName ?? "Ledger",
      capabilities: ["mcp:expose"],
      contributes: {
        ...(over.databases === false
          ? {}
          : { databases: [{ id: "ledger", description: "Household transactions" }] }),
        ...(agentMcp !== null ? { agentMcp } : {}),
      },
    } as unknown as PluginManifest,
    instanceId: over.instanceId ?? name,
    origin: over.origin ?? "global",
    projectId: over.projectId ?? null,
    disabled: over.disabled ?? false,
    blocklisted: false,
  } as unknown as LoadedPluginInfo;
}

function projectLedger(): LoadedPluginInfo {
  return plugin({ instanceId: PROJECT_LEDGER, origin: "project", projectId: PROJECT });
}

async function list(): Promise<ProjectAgentToolsSnapshot> {
  return (await getHandler(LIST)(EVENT)) as ProjectAgentToolsSnapshot;
}

async function set(payload: Record<string, unknown>): Promise<ProjectAgentToolsSnapshot> {
  return (await getHandler(SET)(EVENT, payload)) as ProjectAgentToolsSnapshot;
}

function issueGrant(
  scope: { databases: boolean; pluginEndpointId?: string },
  over: { pluginInstanceId?: string; projectId?: string; terminalId?: string } = {}
) {
  return pluginMcpGrantRegistry.issue({
    pluginInstanceId: over.pluginInstanceId ?? "acme.ledger",
    scope,
    serverName: "daintree-ledger",
    projectId: over.projectId ?? PROJECT,
    terminalId: over.terminalId ?? "term-1",
  }).grant;
}

let dispose: () => void;
let repoRoot: string;

beforeAll(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-agent-mcp-handlers-"));
});

afterAll(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  storeData.clear();
  _resetProjectMcpDefaultsForTests();
  await fs.rm(path.join(repoRoot, ".daintree"), { recursive: true, force: true });
  mocks.projectRoot.current = repoRoot;
  mocks.getProjectForWebContents.mockReturnValue(PROJECT);
  mocks.listPlugins.mockReturnValue([plugin()]);
  mocks.hasPlugin.mockReturnValue(true);
  mocks.isMcpEnabled.mockReturnValue(true);
  _resetIpcGuardForTesting();
  markIpcSecurityReady();
  dispose = registerPluginAgentMcpHandlers();
});

afterEach(() => {
  dispose();
  pluginMcpGrantRegistry.revokeAll();
});

async function writeRepositoryDefaults(plugins: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.join(repoRoot, ".daintree"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, ".daintree", "mcp.json"), JSON.stringify({ plugins }));
}

describe("plugin agent MCP access IPC", () => {
  describe("listing", () => {
    it("lists one row per plugin the sender's project could use, off by default", async () => {
      expect(await list()).toEqual({
        plugins: [
          {
            pluginInstanceId: "acme.ledger",
            pluginDisplayName: "Ledger",
            origin: "installed",
            hasDatabases: true,
            pluginTools: { name: "Household ledger", description: "Reads entries" },
            access: "off",
            source: "default",
            allProjectsAccess: "off",
            available: true,
          },
        ],
        mcpServerEnabled: true,
      });
    });

    it("reports the project's own answer", async () => {
      setProjectAgentMcpAccess(PROJECT, "acme.ledger", "read-only");

      const [row] = (await list()).plugins;

      expect(row).toMatchObject({
        access: "read-only",
        source: "project",
        allProjectsAccess: "off",
      });
    });

    it("reports an installed plugin following its all-projects answer", async () => {
      setAllProjectsAgentMcpAccess("acme.ledger", "read-write");

      const [row] = (await list()).plugins;

      expect(row).toMatchObject({
        access: "read-write",
        source: "all-projects",
        allProjectsAccess: "read-write",
      });

      setProjectAgentMcpAccess(PROJECT, "acme.ledger", "off");
      const [overridden] = (await list()).plugins;
      expect(overridden).toMatchObject({
        access: "off",
        source: "project",
        allProjectsAccess: "read-write",
      });
    });

    it("reports a project plugin following the repository's defaults", async () => {
      mocks.listPlugins.mockReturnValue([projectLedger()]);
      await writeRepositoryDefaults({ "acme.ledger": "read-only" });

      const [row] = (await list()).plugins;

      expect(row).toMatchObject({
        pluginInstanceId: PROJECT_LEDGER,
        origin: "project",
        access: "read-only",
        source: "repository",
        repositoryAccess: "read-only",
      });
      expect(row.allProjectsAccess).toBeUndefined();

      setProjectAgentMcpAccess(PROJECT, PROJECT_LEDGER, "read-write");
      const [overridden] = (await list()).plugins;
      expect(overridden).toMatchObject({
        access: "read-write",
        source: "project",
        repositoryAccess: "read-only",
      });
    });

    it("never lets the repository's defaults reach an installed plugin", async () => {
      await writeRepositoryDefaults({ "acme.ledger": "read-write" });

      const [row] = (await list()).plugins;

      expect(row).toMatchObject({ access: "off", source: "default" });
      expect(row.repositoryAccess).toBeUndefined();
    });

    it("shows an answer from before access levels, which kept database tools off", async () => {
      storeData.set("projectAgentMcpEnablement", {
        [PROJECT]: { "acme.ledger": { data: { decidedAt: 1 } } },
      });

      const [row] = (await list()).plugins;

      expect(row).toMatchObject({
        access: "read-write",
        source: "project",
        databasesWithheld: true,
      });
    });

    it("lists a database-only plugin with no plugin tools", async () => {
      mocks.listPlugins.mockReturnValue([plugin({ agentMcp: null })]);

      const [row] = (await list()).plugins;

      expect(row).toMatchObject({ hasDatabases: true, access: "off", available: true });
      expect(row.pluginTools).toBeUndefined();
    });

    it("keeps an answer left on for a plugin that is no longer running, so it can be revoked", async () => {
      setProjectAgentMcpAccess(PROJECT, "acme.ledger", "read-write");
      mocks.hasPlugin.mockReturnValue(false);

      expect((await list()).plugins).toEqual([
        expect.objectContaining({
          pluginInstanceId: "acme.ledger",
          pluginDisplayName: "Ledger",
          pluginTools: { name: "Household ledger", description: "Reads entries" },
          access: "read-write",
          available: false,
        }),
      ]);
    });

    it("keeps an all-projects answer for an uninstalled plugin visible", async () => {
      setAllProjectsAgentMcpAccess("gone.plugin", "read-only");
      mocks.listPlugins.mockReturnValue([]);

      expect((await list()).plugins).toEqual([
        expect.objectContaining({
          pluginInstanceId: "gone.plugin",
          pluginDisplayName: "gone.plugin",
          access: "read-only",
          source: "all-projects",
          available: false,
        }),
      ]);
    });

    it("names a gone plugin's tools from its old per-endpoint answer", async () => {
      mocks.listPlugins.mockReturnValue([]);
      storeData.set("projectAgentMcpEnablement", {
        [PROJECT]: { "gone.plugin": { entries: { decidedAt: 1 } } },
      });

      const [row] = (await list()).plugins;

      expect(row).toMatchObject({
        pluginInstanceId: "gone.plugin",
        pluginTools: { name: "entries" },
        access: "read-write",
        source: "project",
        available: false,
      });
    });

    it("reports a gone plugin's level from the answer on record", async () => {
      setProjectAgentMcpAccess(PROJECT, "gone.plugin", "read-write");
      mocks.listPlugins.mockReturnValue([]);

      const [row] = (await list()).plugins;

      expect(row).toMatchObject({
        pluginInstanceId: "gone.plugin",
        hasDatabases: true,
        access: "read-write",
        source: "project",
        available: false,
      });
      expect(row.pluginTools).toBeUndefined();
    });

    it("reports a stopped plugin's retained level even when its manifest no longer declares it", async () => {
      setProjectAgentMcpAccess(PROJECT, "acme.ledger", "read-write");
      mocks.listPlugins.mockReturnValue([plugin({ databases: false, agentMcp: null })]);
      mocks.hasPlugin.mockReturnValue(false);

      const [row] = (await list()).plugins;

      expect(row).toMatchObject({
        pluginInstanceId: "acme.ledger",
        pluginDisplayName: "Ledger",
        hasDatabases: false,
        access: "read-write",
        source: "project",
        available: false,
      });
      expect(row.pluginTools).toBeUndefined();
    });

    it("reports a stopped installed plugin following an all-projects answer at that level", async () => {
      setAllProjectsAgentMcpAccess("acme.ledger", "read-write");
      mocks.listPlugins.mockReturnValue([plugin({ agentMcp: null })]);
      mocks.hasPlugin.mockReturnValue(false);

      const [row] = (await list()).plugins;

      expect(row).toMatchObject({
        pluginInstanceId: "acme.ledger",
        access: "read-write",
        source: "all-projects",
        allProjectsAccess: "read-write",
        available: false,
      });
    });

    it("lets the all-projects answer fill in rosters an old answer never named", async () => {
      setAllProjectsAgentMcpAccess("acme.ledger", "read-write");
      storeData.set("projectAgentMcpEnablement", {
        [PROJECT]: { "acme.ledger": { data: { decidedAt: 1, enabled: false } } },
      });
      mocks.hasPlugin.mockReturnValue(false);

      const [row] = (await list()).plugins;

      // The old answer turned `data` off but never named `@databases`, which
      // follows the all-projects answer when the plugin comes back.
      expect(row).toMatchObject({ access: "read-only", source: "project", available: false });
    });

    it("asks about the endpoint a stopped plugin declares now, not the one an old answer named", async () => {
      setAllProjectsAgentMcpAccess("acme.ledger", "read-write");
      storeData.set("projectAgentMcpEnablement", {
        [PROJECT]: { "acme.ledger": { data: { decidedAt: 1, enabled: false } } },
      });
      mocks.listPlugins.mockReturnValue([
        plugin({ agentMcp: [{ id: "entries", name: "Entries", mode: "tools" }] }),
      ]);
      mocks.hasPlugin.mockReturnValue(false);

      const [row] = (await list()).plugins;

      // `entries` was never answered, so it follows the all-projects answer.
      expect(row).toMatchObject({ access: "read-write", available: false });
    });

    it("never flags withheld database tools on a plugin that is not running", async () => {
      storeData.set("projectAgentMcpEnablement", {
        [PROJECT]: { "acme.ledger": { data: { decidedAt: 1 } } },
      });
      mocks.hasPlugin.mockReturnValue(false);

      const [row] = (await list()).plugins;

      expect(row).toMatchObject({ access: "read-write", source: "project", available: false });
      expect(row.databasesWithheld).toBeUndefined();
    });

    it("lists no orphan row for an answer that turns nothing on", async () => {
      setProjectAgentMcpAccess(PROJECT, "gone.plugin", "off");
      mocks.listPlugins.mockReturnValue([]);

      expect((await list()).plugins).toEqual([]);
    });

    it("names a plugin and its tools by id when the manifest leaves the names blank", async () => {
      mocks.listPlugins.mockReturnValue([
        plugin({ displayName: "", agentMcp: [{ id: "data", name: " ", mode: "tools" }] }),
      ]);

      expect((await list()).plugins).toEqual([
        expect.objectContaining({
          pluginDisplayName: "acme.ledger",
          pluginTools: { name: "data" },
        }),
      ]);
    });

    it("never lists a project plugin loaded for another project, or a disabled one", async () => {
      mocks.listPlugins.mockReturnValue([
        plugin({
          instanceId: makeProjectPluginInstanceKey(OTHER_PROJECT, "acme.ledger"),
          origin: "project",
          projectId: OTHER_PROJECT,
        }),
        plugin({ name: "acme.crm", disabled: true }),
      ]);

      expect((await list()).plugins).toEqual([]);
    });

    it("answers an empty list to a sender with no project, or a scratch", async () => {
      mocks.getProjectForWebContents.mockReturnValue(null);
      expect(await list()).toEqual({ plugins: [], mcpServerEnabled: true });

      mocks.getProjectForWebContents.mockReturnValue("12345678-1234-4123-8123-123456789abc");
      expect(await list()).toEqual({ plugins: [], mcpServerEnabled: true });
      expect(mocks.listPlugins).not.toHaveBeenCalled();
    });

    it("says when the MCP listener is off", async () => {
      mocks.isMcpEnabled.mockReturnValue(false);

      expect((await list()).mcpServerEnabled).toBe(false);
    });
  });

  describe("setting access", () => {
    it("records the project's answer and returns the fresh list", async () => {
      const snapshot = await set({
        pluginInstanceId: "acme.ledger",
        access: "read-write",
        scope: "project",
      });

      expect(projectAgentMcpAccessAnswer(PROJECT, "acme.ledger")).toBe("read-write");
      expect(snapshot.plugins).toEqual([
        expect.objectContaining({ access: "read-write", source: "project" }),
      ]);
    });

    it("acts on the sender's project even when the payload names another", async () => {
      await set({
        projectId: OTHER_PROJECT,
        pluginInstanceId: "acme.ledger",
        access: "read-only",
        scope: "project",
      });

      expect(projectAgentMcpAccessAnswer(PROJECT, "acme.ledger")).toBe("read-only");
      expect(projectAgentMcpAccessAnswer(OTHER_PROJECT, "acme.ledger")).toBeUndefined();
    });

    it("leaves an old answer that withholds database tools in place when making a default", async () => {
      storeData.set("projectAgentMcpEnablement", {
        [PROJECT]: {
          "acme.ledger": { data: { decidedAt: 1 }, "@databases": { decidedAt: 1, enabled: false } },
        },
      });

      const snapshot = await set({
        pluginInstanceId: "acme.ledger",
        access: "read-write",
        scope: "all-projects",
      });

      expect(allProjectsAgentMcpAccess("acme.ledger")).toBe("read-write");
      expect(projectAgentMcpAccessAnswer(PROJECT, "acme.ledger")).toBeUndefined();
      expect(snapshot.plugins).toEqual([
        expect.objectContaining({
          access: "read-write",
          source: "project",
          databasesWithheld: true,
        }),
      ]);
    });

    it("records an installed plugin's answer for every project", async () => {
      const snapshot = await set({
        pluginInstanceId: "acme.ledger",
        access: "read-only",
        scope: "all-projects",
      });

      expect(allProjectsAgentMcpAccess("acme.ledger")).toBe("read-only");
      expect(projectAgentMcpAccessAnswer(PROJECT, "acme.ledger")).toBeNull();
      expect(snapshot.plugins).toEqual([
        expect.objectContaining({
          access: "read-only",
          source: "all-projects",
          allProjectsAccess: "read-only",
        }),
      ]);
    });

    it("makes the sender's project follow a new all-projects answer, leaving other projects' own", async () => {
      setProjectAgentMcpAccess(PROJECT, "acme.ledger", "off");
      setProjectAgentMcpAccess(OTHER_PROJECT, "acme.ledger", "read-only");

      const snapshot = await set({
        pluginInstanceId: "acme.ledger",
        access: "read-write",
        scope: "all-projects",
      });

      expect(projectAgentMcpAccessAnswer(PROJECT, "acme.ledger")).toBeNull();
      expect(projectAgentMcpAccessAnswer(OTHER_PROJECT, "acme.ledger")).toBe("read-only");
      expect(snapshot.plugins).toEqual([
        expect.objectContaining({
          access: "read-write",
          source: "all-projects",
          allProjectsAccess: "read-write",
        }),
      ]);

      mocks.getProjectForWebContents.mockReturnValue(OTHER_PROJECT);
      expect((await list()).plugins).toEqual([
        expect.objectContaining({
          access: "read-only",
          source: "project",
          allProjectsAccess: "read-write",
        }),
      ]);
    });

    it("leaves the project's own answer alone when the all-projects answer is removed", async () => {
      setAllProjectsAgentMcpAccess("acme.ledger", "read-write");
      setProjectAgentMcpAccess(PROJECT, "acme.ledger", "read-only");

      const snapshot = await set({
        pluginInstanceId: "acme.ledger",
        access: null,
        scope: "all-projects",
      });

      expect(allProjectsAgentMcpAccess("acme.ledger")).toBeNull();
      expect(projectAgentMcpAccessAnswer(PROJECT, "acme.ledger")).toBe("read-only");
      expect(snapshot.plugins).toEqual([
        expect.objectContaining({
          access: "read-only",
          source: "project",
          allProjectsAccess: "off",
        }),
      ]);
    });

    it("refuses an all-projects answer for a project plugin, even off", async () => {
      mocks.listPlugins.mockReturnValue([projectLedger()]);

      for (const access of ["read-write", "off", null]) {
        await expect(
          set({ pluginInstanceId: PROJECT_LEDGER, access, scope: "all-projects" })
        ).rejects.toThrow(/only an installed plugin/);
      }
      expect(storeData.has("pluginAgentMcpAccess")).toBe(false);
    });

    it("refuses a level the plugin has nothing for", async () => {
      mocks.listPlugins.mockReturnValue([
        plugin({ name: "acme.tools", databases: false }),
        plugin({ name: "acme.data", agentMcp: null }),
      ]);

      await expect(
        set({ pluginInstanceId: "acme.tools", access: "read-only", scope: "project" })
      ).rejects.toThrow(/nothing for "read-only"/);
      await expect(
        set({ pluginInstanceId: "acme.data", access: "read-write", scope: "all-projects" })
      ).rejects.toThrow(/nothing for "read-write"/);

      await set({ pluginInstanceId: "acme.tools", access: "read-write", scope: "project" });
      await set({ pluginInstanceId: "acme.data", access: "read-only", scope: "project" });
      expect(projectAgentMcpAccessAnswer(PROJECT, "acme.tools")).toBe("read-write");
      expect(projectAgentMcpAccessAnswer(PROJECT, "acme.data")).toBe("read-only");
      expect(storeData.has("pluginAgentMcpAccess")).toBe(false);
    });

    it("refuses to turn on a plugin nothing running offers here", async () => {
      mocks.hasPlugin.mockReturnValue(false);
      await expect(
        set({ pluginInstanceId: "acme.ledger", access: "read-only", scope: "project" })
      ).rejects.toThrow(/no running plugin offers/);

      mocks.hasPlugin.mockReturnValue(true);
      await expect(
        set({ pluginInstanceId: "acme.other", access: "read-write", scope: "all-projects" })
      ).rejects.toThrow(/no running plugin offers/);

      const foreign = makeProjectPluginInstanceKey(OTHER_PROJECT, "acme.ledger");
      mocks.listPlugins.mockReturnValue([
        plugin({ instanceId: foreign, origin: "project", projectId: OTHER_PROJECT }),
      ]);
      await expect(
        set({ pluginInstanceId: foreign, access: "read-write", scope: "project" })
      ).rejects.toThrow(/no running plugin offers/);

      expect(storeData.has("projectAgentMcpAccess")).toBe(false);
      expect(storeData.has("pluginAgentMcpAccess")).toBe(false);
    });

    it("always allows off or a reset, even for a plugin nothing offers any more", async () => {
      mocks.listPlugins.mockReturnValue([]);
      setAllProjectsAgentMcpAccess("gone.plugin", "read-write");
      setProjectAgentMcpAccess(PROJECT, "gone.plugin", "read-write");

      await set({ pluginInstanceId: "gone.plugin", access: "off", scope: "project" });
      expect(projectAgentMcpAccessAnswer(PROJECT, "gone.plugin")).toBe("off");

      await set({ pluginInstanceId: "gone.plugin", access: null, scope: "project" });
      expect(projectAgentMcpAccessAnswer(PROJECT, "gone.plugin")).toBeNull();

      const snapshot = await set({
        pluginInstanceId: "gone.plugin",
        access: null,
        scope: "all-projects",
      });
      expect(allProjectsAgentMcpAccess("gone.plugin")).toBeNull();
      expect(snapshot.plugins).toEqual([]);
    });

    it("returns to the default when the project's answer is reset", async () => {
      setAllProjectsAgentMcpAccess("acme.ledger", "read-only");
      setProjectAgentMcpAccess(PROJECT, "acme.ledger", "off");

      const snapshot = await set({
        pluginInstanceId: "acme.ledger",
        access: null,
        scope: "project",
      });

      expect(snapshot.plugins).toEqual([
        expect.objectContaining({ access: "read-only", source: "all-projects" }),
      ]);
    });

    it("retires an answer from before access levels on a reset", async () => {
      storeData.set("projectAgentMcpEnablement", {
        [PROJECT]: { "acme.ledger": { data: { decidedAt: 1 } } },
      });

      const snapshot = await set({
        pluginInstanceId: "acme.ledger",
        access: null,
        scope: "project",
      });

      expect(snapshot.plugins).toEqual([
        expect.objectContaining({ access: "off", source: "default" }),
      ]);
      expect(snapshot.plugins[0].databasesWithheld).toBeUndefined();
    });

    it("revokes live grants the project's new answer no longer covers, at once", async () => {
      setProjectAgentMcpAccess(PROJECT, "acme.ledger", "read-write");
      const full = issueGrant({ databases: true, pluginEndpointId: "data" }, { terminalId: "t-1" });
      const dbOnly = issueGrant({ databases: true }, { terminalId: "t-2" });
      const elsewhere = issueGrant(
        { databases: true, pluginEndpointId: "data" },
        { projectId: OTHER_PROJECT, terminalId: "t-3" }
      );
      setProjectAgentMcpAccess(OTHER_PROJECT, "acme.ledger", "read-write");

      await set({ pluginInstanceId: "acme.ledger", access: "read-only", scope: "project" });

      expect(pluginMcpGrantRegistry.isLive(full.credentialId)).toBe(false);
      expect(pluginMcpGrantRegistry.isLive(dbOnly.credentialId)).toBe(true);
      expect(pluginMcpGrantRegistry.isLive(elsewhere.credentialId)).toBe(true);

      await set({ pluginInstanceId: "acme.ledger", access: "off", scope: "project" });
      expect(pluginMcpGrantRegistry.isLive(dbOnly.credentialId)).toBe(false);
    });

    it("revokes, in every project following it, what a lower all-projects answer takes away", async () => {
      setAllProjectsAgentMcpAccess("acme.ledger", "read-write");
      const here = issueGrant({ databases: true, pluginEndpointId: "data" }, { terminalId: "t-1" });
      const there = issueGrant(
        { databases: true, pluginEndpointId: "data" },
        { projectId: OTHER_PROJECT, terminalId: "t-2" }
      );
      setProjectAgentMcpAccess(OTHER_PROJECT, "acme.ledger", "read-write");
      const thereDbOnly = issueGrant(
        { databases: true },
        { projectId: OTHER_PROJECT, terminalId: "t-3" }
      );

      await set({ pluginInstanceId: "acme.ledger", access: "off", scope: "all-projects" });

      expect(pluginMcpGrantRegistry.isLive(here.credentialId)).toBe(false);
      expect(pluginMcpGrantRegistry.isLive(there.credentialId)).toBe(true);
      expect(pluginMcpGrantRegistry.isLive(thereDbOnly.credentialId)).toBe(true);
    });

    it("refuses a change from a sender with no project", async () => {
      const payload = { pluginInstanceId: "acme.ledger", access: "off", scope: "project" };

      mocks.getProjectForWebContents.mockReturnValue(null);
      await expect(set(payload)).rejects.toThrow(/sender has no project/);

      mocks.getProjectForWebContents.mockReturnValue("12345678-1234-4123-8123-123456789abc");
      await expect(set(payload)).rejects.toThrow(/sender has no project/);

      expect(storeData.size).toBe(0);
    });

    it("rejects a malformed payload at the boundary", async () => {
      await expect(set({ pluginInstanceId: "", access: "off", scope: "project" })).rejects.toThrow(
        /IPC validation failed/
      );
      await expect(
        set({ pluginInstanceId: "acme.ledger", access: "on", scope: "project" })
      ).rejects.toThrow(/IPC validation failed/);
      await expect(
        set({ pluginInstanceId: "acme.ledger", access: "off", scope: "everywhere" })
      ).rejects.toThrow(/IPC validation failed/);
      await expect(set({ pluginInstanceId: "acme.ledger", scope: "project" })).rejects.toThrow(
        /IPC validation failed/
      );

      expect(storeData.size).toBe(0);
    });
  });

  it("removes its handlers on dispose", () => {
    dispose();
    const removed = vi.mocked(ipcMain.removeHandler).mock.calls.map(([ch]) => ch);
    expect(removed).toEqual(expect.arrayContaining([LIST, SET]));
    dispose = () => {};
  });
});
