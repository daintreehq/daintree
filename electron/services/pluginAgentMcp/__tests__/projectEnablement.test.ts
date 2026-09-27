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
  agentMcpScopeFor,
  allProjectsAgentMcpAccess,
  hasAnyAgentMcpEnablement,
  hasLegacyAgentMcpAnswer,
  isAgentMcpEndpointEnabled,
  isAgentMcpEndpointEnabledByDefault,
  isAgentMcpScopeAllowed,
  isPluginMcpGrantAllowed,
  listAgentMcpAccessInstances,
  listLegacyAgentMcpEndpointIds,
  projectAgentMcpAccessAnswer,
  refreshProjectAgentMcpDefaults,
  setAllProjectsAgentMcpAccess,
  setProjectAgentMcpAccess,
} from "../projectEnablement.js";
import { _resetProjectMcpDefaultsForTests, refreshProjectMcpDefaults } from "../projectDefaults.js";
import {
  DATABASE_ENDPOINT_ID,
  type AgentMcpToolScope,
  type DeclaredAgentMcpPlugin,
} from "../types.js";

const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);
const DB = DATABASE_ENDPOINT_ID;
const LEDGER = "acme.ledger";
const LEDGER_A = makeProjectPluginInstanceKey(PROJECT_A, LEDGER);
const LEDGER_B = makeProjectPluginInstanceKey(PROJECT_B, LEDGER);
const BOTH: AgentMcpToolScope = { databases: true, pluginEndpointId: "data" };

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

async function withDefaults(projectId: string, content: unknown): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-mcp-defaults-"));
  roots.push(root);
  await fs.mkdir(path.join(root, ".daintree"));
  await fs.writeFile(path.join(root, ".daintree", "mcp.json"), JSON.stringify(content));
  await refreshProjectMcpDefaults(projectId, root);
  return root;
}

function issue(
  pluginInstanceId: string,
  projectId: string,
  scope: AgentMcpToolScope = BOTH,
  terminalId = "t1"
) {
  return pluginMcpGrantRegistry.issue({
    pluginInstanceId,
    scope,
    serverName: "daintree-ledger",
    projectId,
    terminalId,
  });
}

function declared(overrides: Partial<DeclaredAgentMcpPlugin> = {}): DeclaredAgentMcpPlugin {
  return {
    pluginInstanceId: LEDGER,
    pluginManifestId: LEDGER,
    pluginDisplayName: "Ledger",
    origin: "global",
    hasDatabases: true,
    pluginEndpoint: { id: "data", name: "Ledger" },
    ...overrides,
  };
}

function rosters(projectId: string, instanceId: string, endpointId = "data") {
  return [
    isAgentMcpEndpointEnabled(projectId, instanceId, DB),
    isAgentMcpEndpointEnabled(projectId, instanceId, endpointId),
  ];
}

function legacy(records: Record<string, Record<string, Record<string, unknown>>>) {
  storeMock.data.set("projectAgentMcpEnablement", records);
}

