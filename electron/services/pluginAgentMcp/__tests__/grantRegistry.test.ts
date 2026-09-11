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
    endpointId: "data",
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

  it("revokes one instance's endpoint in one project, not a same-named copy or another project", () => {
    const registry = new PluginMcpGrantRegistry();
    const installed = issue(registry, { pluginInstanceId: "acme.ledger" });
    const projectCopy = issue(registry, {
      pluginInstanceId: makeProjectPluginInstanceKey(PROJECT_A, "acme.ledger"),
    });
    const otherProject = issue(registry, { projectId: PROJECT_B });
    const otherEndpoint = issue(registry, { endpointId: "reports" });

    const revoked = registry.revokeEndpoint(PROJECT_A, "acme.ledger", "data");

    expect(revoked.map((g) => g.credentialId)).toEqual([installed.grant.credentialId]);
    expect(registry.authenticate(projectCopy.token)).toBe(projectCopy.grant);
    expect(registry.authenticate(otherProject.token)).toBe(otherProject.grant);
    expect(registry.authenticate(otherEndpoint.token)).toBe(otherEndpoint.grant);
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
