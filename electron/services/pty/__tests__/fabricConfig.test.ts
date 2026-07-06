import { describe, it, expect } from "vitest";
import {
  DEFAULT_SHARD_KEY,
  isPtyFabricEnabled,
  maxProjectShards,
  shardHeapBudgetMb,
  shardServiceName,
} from "../fabricConfig.js";

const GB = 1024 * 1024 * 1024;

describe("fabricConfig", () => {
  describe("isPtyFabricEnabled", () => {
    it("is off by default and on only for explicit opt-in values", () => {
      expect(isPtyFabricEnabled({})).toBe(false);
      expect(isPtyFabricEnabled({ DAINTREE_PTY_FABRIC: "0" })).toBe(false);
      expect(isPtyFabricEnabled({ DAINTREE_PTY_FABRIC: "yes" })).toBe(false);
      expect(isPtyFabricEnabled({ DAINTREE_PTY_FABRIC: "1" })).toBe(true);
      expect(isPtyFabricEnabled({ DAINTREE_PTY_FABRIC: "true" })).toBe(true);
    });
  });

  describe("maxProjectShards", () => {
    it("reserves headroom for main + renderer and clamps to [1, 8]", () => {
      expect(maxProjectShards(4)).toBe(2);
      expect(maxProjectShards(12)).toBe(8);
      expect(maxProjectShards(32)).toBe(8);
      expect(maxProjectShards(2)).toBe(1);
      expect(maxProjectShards(0)).toBe(2);
      expect(maxProjectShards(Number.NaN)).toBe(2);
    });
  });

  describe("shardHeapBudgetMb", () => {
    it("scales at totalMem/32 clamped to [512, 2048]", () => {
      expect(shardHeapBudgetMb(8 * GB)).toBe(512); // 256 → floor
      expect(shardHeapBudgetMb(16 * GB)).toBe(512);
      expect(shardHeapBudgetMb(32 * GB)).toBe(1024);
      expect(shardHeapBudgetMb(64 * GB)).toBe(2048);
      expect(shardHeapBudgetMb(256 * GB)).toBe(2048); // ceiling
      expect(shardHeapBudgetMb(0)).toBe(512);
      expect(shardHeapBudgetMb(Number.NaN)).toBe(512);
    });
  });

  describe("shardServiceName", () => {
    it("keeps the legacy name for the default shard", () => {
      expect(shardServiceName(DEFAULT_SHARD_KEY)).toBe("daintree-pty-host");
    });

    it("derives distinct, stable names for project shards", () => {
      const a = shardServiceName("project-a");
      const b = shardServiceName("project-b");
      expect(a).toMatch(/^daintree-pty-host:project-a-[0-9a-f]{8}$/);
      expect(a).not.toBe(b);
      expect(shardServiceName("project-a")).toBe(a);
    });

    it("stays unique when sanitized prefixes collide", () => {
      const a = shardServiceName("проект/one — ✨");
      const b = shardServiceName("проект/two — ✨");
      expect(a).not.toBe(b);
      expect(a.startsWith("daintree-pty-host:")).toBe(true);
    });
  });
});
