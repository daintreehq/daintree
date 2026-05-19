import { describe, expect, it } from "vitest";
import { buildDedupKey, canonicalArgsHash, readDedupCache } from "../sessionDedup.js";

describe("sessionDedup", () => {
  describe("canonicalArgsHash", () => {
    it("returns the same hash regardless of object key insertion order", () => {
      const a = canonicalArgsHash("terminal.new", { foo: 1, bar: 2 });
      const b = canonicalArgsHash("terminal.new", { bar: 2, foo: 1 });
      expect(a).toBe(b);
    });

    it("recursively sorts nested object keys", () => {
      const a = canonicalArgsHash("worktree.createWithRecipe", {
        outer: { x: 1, y: 2 },
        list: [{ z: 3, w: 4 }],
      });
      const b = canonicalArgsHash("worktree.createWithRecipe", {
        list: [{ w: 4, z: 3 }],
        outer: { y: 2, x: 1 },
      });
      expect(a).toBe(b);
    });

    it("preserves array order (not sorted)", () => {
      const a = canonicalArgsHash("recipe.run", { items: [1, 2, 3] });
      const b = canonicalArgsHash("recipe.run", { items: [3, 2, 1] });
      expect(a).not.toBe(b);
    });

    it("differentiates by actionId so the same args on different actions don't collide", () => {
      const a = canonicalArgsHash("terminal.new", { spawnedBy: "user" });
      const b = canonicalArgsHash("agent.launch", { spawnedBy: "user" });
      expect(a).not.toBe(b);
    });

    it("handles undefined and null args without throwing", () => {
      expect(() => canonicalArgsHash("terminal.new", undefined)).not.toThrow();
      expect(() => canonicalArgsHash("terminal.new", null)).not.toThrow();
      expect(canonicalArgsHash("terminal.new", undefined)).not.toBe(
        canonicalArgsHash("terminal.new", null)
      );
    });

    it("treats { x: undefined } as equivalent to {} (JSON-serialization parity)", () => {
      // JSON.stringify drops undefined-valued keys, matching how MCP would
      // never receive `undefined` over the wire. Two callers that pass
      // semantically-equivalent args must dedup.
      const a = canonicalArgsHash("terminal.new", { cwd: undefined });
      const b = canonicalArgsHash("terminal.new", {});
      expect(a).toBe(b);
    });
  });

  describe("buildDedupKey", () => {
    it("uses the explicit requestKey when provided", () => {
      const key = buildDedupKey("terminal.new", "rk-abc", { foo: 1 });
      expect(key).toContain("rk-abc");
      expect(key).toContain("terminal.new");
    });

    it("differentiates the same requestKey on different actions", () => {
      const a = buildDedupKey("terminal.new", "rk-1", {});
      const b = buildDedupKey("agent.launch", "rk-1", {});
      expect(a).not.toBe(b);
    });

    it("falls back to auto-hash when requestKey is undefined", () => {
      const key = buildDedupKey("terminal.new", undefined, { foo: 1 });
      expect(key).toMatch(/^terminal\.new:auto:/);
    });

    it("treats empty-string requestKey as absent (falls back to auto-hash)", () => {
      const a = buildDedupKey("terminal.new", "", { foo: 1 });
      const b = buildDedupKey("terminal.new", undefined, { foo: 1 });
      expect(a).toBe(b);
    });

    it("auto-hash collapses identical args regardless of key order", () => {
      const a = buildDedupKey("terminal.new", undefined, { foo: 1, bar: 2 });
      const b = buildDedupKey("terminal.new", undefined, { bar: 2, foo: 1 });
      expect(a).toBe(b);
    });
  });

  describe("readDedupCache", () => {
    it("returns the cached entry while not expired", () => {
      const cache = new Map();
      const result = { content: [{ type: "text" as const, text: "ok" }] };
      cache.set("k", { result, expiresAt: 1000, argsHash: "abc123" });
      expect(readDedupCache(cache, "k", 999)).toEqual({
        result,
        expiresAt: 1000,
        argsHash: "abc123",
      });
    });

    it("preserves argsHash on the returned entry", () => {
      const cache = new Map();
      const result = { content: [{ type: "text" as const, text: "ok" }] };
      cache.set("k", { result, expiresAt: 2000, argsHash: "sha256-hex" });
      const entry = readDedupCache(cache, "k", 1000);
      expect(entry?.argsHash).toBe("sha256-hex");
    });

    it("returns undefined and evicts when entry is expired", () => {
      const cache = new Map();
      cache.set("k", { result: { content: [] }, expiresAt: 1000, argsHash: "h" });
      expect(readDedupCache(cache, "k", 1001)).toBeUndefined();
      expect(cache.has("k")).toBe(false);
    });

    it("returns undefined for an entry exactly at expiry (expiresAt is exclusive)", () => {
      const cache = new Map();
      cache.set("k", { result: { content: [] }, expiresAt: 1000, argsHash: "h" });
      expect(readDedupCache(cache, "k", 1000)).toBeUndefined();
    });

    it("returns undefined for an absent key", () => {
      expect(readDedupCache(new Map(), "missing", 0)).toBeUndefined();
    });
  });
});
