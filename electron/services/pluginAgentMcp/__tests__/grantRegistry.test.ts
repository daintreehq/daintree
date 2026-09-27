import { describe, expect, it, vi } from "vitest";
import { makeProjectPluginInstanceKey } from "../../../../shared/types/plugin.js";
import { PluginMcpGrantRegistry } from "../grantRegistry.js";

const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);

function issue(
  registry: PluginMcpGrantRegistry,
  overrides: Partial<Parameters<PluginMcpGrantRegistry["issue"]>[0]> = {}
) {
  return registry.issue({
    pluginInstanceId: "acme.ledger",
    scope: { databases: false, pluginEndpointId: "data" },
    serverName: "daintree-ledger",
    projectId: PROJECT_A,
    terminalId: "term-1",
    ...overrides,
  });
}

describe("PluginMcpGrantRegistry", () => {
  it("authenticates the issued bearer and nothing else", () => {
    const registry = new PluginMcpGrantRegistry();
    const { grant, token } = issue(registry);

    expect(registry.authenticate(token)).toBe(grant);
    expect(registry.authenticate(`${token}x`)).toBeNull();
    expect(registry.authenticate("")).toBeNull();
  });

  it("keeps only a digest of the bearer on the grant", () => {
    const registry = new PluginMcpGrantRegistry();
    const { grant, token } = issue(registry);

    expect(JSON.stringify(grant)).not.toContain(token);
    expect(grant.credentialId).not.toBe(token);
  });

  it("mints a distinct 256-bit bearer and credential id per grant", () => {
    const registry = new PluginMcpGrantRegistry();
    const first = issue(registry);
    const second = issue(registry);

    expect(first.token).not.toBe(second.token);
    expect(first.grant.credentialId).not.toBe(second.grant.credentialId);
    expect(Buffer.from(first.token, "base64url")).toHaveLength(32);
  });

  it("revokes a terminal's grants without touching another terminal's", () => {
    const registry = new PluginMcpGrantRegistry();
    const mine = issue(registry, { terminalId: "term-1" });
    const theirs = issue(registry, { terminalId: "term-2" });

    const revoked = registry.revokeTerminal("term-1");

    expect(revoked.map((g) => g.credentialId)).toEqual([mine.grant.credentialId]);
    expect(registry.authenticate(mine.token)).toBeNull();
    expect(registry.authenticate(theirs.token)).toBe(theirs.grant);
  });

  it("revokes by plugin instance, leaving another project's copy of the same plugin alone", () => {
    const registry = new PluginMcpGrantRegistry();
    const instanceA = makeProjectPluginInstanceKey(PROJECT_A, "acme.ledger");
    const instanceB = makeProjectPluginInstanceKey(PROJECT_B, "acme.ledger");
    const a = issue(registry, { pluginInstanceId: instanceA });
    const b = issue(registry, { pluginInstanceId: instanceB, projectId: PROJECT_B });

    registry.revokePlugin(instanceA);

    expect(registry.authenticate(a.token)).toBeNull();
    expect(registry.authenticate(b.token)).toBe(b.grant);
  });

  it("revokes grants in one project that the check no longer allows, as access-reduced", () => {
    const registry = new PluginMcpGrantRegistry();
    const listener = vi.fn();
    registry.onRevoked(listener);
    const installed = issue(registry, { pluginInstanceId: "acme.ledger" });
    const projectCopy = issue(registry, {
      pluginInstanceId: makeProjectPluginInstanceKey(PROJECT_A, "acme.ledger"),
    });
    const otherProject = issue(registry, { projectId: PROJECT_B });

    const revoked = registry.revokeDisabledInProject(
      PROJECT_A,
      (grant) => grant.pluginInstanceId !== "acme.ledger"
    );

    expect(revoked.map((g) => g.credentialId)).toEqual([installed.grant.credentialId]);
    expect(listener).toHaveBeenCalledWith([installed.grant], "access-reduced");
    expect(registry.authenticate(projectCopy.token)).toBe(projectCopy.grant);
    expect(registry.authenticate(otherProject.token)).toBe(otherProject.grant);
  });

  it("revokes one plugin's disallowed grants across projects, leaving other plugins alone", () => {
    const registry = new PluginMcpGrantRegistry();
    const listener = vi.fn();
    registry.onRevoked(listener);
    const inA = issue(registry, { projectId: PROJECT_A });
    const inB = issue(registry, { projectId: PROJECT_B });
    const kept = issue(registry, { projectId: PROJECT_B, terminalId: "term-keep" });
    const otherPlugin = issue(registry, { pluginInstanceId: "acme.crm" });

    const revoked = registry.revokeDisallowedForPlugin(
      "acme.ledger",
      (grant) => grant.terminalId === "term-keep"
    );

    expect(revoked.map((g) => g.credentialId).sort()).toEqual(
      [inA.grant.credentialId, inB.grant.credentialId].sort()
    );
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][1]).toBe("access-reduced");
    expect(registry.authenticate(kept.token)).toBe(kept.grant);
    expect(registry.authenticate(otherPlugin.token)).toBe(otherPlugin.grant);
  });

  it("freezes the grant and its scope, dropping an absent plugin endpoint", () => {
    const registry = new PluginMcpGrantRegistry();
    const scope = { databases: true, pluginEndpointId: "data" };
    const { grant } = issue(registry, { scope, launchAgentIdHint: "claude" });

    scope.databases = false;
    expect(grant.scope).toEqual({ databases: true, pluginEndpointId: "data" });
    expect(Object.isFrozen(grant)).toBe(true);
    expect(Object.isFrozen(grant.scope)).toBe(true);
    expect(grant.serverName).toBe("daintree-ledger");
    expect(grant.launchAgentIdHint).toBe("claude");

    const { grant: dbOnly } = issue(registry, { scope: { databases: true } });
    expect(dbOnly.scope).toEqual({ databases: true });
    expect(dbOnly.scope).not.toHaveProperty("pluginEndpointId");
    expect(dbOnly).not.toHaveProperty("launchAgentIdHint");
  });

  it("refuses a scope that reaches no tools, and a launch without a terminal", () => {
    const registry = new PluginMcpGrantRegistry();

    expect(() => issue(registry, { scope: { databases: false } })).toThrow(/reaches no tools/);
    expect(() => issue(registry, { scope: { databases: false, pluginEndpointId: "" } })).toThrow(
      /reaches no tools/
    );
    expect(() => issue(registry, { terminalId: "" })).toThrow(/terminal id/);
  });

  it("lists a terminal's grants", () => {
    const registry = new PluginMcpGrantRegistry();
    const mine = issue(registry, { terminalId: "term-1" });
    issue(registry, { terminalId: "term-2" });

    expect(registry.listForTerminal("term-1")).toEqual([mine.grant]);
    expect(registry.get(mine.grant.credentialId)).toBe(mine.grant);
    expect(registry.isLive(mine.grant.credentialId)).toBe(true);
    registry.revokeTerminal("term-1");
    expect(registry.isLive(mine.grant.credentialId)).toBe(false);
    expect(registry.get(mine.grant.credentialId)).toBeNull();
  });

  it("refuses to pair a project plugin instance with another project", () => {
    const registry = new PluginMcpGrantRegistry();

    expect(() =>
      issue(registry, {
        pluginInstanceId: makeProjectPluginInstanceKey(PROJECT_A, "acme.ledger"),
        projectId: PROJECT_B,
      })
    ).toThrow(/different project/);
    expect(() => issue(registry, { projectId: "not-a-project" })).toThrow(/workspace id/);
  });

  it("deletes grants before notifying, and stays quiet when nothing matched", () => {
    const registry = new PluginMcpGrantRegistry();
    const { grant, token } = issue(registry);
    const seen: boolean[] = [];
    const listener = vi.fn(() => {
      seen.push(registry.authenticate(token) === null);
    });
    registry.onRevoked(listener);

    registry.revokeTerminal("no-such-terminal");
    expect(listener).not.toHaveBeenCalled();

    registry.revokeTerminal(grant.terminalId);
    expect(listener).toHaveBeenCalledWith([grant], "terminal-exited");
    expect(seen).toEqual([true]);
  });

  it("keeps revoking when a listener throws", () => {
    const registry = new PluginMcpGrantRegistry();
    const { token } = issue(registry);
    const after = vi.fn();
    registry.onRevoked(() => {
      throw new Error("boom");
    });
    registry.onRevoked(after);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    registry.revokeAll();

    expect(registry.authenticate(token)).toBeNull();
    expect(after).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});
