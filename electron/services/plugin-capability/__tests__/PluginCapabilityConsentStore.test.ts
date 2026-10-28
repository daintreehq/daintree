import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginCapabilityConsentStore } from "../PluginCapabilityConsentStore.js";

function makeStore(initial: Record<string, unknown> = {}) {
  let config: Record<string, unknown> = { ...initial };
  const saveConfig = vi.fn((patch: Record<string, unknown>) => {
    config = { ...config, ...patch };
  });
  const store = new PluginCapabilityConsentStore(saveConfig, () => config);
  return { store, saveConfig, getConfig: () => config };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

  describe("setGrant — the project targeting switch (#13119)", () => {
    const identity = {
      pluginId: "acme.orchestrator",
      capability: "project:dispatch",
      scopeKey: "global",
    } as const;

    function reopen(config: Record<string, unknown>) {
      return new PluginCapabilityConsentStore(
        () => {},
        () => config
      );
    }

    it("persists an enable and a disable", () => {
      const { store, getConfig } = makeStore();
      expect(store.setGrant(identity, true)).toBe(true);
      expect(reopen(getConfig()).hasGrant(identity)).toBe(true);
      expect(store.setGrant(identity, false)).toBe(true);
      expect(reopen(getConfig()).hasGrant(identity)).toBe(false);
    });

    it("reports a failed disable, stays revoked in memory, and re-writes on retry", () => {
      const { store, saveConfig, getConfig } = makeStore();
      store.setGrant(identity, true);
      vi.spyOn(console, "error").mockImplementation(() => {});
      saveConfig.mockImplementationOnce(() => {
        throw new Error("disk full");
      });
      saveConfig.mockImplementationOnce(() => {
        throw new Error("disk full");
      });

      expect(store.setGrant(identity, false)).toBe(false);
      expect(store.hasGrant(identity)).toBe(false);
      // Disk still holds the grant — which is exactly why the failure is surfaced.
      expect(reopen(getConfig()).hasGrant(identity)).toBe(true);

      // Nothing left to delete, but the retry must still write the snapshot.
      expect(store.setGrant(identity, false)).toBe(true);
      expect(reopen(getConfig()).hasGrant(identity)).toBe(false);
    });

    it("rolls back a failed enable so memory matches disk", () => {
      const { store, saveConfig, getConfig } = makeStore();
      vi.spyOn(console, "error").mockImplementation(() => {});
      saveConfig.mockImplementation(() => {
        throw new Error("disk full");
      });

      expect(store.setGrant(identity, true)).toBe(false);
      expect(store.hasGrant(identity)).toBe(false);
      expect(reopen(getConfig()).hasGrant(identity)).toBe(false);
    });
  });

  describe("grantAll — the offer-back after a replacing install (#14019)", () => {
    const grants = [
      { pluginId: "acme.x", capability: "terminal:read", scopeKey: "global" },
      { pluginId: "acme.x", capability: "project:dispatch", scopeKey: "global" },
      { pluginId: "acme.x", capability: "external-link", site: "example.com", scopeKey: "global" },
    ] as const;

    it("mints every grant in one write that survives a reopen", () => {
      const { store, saveConfig, getConfig } = makeStore();
      expect(store.grantAll(grants)).toBe(true);
      expect(saveConfig).toHaveBeenCalledTimes(1);
      const reopened = new PluginCapabilityConsentStore(
        () => {},
        () => getConfig()
      );
      for (const grant of grants) expect(reopened.hasGrant(grant)).toBe(true);
    });

    it("rolls the whole batch back when the write fails, keeping what was there before", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const { store, saveConfig, getConfig } = makeStore();
      store.grant(grants[0]);
      const before = store.list();
      vi.setSystemTime(2_000);
      vi.spyOn(console, "error").mockImplementation(() => {});
      saveConfig.mockImplementation(() => {
        throw new Error("disk full");
      });

      // The duplicate must not overwrite the snapshot of what it replaced.
      expect(store.grantAll([...grants, grants[0]])).toBe(false);
      expect(store.list()).toEqual(before);
      expect(
        new PluginCapabilityConsentStore(
          () => {},
          () => getConfig()
        ).list()
      ).toEqual(before);
    });

    it("lists one plugin's grants in every scope and nobody else's", () => {
      const { store } = makeStore();
      store.grantAll([
        ...grants,
        { pluginId: "acme.x", capability: "shell:exec", scopeKey: "project-1" },
        { pluginId: "acme.y", capability: "shell:exec" },
      ]);
      const listed = store.listForPlugin("acme.x");
      expect(listed.map((r) => [r.capability, r.scopeKey]).sort()).toEqual(
        [
          ["external-link", "global"],
          ["project:dispatch", "global"],
          ["shell:exec", "project-1"],
          ["terminal:read", "global"],
        ].sort()
      );
    });
  });

  describe("external-link grants", () => {
    const link = { pluginId: "acme.x", capability: "external-link", site: "example.com" } as const;

    it("keys a grant by hostname and persists it across a reopen", () => {
      const { store, getConfig } = makeStore();
      store.grant(link);
      expect(store.hasGrant(link)).toBe(true);
      expect(store.hasGrant({ ...link, site: "other.example" })).toBe(false);
      expect(store.hasGrant({ ...link, scopeKey: "proj-1" })).toBe(false);
      const reopened = makeStore(getConfig()).store;
      expect(reopened.hasGrant(link)).toBe(true);
      expect(reopened.list()[0]?.site).toBe("example.com");
    });

    it("drops a persisted link grant that has no hostname instead of widening it", () => {
      const { store } = makeStore({
        grants: [
          { pluginId: "acme.x", capability: "external-link", scopeKey: "global", approvedAt: 1 },
          { pluginId: "acme.x", capability: "external-link", site: "", approvedAt: 1 },
        ],
      });
      expect(store.list()).toEqual([]);
      expect(store.hasGrant({ pluginId: "acme.x", capability: "external-link", site: "" })).toBe(
        false
      );
    });

    it("is purged with the rest of a plugin's grants", () => {
      const { store } = makeStore();
      store.grant(link);
      store.grant({ pluginId: "acme.x", capability: "shell:exec" });
      expect(store.revokeAllForPlugin("acme.x")).toBe(true);
      expect(store.list()).toEqual([]);
    });
  });
});
