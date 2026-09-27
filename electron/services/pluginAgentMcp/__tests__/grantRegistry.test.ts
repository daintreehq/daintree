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

  describe("across a reload", () => {
    it("keeps held grants authenticating but held, and keeps them when the surface matches", () => {
      const registry = new PluginMcpGrantRegistry();
      const listener = vi.fn();
      registry.onRevoked(listener);
      const { grant, token } = issue(registry);

      registry.holdPlugin("acme.ledger", "surface-1");
      expect(registry.authenticate(token)).toBe(grant);
      expect(registry.isHeld(grant.credentialId)).toBe(true);

      expect(registry.releasePlugin("acme.ledger", "surface-1")).toEqual([]);
      expect(registry.isHeld(grant.credentialId)).toBe(false);
      expect(registry.authenticate(token)).toBe(grant);
      expect(listener).not.toHaveBeenCalled();
    });

    it("tells kept listeners which grants survived, and nothing on a revoke", () => {
      const registry = new PluginMcpGrantRegistry();
      const kept = vi.fn();
      registry.onKept(kept);
      const { grant } = issue(registry);
      issue(registry, { terminalId: "term-2" });

      registry.holdPlugin("acme.ledger", "surface-1");
      registry.revokeTerminal("term-2");
      registry.releasePlugin("acme.ledger", "surface-1");
      expect(kept).toHaveBeenCalledExactlyOnceWith([grant]);

      registry.holdPlugin("acme.ledger", "surface-1");
      registry.releasePlugin("acme.ledger", "surface-2");
      expect(kept).toHaveBeenCalledTimes(1);
    });

    it("revokes held grants when the reloaded surface differs", () => {
      const registry = new PluginMcpGrantRegistry();
      const listener = vi.fn();
      registry.onRevoked(listener);
      const { grant, token } = issue(registry);

      registry.holdPlugin("acme.ledger", "surface-1");
      const revoked = registry.releasePlugin("acme.ledger", "surface-2");

      expect(revoked).toEqual([grant]);
      expect(registry.authenticate(token)).toBeNull();
      expect(listener).toHaveBeenCalledWith([grant], "plugin-unloaded");
    });

    it("revokes held grants when no generation came back", () => {
      const registry = new PluginMcpGrantRegistry();
      const { token } = issue(registry);

      registry.holdPlugin("acme.ledger", "surface-1");
      registry.releasePlugin("acme.ledger", null);

      expect(registry.authenticate(token)).toBeNull();
    });

    it("judges against the first hold's surface, and a release with nothing held is a no-op", () => {
      const registry = new PluginMcpGrantRegistry();
      const { token } = issue(registry);

      registry.holdPlugin("acme.ledger", "surface-1");
      registry.holdPlugin("acme.ledger", "surface-2");
      registry.releasePlugin("acme.ledger", "surface-2");
      expect(registry.authenticate(token)).toBeNull();

      expect(registry.releasePlugin("acme.ledger", "surface-1")).toEqual([]);
    });

    it("leaves another instance's grants and later grants out of the hold", () => {
      const registry = new PluginMcpGrantRegistry();
      const held = issue(registry);
      const other = issue(registry, { pluginInstanceId: "acme.other" });

      registry.holdPlugin("acme.ledger", "surface-1");
      const later = issue(registry);

      expect(registry.isHeld(held.grant.credentialId)).toBe(true);
      expect(registry.isHeld(other.grant.credentialId)).toBe(false);
      expect(registry.isHeld(later.grant.credentialId)).toBe(false);
      registry.releasePlugin("acme.ledger", null);
      expect(registry.authenticate(held.token)).toBeNull();
      expect(registry.authenticate(later.token)).toBe(later.grant);
      expect(registry.authenticate(other.token)).toBe(other.grant);
    });

    it("drops a revoked grant from the hold", () => {
      const registry = new PluginMcpGrantRegistry();
      const { grant } = issue(registry);

      registry.holdPlugin("acme.ledger", "surface-1");
      registry.revokeTerminal("term-1");

      expect(registry.isHeld(grant.credentialId)).toBe(false);
      expect(registry.releasePlugin("acme.ledger", null)).toEqual([]);
    });

    it("wakes a waiter when the hold is released or its grant revoked, and times out otherwise", async () => {
      const registry = new PluginMcpGrantRegistry();
      const kept = issue(registry);
      const dropped = issue(registry, { terminalId: "term-2" });
      registry.holdPlugin("acme.ledger", "surface-1");

      const keptWait = registry.whenNotHeld(kept.grant.credentialId, 60_000);
      const droppedWait = registry.whenNotHeld(dropped.grant.credentialId, 60_000);
      registry.revokeTerminal("term-2");
      await droppedWait;
      expect(registry.isHeld(kept.grant.credentialId)).toBe(true);

      registry.releasePlugin("acme.ledger", "surface-1");
      await keptWait;
      expect(registry.isLive(kept.grant.credentialId)).toBe(true);

      registry.holdPlugin("acme.ledger", "surface-1");
      await registry.whenNotHeld(kept.grant.credentialId, 5);
      expect(registry.isHeld(kept.grant.credentialId)).toBe(true);
      await expect(registry.whenNotHeld("not-held", 60_000)).resolves.toBeUndefined();
    });

    it("revokeHeld settles only the matching instances' holds, as revoked", () => {
      const registry = new PluginMcpGrantRegistry();
      const mine = issue(registry);
      const theirs = issue(registry, { pluginInstanceId: "acme.other" });
      registry.holdPlugin("acme.ledger", "surface-1");
      registry.holdPlugin("acme.other", "surface-1");

      const revoked = registry.revokeHeld((id) => id === "acme.ledger");

      expect(revoked).toEqual([mine.grant]);
      expect(registry.isHeld(theirs.grant.credentialId)).toBe(true);
    });

    it("stops waiting when the caller's signal aborts", async () => {
      const registry = new PluginMcpGrantRegistry();
      const { grant } = issue(registry);
      registry.holdPlugin("acme.ledger", "surface-1");
      const controller = new AbortController();

      const waiting = registry.whenNotHeld(grant.credentialId, 60_000, controller.signal);
      controller.abort();

      await waiting;
      expect(registry.isHeld(grant.credentialId)).toBe(true);
    });

    it("holds nothing for an instance with no grants", () => {
      const registry = new PluginMcpGrantRegistry();
      registry.holdPlugin("acme.ledger", "surface-1");
      const { grant } = issue(registry);
      expect(registry.isHeld(grant.credentialId)).toBe(false);
    });
  });
});
