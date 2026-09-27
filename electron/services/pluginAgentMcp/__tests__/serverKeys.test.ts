import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { makeProjectPluginInstanceKey } from "../../../../shared/types/plugin.js";
import {
  fallbackPluginMcpName,
  MAX_PLUGIN_SERVER_KEY_LENGTH,
  pluginServerKeysFor,
  type PluginServerNameInput,
} from "../serverKeys.js";

const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);
const KEY_PATTERN = /^daintree-[a-z0-9-]+$/;

function installed(manifestId: string, mcpName?: string): PluginServerNameInput {
  return {
    pluginInstanceId: manifestId,
    pluginManifestId: manifestId,
    origin: "global",
    ...(mcpName !== undefined ? { mcpName } : {}),
  };
}

function project(projectId: string, manifestId: string, mcpName?: string): PluginServerNameInput {
  return {
    pluginInstanceId: makeProjectPluginInstanceKey(projectId, manifestId),
    pluginManifestId: manifestId,
    origin: "project",
    ...(mcpName !== undefined ? { mcpName } : {}),
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8);
}

function keyOf(plugins: PluginServerNameInput[], plugin: PluginServerNameInput): string {
  const key = pluginServerKeysFor(plugins).get(plugin.pluginInstanceId);
  if (key === undefined) throw new Error("no key");
  return key;
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest])
  );
}

function expectSafe(keys: Map<string, string>): void {
  for (const key of keys.values()) {
    expect(key).toMatch(KEY_PATTERN);
    expect(key.length).toBeLessThanOrEqual(MAX_PLUGIN_SERVER_KEY_LENGTH);
    expect(key).not.toBe("daintree");
  }
  expect(new Set(keys.values()).size).toBe(keys.size);
}

describe("fallbackPluginMcpName", () => {
  it.each([
    ["acme.ledger", "ledger"],
    ["Ledger", "ledger"],
    ["acme.My_Ledger", "my-ledger"],
    ["acme.My__Big..Ledger", "ledger"],
    ["acme.__x", "x"],
    ["acme.abcdefghijklmno-xyz", "abcdefghijklmno"],
    ["acme.abcdefghijklmnopqrstuvwxyz", "abcdefghijklmnop"],
    ["acme.", "plugin"],
    ["acme.___", "plugin"],
    ["acme.ÉÉÉ", "plugin"],
  ])("%j → %j", (manifestId, expected) => {
    expect(fallbackPluginMcpName(manifestId)).toBe(expected);
  });

  it("never exceeds 16 characters of [a-z0-9-] without edge hyphens", () => {
    for (const id of ["x.-a-", "x.A B C", `x.${"z".repeat(40)}`, "x.1-2-3-4-5-6-7-8-9"]) {
      const name = fallbackPluginMcpName(id);
      expect(name).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
      expect(name.length).toBeLessThanOrEqual(16);
    }
  });
});

