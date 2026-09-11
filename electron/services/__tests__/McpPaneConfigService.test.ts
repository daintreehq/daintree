import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testUserData = vi.hoisted(
  () => `${process.cwd()}/.vitest-mcp-pane-${Math.random().toString(36).slice(2)}`
);

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name !== "userData") {
        throw new Error(`Unexpected getPath: ${name}`);
      }
      return testUserData;
    },
  },
}));

// `hooks` run one per write, in order, before it lands — a hook that waits
// holds that write open, one that throws fails it.
const writeControl = vi.hoisted(() => ({
  error: null as Error | null,
  hooks: [] as Array<() => Promise<void>>,
}));

vi.mock("../../utils/fs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/fs.js")>();
  return {
    ...actual,
    resilientAtomicWriteFile: async (
      ...args: Parameters<typeof actual.resilientAtomicWriteFile>
    ) => {
      const hook = writeControl.hooks.shift();
      if (hook) await hook();
      if (writeControl.error) throw writeControl.error;
      return actual.resilientAtomicWriteFile(...args);
    },
  };
});

function deferred() {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

import { McpPaneConfigService, pluginServerKeysFor } from "../McpPaneConfigService.js";
import { PluginMcpGrantRegistry } from "../pluginAgentMcp/grantRegistry.js";
import { pluginMcpRoutePath } from "../pluginAgentMcp/types.js";
import { makeProjectPluginInstanceKey } from "../../../shared/types/plugin.js";
import { createHash } from "node:crypto";

const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);

function bearerOf(entry: { headers: { Authorization: string } }): string {
  const match = /^Bearer (.+)$/.exec(entry.headers.Authorization);
  if (!match) throw new Error(`Not a bearer header: ${entry.headers.Authorization}`);
  return match[1];
}

