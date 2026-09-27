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
  hasAnyAgentMcpEnablement,
  hasUserAgentMcpAnswer,
  isAgentMcpEndpointEnabled,
  listEnabledAgentMcpEndpoints,
  refreshProjectAgentMcpDefaults,
  setAgentMcpEndpointEnabled,
} from "../projectEnablement.js";
import { _resetProjectMcpDefaultsForTests, refreshProjectMcpDefaults } from "../projectDefaults.js";

const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);

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

describe("projectEnablement", () => {
  it("is off until the user turns it on, per project", () => {
    expect(isAgentMcpEndpointEnabled(PROJECT_A, "acme.ledger", "data")).toBe(false);

    setAgentMcpEndpointEnabled(PROJECT_A, "acme.ledger", "data", true);

    expect(isAgentMcpEndpointEnabled(PROJECT_A, "acme.ledger", "data")).toBe(true);
    expect(isAgentMcpEndpointEnabled(PROJECT_B, "acme.ledger", "data")).toBe(false);
    expect(listEnabledAgentMcpEndpoints(PROJECT_A)).toEqual([
      { pluginInstanceId: "acme.ledger", endpointId: "data" },
    ]);
  });

  it("records turning off as an answer, keeping other projects' answers", () => {
    setAgentMcpEndpointEnabled(PROJECT_A, "acme.ledger", "data", true, 1);
    setAgentMcpEndpointEnabled(PROJECT_B, "acme.ledger", "data", true, 2);

    setAgentMcpEndpointEnabled(PROJECT_A, "acme.ledger", "data", false, 3);

    expect(storeMock.data.get("projectAgentMcpEnablement")).toEqual({
      [PROJECT_A]: { "acme.ledger": { data: { decidedAt: 3, enabled: false } } },
      [PROJECT_B]: { "acme.ledger": { data: { decidedAt: 2 } } },
    });
    expect(isAgentMcpEndpointEnabled(PROJECT_A, "acme.ledger", "data")).toBe(false);
    expect(listEnabledAgentMcpEndpoints(PROJECT_A)).toEqual([]);
  });

  it("revokes live credentials for the endpoint in that project when turned off", () => {
    setAgentMcpEndpointEnabled(PROJECT_A, "acme.ledger", "data", true);
    const here = pluginMcpGrantRegistry.issue({
      pluginInstanceId: "acme.ledger",
      endpointId: "data",
      projectId: PROJECT_A,
      terminalId: "t1",
    });
    const elsewhere = pluginMcpGrantRegistry.issue({
      pluginInstanceId: "acme.ledger",
      endpointId: "data",
      projectId: PROJECT_B,
      terminalId: "t2",
    });

    setAgentMcpEndpointEnabled(PROJECT_A, "acme.ledger", "data", false);

    expect(pluginMcpGrantRegistry.authenticate(here.token)).toBeNull();
    expect(pluginMcpGrantRegistry.authenticate(elsewhere.token)).toBe(elsewhere.grant);
  });

  it("keeps consent to an installed plugin away from a project copy with the same manifest id", () => {
    setAgentMcpEndpointEnabled(PROJECT_A, "acme.ledger", "data", true);

    expect(isAgentMcpEndpointEnabled(PROJECT_A, `project__${PROJECT_A}__acme.ledger`, "data")).toBe(
      false
    );
  });

  it("stores and reads an id that collides with an Object.prototype key as a plain key", () => {
    setAgentMcpEndpointEnabled(PROJECT_A, "acme.ledger", "data", true);
    expect(isAgentMcpEndpointEnabled(PROJECT_A, "acme.ledger", "__proto__")).toBe(false);
    expect(isAgentMcpEndpointEnabled(PROJECT_A, "acme.ledger", "constructor")).toBe(false);

    setAgentMcpEndpointEnabled(PROJECT_A, "acme.ledger", "__proto__", true);

    expect(isAgentMcpEndpointEnabled(PROJECT_A, "acme.ledger", "__proto__")).toBe(true);
    expect(listEnabledAgentMcpEndpoints(PROJECT_A)).toHaveLength(2);
  });

  it("treats malformed stored entries as off", () => {
    storeMock.data.set("projectAgentMcpEnablement", {
      [PROJECT_A]: {
        "acme.ledger": { data: true, reports: null, empty: {}, bad: { decidedAt: "x" } },
      },
    });
    expect(isAgentMcpEndpointEnabled(PROJECT_A, "acme.ledger", "empty")).toBe(false);

    expect(isAgentMcpEndpointEnabled(PROJECT_A, "acme.ledger", "data")).toBe(false);
    expect(listEnabledAgentMcpEndpoints(PROJECT_A)).toEqual([]);
  });

  it("rejects a project id that names no project workspace", () => {
    expect(() => setAgentMcpEndpointEnabled("not-a-project", "acme.ledger", "data", true)).toThrow(
      /project workspace id/
    );
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  describe("project defaults from .daintree/mcp.json", () => {
    const LEDGER_A = makeProjectPluginInstanceKey(PROJECT_A, "acme.ledger");
    const LEDGER_B = makeProjectPluginInstanceKey(PROJECT_B, "acme.ledger");

    it("turns on the listed endpoints of the project's own plugins", async () => {
      await withDefaults(PROJECT_A, { plugins: { "acme.ledger": ["@databases"] } });

      expect(isAgentMcpEndpointEnabled(PROJECT_A, LEDGER_A, "@databases")).toBe(true);
      expect(isAgentMcpEndpointEnabled(PROJECT_A, LEDGER_A, "entries")).toBe(false);
      expect(hasUserAgentMcpAnswer(PROJECT_A, LEDGER_A, "@databases")).toBe(false);
      expect(hasAnyAgentMcpEnablement(PROJECT_A)).toBe(true);
      expect(hasAnyAgentMcpEnablement(PROJECT_B)).toBe(false);
    });

    it("never reaches an installed plugin or another project's plugin", async () => {
      await withDefaults(PROJECT_A, { plugins: { "acme.ledger": "*" } });

      expect(isAgentMcpEndpointEnabled(PROJECT_A, "acme.ledger", "@databases")).toBe(false);
      expect(isAgentMcpEndpointEnabled(PROJECT_A, LEDGER_B, "@databases")).toBe(false);
      expect(isAgentMcpEndpointEnabled(PROJECT_A, LEDGER_A, "anything")).toBe(true);
    });

    it("lets the user's answer beat the default in both directions", async () => {
      await withDefaults(PROJECT_A, { plugins: { "acme.ledger": ["@databases"] } });

      setAgentMcpEndpointEnabled(PROJECT_A, LEDGER_A, "@databases", false);
      expect(isAgentMcpEndpointEnabled(PROJECT_A, LEDGER_A, "@databases")).toBe(false);

      setAgentMcpEndpointEnabled(PROJECT_A, LEDGER_A, "entries", true);
      expect(isAgentMcpEndpointEnabled(PROJECT_A, LEDGER_A, "entries")).toBe(true);
    });

    it("revokes a running agent's grant when its default leaves the file, but not one the user turned on", async () => {
      const root = await withDefaults(PROJECT_A, {
        plugins: { "acme.ledger": ["@databases", "data"] },
      });
      setAgentMcpEndpointEnabled(PROJECT_A, LEDGER_A, "data", true);
      const issue = (endpointId: string) =>
        pluginMcpGrantRegistry.issue({
          pluginInstanceId: LEDGER_A,
          endpointId,
          projectId: PROJECT_A,
          terminalId: "t1",
        });
      const databases = issue("@databases");
      const data = issue("data");

      await fs.writeFile(path.join(root, ".daintree", "mcp.json"), JSON.stringify({ plugins: {} }));
      await refreshProjectAgentMcpDefaults(PROJECT_A, root);

      expect(pluginMcpGrantRegistry.authenticate(databases.token)).toBeNull();
      expect(pluginMcpGrantRegistry.authenticate(data.token)).toBe(data.grant);

      // Restoring the default never revives a revoked bearer.
      await fs.writeFile(
        path.join(root, ".daintree", "mcp.json"),
        JSON.stringify({ plugins: { "acme.ledger": ["@databases"] } })
      );
      await refreshProjectAgentMcpDefaults(PROJECT_A, root);
      expect(pluginMcpGrantRegistry.authenticate(databases.token)).toBeNull();
    });

    it("keeps the newest read when two refreshes race", async () => {
      const root = await withDefaults(PROJECT_A, { plugins: { "acme.ledger": "*" } });
      const older = refreshProjectMcpDefaults(PROJECT_A, root);
      await fs.writeFile(path.join(root, ".daintree", "mcp.json"), JSON.stringify({ plugins: {} }));
      const newer = refreshProjectMcpDefaults(PROJECT_A, root);
      await Promise.all([older, newer]);

      expect(hasAnyAgentMcpEnablement(PROJECT_A)).toBe(false);
    });

    it("reads a BOM, accepts true as every endpoint, and ignores a file past the size cap", async () => {
      const root = await withDefaults(PROJECT_A, {});
      const file = path.join(root, ".daintree", "mcp.json");
      await fs.writeFile(file, "\ufeff" + JSON.stringify({ plugins: { "acme.ledger": true } }));
      await refreshProjectMcpDefaults(PROJECT_A, root);
      expect(isAgentMcpEndpointEnabled(PROJECT_A, LEDGER_A, "anything")).toBe(true);

      await fs.writeFile(
        file,
        JSON.stringify({ plugins: { "acme.ledger": "*" }, pad: "x".repeat(70 * 1024) })
      );
      await refreshProjectMcpDefaults(PROJECT_A, root);
      expect(hasAnyAgentMcpEnablement(PROJECT_A)).toBe(false);
    });

    it("refuses a symlinked .daintree directory", async () => {
      const real = await withDefaults(PROJECT_B, { plugins: { "acme.ledger": "*" } });
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-mcp-defaults-"));
      roots.push(root);
      await fs.symlink(path.join(real, ".daintree"), path.join(root, ".daintree"));
      await refreshProjectMcpDefaults(PROJECT_A, root);

      expect(isAgentMcpEndpointEnabled(PROJECT_A, LEDGER_A, "@databases")).toBe(false);
    });

    it("counts nothing as possibly on when the user only ever turned endpoints off", () => {
      setAgentMcpEndpointEnabled(PROJECT_A, LEDGER_A, "data", false);
      expect(hasAnyAgentMcpEnablement(PROJECT_A)).toBe(false);
    });

    it("drops the default once the file is gone", async () => {
      const root = await withDefaults(PROJECT_A, { plugins: { "acme.ledger": "*" } });
      await fs.rm(path.join(root, ".daintree", "mcp.json"));
      await refreshProjectMcpDefaults(PROJECT_A, root);

      expect(isAgentMcpEndpointEnabled(PROJECT_A, LEDGER_A, "@databases")).toBe(false);
      expect(hasAnyAgentMcpEnablement(PROJECT_A)).toBe(false);
    });

    it("ignores a malformed file and malformed entries", async () => {
      await withDefaults(PROJECT_A, { plugins: { "acme.ledger": [42, ""], other: { x: 1 } } });
      expect(hasAnyAgentMcpEnablement(PROJECT_A)).toBe(false);

      const root = await withDefaults(PROJECT_A, {});
      await fs.writeFile(path.join(root, ".daintree", "mcp.json"), "{ not json");
      await refreshProjectMcpDefaults(PROJECT_A, root);
      expect(hasAnyAgentMcpEnablement(PROJECT_A)).toBe(false);
    });

    it("refuses a symlinked defaults file", async () => {
      const root = await withDefaults(PROJECT_A, {});
      const outside = path.join(root, "elsewhere.json");
      await fs.writeFile(outside, JSON.stringify({ plugins: { "acme.ledger": "*" } }));
      await fs.rm(path.join(root, ".daintree", "mcp.json"));
      await fs.symlink(outside, path.join(root, ".daintree", "mcp.json"));
      await refreshProjectMcpDefaults(PROJECT_A, root);

      expect(isAgentMcpEndpointEnabled(PROJECT_A, LEDGER_A, "@databases")).toBe(false);
    });

    it("treats a record written before defaults existed as on, and a malformed one as no answer", () => {
      storeMock.data.set("projectAgentMcpEnablement", {
        [PROJECT_A]: {
          [LEDGER_A]: { legacy: { decidedAt: 1 }, broken: { decidedAt: 1, enabled: "no" } },
        },
      });

      expect(isAgentMcpEndpointEnabled(PROJECT_A, LEDGER_A, "legacy")).toBe(true);
      expect(hasUserAgentMcpAnswer(PROJECT_A, LEDGER_A, "broken")).toBe(false);
    });
  });
});
