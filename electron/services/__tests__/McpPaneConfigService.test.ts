import { createHash } from "node:crypto";
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
// holds that write open, one that throws fails it. `written` records each
// write that landed, in order — the only stable view of a file a later
// preparation for the same pane has since unlinked and rewritten.
const writeControl = vi.hoisted(() => ({
  error: null as Error | null,
  hooks: [] as Array<() => Promise<void>>,
  written: [] as Array<{ path: string; data: string }>,
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
      await actual.resilientAtomicWriteFile(...args);
      writeControl.written.push({ path: String(args[0]), data: String(args[1]) });
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

import {
  McpPaneConfigService,
  mcpPaneConfigService,
  type PanePluginServer,
} from "../McpPaneConfigService.js";
import { isAuthorized, resolveTokenTier } from "../mcp-server/tierAuth.js";
import { PluginMcpGrantRegistry } from "../pluginAgentMcp/grantRegistry.js";
import { pluginMcpRoutePath } from "../pluginAgentMcp/types.js";
import { MCP_CONFIRMABLE_CALL_MAX_MS } from "../../../shared/config/mcpConfirmWindow.js";
import { makeProjectPluginInstanceKey } from "../../../shared/types/plugin.js";

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
    writeControl.written.length = 0;
    await service.revokeAll();
    await fs.rm(testUserData, { recursive: true, force: true });
  });

  it("writes a per-pane MCP config file with the literal token in the Authorization header", async () => {
    const { configPath, token } = await service.preparePaneConfig({
      paneId: "pane-001",
      port: 45454,
      tier: "core",
    });

    expect(configPath).toBe(path.join(testUserData, "mcp-pane-configs", "pane-001.json"));
    expect(token).toMatch(/^[0-9a-f-]{36}$/);

    const raw = await fs.readFile(configPath!, "utf-8");
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

    await service.preparePaneConfig({ paneId: "pane-002", port: 45454, tier: "core" });
    const stat = await fs.stat(path.join(testUserData, "mcp-pane-configs"));
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it("creates the config file with mode 0600 on POSIX", async () => {
    if (process.platform === "win32") return;

    const { configPath } = await service.preparePaneConfig({
      paneId: "pane-003",
      port: 45454,
      tier: "core",
    });
    const stat = await fs.stat(configPath!);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("registers the token as valid and rejects unknown tokens", async () => {
    const { token } = await service.preparePaneConfig({
      paneId: "pane-004",
      port: 45454,
      tier: "core",
    });

    expect(service.isValidPaneToken(token)).toBe(true);
    expect(service.isValidPaneToken("not-a-real-token")).toBe(false);
    expect(service.isValidPaneToken("")).toBe(false);
  });

  it("revokes the token and deletes the config file on revokePaneConfig", async () => {
    const { configPath, token } = await service.preparePaneConfig({
      paneId: "pane-005",
      port: 45454,
      tier: "core",
    });

    expect(service.isValidPaneToken(token)).toBe(true);
    await service.revokePaneConfig("pane-005");

    expect(service.isValidPaneToken(token)).toBe(false);
    await expect(fs.stat(configPath!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is idempotent — revokePaneConfig tolerates missing files and unknown panes", async () => {
    await expect(service.revokePaneConfig("never-existed")).resolves.toBeUndefined();

    await service.preparePaneConfig({ paneId: "pane-006", port: 45454, tier: "core" });
    await service.revokePaneConfig("pane-006");
    // second call against an already-revoked pane must not throw
    await expect(service.revokePaneConfig("pane-006")).resolves.toBeUndefined();
  });

  it("re-preparing the same paneId rotates the token and overwrites the file", async () => {
    const first = await service.preparePaneConfig({
      paneId: "pane-007",
      port: 45454,
      tier: "core",
    });
    const second = await service.preparePaneConfig({
      paneId: "pane-007",
      port: 45454,
      tier: "full",
    });

    expect(second.token).not.toBe(first.token);
    expect(service.isValidPaneToken(first.token)).toBe(false);
    expect(service.isValidPaneToken(second.token)).toBe(true);

    const raw = await fs.readFile(second.configPath!, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.mcpServers.daintree.headers.Authorization).toBe(`Bearer ${second.token}`);
  });

  it("rejects invalid ports", async () => {
    await expect(
      service.preparePaneConfig({ paneId: "pane-008", port: 0, tier: "core" })
    ).rejects.toThrow(/Invalid MCP port/);
    await expect(
      service.preparePaneConfig({ paneId: "pane-009", port: 70000, tier: "core" })
    ).rejects.toThrow(/Invalid MCP port/);
    await expect(
      service.preparePaneConfig({
        paneId: "pane-010",
        port: -1 as unknown as number,
        tier: "core",
      })
    ).rejects.toThrow(/Invalid MCP port/);
  });

  it("rejects empty pane IDs", async () => {
    await expect(
      service.preparePaneConfig({ paneId: "", port: 45454, tier: "core" })
    ).rejects.toThrow(/paneId is required/);
  });

  it('rejects tier "off" — caller must skip preparePaneConfig instead', async () => {
    await expect(
      service.preparePaneConfig({ paneId: "pane-off", port: 45454, tier: "off" })
    ).rejects.toThrow(/should not be called with tier "off"/);
  });

  it("rejects path-traversal pane IDs", async () => {
    await expect(
      service.preparePaneConfig({ paneId: "../escape", port: 45454, tier: "core" })
    ).rejects.toThrow(/Invalid paneId/);
    await expect(
      service.preparePaneConfig({
        paneId: "../../etc/passwd",
        port: 45454,
        tier: "core",
      })
    ).rejects.toThrow(/Invalid paneId/);
    await expect(
      service.preparePaneConfig({ paneId: "subdir/leak", port: 45454, tier: "core" })
    ).rejects.toThrow(/Invalid paneId/);

    // Confirm no file was written outside the base directory.
    const escapeCandidate = path.join(testUserData, "escape.json");
    await expect(fs.stat(escapeCandidate)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("getTierForToken returns the tier the token was minted at", async () => {
    const core = await service.preparePaneConfig({
      paneId: "pane-core",
      port: 45454,
      tier: "core",
    });
    const full = await service.preparePaneConfig({
      paneId: "pane-full",
      port: 45454,
      tier: "full",
    });

    expect(service.getTierForToken(core.token)).toBe("core");
    expect(service.getTierForToken(full.token)).toBe("full");
    expect(service.getTierForToken("not-a-real-token")).toBeUndefined();
    expect(service.getTierForToken("")).toBeUndefined();
  });

  it("revokePaneConfig clears the tier mapping", async () => {
    const { token } = await service.preparePaneConfig({
      paneId: "pane-revoke-tier",
      port: 45454,
      tier: "full",
    });
    expect(service.getTierForToken(token)).toBe("full");
    await service.revokePaneConfig("pane-revoke-tier");
    expect(service.getTierForToken(token)).toBeUndefined();
  });

  describe("orchestrator panes for a terminal hand-over (#12490)", () => {
    it("resolves a pane's bearer identity before it ever connects", async () => {
      const { token } = await service.preparePaneConfig({
        paneId: "pane-orch",
        port: 45454,
        tier: "core",
      });
      service.registerPaneWorkspaceBinding(token, { workspaceId: "p1" });

      const identity = service.getOrchestratorPane("pane-orch");

      expect(identity).toEqual({
        principalId: service.getOwnershipPrincipalForToken(token),
        tier: "core",
        workspaceId: "p1",
      });
      expect(service.listOrchestratorPanes()).toEqual([{ paneId: "pane-orch", ...identity }]);
    });

    it("resolves nothing for an unknown pane or a revoked bearer", async () => {
      expect(service.getOrchestratorPane("pane-never")).toBeNull();

      await service.preparePaneConfig({ paneId: "pane-gone", port: 45454, tier: "core" });
      await service.revokePaneConfig("pane-gone");
      expect(service.getOrchestratorPane("pane-gone")).toBeNull();
      expect(service.listOrchestratorPanes()).toEqual([]);
    });

    it("names a new principal after a relaunch, so nothing handed to the old one follows", async () => {
      await service.preparePaneConfig({ paneId: "pane-orch", port: 45454, tier: "core" });
      const before = service.getOrchestratorPane("pane-orch")?.principalId;

      await service.preparePaneConfig({ paneId: "pane-orch", port: 45454, tier: "core" });

      const after = service.getOrchestratorPane("pane-orch")?.principalId;
      expect(after).toBeDefined();
      expect(after).not.toBe(before);
    });
  });

  describe("agent-pane workspace binding (#12486)", () => {
    it("binds the token to its launch workspace, launch view, and context", async () => {
      const { token } = await service.preparePaneConfig({
        paneId: "pane-agent",
        port: 45454,
        tier: "core",
      });
      const ctx = { projectId: "p1", activeWorktreeId: "wt-3" };

      service.registerPaneWorkspaceBinding(token, {
        workspaceId: "p1",
        launchWebContentsId: 42,
        actionContext: ctx,
      });

      expect(service.getPaneWorkspaceBindingForToken(token)).toEqual({
        workspaceId: "p1",
        launchWebContentsId: 42,
        actionContext: ctx,
      });
      // The tier the pane was minted at is untouched by where it routes.
      expect(service.getTierForToken(token)).toBe("core");
    });

    it("carries the launch-time skip-confirmations setting (#12876)", async () => {
      const { token } = await service.preparePaneConfig({
        paneId: "pane-agent-skip",
        port: 45454,
        tier: "full",
      });

      service.registerPaneWorkspaceBinding(token, { workspaceId: "p1", skipConfirmations: true });

      expect(service.getPaneWorkspaceBindingForToken(token)).toEqual({
        workspaceId: "p1",
        skipConfirmations: true,
      });
      await service.revokePaneConfig("pane-agent-skip");
      expect(service.getPaneWorkspaceBindingForToken(token)).toBeNull();
    });

    it("no-ops for an unknown or revoked token", async () => {
      expect(() =>
        service.registerPaneWorkspaceBinding("ghost-token", { workspaceId: "p1" })
      ).not.toThrow();
      expect(service.getPaneWorkspaceBindingForToken("ghost-token")).toBeNull();
      expect(service.getPaneWorkspaceBindingForToken("")).toBeNull();

      const { token } = await service.preparePaneConfig({
        paneId: "pane-agent-race",
        port: 45454,
        tier: "core",
      });
      await service.revokePaneConfig("pane-agent-race");
      service.registerPaneWorkspaceBinding(token, { workspaceId: "p1" });

      expect(service.getPaneWorkspaceBindingForToken(token)).toBeNull();
    });

    it("drops the previous launch's binding when the pane is prepared again", async () => {
      // A restart re-prepares the same pane id and mints a new bearer; the old
      // one must not keep routing anywhere.
      const first = await service.preparePaneConfig({
        paneId: "pane-agent-restart",
        port: 45454,
        tier: "core",
      });
      service.registerPaneWorkspaceBinding(first.token, { workspaceId: "p1" });

      const second = await service.preparePaneConfig({
        paneId: "pane-agent-restart",
        port: 45454,
        tier: "core",
      });

      expect(service.getPaneWorkspaceBindingForToken(first.token)).toBeNull();
      expect(service.getPaneWorkspaceBindingForToken(second.token)).toBeNull();
    });
  });

  describe("resource-ownership principal (#12487)", () => {
    it("resolves one stable principal per live token, and nothing for other tokens", async () => {
      const a = await service.preparePaneConfig({ paneId: "pane-a", port: 45454, tier: "core" });
      const b = await service.preparePaneConfig({ paneId: "pane-b", port: 45454, tier: "core" });

      const principal = service.getOwnershipPrincipalForToken(a.token);
      expect(principal).toEqual(expect.any(String));
      expect(service.getOwnershipPrincipalForToken(a.token)).toBe(principal);
      expect(service.getOwnershipPrincipalForToken(b.token)).not.toBe(principal);
      expect(service.getOwnershipPrincipalForToken("not-a-pane-token")).toBeNull();
      expect(service.getOwnershipPrincipalForToken("")).toBeNull();
    });

    it("resolves a pane bearer to its own terminal until it is revoked (#12491)", async () => {
      const { token } = await service.preparePaneConfig({
        paneId: "pane-own",
        port: 45454,
        tier: "core",
      });

      expect(service.getPaneIdForToken(token)).toBe("pane-own");
      expect(service.getPaneIdForToken("not-a-pane-token")).toBeNull();
      expect(service.getPaneIdForToken("")).toBeNull();

      await service.revokePaneConfig("pane-own");
      expect(service.getPaneIdForToken(token)).toBeNull();
    });

    it("tells the listener the principal in the same step the bearer is revoked", async () => {
      const listener = vi.fn<(principal: string) => void>();
      service.setOwnershipPrincipalRevokedListener(listener);
      const { token } = await service.preparePaneConfig({
        paneId: "pane-exit",
        port: 45454,
        tier: "core",
      });
      const principal = service.getOwnershipPrincipalForToken(token);

      const revoking = service.revokePaneConfig("pane-exit");
      // Before the file unlink is awaited: nothing may run between the bearer
      // going and its authority going.
      expect(service.isValidPaneToken(token)).toBe(false);
      expect(listener).toHaveBeenCalledExactlyOnceWith(principal);
      await revoking;

      expect(service.getOwnershipPrincipalForToken(token)).toBeNull();
    });

    it("gives a relaunch a new principal and revokes the old one", async () => {
      const listener = vi.fn<(principal: string) => void>();
      service.setOwnershipPrincipalRevokedListener(listener);
      const first = await service.preparePaneConfig({
        paneId: "pane-restart",
        port: 45454,
        tier: "core",
      });
      const firstPrincipal = service.getOwnershipPrincipalForToken(first.token);

      const second = await service.preparePaneConfig({
        paneId: "pane-restart",
        port: 45454,
        tier: "core",
      });

      expect(listener).toHaveBeenCalledExactlyOnceWith(firstPrincipal);
      const secondPrincipal = service.getOwnershipPrincipalForToken(second.token);
      expect(secondPrincipal).toEqual(expect.any(String));
      expect(secondPrincipal).not.toBe(firstPrincipal);
    });

    it("revokes every pane's principal on revokeAll", async () => {
      const listener = vi.fn<(principal: string) => void>();
      service.setOwnershipPrincipalRevokedListener(listener);
      const a = await service.preparePaneConfig({ paneId: "pane-a", port: 45454, tier: "core" });
      const b = await service.preparePaneConfig({ paneId: "pane-b", port: 45454, tier: "full" });
      const principals = [a.token, b.token].map((t) => service.getOwnershipPrincipalForToken(t));

      await service.revokeAll();

      expect(listener.mock.calls.map(([principal]) => principal).sort()).toEqual(
        [...principals].sort()
      );
    });

    it("does not notify for a pane that holds no bearer", async () => {
      const listener = vi.fn<(principal: string) => void>();
      service.setOwnershipPrincipalRevokedListener(listener);

      await service.revokePaneConfig("pane-never-prepared");

      expect(listener).not.toHaveBeenCalled();
    });

    it("finishes revoking when the listener throws", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      service.setOwnershipPrincipalRevokedListener(() => {
        throw new Error("ledger unavailable");
      });
      const { token, configPath } = await service.preparePaneConfig({
        paneId: "pane-throw",
        port: 45454,
        tier: "core",
      });

      await service.revokePaneConfig("pane-throw");

      expect(service.isValidPaneToken(token)).toBe(false);
      await expect(fs.stat(configPath!)).rejects.toMatchObject({ code: "ENOENT" });
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });

  it("revokeAll clears all tokens and files", async () => {
    const a = await service.preparePaneConfig({
      paneId: "pane-a",
      port: 45454,
      tier: "core",
    });
    const b = await service.preparePaneConfig({
      paneId: "pane-b",
      port: 45454,
      tier: "full",
    });

    expect(service.isValidPaneToken(a.token)).toBe(true);
    expect(service.isValidPaneToken(b.token)).toBe(true);

    await service.revokeAll();

    expect(service.isValidPaneToken(a.token)).toBe(false);
    expect(service.isValidPaneToken(b.token)).toBe(false);
    await expect(fs.stat(a.configPath!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(b.configPath!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  describe("plugin MCP servers", () => {
    let grants: PluginMcpGrantRegistry;

    beforeEach(() => {
      grants = new PluginMcpGrantRegistry();
      service = new McpPaneConfigService(grants);
    });

    const ledger: PanePluginServer = {
      pluginInstanceId: "acme.ledger",
      serverKey: "daintree-ledger",
      scope: { databases: true, pluginEndpointId: "data" },
    };

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
        plugin: { projectId: PROJECT_A, servers: [ledger], launchAgentIdHint: "claude" },
      });

      expect(prepared).not.toBeNull();
      expect(prepared!.token).toBeNull();
      const servers = await readServers(prepared!.configPath!);
      expect(Object.keys(servers)).toEqual(prepared!.pluginServerKeys);
      expect(servers.daintree).toBeUndefined();

      const [grant] = grants.listForTerminal("pane-plugin-off");
      expect(grant.projectId).toBe(PROJECT_A);
      expect(grant.launchAgentIdHint).toBe("claude");
      // Nothing about the plugin grant is valid on the orchestration surface.
      expect(service.isValidPaneToken(bearerOf(Object.values(servers)[0]))).toBe(false);
    });

    it("hands Codex its servers as -c overrides and env bearers, writing no file", async () => {
      const prepared = await service.preparePaneConfig({
        paneId: "pane-codex",
        port: 45454,
        tier: "core",
        plugin: { projectId: PROJECT_A, servers: [ledger], launchAgentIdHint: "codex" },
        injection: { format: "codex-config-overrides" },
      });

      expect(prepared!.configPath).toBeNull();
      await expect(
        fs.stat(path.join(testUserData, "mcp-pane-configs", "pane-codex.json"))
      ).rejects.toMatchObject({ code: "ENOENT" });
      const [key] = prepared!.pluginServerKeys;
      expect(prepared!.args).toEqual([
        "-c",
        'mcp_servers.daintree.url="http://127.0.0.1:45454/mcp"',
        "-c",
        'mcp_servers.daintree.bearer_token_env_var="DAINTREE_MCP_TOKEN"',
        // Only Daintree's own server can hold a call open on the approval dialog.
        "-c",
        `mcp_servers.daintree.tool_timeout_sec=${Math.ceil(MCP_CONFIRMABLE_CALL_MAX_MS / 1_000)}`,
        "-c",
        `mcp_servers.${key}.url="http://127.0.0.1:45454${pluginMcpRoutePath("acme.ledger")}"`,
        "-c",
        `mcp_servers.${key}.bearer_token_env_var="DAINTREE_PLUGIN_MCP_TOKEN_1"`,
      ]);
      expect(prepared!.env.DAINTREE_MCP_TOKEN).toBe(prepared!.token);
      expect(service.isValidPaneToken(prepared!.env.DAINTREE_MCP_TOKEN)).toBe(true);
      expect(grants.authenticate(prepared!.env.DAINTREE_PLUGIN_MCP_TOKEN_1)?.scope).toEqual(
        ledger.scope
      );

      await service.revokePaneConfig("pane-codex");
      expect(service.isValidPaneToken(prepared!.env.DAINTREE_MCP_TOKEN)).toBe(false);
      expect(grants.authenticate(prepared!.env.DAINTREE_PLUGIN_MCP_TOKEN_1)).toBeNull();
    });

    it("switches a relaunched pane between file and env formats, leaving only the new wiring live", async () => {
      const claude = await service.preparePaneConfig({
        paneId: "pane-switch",
        port: 45454,
        tier: "off",
        plugin: { projectId: PROJECT_A, servers: [ledger] },
      });
      const claudeBearer = bearerOf(Object.values(await readServers(claude!.configPath!))[0]);

      const codex = await service.preparePaneConfig({
        paneId: "pane-switch",
        port: 45454,
        tier: "off",
        plugin: { projectId: PROJECT_A, servers: [ledger] },
        injection: { format: "codex-config-overrides" },
      });
      expect(grants.authenticate(claudeBearer)).toBeNull();
      await expect(fs.stat(claude!.configPath!)).rejects.toMatchObject({ code: "ENOENT" });
      const codexBearer = codex!.env.DAINTREE_PLUGIN_MCP_TOKEN_1;
      expect(grants.authenticate(codexBearer)?.scope).toEqual(ledger.scope);

      const again = await service.preparePaneConfig({
        paneId: "pane-switch",
        port: 45454,
        tier: "off",
        plugin: { projectId: PROJECT_A, servers: [ledger] },
      });
      expect(grants.authenticate(codexBearer)).toBeNull();
      expect(grants.listForTerminal("pane-switch")).toHaveLength(1);
      await expect(fs.stat(again!.configPath!)).resolves.toBeDefined();
    });

    it("records a relaunch's revocation apart from the pane's exit", async () => {
      const first = await service.preparePaneConfig({
        paneId: "pane-reasons",
        port: 45454,
        tier: "off",
        plugin: { projectId: PROJECT_A, servers: [ledger] },
      });
      const firstBearer = bearerOf(Object.values(await readServers(first!.configPath!))[0]);

      const second = await service.preparePaneConfig({
        paneId: "pane-reasons",
        port: 45454,
        tier: "off",
        plugin: { projectId: PROJECT_A, servers: [ledger] },
      });
      const secondBearer = bearerOf(Object.values(await readServers(second!.configPath!))[0]);
      expect(grants.describeRevoked(firstBearer)?.reason).toBe("relaunched");

      await service.revokePaneConfig("pane-reasons");
      expect(grants.describeRevoked(secondBearer)?.reason).toBe("terminal-exited");
    });

    it("mints nothing when the configuration a format would replace cannot be carried forward", async () => {
      await fs.mkdir(testUserData, { recursive: true });
      const broken = path.join(testUserData, "broken-defaults.json");
      await fs.writeFile(broken, "{ not json");

      await expect(
        service.preparePaneConfig({
          paneId: "pane-broken-base",
          port: 45454,
          tier: "core",
          plugin: { projectId: PROJECT_A, servers: [ledger] },
          injection: {
            format: "gemini-system-defaults",
            envVar: "GEMINI_CLI_SYSTEM_DEFAULTS_PATH",
          },
          inheritedEnv: { GEMINI_CLI_SYSTEM_DEFAULTS_PATH: broken },
        })
      ).rejects.toThrow(/cannot parse/);
      expect(grants.listForTerminal("pane-broken-base")).toEqual([]);
      expect(service.getOrchestratorPane("pane-broken-base")).toBeNull();
    });

    it("writes Gemini's settings file and names it in the env, carrying an admin's defaults forward", async () => {
      const adminDefaults = path.join(testUserData, "admin-defaults.json");
      await fs.mkdir(testUserData, { recursive: true });
      await fs.writeFile(adminDefaults, JSON.stringify({ general: { vimMode: true } }));

      const prepared = await service.preparePaneConfig({
        paneId: "pane-gemini",
        port: 45454,
        tier: "off",
        plugin: { projectId: PROJECT_A, servers: [ledger] },
        injection: { format: "gemini-system-defaults", envVar: "GEMINI_CLI_SYSTEM_DEFAULTS_PATH" },
        inheritedEnv: { GEMINI_CLI_SYSTEM_DEFAULTS_PATH: adminDefaults },
      });

      expect(prepared!.args).toEqual([]);
      expect(prepared!.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH).toBe(prepared!.configPath);
      const written = JSON.parse(await fs.readFile(prepared!.configPath!, "utf-8"));
      expect(written.general).toEqual({ vimMode: true });
      const entry = written.mcpServers[prepared!.pluginServerKeys[0]];
      expect(entry.type).toBe("http");
      expect(grants.authenticate(bearerOf(entry))?.scope).toEqual(ledger.scope);
      // Windows does not report POSIX file mode bits; the dedicated mode test
      // covers this guarantee on platforms that support it.
      if (process.platform !== "win32") {
        expect((await fs.stat(prepared!.configPath!)).mode & 0o777).toBe(0o600);
      }
    });

    it("a non-off tier keeps the Daintree entry and pane token, with the plugin entries alongside", async () => {
      const prepared = await service.preparePaneConfig({
        paneId: "pane-plugin-core",
        port: 45454,
        tier: "core",
        plugin: { projectId: PROJECT_A, servers: [ledger] },
      });

      const servers = await readServers(prepared!.configPath!);
      expect(servers.daintree.headers.Authorization).toBe(`Bearer ${prepared!.token}`);
      expect(service.getTierForToken(prepared!.token!)).toBe("core");
      expect(prepared!.pluginServerKeys).toHaveLength(1);
      expect(prepared!.pluginServerKeys[0]).not.toBe("daintree");
      expect(Object.keys(servers).sort()).toEqual(
        ["daintree", ...prepared!.pluginServerKeys].sort()
      );
    });

    it("writes a Streamable HTTP entry under its server key at the plugin's route with a literal bearer the registry accepts", async () => {
      const prepared = await service.preparePaneConfig({
        paneId: "pane-plugin-entry",
        port: 45460,
        tier: "off",
        plugin: { projectId: PROJECT_A, servers: [ledger] },
      });

      expect(prepared!.pluginServerKeys).toEqual(["daintree-ledger"]);
      const entry = (await readServers(prepared!.configPath!))["daintree-ledger"];
      expect(entry.type).toBe("http");
      expect(entry.url).toBe("http://127.0.0.1:45460/mcp/plugin/acme.ledger");
      expect(entry.headers.Authorization).not.toContain("${");
      const grant = grants.authenticate(bearerOf(entry));
      expect(grant).toMatchObject({
        pluginInstanceId: "acme.ledger",
        scope: { databases: true, pluginEndpointId: "data" },
        serverName: "daintree-ledger",
        projectId: PROJECT_A,
        terminalId: "pane-plugin-entry",
      });
    });

    it("skips a plugin the registry refuses and returns null when nothing is left to write", async () => {
      const foreign: PanePluginServer = {
        ...ledger,
        pluginInstanceId: makeProjectPluginInstanceKey(PROJECT_B, "acme.ledger"),
        serverKey: "daintree-ledger-1a2b3c4d",
      };

      const skipped = await service.preparePaneConfig({
        paneId: "pane-plugin-foreign",
        port: 45454,
        tier: "off",
        plugin: { projectId: PROJECT_A, servers: [foreign] },
      });
      expect(skipped).toBeNull();
      await expect(
        fs.stat(path.join(testUserData, "mcp-pane-configs", "pane-plugin-foreign.json"))
      ).rejects.toMatchObject({ code: "ENOENT" });

      const mixed = await service.preparePaneConfig({
        paneId: "pane-plugin-mixed",
        port: 45454,
        tier: "off",
        plugin: { projectId: PROJECT_A, servers: [foreign, ledger] },
      });
      expect(mixed!.pluginServerKeys).toHaveLength(1);
      expect(grants.listForTerminal("pane-plugin-mixed").map((g) => g.pluginInstanceId)).toEqual([
        "acme.ledger",
      ]);
    });

    it("mints one grant per plugin, each reaching only its own scope", async () => {
      const crm: PanePluginServer = {
        pluginInstanceId: "acme.crm",
        serverKey: "daintree-crm",
        scope: { databases: true },
      };
      const tasks: PanePluginServer = {
        pluginInstanceId: makeProjectPluginInstanceKey(PROJECT_A, "acme.tasks"),
        serverKey: "daintree-tasks",
        scope: { databases: false, pluginEndpointId: "board" },
      };

      const prepared = await service.preparePaneConfig({
        paneId: "pane-plugin-many",
        port: 45454,
        tier: "off",
        plugin: { projectId: PROJECT_A, servers: [ledger, crm, tasks] },
      });

      expect(prepared!.pluginServerKeys).toEqual([
        "daintree-ledger",
        "daintree-crm",
        "daintree-tasks",
      ]);
      const servers = await readServers(prepared!.configPath!);
      expect(servers["daintree-tasks"].url).toBe(
        `http://127.0.0.1:45454/mcp/plugin/${encodeURIComponent(tasks.pluginInstanceId)}`
      );
      for (const server of [ledger, crm, tasks]) {
        const grant = grants.authenticate(bearerOf(servers[server.serverKey]));
        expect(grant).toMatchObject({
          pluginInstanceId: server.pluginInstanceId,
          scope: server.scope,
          serverName: server.serverKey,
        });
      }
      expect(grants.listForTerminal("pane-plugin-many")).toHaveLength(3);
    });

    it("skips a second server for the same plugin, a key already taken, and the Daintree key", async () => {
      const prepared = await service.preparePaneConfig({
        paneId: "pane-plugin-dupes",
        port: 45454,
        tier: "core",
        plugin: {
          projectId: PROJECT_A,
          servers: [
            ledger,
            { ...ledger, serverKey: "daintree-ledger-2" },
            {
              pluginInstanceId: "acme.crm",
              serverKey: "daintree-ledger",
              scope: { databases: true },
            },
            { pluginInstanceId: "acme.tasks", serverKey: "daintree", scope: { databases: true } },
          ],
        },
      });

      expect(prepared!.pluginServerKeys).toEqual(["daintree-ledger"]);
      const servers = await readServers(prepared!.configPath!);
      expect(Object.keys(servers).sort()).toEqual(["daintree", "daintree-ledger"]);
      expect(servers.daintree.headers.Authorization).toBe(`Bearer ${prepared!.token}`);
      expect(grants.listForTerminal("pane-plugin-dupes").map((g) => g.pluginInstanceId)).toEqual([
        "acme.ledger",
      ]);
    });

    it("mints nothing for a server whose scope reaches no tools", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const prepared = await service.preparePaneConfig({
        paneId: "pane-plugin-empty-scope",
        port: 45454,
        tier: "core",
        plugin: {
          projectId: PROJECT_A,
          servers: [{ ...ledger, scope: { databases: false } }],
        },
      });
      warn.mockRestore();

      expect(prepared!.pluginServerKeys).toEqual([]);
      expect(grants.listForTerminal("pane-plugin-empty-scope")).toEqual([]);
    });

    it("revokePaneConfig revokes the pane's grants", async () => {
      const prepared = await service.preparePaneConfig({
        paneId: "pane-plugin-revoke",
        port: 45454,
        tier: "core",
        plugin: { projectId: PROJECT_A, servers: [ledger] },
      });
      const bearer = bearerOf(
        (await readServers(prepared!.configPath!))[prepared!.pluginServerKeys[0]]
      );

      await service.revokePaneConfig("pane-plugin-revoke");

      expect(grants.authenticate(bearer)).toBeNull();
      expect(grants.listForTerminal("pane-plugin-revoke")).toEqual([]);
    });

    it("revokePaneConfig revokes a terminal's grants even when the pane has no record", async () => {
      grants.issue({
        pluginInstanceId: "acme.ledger",
        scope: ledger.scope,
        serverName: ledger.serverKey,
        projectId: PROJECT_A,
        terminalId: "pane-without-record",
      });

      await service.revokePaneConfig("pane-without-record");

      expect(grants.listForTerminal("pane-without-record")).toEqual([]);
    });

    it("revokeAll revokes every grant it minted", async () => {
      await service.preparePaneConfig({
        paneId: "pane-plugin-all-a",
        port: 45454,
        tier: "off",
        plugin: { projectId: PROJECT_A, servers: [ledger] },
      });
      await service.preparePaneConfig({
        paneId: "pane-plugin-all-b",
        port: 45454,
        tier: "full",
        plugin: { projectId: PROJECT_A, servers: [ledger] },
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
          plugin: { projectId: PROJECT_A, servers: [ledger] },
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
        tier: "core",
        plugin: { projectId: PROJECT_A, servers: [ledger] },
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
        tier: "core",
      });
      await vi.waitFor(() => expect(writeStarted).toBe(true));
      await service.revokePaneConfig("pane-late-exit-daintree");
      gate.resolve();

      const prepared = await pending;
      expect(service.isValidPaneToken(prepared.token)).toBe(true);
      await expect(fs.stat(prepared.configPath!)).resolves.toBeDefined();
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
        tier: "core",
        plugin: { projectId: PROJECT_A, servers: [ledger] },
      });
      await vi.waitFor(() => expect(olderWriteStarted).toBe(true));
      const newerPending = service.preparePaneConfig({
        paneId: "pane-plugin-overlap",
        port: 45454,
        tier: "core",
        plugin: { projectId: PROJECT_A, servers: [ledger] },
      });

      // The older one finishes its write after the newer was requested; the
      // newer then revokes it and writes last. The newer starts as soon as the
      // older settles and unlinks the shared path, so the older file is read
      // from the recorded write, never from disk.
      olderGate.resolve();
      const olderPrepared = await older;
      const newer = await newerPending;

      expect(writeControl.written.map((w) => w.path)).toEqual([
        olderPrepared!.configPath,
        newer!.configPath,
      ]);
      const olderServers = JSON.parse(writeControl.written[0].data).mcpServers;
      const olderBearer = bearerOf(olderServers[olderPrepared!.pluginServerKeys[0]]);
      const onDisk = await fs.readFile(newer!.configPath!, "utf-8");
      expect(onDisk).toBe(writeControl.written[1].data);
      const newerBearer = bearerOf(JSON.parse(onDisk).mcpServers[newer!.pluginServerKeys[0]]);

      expect(newerBearer).not.toBe(olderBearer);
      expect(grants.authenticate(olderBearer)).toBeNull();
      expect(grants.authenticate(newerBearer)).not.toBeNull();
      expect(service.isValidPaneToken(olderPrepared!.token!)).toBe(false);
      expect(service.isValidPaneToken(newer!.token!)).toBe(true);
    });

    it("asks about each server on its own, minting the eligible ones", async () => {
      const crm: PanePluginServer = {
        pluginInstanceId: "acme.crm",
        serverKey: "daintree-crm",
        scope: { databases: true },
      };
      const isEligible = vi.fn(
        (server: PanePluginServer) => server.pluginInstanceId === "acme.crm"
      );

      const prepared = await service.preparePaneConfig({
        paneId: "pane-plugin-partly-eligible",
        port: 45454,
        tier: "off",
        plugin: { projectId: PROJECT_A, servers: [ledger, crm], isEligible },
      });

      expect(isEligible.mock.calls.map(([server]) => server)).toEqual([ledger, crm]);
      expect(prepared!.pluginServerKeys).toEqual(["daintree-crm"]);
      expect(grants.listForTerminal("pane-plugin-partly-eligible")).toEqual([
        expect.objectContaining({ pluginInstanceId: "acme.crm", scope: { databases: true } }),
      ]);
    });

    it('still rejects tier "off" with no plugin servers', async () => {
      await expect(
        service.preparePaneConfig({
          paneId: "pane-plugin-empty",
          port: 45454,
          tier: "off",
          plugin: { projectId: PROJECT_A, servers: [] },
        })
      ).rejects.toThrow(/should not be called with tier "off"/);
    });

    it("re-preparing the same pane revokes the previous launch's grants", async () => {
      const first = await service.preparePaneConfig({
        paneId: "pane-plugin-restart",
        port: 45454,
        tier: "off",
        plugin: { projectId: PROJECT_A, servers: [ledger] },
      });
      const firstBearer = bearerOf(
        (await readServers(first!.configPath!))[first!.pluginServerKeys[0]]
      );

      await service.preparePaneConfig({
        paneId: "pane-plugin-restart",
        port: 45454,
        tier: "off",
        plugin: { projectId: PROJECT_A, servers: [ledger] },
      });

      expect(grants.authenticate(firstBearer)).toBeNull();
      expect(grants.listForTerminal("pane-plugin-restart")).toHaveLength(1);
    });
  });

  describe("Decisions server (#16012)", () => {
    let grants: PluginMcpGrantRegistry;

    beforeEach(() => {
      grants = new PluginMcpGrantRegistry();
      service = new McpPaneConfigService(grants);
    });

    const ledger: PanePluginServer = {
      pluginInstanceId: "acme.ledger",
      serverKey: "daintree-ledger",
      scope: { databases: true, pluginEndpointId: "data" },
    };
    const DECISIONS = { workspaceId: PROJECT_A };
    const CODEX = { format: "codex-config-overrides" } as const;

    async function readServers(configPath: string) {
      const parsed = JSON.parse(await fs.readFile(configPath, "utf-8"));
      return parsed.mcpServers as Record<
        string,
        { type: string; url: string; headers: { Authorization: string } }
      >;
    }

    function codexArgsFor(args: readonly string[], key: string): string[] {
      return args.filter((arg) => arg.startsWith(`mcp_servers.${key}.`));
    }

    it('gives a tier "off" Claude launch only the Decisions entry, with a bearer the control surface refuses', async () => {
      const prepared = await service.preparePaneConfig({
        paneId: "pane-dec-off",
        port: 45454,
        tier: "off",
        decisions: DECISIONS,
      });

      expect(prepared.token).toBeNull();
      expect(prepared.pluginServerKeys).toEqual([]);
      const servers = await readServers(prepared.configPath!);
      expect(Object.keys(servers)).toEqual(["daintree-decisions"]);
      expect(servers["daintree-decisions"]).toEqual({
        type: "http",
        url: "http://127.0.0.1:45454/mcp/decisions",
        headers: { Authorization: `Bearer ${prepared.decisionsToken}` },
      });

      const bearer = prepared.decisionsToken!;
      expect(service.getDecisionsBearerForToken(bearer)).toEqual({
        paneId: "pane-dec-off",
        principal: service.getDecisionsPrincipal("pane-dec-off"),
        workspaceId: PROJECT_A,
      });
      expect(service.getDecisionsPrincipal("pane-dec-off")).toMatch(/^[0-9a-f-]{36}$/);
      // Nothing on the control surface or the orchestration hand-over knows it.
      expect(service.isValidPaneToken(bearer)).toBe(false);
      expect(service.getTierForToken(bearer)).toBeUndefined();
      expect(service.getPaneIdForToken(bearer)).toBeNull();
      expect(service.getOwnershipPrincipalForToken(bearer)).toBeNull();
      expect(service.getOrchestratorPane("pane-dec-off")).toBeNull();
      expect(service.listOrchestratorPanes()).toEqual([]);
      // Nor does any plugin route.
      expect(grants.authenticate(bearer)).toBeNull();
    });

    it('gives a tier "off" Codex launch the Decisions override, its bearer in the env and never in argv', async () => {
      const prepared = await service.preparePaneConfig({
        paneId: "pane-dec-codex-off",
        port: 45454,
        tier: "off",
        decisions: DECISIONS,
        injection: CODEX,
      });

      expect(prepared.configPath).toBeNull();
      expect(prepared.token).toBeNull();
      expect(prepared.args).toEqual([
        "-c",
        'mcp_servers.daintree-decisions.url="http://127.0.0.1:45454/mcp/decisions"',
        "-c",
        'mcp_servers.daintree-decisions.bearer_token_env_var="DAINTREE_DECISIONS_MCP_TOKEN"',
      ]);
      expect(prepared.env).toEqual({ DAINTREE_DECISIONS_MCP_TOKEN: prepared.decisionsToken });
      expect(prepared.args.join(" ")).not.toContain(prepared.decisionsToken!);
    });

    it("gives a tier-on launch both entries, with distinct bearers under one principal", async () => {
      const prepared = await service.preparePaneConfig({
        paneId: "pane-dec-core",
        port: 45454,
        tier: "core",
        decisions: DECISIONS,
      });

      const servers = await readServers(prepared.configPath!);
      expect(Object.keys(servers)).toEqual(["daintree", "daintree-decisions"]);
      expect(bearerOf(servers.daintree)).toBe(prepared.token);
      expect(bearerOf(servers["daintree-decisions"])).toBe(prepared.decisionsToken);
      expect(prepared.decisionsToken).not.toBe(prepared.token);

      // Each bearer opens its own route and nothing else.
      expect(service.getTierForToken(prepared.token!)).toBe("core");
      expect(service.getDecisionsBearerForToken(prepared.token!)).toBeNull();
      expect(service.isValidPaneToken(prepared.decisionsToken!)).toBe(false);
      // A question asked through one belongs to the run the other acts for.
      expect(service.getDecisionsPrincipal("pane-dec-core")).toBe(
        service.getOwnershipPrincipalForToken(prepared.token!)
      );
      expect(service.getOrchestratorPane("pane-dec-core")?.principalId).toBe(
        service.getDecisionsPrincipal("pane-dec-core")
      );
    });

    it("gives a tier-on Codex launch both overrides, the long timeout only on Daintree's own", async () => {
      const prepared = await service.preparePaneConfig({
        paneId: "pane-dec-codex-full",
        port: 45454,
        tier: "full",
        decisions: DECISIONS,
        injection: CODEX,
      });

      expect(codexArgsFor(prepared.args, "daintree")).toEqual([
        'mcp_servers.daintree.url="http://127.0.0.1:45454/mcp"',
        'mcp_servers.daintree.bearer_token_env_var="DAINTREE_MCP_TOKEN"',
        `mcp_servers.daintree.tool_timeout_sec=${Math.ceil(MCP_CONFIRMABLE_CALL_MAX_MS / 1_000)}`,
      ]);
      expect(codexArgsFor(prepared.args, "daintree-decisions")).toEqual([
        'mcp_servers.daintree-decisions.url="http://127.0.0.1:45454/mcp/decisions"',
        'mcp_servers.daintree-decisions.bearer_token_env_var="DAINTREE_DECISIONS_MCP_TOKEN"',
      ]);
      expect(prepared.env).toEqual({
        DAINTREE_MCP_TOKEN: prepared.token,
        DAINTREE_DECISIONS_MCP_TOKEN: prepared.decisionsToken,
      });
    });

    it("gives a plugin-granted pane its plugin entry and the Decisions entry, each bearer for its own route", async () => {
      const prepared = await service.preparePaneConfig({
        paneId: "pane-dec-plugin",
        port: 45454,
        tier: "off",
        plugin: { projectId: PROJECT_A, servers: [ledger], launchAgentIdHint: "claude" },
        decisions: DECISIONS,
      });

      expect(prepared.token).toBeNull();
      const servers = await readServers(prepared.configPath!);
      expect(Object.keys(servers)).toEqual(["daintree-ledger", "daintree-decisions"]);
      const pluginBearer = bearerOf(servers["daintree-ledger"]);
      expect(grants.authenticate(pluginBearer)?.terminalId).toBe("pane-dec-plugin");
      expect(service.getDecisionsBearerForToken(pluginBearer)).toBeNull();
      expect(grants.authenticate(prepared.decisionsToken!)).toBeNull();
      expect(service.getDecisionsBearerForToken(prepared.decisionsToken!)?.paneId).toBe(
        "pane-dec-plugin"
      );
    });

    it("gives a plugin-granted Codex pane the plugin and Decisions overrides with their own env bearers", async () => {
      const prepared = await service.preparePaneConfig({
        paneId: "pane-dec-plugin-codex",
        port: 45454,
        tier: "off",
        plugin: { projectId: PROJECT_A, servers: [ledger], launchAgentIdHint: "codex" },
        decisions: DECISIONS,
        injection: CODEX,
      });

      expect(codexArgsFor(prepared.args, "daintree-ledger")).toHaveLength(2);
      expect(codexArgsFor(prepared.args, "daintree-decisions")).toHaveLength(2);
      expect(Object.keys(prepared.env).sort()).toEqual([
        "DAINTREE_DECISIONS_MCP_TOKEN",
        "DAINTREE_PLUGIN_MCP_TOKEN_1",
      ]);
    });

    it("still prepares the Decisions entry when every plugin grant is refused", async () => {
      const prepared = await service.preparePaneConfig({
        paneId: "pane-dec-refused",
        port: 45454,
        tier: "off",
        plugin: { projectId: PROJECT_A, servers: [ledger], isEligible: () => false },
        decisions: DECISIONS,
      });

      expect(prepared.pluginServerKeys).toEqual([]);
      expect(Object.keys(await readServers(prepared.configPath!))).toEqual(["daintree-decisions"]);
    });

    it("leaves a launch without Decisions exactly as it was: no entry, no bearer, no env", async () => {
      const claude = await service.preparePaneConfig({
        paneId: "pane-no-dec",
        port: 45454,
        tier: "core",
      });
      const codex = await service.preparePaneConfig({
        paneId: "pane-no-dec-codex",
        port: 45454,
        tier: "core",
        injection: CODEX,
      });

      expect(claude.decisionsToken).toBeNull();
      expect(Object.keys(await readServers(claude.configPath!))).toEqual(["daintree"]);
      expect(codex.args.some((arg) => arg.includes("decisions"))).toBe(false);
      expect(Object.keys(codex.env)).toEqual(["DAINTREE_MCP_TOKEN"]);
      expect(service.getDecisionsPrincipal("pane-no-dec")).toBeNull();
      await expect(
        service.preparePaneConfig({ paneId: "pane-none", port: 45454, tier: "off" })
      ).rejects.toThrow(/should not be called with tier "off"/);
    });

    it("revokes the Decisions bearer with the pane, telling the listener its principal once", async () => {
      const revoked: string[] = [];
      service.setOwnershipPrincipalRevokedListener((principal) => revoked.push(principal));
      const off = await service.preparePaneConfig({
        paneId: "pane-dec-revoke-off",
        port: 45454,
        tier: "off",
        decisions: DECISIONS,
      });
      const both = await service.preparePaneConfig({
        paneId: "pane-dec-revoke-both",
        port: 45454,
        tier: "core",
        decisions: DECISIONS,
      });
      const offPrincipal = service.getDecisionsPrincipal("pane-dec-revoke-off");
      const bothPrincipal = service.getDecisionsPrincipal("pane-dec-revoke-both");

      await service.revokePaneConfig("pane-dec-revoke-off");
      await service.revokePaneConfig("pane-dec-revoke-both");

      expect(revoked).toEqual([offPrincipal, bothPrincipal]);
      expect(service.getDecisionsBearerForToken(off.decisionsToken!)).toBeNull();
      expect(service.getDecisionsBearerForToken(both.decisionsToken!)).toBeNull();
      expect(service.getDecisionsPrincipal("pane-dec-revoke-off")).toBeNull();
      expect(service.isValidPaneToken(both.token!)).toBe(false);
      await expect(fs.stat(off.configPath!)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("rotates the Decisions bearer and principal on a relaunch", async () => {
      const first = await service.preparePaneConfig({
        paneId: "pane-dec-relaunch",
        port: 45454,
        tier: "off",
        decisions: DECISIONS,
      });
      const firstPrincipal = service.getDecisionsPrincipal("pane-dec-relaunch");
      const second = await service.preparePaneConfig({
        paneId: "pane-dec-relaunch",
        port: 45454,
        tier: "off",
        decisions: DECISIONS,
      });

      expect(service.getDecisionsBearerForToken(first.decisionsToken!)).toBeNull();
      expect(service.getDecisionsBearerForToken(second.decisionsToken!)?.paneId).toBe(
        "pane-dec-relaunch"
      );
      expect(service.getDecisionsPrincipal("pane-dec-relaunch")).not.toBe(firstPrincipal);
    });

    it("registers no Decisions bearer when the file can't be written", async () => {
      writeControl.error = new Error("EIO");
      await expect(
        service.preparePaneConfig({
          paneId: "pane-dec-write-fail",
          port: 45454,
          tier: "off",
          decisions: DECISIONS,
        })
      ).rejects.toThrow("EIO");
      expect(service.getDecisionsPrincipal("pane-dec-write-fail")).toBeNull();
    });

    it("keeps the Decisions bearer off the control surface's authorisation", async () => {
      const prepared = await mcpPaneConfigService.preparePaneConfig({
        paneId: "pane-dec-auth",
        port: 45454,
        tier: "core",
        decisions: DECISIONS,
      });
      const apiKeyHash = createHash("sha256").update("Bearer api-key").digest();
      try {
        expect(isAuthorized(`Bearer ${prepared.token}`, apiKeyHash, null)).toBe(true);
        expect(isAuthorized(`Bearer ${prepared.decisionsToken}`, apiKeyHash, null)).toBe(false);
        expect(resolveTokenTier(`Bearer ${prepared.token}`, apiKeyHash, null)).toBe("core");
      } finally {
        await mcpPaneConfigService.revokePaneConfig("pane-dec-auth");
      }
    });
  });
});
