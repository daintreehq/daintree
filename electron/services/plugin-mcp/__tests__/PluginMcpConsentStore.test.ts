import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginMcpConsentStore } from "../PluginMcpConsentStore.js";

function makeConfig() {
  let config: Record<string, unknown> = {};
  return {
    save: (patch: Record<string, unknown>) => {
      config = { ...config, ...patch };
    },
    read: () => config,
    raw: () => config,
  };
}

const identity = { pluginId: "acme", serverId: "main", toolName: "read_file" };
const fpA = {
  rawHash: "a".repeat(64),
  displayHash: "x".repeat(64),
  schemaHash: "s".repeat(64),
  annotationHash: "n".repeat(64),
};
const fpB = {
  rawHash: "b".repeat(64),
  displayHash: "x".repeat(64),
  schemaHash: "s".repeat(64),
  annotationHash: "n".repeat(64),
};
const fpSchemaChanged = { ...fpA, schemaHash: "t".repeat(64) };
const fpAnnotationChanged = { ...fpA, annotationHash: "m".repeat(64) };

describe("PluginMcpConsentStore", () => {
  let cfg: ReturnType<typeof makeConfig>;
  let store: PluginMcpConsentStore;

  beforeEach(() => {
    cfg = makeConfig();
    store = new PluginMcpConsentStore(cfg.save, cfg.read);
  });

  afterEach(() => {
    store._resetForTest();
  });

  it("returns first-use when no pin exists", () => {
    expect(store.lookup(identity, fpA)).toEqual({ kind: "first-use" });
  });

  it("returns approved when the fingerprint matches the pin", () => {
    store.pin(identity, fpA);
    const result = store.lookup(identity, fpA);
    expect(result.kind).toBe("approved");
  });

  it("returns raw-changed when the raw hash flips — defends against MCP03 rug-pull", () => {
    store.pin(identity, fpA);
    const result = store.lookup(identity, fpB);
    expect(result.kind).toBe("raw-changed");
  });

  it("returns schema-changed when raw matches but schema flips", () => {
    store.pin(identity, fpA);
    const result = store.lookup(identity, fpSchemaChanged);
    expect(result.kind).toBe("schema-changed");
  });

  it("prefers raw-changed over schema-changed when both differ", () => {
    store.pin(identity, fpA);
    const both = {
      rawHash: "c".repeat(64),
      displayHash: "y".repeat(64),
      schemaHash: "u".repeat(64),
      annotationHash: "z".repeat(64),
    };
    expect(store.lookup(identity, both).kind).toBe("raw-changed");
  });

  it("returns annotation-changed when only the annotation hash flips — tier rug-pull", () => {
    store.pin(identity, fpA);
    const result = store.lookup(identity, fpAnnotationChanged);
    expect(result.kind).toBe("annotation-changed");
  });

  it("prefers schema-changed over annotation-changed when both differ", () => {
    store.pin(identity, fpA);
    const both = { ...fpA, schemaHash: "t".repeat(64), annotationHash: "m".repeat(64) };
    expect(store.lookup(identity, both).kind).toBe("schema-changed");
  });

  it("treats a legacy pin lacking annotationHash as annotation-changed so it re-prompts", () => {
    // Hydrate from a persisted snapshot minted before annotationHash existed.
    // normalizeRecord backfills the "" sentinel, which never equals a real
    // 64-char digest — so the next lookup forces re-consent rather than
    // silently inheriting an approval that never covered the annotation tier.
    const legacy = {
      pluginId: identity.pluginId,
      serverId: identity.serverId,
      toolName: identity.toolName,
      approvedAt: 1,
      fingerprint: {
        rawHash: fpA.rawHash,
        displayHash: fpA.displayHash,
        schemaHash: fpA.schemaHash,
        // no annotationHash
      },
    };
    const rebuilt = new PluginMcpConsentStore(cfg.save, () => ({ pins: [legacy] }));
    expect(rebuilt.lookup(identity, fpA).kind).toBe("annotation-changed");
  });

  it("returns revoked after revoke()", () => {
    store.pin(identity, fpA);
    store.revoke(identity);
    expect(store.lookup(identity, fpA).kind).toBe("revoked");
  });

  it("re-approving after revoke clears the revoke marker", () => {
    store.pin(identity, fpA);
    store.revoke(identity);
    store.pin(identity, fpA);
    expect(store.lookup(identity, fpA).kind).toBe("approved");
  });

  it("persists pins through the saver callback", () => {
    store.pin(identity, fpA);
    expect(Array.isArray(cfg.raw().pins)).toBe(true);
    const pins = cfg.raw().pins as Array<Record<string, unknown>>;
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ pluginId: "acme", toolName: "read_file" });
  });

  it("hydrates from a saved snapshot", () => {
    store.pin(identity, fpA);
    const snapshot = cfg.raw();
    const rebuilt = new PluginMcpConsentStore(cfg.save, () => snapshot);
    expect(rebuilt.lookup(identity, fpA).kind).toBe("approved");
  });

  it("discards malformed persisted entries silently", () => {
    const cfgBad = {
      save: () => {},
      read: () => ({
        pins: [
          { pluginId: 123 /* wrong type */, serverId: "x", toolName: "y" },
          null,
          "not-an-object",
        ],
      }),
    };
    const rebuilt = new PluginMcpConsentStore(cfgBad.save, cfgBad.read);
    expect(rebuilt.list()).toEqual([]);
  });

  it("makeKey encodes components so a '::' in any field cannot collide across identities", () => {
    // pluginId="a::b", serverId="c" must NOT collide with pluginId="a", serverId="b::c"
    store.pin({ pluginId: "a::b", serverId: "c", toolName: "t" }, fpA);
    const lookup = store.lookup({ pluginId: "a", serverId: "b::c", toolName: "t" }, fpA);
    expect(lookup.kind).toBe("first-use");
  });

  it("revokeAllForPlugin purges every pin for the plugin so a reinstall starts fresh", () => {
    store.pin({ pluginId: "acme", serverId: "main", toolName: "read_file" }, fpA);
    store.pin({ pluginId: "acme", serverId: "main", toolName: "write_file" }, fpA);
    store.pin({ pluginId: "other", serverId: "main", toolName: "read_file" }, fpA);

    store.revokeAllForPlugin("acme");

    // Reinstall: a fresh lookup must re-prompt, not auto-approve from a stale pin.
    expect(
      store.lookup({ pluginId: "acme", serverId: "main", toolName: "read_file" }, fpA).kind
    ).toBe("first-use");
    expect(
      store.lookup({ pluginId: "acme", serverId: "main", toolName: "write_file" }, fpA).kind
    ).toBe("first-use");
    // Other plugins are untouched.
    expect(
      store.lookup({ pluginId: "other", serverId: "main", toolName: "read_file" }, fpA).kind
    ).toBe("approved");
  });

  it("revokeAllForPlugin leaves no tombstone — purged pins read first-use, not revoked", () => {
    store.pin(identity, fpA);
    store.revoke(identity);
    expect(store.lookup(identity, fpA).kind).toBe("revoked");

    store.revokeAllForPlugin("acme");
    expect(store.lookup(identity, fpA).kind).toBe("first-use");
    // The orphaned revoke marker is gone from persistence too.
    expect(cfg.raw().revoked).toEqual([]);
  });

  it("revokeAllForPlugin skips the flush when the plugin had no consent state", () => {
    store.pin({ pluginId: "keep", serverId: "main", toolName: "t" }, fpA);
    const before = cfg.raw();
    const result = store.revokeAllForPlugin("absent");
    // No write occurred for an absent plugin (same snapshot object reference),
    // and the no-op purge is reported durable.
    expect(cfg.raw()).toBe(before);
    expect(result).toBe(true);
  });

  it("revokeAllForPlugin reports true when the purge persists", () => {
    store.pin(identity, fpA);
    expect(store.revokeAllForPlugin("acme")).toBe(true);
  });

  it("revokeAllForPlugin surfaces a failed flush instead of swallowing it", () => {
    // A flush failure after the in-memory drop means the persisted snapshot may
    // still hold the stale pins — they'd rehydrate on restart. The store must
    // report that so the uninstall caller can retry or escalate.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const throwingStore = new PluginMcpConsentStore(() => {
      throw new Error("disk full");
    }, cfg.read);
    throwingStore.pin(identity, fpA);
    // The pin() flush also throws but is swallowed; the purge return value is
    // the contract under test.
    expect(throwingStore.revokeAllForPlugin("acme")).toBe(false);
    errSpy.mockRestore();
  });

  it("list() returns newest pins first", () => {
    store.pin({ pluginId: "p1", serverId: "s", toolName: "t1" }, fpA);
    // Tick so approvedAt differs.
    const now = Date.now;
    Date.now = () => now() + 10;
    store.pin({ pluginId: "p2", serverId: "s", toolName: "t2" }, fpA);
    Date.now = now;
    const list = store.list();
    expect(list[0]?.pluginId).toBe("p2");
    expect(list[1]?.pluginId).toBe("p1");
  });
});