describe("McpPaneConfigService", () => {
  let service: McpPaneConfigService;

  beforeEach(async () => {
    await fs.rm(testUserData, { recursive: true, force: true });
    service = new McpPaneConfigService();
  });

  afterEach(async () => {
    writeControl.error = null;
    writeControl.hooks.length = 0;
    await service.revokeAll();
    await fs.rm(testUserData, { recursive: true, force: true });
  });

  it("writes a per-pane MCP config file with the literal token in the Authorization header", async () => {
    const { configPath, token } = await service.preparePaneConfig({
      paneId: "pane-001",
      port: 45454,
      tier: "workbench",
    });

    expect(configPath).toBe(path.join(testUserData, "mcp-pane-configs", "pane-001.json"));
    expect(token).toMatch(/^[0-9a-f-]{36}$/);

    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw);

    expect(parsed.mcpServers.daintree.type).toBe("sse");
    expect(parsed.mcpServers.daintree.url).toBe("http://127.0.0.1:45454/sse");
    expect(parsed.mcpServers.daintree.headers.Authorization).toBe(`Bearer ${token}`);
    // Token must NOT be ${VAR}-style — Claude Code's header env substitution is
    // still broken (anthropics/claude-code#6204) and `mcp add/remove` rewrite it
    // to a literal, leaking it to disk (#18692, #57131); literal is reliable.
    expect(parsed.mcpServers.daintree.headers.Authorization).not.toContain("${");
  });

  it("creates the pane config directory with mode 0700 on POSIX", async () => {
    if (process.platform === "win32") return;

    await service.preparePaneConfig({ paneId: "pane-002", port: 45454, tier: "workbench" });
    const stat = await fs.stat(path.join(testUserData, "mcp-pane-configs"));
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it("creates the config file with mode 0600 on POSIX", async () => {
    if (process.platform === "win32") return;

    const { configPath } = await service.preparePaneConfig({
      paneId: "pane-003",
      port: 45454,
      tier: "workbench",
    });
    const stat = await fs.stat(configPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("registers the token as valid and rejects unknown tokens", async () => {
    const { token } = await service.preparePaneConfig({
      paneId: "pane-004",
      port: 45454,
      tier: "workbench",
    });

    expect(service.isValidPaneToken(token)).toBe(true);
    expect(service.isValidPaneToken("not-a-real-token")).toBe(false);
    expect(service.isValidPaneToken("")).toBe(false);
  });

  it("revokes the token and deletes the config file on revokePaneConfig", async () => {
    const { configPath, token } = await service.preparePaneConfig({
      paneId: "pane-005",
      port: 45454,
      tier: "action",
    });

    expect(service.isValidPaneToken(token)).toBe(true);
    await service.revokePaneConfig("pane-005");

    expect(service.isValidPaneToken(token)).toBe(false);
    await expect(fs.stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is idempotent — revokePaneConfig tolerates missing files and unknown panes", async () => {
    await expect(service.revokePaneConfig("never-existed")).resolves.toBeUndefined();

    await service.preparePaneConfig({ paneId: "pane-006", port: 45454, tier: "workbench" });
    await service.revokePaneConfig("pane-006");
    // second call against an already-revoked pane must not throw
    await expect(service.revokePaneConfig("pane-006")).resolves.toBeUndefined();
  });

  it("re-preparing the same paneId rotates the token and overwrites the file", async () => {
    const first = await service.preparePaneConfig({
      paneId: "pane-007",
      port: 45454,
      tier: "workbench",
    });
    const second = await service.preparePaneConfig({
      paneId: "pane-007",
      port: 45454,
      tier: "system",
    });

    expect(second.token).not.toBe(first.token);
    expect(service.isValidPaneToken(first.token)).toBe(false);
    expect(service.isValidPaneToken(second.token)).toBe(true);

    const raw = await fs.readFile(second.configPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.mcpServers.daintree.headers.Authorization).toBe(`Bearer ${second.token}`);
  });

  it("rejects invalid ports", async () => {
    await expect(
      service.preparePaneConfig({ paneId: "pane-008", port: 0, tier: "workbench" })
    ).rejects.toThrow(/Invalid MCP port/);
    await expect(
      service.preparePaneConfig({ paneId: "pane-009", port: 70000, tier: "workbench" })
    ).rejects.toThrow(/Invalid MCP port/);
    await expect(
      service.preparePaneConfig({
        paneId: "pane-010",
        port: -1 as unknown as number,
        tier: "workbench",
      })
    ).rejects.toThrow(/Invalid MCP port/);
  });

  it("rejects empty pane IDs", async () => {
    await expect(
      service.preparePaneConfig({ paneId: "", port: 45454, tier: "workbench" })
    ).rejects.toThrow(/paneId is required/);
  });

  it('rejects tier "off" — caller must skip preparePaneConfig instead', async () => {
    await expect(
      service.preparePaneConfig({ paneId: "pane-off", port: 45454, tier: "off" })
    ).rejects.toThrow(/should not be called with tier "off"/);
  });

  it("rejects path-traversal pane IDs", async () => {
    await expect(
      service.preparePaneConfig({ paneId: "../escape", port: 45454, tier: "workbench" })
    ).rejects.toThrow(/Invalid paneId/);
    await expect(
      service.preparePaneConfig({
        paneId: "../../etc/passwd",
        port: 45454,
        tier: "workbench",
      })
    ).rejects.toThrow(/Invalid paneId/);
    await expect(
      service.preparePaneConfig({ paneId: "subdir/leak", port: 45454, tier: "workbench" })
    ).rejects.toThrow(/Invalid paneId/);

    // Confirm no file was written outside the base directory.
    const escapeCandidate = path.join(testUserData, "escape.json");
    await expect(fs.stat(escapeCandidate)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("getTierForToken returns the tier the token was minted at", async () => {
    const wb = await service.preparePaneConfig({
      paneId: "pane-wb",
      port: 45454,
      tier: "workbench",
    });
    const action = await service.preparePaneConfig({
      paneId: "pane-action",
      port: 45454,
      tier: "action",
    });
    const sys = await service.preparePaneConfig({
      paneId: "pane-sys",
      port: 45454,
      tier: "system",
    });

    expect(service.getTierForToken(wb.token)).toBe("workbench");
    expect(service.getTierForToken(action.token)).toBe("action");
    expect(service.getTierForToken(sys.token)).toBe("system");
    expect(service.getTierForToken("not-a-real-token")).toBeUndefined();
    expect(service.getTierForToken("")).toBeUndefined();
  });

  it("revokePaneConfig clears the tier mapping", async () => {
    const { token } = await service.preparePaneConfig({
      paneId: "pane-revoke-tier",
      port: 45454,
      tier: "system",
    });
    expect(service.getTierForToken(token)).toBe("system");
    await service.revokePaneConfig("pane-revoke-tier");
    expect(service.getTierForToken(token)).toBeUndefined();
  });

  describe("assistant-session pinning (#10647)", () => {
    it("getWebContentsIdForToken / getActionContextForToken return null for generic pane tokens", async () => {
      const { token } = await service.preparePaneConfig({
        paneId: "pane-generic",
        port: 45454,
        tier: "action",
      });
      // Never promoted to an assistant bearer → no pinning metadata.
      expect(service.getWebContentsIdForToken(token)).toBeNull();
      expect(service.getActionContextForToken(token)).toBeNull();
      expect(service.getWebContentsIdForToken("")).toBeNull();
      expect(service.getActionContextForToken("not-a-token")).toBeNull();
    });

    it("registerAssistantPaneBearer binds the token to a WebContents id and ActionContext", async () => {
      const { token } = await service.preparePaneConfig({
        paneId: "pane-assistant",
        port: 45454,
        tier: "action",
      });
      const ctx = { projectId: "p1", activeWorktreeId: "wt-9" };

      service.registerAssistantPaneBearer(token, 42, ctx);

      expect(service.getWebContentsIdForToken(token)).toBe(42);
      expect(service.getActionContextForToken(token)).toEqual(ctx);
      // The token is still a valid pane token at its minted tier.
      expect(service.isValidPaneToken(token)).toBe(true);
      expect(service.getTierForToken(token)).toBe("action");
    });

    it("registerAssistantPaneBearer accepts a binding with no ActionContext", async () => {
      const { token } = await service.preparePaneConfig({
        paneId: "pane-assistant-noctx",
        port: 45454,
        tier: "action",
      });

      service.registerAssistantPaneBearer(token, 7);

      expect(service.getWebContentsIdForToken(token)).toBe(7);
      expect(service.getActionContextForToken(token)).toBeNull();
    });

    it("registerAssistantPaneBearer no-ops for an unknown or revoked token", async () => {
      // Never minted — nothing to bind, must not throw or resurrect a record.
      expect(() => service.registerAssistantPaneBearer("ghost-token", 42)).not.toThrow();
      expect(service.getWebContentsIdForToken("ghost-token")).toBeNull();

      const { token } = await service.preparePaneConfig({
        paneId: "pane-race",
        port: 45454,
        tier: "action",
      });
      await service.revokePaneConfig("pane-race");
      service.registerAssistantPaneBearer(token, 42);
      expect(service.getWebContentsIdForToken(token)).toBeNull();
    });

    it("revokePaneConfig tears down the assistant pinning metadata", async () => {
      const { token } = await service.preparePaneConfig({
        paneId: "pane-assistant-revoke",
        port: 45454,
        tier: "action",
      });
      service.registerAssistantPaneBearer(token, 42, { projectId: "p1" });
      expect(service.getWebContentsIdForToken(token)).toBe(42);

      await service.revokePaneConfig("pane-assistant-revoke");

      expect(service.getWebContentsIdForToken(token)).toBeNull();
      expect(service.getActionContextForToken(token)).toBeNull();
    });
  });

  it("revokeAll clears all tokens and files", async () => {
    const a = await service.preparePaneConfig({
      paneId: "pane-a",
      port: 45454,
      tier: "workbench",
    });
    const b = await service.preparePaneConfig({
      paneId: "pane-b",
      port: 45454,
      tier: "system",
    });

    expect(service.isValidPaneToken(a.token)).toBe(true);
    expect(service.isValidPaneToken(b.token)).toBe(true);

    await service.revokeAll();

    expect(service.isValidPaneToken(a.token)).toBe(false);
    expect(service.isValidPaneToken(b.token)).toBe(false);
    await expect(fs.stat(a.configPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(b.configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  describe("plugin MCP endpoints", () => {
    let grants: PluginMcpGrantRegistry;

    beforeEach(() => {
      grants = new PluginMcpGrantRegistry();
      service = new McpPaneConfigService(grants);
    });

    const ledger = { pluginInstanceId: "acme.ledger", endpointId: "data" };

    async function readServers(configPath: string) {
      const parsed = JSON.parse(await fs.readFile(configPath, "utf-8"));
      return parsed.mcpServers as Record<
        string,
        { type: string; url: string; headers: { Authorization: string } }
      >;
    }

    it('tier "off" writes only plugin entries and registers no pane token', async () => {
      const prepared = await service.preparePaneConfig({
        paneId: "pane-plugin-off",
        port: 45454,
        tier: "off",
        plugin: { projectId: PROJECT_A, endpoints: [ledger], launchAgentIdHint: "claude" },
      });

      expect(prepared).not.toBeNull();
      expect(prepared!.token).toBeNull();
      const servers = await readServers(prepared!.configPath);
      expect(Object.keys(servers)).toEqual(prepared!.pluginServerKeys);
      expect(servers.daintree).toBeUndefined();

      const [grant] = grants.listForTerminal("pane-plugin-off");
      expect(grant.projectId).toBe(PROJECT_A);
      expect(grant.launchAgentIdHint).toBe("claude");
      // Nothing about the plugin grant is valid on the orchestration surface.
      expect(service.isValidPaneToken(bearerOf(Object.values(servers)[0]))).toBe(false);
    });

    it("a non-off tier keeps the Daintree entry and pane token, with the plugin entries alongside", async () => {
      const prepared = await service.preparePaneConfig({
        paneId: "pane-plugin-wb",
        port: 45454,
        tier: "workbench",
        plugin: { projectId: PROJECT_A, endpoints: [ledger] },
      });

      const servers = await readServers(prepared!.configPath);
      expect(servers.daintree.headers.Authorization).toBe(`Bearer ${prepared!.token}`);
      expect(service.getTierForToken(prepared!.token!)).toBe("workbench");
      expect(prepared!.pluginServerKeys).toHaveLength(1);
      expect(prepared!.pluginServerKeys[0]).not.toBe("daintree");
      expect(Object.keys(servers).sort()).toEqual(
        ["daintree", ...prepared!.pluginServerKeys].sort()
      );
    });

    it("writes a Streamable HTTP entry at the endpoint's route with a literal bearer the registry accepts", async () => {
      const prepared = await service.preparePaneConfig({
        paneId: "pane-plugin-entry",
        port: 45460,
        tier: "off",
        plugin: { projectId: PROJECT_A, endpoints: [ledger] },
      });

      const entry = (await readServers(prepared!.configPath))[prepared!.pluginServerKeys[0]];
      expect(entry.type).toBe("http");
      expect(entry.url).toBe(`http://127.0.0.1:45460${pluginMcpRoutePath("acme.ledger", "data")}`);
      expect(entry.headers.Authorization).not.toContain("${");
      const grant = grants.authenticate(bearerOf(entry));
      expect(grant).toMatchObject({
        pluginInstanceId: "acme.ledger",
        endpointId: "data",
        projectId: PROJECT_A,
        terminalId: "pane-plugin-entry",
      });
    });

    it("writes the plugin-only file with mode 0600 on POSIX", async () => {
      if (process.platform === "win32") return;

      const prepared = await service.preparePaneConfig({
        paneId: "pane-plugin-mode",
        port: 45454,
        tier: "off",
        plugin: { projectId: PROJECT_A, endpoints: [ledger] },
      });
      const stat = await fs.stat(prepared!.configPath);
      expect(stat.mode & 0o777).toBe(0o600);
    });

    it("skips an endpoint the registry refuses and returns null when nothing is left to write", async () => {
      const foreign = {
        pluginInstanceId: makeProjectPluginInstanceKey(PROJECT_B, "acme.ledger"),
        endpointId: "data",
      };

      const skipped = await service.preparePaneConfig({
        paneId: "pane-plugin-foreign",
        port: 45454,
        tier: "off",
        plugin: { projectId: PROJECT_A, endpoints: [foreign] },
      });
      expect(skipped).toBeNull();
      await expect(
        fs.stat(path.join(testUserData, "mcp-pane-configs", "pane-plugin-foreign.json"))
      ).rejects.toMatchObject({ code: "ENOENT" });

      const mixed = await service.preparePaneConfig({
        paneId: "pane-plugin-mixed",
        port: 45454,
        tier: "off",
        plugin: { projectId: PROJECT_A, endpoints: [foreign, ledger] },
      });
      expect(mixed!.pluginServerKeys).toHaveLength(1);
      expect(grants.listForTerminal("pane-plugin-mixed").map((g) => g.pluginInstanceId)).toEqual([
        "acme.ledger",
      ]);
    });

    it("revokePaneConfig revokes the pane's grants", async () => {
      const prepared = await service.preparePaneConfig({
        paneId: "pane-plugin-revoke",
        port: 45454,
        tier: "action",
        plugin: { projectId: PROJECT_A, endpoints: [ledger] },
      });
      const bearer = bearerOf(
        (await readServers(prepared!.configPath))[prepared!.pluginServerKeys[0]]
      );

      await service.revokePaneConfig("pane-plugin-revoke");

      expect(grants.authenticate(bearer)).toBeNull();
      expect(grants.listForTerminal("pane-plugin-revoke")).toEqual([]);
    });

    it("revokePaneConfig revokes a terminal's grants even when the pane has no record", async () => {
      grants.issue({
        pluginInstanceId: "acme.ledger",
        endpointId: "data",
        projectId: PROJECT_A,
        terminalId: "pane-without-record",
      });

      await service.revokePaneConfig("pane-without-record");

      expect(grants.listForTerminal("pane-without-record")).toEqual([]);
    });

    it("re-preparing the same pane revokes the previous launch's grants", async () => {
      const first = await service.preparePaneConfig({
        paneId: "pane-plugin-restart",
        port: 45454,
        tier: "off",
        plugin: { projectId: PROJECT_A, endpoints: [ledger] },
      });
      const firstBearer = bearerOf(
        (await readServers(first!.configPath))[first!.pluginServerKeys[0]]
      );

      await service.preparePaneConfig({
        paneId: "pane-plugin-restart",
        port: 45454,
        tier: "off",
        plugin: { projectId: PROJECT_A, endpoints: [ledger] },
      });

      expect(grants.authenticate(firstBearer)).toBeNull();
      expect(grants.listForTerminal("pane-plugin-restart")).toHaveLength(1);
    });

    it("revokeAll revokes every grant it minted", async () => {
      await service.preparePaneConfig({
        paneId: "pane-plugin-all-a",
        port: 45454,
        tier: "off",
        plugin: { projectId: PROJECT_A, endpoints: [ledger] },
      });
      await service.preparePaneConfig({
        paneId: "pane-plugin-all-b",
        port: 45454,
        tier: "system",
        plugin: { projectId: PROJECT_A, endpoints: [ledger] },
      });

      await service.revokeAll();

      expect(grants.listForTerminal("pane-plugin-all-a")).toEqual([]);
      expect(grants.listForTerminal("pane-plugin-all-b")).toEqual([]);
    });

    it("revokes the grants it minted when the file cannot be written", async () => {
      writeControl.error = new Error("disk full");
      await expect(
        service.preparePaneConfig({
          paneId: "pane-plugin-blocked",
          port: 45454,
          tier: "off",
          plugin: { projectId: PROJECT_A, endpoints: [ledger] },
        })
      ).rejects.toThrow("disk full");

      expect(grants.listForTerminal("pane-plugin-blocked")).toEqual([]);
    });

    it("fails a preparation revoked mid-write instead of handing over dead bearers", async () => {
      const gate = deferred();
      let writeStarted = false;
      writeControl.hooks.push(async () => {
        writeStarted = true;
        await gate.promise;
      });

      const pending = service.preparePaneConfig({
        paneId: "pane-plugin-late-exit",
        port: 45454,
        tier: "action",
        plugin: { projectId: PROJECT_A, endpoints: [ledger] },
      });
      await vi.waitFor(() => expect(writeStarted).toBe(true));
      // The previous launch's exit lands while the file is being written.
      await service.revokePaneConfig("pane-plugin-late-exit");
      gate.resolve();

      await expect(pending).rejects.toThrow(/revoked while preparing/);
      expect(grants.listForTerminal("pane-plugin-late-exit")).toEqual([]);
      await expect(
        fs.stat(path.join(testUserData, "mcp-pane-configs", "pane-plugin-late-exit.json"))
      ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("a Daintree-only preparation revoked mid-write still goes ahead", async () => {
      const gate = deferred();
      let writeStarted = false;
      writeControl.hooks.push(async () => {
        writeStarted = true;
        await gate.promise;
      });

      const pending = service.preparePaneConfig({
        paneId: "pane-late-exit-daintree",
        port: 45454,
        tier: "action",
      });
      await vi.waitFor(() => expect(writeStarted).toBe(true));
      await service.revokePaneConfig("pane-late-exit-daintree");
      gate.resolve();

      const prepared = await pending;
      expect(service.isValidPaneToken(prepared.token)).toBe(true);
      await expect(fs.stat(prepared.configPath)).resolves.toBeDefined();
    });

    it("runs overlapping preparations for one pane in order, so the newer file wins", async () => {
      const olderGate = deferred();
      let olderWriteStarted = false;
      writeControl.hooks.push(async () => {
        olderWriteStarted = true;
        await olderGate.promise;
      });

      const older = service.preparePaneConfig({
        paneId: "pane-plugin-overlap",
        port: 45454,
        tier: "action",
        plugin: { projectId: PROJECT_A, endpoints: [ledger] },
      });
      await vi.waitFor(() => expect(olderWriteStarted).toBe(true));
      const newerPending = service.preparePaneConfig({
        paneId: "pane-plugin-overlap",
        port: 45454,
        tier: "action",
        plugin: { projectId: PROJECT_A, endpoints: [ledger] },
      });

      // The older one finishes its write after the newer was requested; the
      // newer then revokes it and writes last.
      olderGate.resolve();
      const olderPrepared = await older;
      const olderBearer = bearerOf(
        (await readServers(olderPrepared!.configPath))[olderPrepared!.pluginServerKeys[0]]
      );
      const newer = await newerPending;
      const newerBearer = bearerOf(
        (await readServers(newer!.configPath))[newer!.pluginServerKeys[0]]
      );

      expect(newerBearer).not.toBe(olderBearer);
      expect(grants.authenticate(olderBearer)).toBeNull();
      expect(grants.authenticate(newerBearer)).not.toBeNull();
      expect(service.isValidPaneToken(olderPrepared!.token!)).toBe(false);
      expect(service.isValidPaneToken(newer!.token!)).toBe(true);
    });

    it("re-checks eligibility as each grant is minted", async () => {
      const prepared = await service.preparePaneConfig({
        paneId: "pane-plugin-ineligible",
        port: 45454,
        tier: "action",
        plugin: { projectId: PROJECT_A, endpoints: [ledger], isEligible: () => false },
      });

      expect(prepared!.pluginServerKeys).toEqual([]);
      expect(grants.listForTerminal("pane-plugin-ineligible")).toEqual([]);
    });

    it('still rejects tier "off" with no plugin endpoints', async () => {
      await expect(
        service.preparePaneConfig({
          paneId: "pane-plugin-empty",
          port: 45454,
          tier: "off",
          plugin: { projectId: PROJECT_A, endpoints: [] },
        })
      ).rejects.toThrow(/should not be called with tier "off"/);
    });
  });

  describe("pluginServerKeysFor", () => {
    const KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

    it("derives a key from the manifest id and endpoint, restricted to safe characters", () => {
      const [key] = pluginServerKeysFor([{ pluginInstanceId: "acme.ledger", endpointId: "d.v2" }]);
      expect(key).toMatch(KEY_PATTERN);
      expect(key).toContain("acme_ledger");
      expect(key).toContain("d_v2");
      expect(key).not.toBe("daintree");
    });

    it("leaves room for a 32-character tool name inside Claude's 64-character limit", () => {
      const keys = pluginServerKeysFor([
        { pluginInstanceId: "acme.an-extremely-long-plugin-manifest-name", endpointId: "data" },
        { pluginInstanceId: "acme.ledger", endpointId: "data" },
      ]);
      const longestTool = "t".repeat(32);
      for (const key of keys) {
        expect(`mcp__${key}__${longestTool}`.length).toBeLessThanOrEqual(64);
      }
    });

    it("keeps a project plugin's key free of its 64-hex project id", () => {
      const [key] = pluginServerKeysFor([
        {
          pluginInstanceId: makeProjectPluginInstanceKey(PROJECT_A, "acme.ledger"),
          endpointId: "data",
        },
      ]);
      expect(key).not.toContain(PROJECT_A);
      expect(key).toContain("acme_ledger");
    });

    it("disambiguates endpoints that sanitise to the same key, independent of order", () => {
      const installed = { pluginInstanceId: "acme.ledger", endpointId: "data" };
      const project = {
        pluginInstanceId: makeProjectPluginInstanceKey(PROJECT_A, "acme.ledger"),
        endpointId: "data",
      };
      const folded = { pluginInstanceId: "acme_ledger", endpointId: "data" };

      const keys = pluginServerKeysFor([installed, project, folded]);
      expect(new Set(keys).size).toBe(3);
      for (const key of keys) expect(key).toMatch(KEY_PATTERN);

      const reversed = pluginServerKeysFor([folded, project, installed]);
      expect(reversed).toEqual([...keys].reverse());
    });

    it("stays order-independent when a hashed key lands on another endpoint's plain key", () => {
      const installed = { pluginInstanceId: "acme.ledger", endpointId: "data" };
      const project = {
        pluginInstanceId: makeProjectPluginInstanceKey(PROJECT_A, "acme.ledger"),
        endpointId: "data",
      };
      // An endpoint whose plain key is exactly the installed copy's hashed key.
      const hash = createHash("sha256")
        .update(`acme.ledger\0data`, "utf8")
        .digest("hex")
        .slice(0, 8);
      const lookalike = { pluginInstanceId: "acme.ledger", endpointId: `data-${hash}` };

      const keys = pluginServerKeysFor([installed, project, lookalike]);
      expect(new Set(keys).size).toBe(3);
      expect(pluginServerKeysFor([lookalike, project, installed])).toEqual([...keys].reverse());
      expect(pluginServerKeysFor([project, lookalike, installed])).toEqual([
        keys[1],
        keys[2],
        keys[0],
      ]);
    });

    it("bounds the key length for long ids without losing uniqueness", () => {
      const longId = `com.example.${"very-long-plugin-name-".repeat(4)}`;
      const keys = pluginServerKeysFor([
        { pluginInstanceId: `${longId}a`, endpointId: "data" },
        { pluginInstanceId: `${longId}b`, endpointId: "data" },
      ]);
      expect(new Set(keys).size).toBe(2);
      for (const key of keys) {
        expect(key).toMatch(KEY_PATTERN);
        expect(key.length).toBeLessThanOrEqual(48);
      }
    });
  });
});
