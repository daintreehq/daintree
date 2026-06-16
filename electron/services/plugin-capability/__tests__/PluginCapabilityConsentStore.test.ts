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

  it("ignores malformed persisted records on hydrate", () => {
    const { store } = makeStore({
      grants: [
        { pluginId: "acme.x", capability: "shell:exec", approvedAt: 123 },
        { pluginId: 42, capability: "shell:exec", approvedAt: 1 }, // bad pluginId
        { capability: "git:write", approvedAt: 1 }, // missing pluginId
        null,
      ],
    });
    expect(store.hasGrant({ pluginId: "acme.x", capability: "shell:exec" })).toBe(true);
    expect(store.list()).toHaveLength(1);
  });
});