describe("pluginServerKeysFor", () => {
  it("uses the declared mcpName, or the manifest id's last segment", () => {
    const named = installed("acme.ledger", "books");
    const unnamed = installed("acme.crm");
    const keys = pluginServerKeysFor([named, unnamed]);

    expect(keys.get("acme.ledger")).toBe("daintree-books");
    expect(keys.get("acme.crm")).toBe("daintree-crm");
  });

  it("names a plugin with an unusable id daintree-plugin, never bare daintree", () => {
    const keys = pluginServerKeysFor([installed("acme.___")]);
    expect(keys.get("acme.___")).toBe("daintree-plugin");
    expectSafe(keys);
  });

  it("leaves room for a 32-character tool name inside Claude's 64-character limit", () => {
    const keys = pluginServerKeysFor([
      installed("acme.an-extremely-long-plugin-manifest-name"),
      installed("zeta.an-extremely-long-plugin-manifest-name"),
      installed("acme.ledger", "abcdefghijklmnop"),
      installed("zeta.ledger", "abcdefghijklmnop"),
    ]);
    const longestTool = "t".repeat(32);
    for (const key of keys.values()) {
      expect(`mcp__${key}__${longestTool}`.length).toBeLessThanOrEqual(64);
    }
    expectSafe(keys);
  });

  it("truncates a hashed key to the length cap", () => {
    const first = installed("acme.one", "abcdefghijklmnop");
    const second = installed("acme.two", "abcdefghijklmnop");
    const keys = pluginServerKeysFor([first, second]);

    expect(keys.get("acme.one")).toBe("daintree-abcdefghijklmnop");
    expect(keys.get("acme.two")).toBe(`daintree-abcdefg-${hash("global\0acme.two")}`);
    expect(keys.get("acme.two")).toHaveLength(MAX_PLUGIN_SERVER_KEY_LENGTH);
  });

  it("keeps a project plugin's key free of its 64-hex project id", () => {
    const plugin = project(PROJECT_A, "acme.ledger");
    const key = keyOf([plugin], plugin);
    expect(key).toBe("daintree-ledger");
    expect(key).not.toContain(PROJECT_A);
  });

  it("names a project copy the same in every project", () => {
    const inA = project(PROJECT_A, "acme.ledger");
    const inB = project(PROJECT_B, "acme.ledger");
    expect(inA.pluginInstanceId).toBe(`project__${PROJECT_A}__acme.ledger`);
    expect(inB.pluginInstanceId).toBe(`project__${PROJECT_B}__acme.ledger`);

    const keyA = keyOf([installed("acme.ledger"), inA], inA);
    const keyB = keyOf([installed("acme.ledger"), inB], inB);
    expect(keyA).toBe(`daintree-ledger-${hash("project\0acme.ledger")}`);
    expect(keyB).toBe(keyA);
    expect(keyOf([inA], inA)).toBe(keyOf([inB], inB));
  });

  it("lets an installed plugin keep its plain name when a project copy appears", () => {
    const global = installed("acme.ledger");
    const copy = project(PROJECT_A, "acme.ledger");

    expect(keyOf([global], global)).toBe("daintree-ledger");
    expect(keyOf([copy], copy)).toBe("daintree-ledger");
    expect(keyOf([copy, global], global)).toBe("daintree-ledger");
    expect(keyOf([copy, global], copy)).not.toBe("daintree-ledger");
  });

  it("gives the plain name to an installed plugin over a project plugin with a lower id", () => {
    const global = installed("zeta.ledger");
    const local = project(PROJECT_A, "acme.ledger");
    const keys = pluginServerKeysFor([local, global]);

    expect(keys.get(global.pluginInstanceId)).toBe("daintree-ledger");
    expect(keys.get(local.pluginInstanceId)).toBe(
      `daintree-ledger-${hash("project\0acme.ledger")}`
    );
  });

  it("gives the plain name to the lower manifest id when two installed plugins share it", () => {
    const acme = installed("acme.ledger");
    const zeta = installed("zeta.ledger");
    const keys = pluginServerKeysFor([zeta, acme]);

    expect(keys.get("acme.ledger")).toBe("daintree-ledger");
    expect(keys.get("zeta.ledger")).toBe(`daintree-ledger-${hash("global\0zeta.ledger")}`);

    const named = pluginServerKeysFor([installed("zeta.x", "books"), installed("acme.y", "books")]);
    expect(named.get("acme.y")).toBe("daintree-books");
    expect(named.get("zeta.x")).toBe(`daintree-books-${hash("global\0zeta.x")}`);
  });

  it("disambiguates plugins sharing a name, independent of order", () => {
    const plugins = [
      installed("acme.ledger"),
      project(PROJECT_A, "acme.ledger"),
      installed("zeta.ledger"),
      installed("acme.other", "ledger"),
    ];
    const keys = pluginServerKeysFor(plugins);
    expect(keys.size).toBe(4);
    expectSafe(keys);

    for (const order of permutations(plugins)) {
      expect(pluginServerKeysFor(order)).toEqual(keys);
    }
  });

  it("never lets a hashed key take another plugin's plain name, in any order", () => {
    const global = installed("acme.ledger");
    const copy = project(PROJECT_A, "acme.ledger");
    const loserKey = `daintree-ledger-${hash("project\0acme.ledger")}`;
    expect(keyOf([global, copy], copy)).toBe(loserKey);

    // A plugin whose plain name is exactly the key the project copy would get.
    const lookalike = installed("zeta.lookalike", `ledger-${hash("project\0acme.ledger")}`);
    const plugins = [global, copy, lookalike];
    const keys = pluginServerKeysFor(plugins);

    expect(keys.get(lookalike.pluginInstanceId)).toBe(loserKey);
    expect(keys.get(global.pluginInstanceId)).toBe("daintree-ledger");
    expect(keys.get(copy.pluginInstanceId)).toBe(
      `daintree-ledger-${hash("project\0acme.ledger\0" + "2")}`
    );
    expectSafe(keys);
    for (const order of permutations(plugins)) {
      expect(pluginServerKeysFor(order)).toEqual(keys);
    }
  });

  it("bounds the key length for long ids without losing uniqueness", () => {
    const longId = `com.example.${"very-long-plugin-name-".repeat(4)}`;
    const keys = pluginServerKeysFor([
      installed(`${longId}a`),
      installed(`${longId}b`),
      project(PROJECT_A, `${longId}a`),
    ]);
    expect(keys.size).toBe(3);
    expectSafe(keys);
  });

  it("returns an empty map for no plugins", () => {
    expect(pluginServerKeysFor([]).size).toBe(0);
  });
});