describe("projectEnablement", () => {
  describe("the user's answer for a project", () => {
    it("is off until the user answers, per project", () => {
      expect(rosters(PROJECT_A, LEDGER)).toEqual([false, false]);
      expect(projectAgentMcpAccessAnswer(PROJECT_A, LEDGER)).toBeUndefined();

      setProjectAgentMcpAccess(PROJECT_A, LEDGER, "read-write");

      expect(rosters(PROJECT_A, LEDGER)).toEqual([true, true]);
      expect(rosters(PROJECT_B, LEDGER)).toEqual([false, false]);
      expect(projectAgentMcpAccessAnswer(PROJECT_A, LEDGER)).toBe("read-write");
    });

    it("maps each level onto the rosters it reaches", () => {
      setProjectAgentMcpAccess(PROJECT_A, LEDGER, "read-only");
      expect(rosters(PROJECT_A, LEDGER)).toEqual([true, false]);

      setProjectAgentMcpAccess(PROJECT_A, LEDGER, "off");
      expect(rosters(PROJECT_A, LEDGER)).toEqual([false, false]);
      expect(projectAgentMcpAccessAnswer(PROJECT_A, LEDGER)).toBe("off");
    });

    it("stores the answer under projectAgentMcpAccess, keeping other projects' answers", () => {
      setProjectAgentMcpAccess(PROJECT_A, LEDGER, "read-write", 1);
      setProjectAgentMcpAccess(PROJECT_B, LEDGER, "read-only", 2);
      setProjectAgentMcpAccess(PROJECT_A, "acme.crm", "read-only", 3);

      setProjectAgentMcpAccess(PROJECT_A, LEDGER, "off", 4);

      expect(storeMock.data.get("projectAgentMcpAccess")).toEqual({
        [PROJECT_A]: {
          [LEDGER]: { decidedAt: 4, access: "off" },
          "acme.crm": { decidedAt: 3, access: "read-only" },
        },
        [PROJECT_B]: { [LEDGER]: { decidedAt: 2, access: "read-only" } },
      });
      expect(storeMock.data.has("projectAgentMcpEnablement")).toBe(false);
    });

    it("rejects a project id that names no project workspace, and a missing plugin id", () => {
      expect(() => setProjectAgentMcpAccess("not-a-project", LEDGER, "read-write")).toThrow(
        /project workspace id/
      );
      expect(() => setProjectAgentMcpAccess(PROJECT_A, "", "read-write")).toThrow(/plugin id/);
      expect(storeMock.set).not.toHaveBeenCalled();
    });

    it("propagates a store read failure instead of overwriting every answer", () => {
      setProjectAgentMcpAccess(PROJECT_B, LEDGER, "read-write");
      storeMock.get.mockImplementation(() => {
        throw new Error("corrupt");
      });
      storeMock.set.mockClear();

      expect(() => setProjectAgentMcpAccess(PROJECT_A, LEDGER, "off")).toThrow(/corrupt/);
      expect(storeMock.set).not.toHaveBeenCalled();
    });

    it("keeps consent to an installed plugin away from a project copy with the same manifest id", () => {
      setProjectAgentMcpAccess(PROJECT_A, LEDGER, "read-write");
      expect(rosters(PROJECT_A, LEDGER_A)).toEqual([false, false]);

      setAllProjectsAgentMcpAccess(LEDGER, "read-write");
      expect(rosters(PROJECT_A, LEDGER_A)).toEqual([false, false]);
    });

    it("treats malformed records as no answer", () => {
      storeMock.data.set("projectAgentMcpAccess", {
        [PROJECT_A]: {
          [LEDGER]: { decidedAt: 1, access: "everything" },
          "acme.crm": { access: "read-write" },
          "acme.bad": "read-write",
        },
      });

      expect(projectAgentMcpAccessAnswer(PROJECT_A, LEDGER)).toBeUndefined();
      expect(rosters(PROJECT_A, LEDGER)).toEqual([false, false]);
      expect(rosters(PROJECT_A, "acme.crm")).toEqual([false, false]);
      expect(rosters(PROJECT_A, "acme.bad")).toEqual([false, false]);
      expect(listAgentMcpAccessInstances(PROJECT_A)).toEqual([]);
    });
  });

  describe("the null reset marker", () => {
    it("follows the default again, and retires an older per-endpoint answer", () => {
      legacy({ [PROJECT_A]: { [LEDGER]: { data: { decidedAt: 1 } } } });
      expect(rosters(PROJECT_A, LEDGER)).toEqual([false, true]);

      setProjectAgentMcpAccess(PROJECT_A, LEDGER, null);

      expect(projectAgentMcpAccessAnswer(PROJECT_A, LEDGER)).toBeNull();
      expect(rosters(PROJECT_A, LEDGER)).toEqual([false, false]);
      expect(hasLegacyAgentMcpAnswer(PROJECT_A, LEDGER)).toBe(false);
      expect(listAgentMcpAccessInstances(PROJECT_A)).toEqual([]);
    });

    it("falls through to the all-projects answer for an installed plugin", () => {
      setAllProjectsAgentMcpAccess(LEDGER, "read-only");
      setProjectAgentMcpAccess(PROJECT_A, LEDGER, "read-write");
      expect(rosters(PROJECT_A, LEDGER)).toEqual([true, true]);

      setProjectAgentMcpAccess(PROJECT_A, LEDGER, null);
      expect(rosters(PROJECT_A, LEDGER)).toEqual([true, false]);
    });

    it("falls through to the repository default for a project plugin", async () => {
      await withDefaults(PROJECT_A, { plugins: { [LEDGER]: "read-only" } });
      setProjectAgentMcpAccess(PROJECT_A, LEDGER_A, "off");
      expect(rosters(PROJECT_A, LEDGER_A)).toEqual([false, false]);

      setProjectAgentMcpAccess(PROJECT_A, LEDGER_A, null);
      expect(rosters(PROJECT_A, LEDGER_A)).toEqual([true, false]);
    });
  });

  describe("answers from before access levels", () => {
    it("reads per-endpoint answers, where no enabled field means on", () => {
      legacy({
        [PROJECT_A]: {
          [LEDGER]: {
            data: { decidedAt: 1 },
            [DB]: { decidedAt: 1, enabled: false },
            reports: { decidedAt: 1, enabled: true },
            broken: { decidedAt: 1, enabled: "no" },
            bad: { decidedAt: "x" },
          },
        },
      });

      expect(rosters(PROJECT_A, LEDGER)).toEqual([false, true]);
      expect(isAgentMcpEndpointEnabled(PROJECT_A, LEDGER, "reports")).toBe(true);
      expect(isAgentMcpEndpointEnabled(PROJECT_A, LEDGER, "broken")).toBe(false);
      expect(isAgentMcpEndpointEnabled(PROJECT_A, LEDGER, "bad")).toBe(false);
      expect(hasLegacyAgentMcpAnswer(PROJECT_A, LEDGER)).toBe(true);
      expect(hasLegacyAgentMcpAnswer(PROJECT_B, LEDGER)).toBe(false);
      expect(listLegacyAgentMcpEndpointIds(PROJECT_A, LEDGER).sort()).toEqual(
        [DB, "data", "reports"].sort()
      );
      expect(listLegacyAgentMcpEndpointIds(PROJECT_B, LEDGER)).toEqual([]);
    });

    it("gives way to any new answer for the project", () => {
      legacy({ [PROJECT_A]: { [LEDGER]: { data: { decidedAt: 1 } } } });

      setProjectAgentMcpAccess(PROJECT_A, LEDGER, "read-only");

      expect(rosters(PROJECT_A, LEDGER)).toEqual([true, false]);
      expect(hasLegacyAgentMcpAnswer(PROJECT_A, LEDGER)).toBe(false);
      expect(storeMock.data.get("projectAgentMcpEnablement")).toEqual({
        [PROJECT_A]: { [LEDGER]: { data: { decidedAt: 1 } } },
      });
    });

    it("beats the all-projects answer for the rosters it names, and defers to it for the rest", () => {
      legacy({ [PROJECT_A]: { [LEDGER]: { data: { decidedAt: 1, enabled: false } } } });
      setAllProjectsAgentMcpAccess(LEDGER, "read-write");

      expect(rosters(PROJECT_A, LEDGER)).toEqual([true, false]);
      expect(rosters(PROJECT_B, LEDGER)).toEqual([true, true]);
    });

    it("mixes with the repository default one roster at a time", async () => {
      await withDefaults(PROJECT_A, { plugins: { [LEDGER]: "read-only" } });
      legacy({ [PROJECT_A]: { [LEDGER_A]: { data: { decidedAt: 1 } } } });
      expect(rosters(PROJECT_A, LEDGER_A)).toEqual([true, true]);

      legacy({ [PROJECT_A]: { [LEDGER_A]: { [DB]: { decidedAt: 1, enabled: false } } } });
      expect(rosters(PROJECT_A, LEDGER_A)).toEqual([false, false]);
    });

    it("counts only answers that turn something on as possibly on", () => {
      legacy({ [PROJECT_A]: { [LEDGER]: { data: { decidedAt: 1, enabled: false } } } });
      expect(hasAnyAgentMcpEnablement(PROJECT_A)).toBe(false);
      expect(listAgentMcpAccessInstances(PROJECT_A)).toEqual([]);

      legacy({ [PROJECT_A]: { [LEDGER]: { data: { decidedAt: 1 } } } });
      expect(hasAnyAgentMcpEnablement(PROJECT_A)).toBe(true);
      expect(listAgentMcpAccessInstances(PROJECT_A)).toEqual([LEDGER]);
    });
  });

  describe("the answer for every project", () => {
    it("applies an installed plugin's answer in every project without one of its own", () => {
      setAllProjectsAgentMcpAccess(LEDGER, "read-only", 5);

      expect(allProjectsAgentMcpAccess(LEDGER)).toBe("read-only");
      expect(rosters(PROJECT_A, LEDGER)).toEqual([true, false]);
      expect(rosters(PROJECT_B, LEDGER)).toEqual([true, false]);
      expect(isAgentMcpEndpointEnabledByDefault(PROJECT_A, LEDGER, DB)).toBe(true);
      expect(storeMock.data.get("pluginAgentMcpAccess")).toEqual({
        [LEDGER]: { decidedAt: 5, access: "read-only" },
      });

      setProjectAgentMcpAccess(PROJECT_A, LEDGER, "off");
      expect(rosters(PROJECT_A, LEDGER)).toEqual([false, false]);
      expect(rosters(PROJECT_B, LEDGER)).toEqual([true, false]);
    });

    it("removes the answer on null", () => {
      setAllProjectsAgentMcpAccess(LEDGER, "read-write");
      setAllProjectsAgentMcpAccess("acme.crm", "read-only");

      setAllProjectsAgentMcpAccess(LEDGER, null);

      expect(allProjectsAgentMcpAccess(LEDGER)).toBeNull();
      expect(rosters(PROJECT_A, LEDGER)).toEqual([false, false]);
      expect(storeMock.data.get("pluginAgentMcpAccess")).toEqual({
        "acme.crm": expect.objectContaining({ access: "read-only" }),
      });
    });

    it("is refused for a project plugin, and never read for one", () => {
      expect(() => setAllProjectsAgentMcpAccess(LEDGER_A, "read-write")).toThrow(
        /installed plugin/
      );
      expect(() => setAllProjectsAgentMcpAccess("", "read-write")).toThrow(/plugin id/);
      expect(storeMock.set).not.toHaveBeenCalled();

      storeMock.data.set("pluginAgentMcpAccess", {
        [LEDGER_A]: { decidedAt: 1, access: "read-write" },
      });
      expect(allProjectsAgentMcpAccess(LEDGER_A)).toBeNull();
      expect(rosters(PROJECT_A, LEDGER_A)).toEqual([false, false]);
      expect(listAgentMcpAccessInstances(PROJECT_A)).toEqual([]);
    });

    it("counts toward every project's possible enablement unless it is off", () => {
      setAllProjectsAgentMcpAccess(LEDGER, "off");
      expect(hasAnyAgentMcpEnablement(PROJECT_A)).toBe(false);

      setAllProjectsAgentMcpAccess(LEDGER, "read-only");
      expect(hasAnyAgentMcpEnablement(PROJECT_A)).toBe(true);
      expect(hasAnyAgentMcpEnablement(PROJECT_B)).toBe(true);
      expect(listAgentMcpAccessInstances(PROJECT_B)).toEqual([LEDGER]);
    });
  });

  describe("scopes and grants", () => {
    it("scopes a new grant to what the project's access reaches", () => {
      expect(agentMcpScopeFor(PROJECT_A, declared())).toBeNull();

      setProjectAgentMcpAccess(PROJECT_A, LEDGER, "read-only");
      expect(agentMcpScopeFor(PROJECT_A, declared())).toEqual({ databases: true });

      setProjectAgentMcpAccess(PROJECT_A, LEDGER, "read-write");
      expect(agentMcpScopeFor(PROJECT_A, declared())).toEqual(BOTH);
    });

    it("scopes only what the plugin declares", () => {
      setProjectAgentMcpAccess(PROJECT_A, LEDGER, "read-write");

      const dbOnly = declared({ pluginEndpoint: undefined });
      expect(agentMcpScopeFor(PROJECT_A, dbOnly)).toEqual({ databases: true });

      const toolsOnly = declared({ hasDatabases: false });
      expect(agentMcpScopeFor(PROJECT_A, toolsOnly)).toEqual({
        databases: false,
        pluginEndpointId: "data",
      });

      setProjectAgentMcpAccess(PROJECT_A, LEDGER, "read-only");
      expect(agentMcpScopeFor(PROJECT_A, toolsOnly)).toBeNull();
    });

    it("checks a grant against the access of its own project and instance", () => {
      setProjectAgentMcpAccess(PROJECT_A, LEDGER, "read-only");
      const dbGrant = issue(LEDGER, PROJECT_A, { databases: true }).grant;
      const bothGrant = issue(LEDGER, PROJECT_A).grant;
      const elsewhere = issue(LEDGER, PROJECT_B, { databases: true }).grant;

      expect(isPluginMcpGrantAllowed(dbGrant)).toBe(true);
      expect(isPluginMcpGrantAllowed(bothGrant)).toBe(false);
      expect(isPluginMcpGrantAllowed(elsewhere)).toBe(false);
      expect(
        isAgentMcpScopeAllowed(PROJECT_A, LEDGER, { databases: false, pluginEndpointId: "data" })
      ).toBe(false);
    });
  });

  describe("revocation", () => {
    it("revokes that plugin's grants in the project that a downgrade no longer covers", () => {
      setProjectAgentMcpAccess(PROJECT_A, LEDGER, "read-write");
      setProjectAgentMcpAccess(PROJECT_B, LEDGER, "read-write");
      const both = issue(LEDGER, PROJECT_A, BOTH, "t1");
      const dbOnly = issue(LEDGER, PROJECT_A, { databases: true }, "t2");
      const elsewhere = issue(LEDGER, PROJECT_B, BOTH, "t3");
      // Not allowed by anything, but not the plugin whose answer changed.
      const otherPlugin = pluginMcpGrantRegistry.issue({
        pluginInstanceId: "acme.crm",
        scope: { databases: true },
        serverName: "daintree-crm",
        projectId: PROJECT_A,
        terminalId: "t4",
      });

      setProjectAgentMcpAccess(PROJECT_A, LEDGER, "read-only");

      expect(pluginMcpGrantRegistry.authenticate(both.token)).toBeNull();
      expect(pluginMcpGrantRegistry.authenticate(dbOnly.token)).toBe(dbOnly.grant);
      expect(pluginMcpGrantRegistry.authenticate(elsewhere.token)).toBe(elsewhere.grant);
      expect(pluginMcpGrantRegistry.authenticate(otherPlugin.token)).toBe(otherPlugin.grant);

      setProjectAgentMcpAccess(PROJECT_A, LEDGER, "off");
      expect(pluginMcpGrantRegistry.authenticate(dbOnly.token)).toBeNull();
    });

    it("revokes on a reset that lands on a narrower default", () => {
      setAllProjectsAgentMcpAccess(LEDGER, "read-only");
      setProjectAgentMcpAccess(PROJECT_A, LEDGER, "read-write");
      const both = issue(LEDGER, PROJECT_A);

      setProjectAgentMcpAccess(PROJECT_A, LEDGER, null);

      expect(pluginMcpGrantRegistry.authenticate(both.token)).toBeNull();
    });

    it("revokes across projects when the all-projects answer narrows, sparing projects with their own answer", () => {
      setAllProjectsAgentMcpAccess(LEDGER, "read-write");
      setProjectAgentMcpAccess(PROJECT_B, LEDGER, "read-write");
      const inA = issue(LEDGER, PROJECT_A, BOTH, "t1");
      const dbInA = issue(LEDGER, PROJECT_A, { databases: true }, "t2");
      const inB = issue(LEDGER, PROJECT_B, BOTH, "t3");
      const listener = vi.fn();
      const unsubscribe = pluginMcpGrantRegistry.onRevoked(listener);

      setAllProjectsAgentMcpAccess(LEDGER, "read-only");

      expect(pluginMcpGrantRegistry.authenticate(inA.token)).toBeNull();
      expect(pluginMcpGrantRegistry.authenticate(dbInA.token)).toBe(dbInA.grant);
      expect(pluginMcpGrantRegistry.authenticate(inB.token)).toBe(inB.grant);
      expect(listener).toHaveBeenCalledWith([inA.grant], "access-reduced");

      setAllProjectsAgentMcpAccess(LEDGER, null);
      expect(pluginMcpGrantRegistry.authenticate(dbInA.token)).toBeNull();
      expect(pluginMcpGrantRegistry.authenticate(inB.token)).toBe(inB.grant);
      unsubscribe();
    });

    it("never revives a revoked grant when access comes back", () => {
      setProjectAgentMcpAccess(PROJECT_A, LEDGER, "read-write");
      const grant = issue(LEDGER, PROJECT_A);

      setProjectAgentMcpAccess(PROJECT_A, LEDGER, "off");
      setProjectAgentMcpAccess(PROJECT_A, LEDGER, "read-write");
      expect(pluginMcpGrantRegistry.authenticate(grant.token)).toBeNull();

      setAllProjectsAgentMcpAccess(LEDGER, "read-write");
      expect(pluginMcpGrantRegistry.authenticate(grant.token)).toBeNull();
    });

    it("leaves grants alone on an upgrade", () => {
      setProjectAgentMcpAccess(PROJECT_A, LEDGER, "read-only");
      const grant = issue(LEDGER, PROJECT_A, { databases: true });

      setProjectAgentMcpAccess(PROJECT_A, LEDGER, "read-write");
      setAllProjectsAgentMcpAccess(LEDGER, "read-write");

      expect(pluginMcpGrantRegistry.authenticate(grant.token)).toBe(grant.grant);
    });
  });

  describe("listAgentMcpAccessInstances", () => {
    it("lists every instance with an answer that reaches something, running or not", () => {
      setProjectAgentMcpAccess(PROJECT_A, LEDGER_A, "read-only");
      setProjectAgentMcpAccess(PROJECT_A, "acme.off", "off");
      setProjectAgentMcpAccess(PROJECT_A, "acme.reset", null);
      setProjectAgentMcpAccess(PROJECT_B, "acme.elsewhere", "read-write");
      setAllProjectsAgentMcpAccess("acme.global", "read-write");
      setAllProjectsAgentMcpAccess("acme.globaloff", "off");
      legacy({
        [PROJECT_A]: {
          "acme.legacy": { data: { decidedAt: 1 } },
          "acme.legacyoff": { data: { decidedAt: 1, enabled: false } },
        },
      });

      expect(listAgentMcpAccessInstances(PROJECT_A).sort()).toEqual(
        [LEDGER_A, "acme.global", "acme.legacy"].sort()
      );
      expect(listAgentMcpAccessInstances(PROJECT_B).sort()).toEqual(
        ["acme.elsewhere", "acme.global"].sort()
      );
    });

    it("skips a legacy answer once a new answer replaces it", () => {
      legacy({ [PROJECT_A]: { [LEDGER]: { data: { decidedAt: 1 } } } });
      setProjectAgentMcpAccess(PROJECT_A, LEDGER, "off");

      expect(listAgentMcpAccessInstances(PROJECT_A)).toEqual([]);
      expect(hasAnyAgentMcpEnablement(PROJECT_A)).toBe(false);
    });
  });

  describe("ids that collide with Object.prototype keys", () => {
    it("stores and reads __proto__ as a plain plugin id", () => {
      setProjectAgentMcpAccess(PROJECT_A, "__proto__", "read-write");
      setAllProjectsAgentMcpAccess("__proto__", "read-only");

      expect(rosters(PROJECT_A, "__proto__")).toEqual([true, true]);
      expect(rosters(PROJECT_B, "__proto__")).toEqual([true, false]);
      expect(
        Object.hasOwn(
          (storeMock.data.get("projectAgentMcpAccess") as Record<string, object>)[PROJECT_A],
          "__proto__"
        )
      ).toBe(true);
      expect(Object.hasOwn(storeMock.data.get("pluginAgentMcpAccess") as object, "__proto__")).toBe(
        true
      );
      expect(listAgentMcpAccessInstances(PROJECT_A)).toEqual(["__proto__"]);
    });

    it("never resolves an id through the prototype", () => {
      setProjectAgentMcpAccess(PROJECT_A, LEDGER, "read-write");
      for (const id of ["constructor", "toString", "hasOwnProperty"]) {
        expect(projectAgentMcpAccessAnswer(PROJECT_A, id)).toBeUndefined();
        expect(allProjectsAgentMcpAccess(id)).toBeNull();
        expect(rosters(PROJECT_A, id)).toEqual([false, false]);
      }
      expect(isAgentMcpEndpointEnabled(PROJECT_A, LEDGER, "constructor")).toBe(true);
      expect(projectAgentMcpAccessAnswer("constructor", LEDGER)).toBeUndefined();

      legacy({ [PROJECT_A]: { [LEDGER]: { data: { decidedAt: 1 } } } });
      storeMock.data.delete("projectAgentMcpAccess");
      expect(isAgentMcpEndpointEnabled(PROJECT_A, LEDGER, "__proto__")).toBe(false);
      expect(isAgentMcpEndpointEnabled(PROJECT_A, LEDGER, "constructor")).toBe(false);
    });
  });

  describe("project defaults from .daintree/mcp.json", () => {
    it("reads access levels for the project's own plugins", async () => {
      await withDefaults(PROJECT_A, {
        plugins: { [LEDGER]: "read-only", "acme.crm": "read-write", "acme.off": "off" },
      });
      const crm = makeProjectPluginInstanceKey(PROJECT_A, "acme.crm");
      const off = makeProjectPluginInstanceKey(PROJECT_A, "acme.off");

      expect(rosters(PROJECT_A, LEDGER_A)).toEqual([true, false]);
      expect(rosters(PROJECT_A, crm)).toEqual([true, true]);
      expect(rosters(PROJECT_A, off)).toEqual([false, false]);
      expect(
        agentMcpScopeFor(PROJECT_A, declared({ pluginInstanceId: LEDGER_A, origin: "project" }))
      ).toEqual({
        databases: true,
      });
      expect(hasAnyAgentMcpEnablement(PROJECT_A)).toBe(true);
      expect(hasAnyAgentMcpEnablement(PROJECT_B)).toBe(false);
    });

    it("still reads the list forms from before access levels", async () => {
      await withDefaults(PROJECT_A, {
        plugins: { [LEDGER]: [DB], "acme.all": "*", "acme.yes": true },
      });

      expect(rosters(PROJECT_A, LEDGER_A)).toEqual([true, false]);
      expect(rosters(PROJECT_A, makeProjectPluginInstanceKey(PROJECT_A, "acme.all"))).toEqual([
        true,
        true,
      ]);
      expect(rosters(PROJECT_A, makeProjectPluginInstanceKey(PROJECT_A, "acme.yes"))).toEqual([
        true,
        true,
      ]);
    });

    it("never reaches an installed plugin or another project's plugin", async () => {
      await withDefaults(PROJECT_A, { plugins: { [LEDGER]: "read-write" } });

      expect(rosters(PROJECT_A, LEDGER)).toEqual([false, false]);
      expect(isAgentMcpEndpointEnabledByDefault(PROJECT_A, LEDGER, DB)).toBe(false);
      expect(rosters(PROJECT_A, LEDGER_B)).toEqual([false, false]);
      expect(rosters(PROJECT_A, LEDGER_A)).toEqual([true, true]);
    });

    it("lets the user's answer beat the default in both directions", async () => {
      await withDefaults(PROJECT_A, { plugins: { [LEDGER]: "read-only" } });

      setProjectAgentMcpAccess(PROJECT_A, LEDGER_A, "off");
      expect(rosters(PROJECT_A, LEDGER_A)).toEqual([false, false]);

      setProjectAgentMcpAccess(PROJECT_A, LEDGER_A, "read-write");
      expect(rosters(PROJECT_A, LEDGER_A)).toEqual([true, true]);
    });

    it("revokes a running agent's grant when its default leaves the file, but not one the user allowed", async () => {
      const root = await withDefaults(PROJECT_A, {
        plugins: { [LEDGER]: "read-write", "acme.crm": "read-write" },
      });
      const crm = makeProjectPluginInstanceKey(PROJECT_A, "acme.crm");
      setProjectAgentMcpAccess(PROJECT_A, crm, "read-write");
      const ledger = issue(LEDGER_A, PROJECT_A);
      const crmGrant = issue(crm, PROJECT_A);

      await fs.writeFile(path.join(root, ".daintree", "mcp.json"), JSON.stringify({ plugins: {} }));
      await refreshProjectAgentMcpDefaults(PROJECT_A, root);

      expect(pluginMcpGrantRegistry.authenticate(ledger.token)).toBeNull();
      expect(pluginMcpGrantRegistry.authenticate(crmGrant.token)).toBe(crmGrant.grant);

      // Restoring the default never revives a revoked bearer.
      await fs.writeFile(
        path.join(root, ".daintree", "mcp.json"),
        JSON.stringify({ plugins: { [LEDGER]: "read-write" } })
      );
      await refreshProjectAgentMcpDefaults(PROJECT_A, root);
      expect(pluginMcpGrantRegistry.authenticate(ledger.token)).toBeNull();
    });

    it("revokes the plugin's own tools when the default narrows to read-only", async () => {
      const root = await withDefaults(PROJECT_A, { plugins: { [LEDGER]: "read-write" } });
      const both = issue(LEDGER_A, PROJECT_A, BOTH, "t1");
      const dbOnly = issue(LEDGER_A, PROJECT_A, { databases: true }, "t2");

      await fs.writeFile(
        path.join(root, ".daintree", "mcp.json"),
        JSON.stringify({ plugins: { [LEDGER]: "read-only" } })
      );
      await refreshProjectAgentMcpDefaults(PROJECT_A, root);

      expect(pluginMcpGrantRegistry.authenticate(both.token)).toBeNull();
      expect(pluginMcpGrantRegistry.authenticate(dbOnly.token)).toBe(dbOnly.grant);
    });

    it("keeps the newest read when two refreshes race", async () => {
      const root = await withDefaults(PROJECT_A, { plugins: { [LEDGER]: "*" } });
      const older = refreshProjectMcpDefaults(PROJECT_A, root);
      await fs.writeFile(path.join(root, ".daintree", "mcp.json"), JSON.stringify({ plugins: {} }));
      const newer = refreshProjectMcpDefaults(PROJECT_A, root);
      await Promise.all([older, newer]);

      expect(hasAnyAgentMcpEnablement(PROJECT_A)).toBe(false);
    });

    it("reads a BOM, and ignores a file past the size cap", async () => {
      const root = await withDefaults(PROJECT_A, {});
      const file = path.join(root, ".daintree", "mcp.json");
      await fs.writeFile(file, "﻿" + JSON.stringify({ plugins: { [LEDGER]: "read-write" } }));
      await refreshProjectMcpDefaults(PROJECT_A, root);
      expect(rosters(PROJECT_A, LEDGER_A, "anything")).toEqual([true, true]);

      await fs.writeFile(
        file,
        JSON.stringify({ plugins: { [LEDGER]: "*" }, pad: "x".repeat(70 * 1024) })
      );
      await refreshProjectMcpDefaults(PROJECT_A, root);
      expect(hasAnyAgentMcpEnablement(PROJECT_A)).toBe(false);
    });

    it("refuses a symlinked .daintree directory", async () => {
      const real = await withDefaults(PROJECT_B, { plugins: { [LEDGER]: "*" } });
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-mcp-defaults-"));
      roots.push(root);
      await fs.symlink(path.join(real, ".daintree"), path.join(root, ".daintree"));
      await refreshProjectMcpDefaults(PROJECT_A, root);

      expect(isAgentMcpEndpointEnabled(PROJECT_A, LEDGER_A, DB)).toBe(false);
    });

    it("refuses a symlinked defaults file", async () => {
      const root = await withDefaults(PROJECT_A, {});
      const outside = path.join(root, "elsewhere.json");
      await fs.writeFile(outside, JSON.stringify({ plugins: { [LEDGER]: "*" } }));
      await fs.rm(path.join(root, ".daintree", "mcp.json"));
      await fs.symlink(outside, path.join(root, ".daintree", "mcp.json"));
      await refreshProjectMcpDefaults(PROJECT_A, root);

      expect(isAgentMcpEndpointEnabled(PROJECT_A, LEDGER_A, DB)).toBe(false);
    });

    it("drops the default once the file is gone", async () => {
      const root = await withDefaults(PROJECT_A, { plugins: { [LEDGER]: "*" } });
      await fs.rm(path.join(root, ".daintree", "mcp.json"));
      await refreshProjectMcpDefaults(PROJECT_A, root);

      expect(isAgentMcpEndpointEnabled(PROJECT_A, LEDGER_A, DB)).toBe(false);
      expect(hasAnyAgentMcpEnablement(PROJECT_A)).toBe(false);
    });

    it("ignores a malformed file and malformed entries", async () => {
      await withDefaults(PROJECT_A, {
        plugins: { [LEDGER]: [42, ""], other: { x: 1 }, bad: "everything", no: false },
      });
      expect(hasAnyAgentMcpEnablement(PROJECT_A)).toBe(false);

      const root = await withDefaults(PROJECT_A, {});
      await fs.writeFile(path.join(root, ".daintree", "mcp.json"), "{ not json");
      await refreshProjectMcpDefaults(PROJECT_A, root);
      expect(hasAnyAgentMcpEnablement(PROJECT_A)).toBe(false);
    });
  });
});
