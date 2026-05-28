import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
const fpA = { rawHash: "a".repeat(64), displayHash: "x".repeat(64), schemaHash: "s".repeat(64) };
const fpB = { rawHash: "b".repeat(64), displayHash: "x".repeat(64), schemaHash: "s".repeat(64) };
const fpSchemaChanged = { ...fpA, schemaHash: "t".repeat(64) };

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
    };
    expect(store.lookup(identity, both).kind).toBe("raw-changed");
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
