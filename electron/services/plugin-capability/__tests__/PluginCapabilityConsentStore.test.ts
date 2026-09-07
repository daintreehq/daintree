import { describe, expect, it, vi } from "vitest";
import { PluginCapabilityConsentStore } from "../PluginCapabilityConsentStore.js";

function makeStore(initial: Record<string, unknown> = {}) {
  let config: Record<string, unknown> = { ...initial };
  const saveConfig = vi.fn((patch: Record<string, unknown>) => {
    config = { ...config, ...patch };
  });
  const store = new PluginCapabilityConsentStore(saveConfig, () => config);
  return { store, saveConfig, getConfig: () => config };
}

describe("PluginCapabilityConsentStore", () => {
  it("reports no grant before one is minted, and a grant after", () => {
    const { store } = makeStore();
    expect(store.hasGrant({ pluginId: "acme.x", capability: "shell:exec" })).toBe(false);
    store.grant({ pluginId: "acme.x", capability: "shell:exec" });
    expect(store.hasGrant({ pluginId: "acme.x", capability: "shell:exec" })).toBe(true);
  });

  it("scopes a grant to its exact (pluginId, capability) pair", () => {
    const { store } = makeStore();
    store.grant({ pluginId: "acme.x", capability: "shell:exec" });
    // Same plugin, different capability — not granted.
    expect(store.hasGrant({ pluginId: "acme.x", capability: "git:write" })).toBe(false);
    // Different plugin, same capability — not granted.
    expect(store.hasGrant({ pluginId: "acme.y", capability: "shell:exec" })).toBe(false);
  });

  it("does not let a separator-bearing pluginId inherit another plugin's grant", () => {
    const { store } = makeStore();
    // JSON-encoded keys, so these two identities must stay distinct even though
    // a naive `::` join of their parts would collide.
    store.grant({ pluginId: "a", capability: "git:write" });
    expect(store.hasGrant({ pluginId: "a", capability: "git:write" })).toBe(true);
    expect(
      store.hasGrant({
        pluginId: 'a","git:write"]',
        capability: "git:write",
      })
    ).toBe(false);
  });

  it("persists grants through the saver and rehydrates them", () => {
    const { store, getConfig } = makeStore();
    store.grant({ pluginId: "acme.x", capability: "fs:project-write" });

    // A fresh store reading the same persisted config sees the grant.
    const reopened = new PluginCapabilityConsentStore(
      () => {},
      () => getConfig()
    );
    expect(reopened.hasGrant({ pluginId: "acme.x", capability: "fs:project-write" })).toBe(true);
  });

  it("revoke drops a single grant and leaves others intact", () => {
    const { store } = makeStore();
    store.grant({ pluginId: "acme.x", capability: "shell:exec" });
    store.grant({ pluginId: "acme.x", capability: "git:write" });
    store.revoke({ pluginId: "acme.x", capability: "shell:exec" });
    expect(store.hasGrant({ pluginId: "acme.x", capability: "shell:exec" })).toBe(false);
    expect(store.hasGrant({ pluginId: "acme.x", capability: "git:write" })).toBe(true);
  });

  it("revokeAllForPlugin removes only that plugin's grants and reports durable", () => {
    const { store } = makeStore();
    store.grant({ pluginId: "acme.x", capability: "shell:exec" });
    store.grant({ pluginId: "acme.x", capability: "git:write" });
    store.grant({ pluginId: "acme.y", capability: "shell:exec" });

    expect(store.revokeAllForPlugin("acme.x")).toBe(true);
    expect(store.hasGrant({ pluginId: "acme.x", capability: "shell:exec" })).toBe(false);
    expect(store.hasGrant({ pluginId: "acme.x", capability: "git:write" })).toBe(false);
    // Sibling plugin untouched.
    expect(store.hasGrant({ pluginId: "acme.y", capability: "shell:exec" })).toBe(true);
  });

  it("revokeAllForPlugin is a durable no-op when there is nothing to purge", () => {
    const { store, saveConfig } = makeStore();
    expect(store.revokeAllForPlugin("acme.absent")).toBe(true);
    // Nothing changed, so no flush.
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("revokeAllForPlugin reports non-durable when the flush throws", () => {
    let config: Record<string, unknown> = {};
    let failOnNextSave = false;
    const saveConfig = vi.fn((patch: Record<string, unknown>) => {
      if (failOnNextSave) throw new Error("disk full");
      config = { ...config, ...patch };
    });
    const store = new PluginCapabilityConsentStore(saveConfig, () => config);
    store.grant({ pluginId: "acme.x", capability: "shell:exec" });
    failOnNextSave = true;
    expect(store.revokeAllForPlugin("acme.x")).toBe(false);
  });

  it("keeps two scopes independent for the same plugin and capability", () => {
    const { store } = makeStore();
    store.grant({ pluginId: "acme.x", capability: "shell:exec", scopeKey: "proj-1" });
    // The project grant must not satisfy the app-wide check, or its sibling project.
    expect(store.hasGrant({ pluginId: "acme.x", capability: "shell:exec" })).toBe(false);
    expect(
      store.hasGrant({ pluginId: "acme.x", capability: "shell:exec", scopeKey: "global" })
    ).toBe(false);
    expect(
      store.hasGrant({ pluginId: "acme.x", capability: "shell:exec", scopeKey: "proj-2" })
    ).toBe(false);
    expect(
      store.hasGrant({ pluginId: "acme.x", capability: "shell:exec", scopeKey: "proj-1" })
    ).toBe(true);
  });

  it("treats an omitted scopeKey as the global scope", () => {
    const { store } = makeStore();
    const record = store.grant({ pluginId: "acme.x", capability: "shell:exec" });
    expect(record.scopeKey).toBe("global");
    expect(
      store.hasGrant({ pluginId: "acme.x", capability: "shell:exec", scopeKey: "global" })
    ).toBe(true);
  });

  it("does not let a separator-bearing scopeKey inherit another scope's grant", () => {
    const { store } = makeStore();
    store.grant({ pluginId: "acme.x", capability: "git:write", scopeKey: "proj-1" });
    expect(
      store.hasGrant({
        pluginId: "acme.x",
        capability: "git:write",
        scopeKey: 'proj-1","acme.x',
      })
    ).toBe(false);
  });

  it("revoke targets one scope and leaves the other intact", () => {
    const { store } = makeStore();
    store.grant({ pluginId: "acme.x", capability: "shell:exec" });
    store.grant({ pluginId: "acme.x", capability: "shell:exec", scopeKey: "proj-1" });
    store.revoke({ pluginId: "acme.x", capability: "shell:exec", scopeKey: "proj-1" });
    expect(
      store.hasGrant({ pluginId: "acme.x", capability: "shell:exec", scopeKey: "proj-1" })
    ).toBe(false);
    expect(store.hasGrant({ pluginId: "acme.x", capability: "shell:exec" })).toBe(true);
  });

  it("revokeAllForPlugin purges every scope — uninstall removes the plugin everywhere", () => {
    const { store } = makeStore();
    store.grant({ pluginId: "acme.x", capability: "shell:exec" });
    store.grant({ pluginId: "acme.x", capability: "shell:exec", scopeKey: "proj-1" });
    store.grant({ pluginId: "acme.y", capability: "shell:exec", scopeKey: "proj-1" });

    expect(store.revokeAllForPlugin("acme.x")).toBe(true);
    expect(store.hasGrant({ pluginId: "acme.x", capability: "shell:exec" })).toBe(false);
    expect(
      store.hasGrant({ pluginId: "acme.x", capability: "shell:exec", scopeKey: "proj-1" })
    ).toBe(false);
    expect(
      store.hasGrant({ pluginId: "acme.y", capability: "shell:exec", scopeKey: "proj-1" })
    ).toBe(true);
  });

  it("reads a store file written before the scope key existed as global", () => {
    // Exactly the persisted shape the previous version flushed: no scopeKey.
    const { store } = makeStore({
      grants: [
        { pluginId: "acme.x", capability: "shell:exec", approvedAt: 111 },
        { pluginId: "acme.x", capability: "git:write", approvedAt: 222 },
      ],
    });
    expect(store.hasGrant({ pluginId: "acme.x", capability: "shell:exec" })).toBe(true);
    expect(
      store.hasGrant({ pluginId: "acme.x", capability: "git:write", scopeKey: "global" })
    ).toBe(true);
    // No grant is invented for a project scope.
    expect(
      store.hasGrant({ pluginId: "acme.x", capability: "shell:exec", scopeKey: "proj-1" })
    ).toBe(false);
    // Two legacy records in, two records out — nothing lost, nothing duplicated.
    expect(store.list()).toHaveLength(2);
    expect(store.list().every((r) => r.scopeKey === "global")).toBe(true);
  });

  it("keeps scoped and legacy records distinct through a persist/rehydrate round trip", () => {
    const { store, getConfig } = makeStore({
      grants: [{ pluginId: "acme.x", capability: "shell:exec", approvedAt: 111 }],
    });
    store.grant({ pluginId: "acme.x", capability: "shell:exec", scopeKey: "proj-1" });

    const reopened = new PluginCapabilityConsentStore(
      () => {},
      () => getConfig()
    );
    expect(reopened.list()).toHaveLength(2);
    expect(reopened.hasGrant({ pluginId: "acme.x", capability: "shell:exec" })).toBe(true);
    expect(
      reopened.hasGrant({ pluginId: "acme.x", capability: "shell:exec", scopeKey: "proj-1" })
    ).toBe(true);
  });

  it("ignores malformed persisted records on hydrate", () => {
    const { store } = makeStore({
      grants: [
        { pluginId: "acme.x", capability: "shell:exec", approvedAt: 123 },
        { pluginId: 42, capability: "shell:exec", approvedAt: 1 }, // bad pluginId
        { capability: "git:write", approvedAt: 1 }, // missing pluginId
        // A non-string scopeKey drops the record rather than defaulting it into
        // the widest scope.
        { pluginId: "acme.z", capability: "shell:exec", approvedAt: 1, scopeKey: 7 },
        { pluginId: "acme.z", capability: "git:write", approvedAt: 1, scopeKey: "" },
        null,
      ],
    });
    expect(store.hasGrant({ pluginId: "acme.x", capability: "shell:exec" })).toBe(true);
    expect(store.list()).toHaveLength(1);
  });
});
