import { describe, it, expect } from "vitest";
import {
  DEFAULT_SHARD_KEY,
  isPtyFabricEnabled,
  maxProjectShards,
  ptyHostHeapMb,
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

  describe("ptyHostHeapMb", () => {
    it("passes every RAM-scaled budget through unchanged", () => {
      for (const gb of [4, 8, 16, 24, 32, 48, 64, 128]) {
        const budget = shardHeapBudgetMb(gb * GB);
        expect(ptyHostHeapMb(budget)).toBe(budget);
      }
    });

    it("floors fractions and clamps overrides into the range the governor accepts", () => {
      expect(ptyHostHeapMb(1024.9)).toBe(1024);
      expect(ptyHostHeapMb(256)).toBe(256);
      expect(ptyHostHeapMb(100)).toBe(256);
      expect(ptyHostHeapMb(-1)).toBe(256);
      expect(ptyHostHeapMb(8192)).toBe(8192);
      expect(ptyHostHeapMb(20_000)).toBe(8192);
    });

    it("falls back to 512 for a non-finite request", () => {
      expect(ptyHostHeapMb(Number.NaN)).toBe(512);
      expect(ptyHostHeapMb(Number.POSITIVE_INFINITY)).toBe(512);
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
