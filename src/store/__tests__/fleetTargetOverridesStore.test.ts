// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  useFleetTargetOverridesStore,
  __resetFleetTargetOverridesStoreForTesting,
} from "../fleetTargetOverridesStore";

beforeEach(() => {
  __resetFleetTargetOverridesStoreForTesting();
});

describe("fleetTargetOverridesStore", () => {
  describe("payload overrides", () => {
    it("sets and reads a per-target payload override", () => {
      useFleetTargetOverridesStore.getState().setPayloadOverride("t-1", "custom payload");
      expect(useFleetTargetOverridesStore.getState().payloadOverrides["t-1"]).toBe(
        "custom payload"
      );
    });

    it("clearPayloadOverride removes the key", () => {
      const store = useFleetTargetOverridesStore.getState();
      store.setPayloadOverride("t-1", "x");
      store.setPayloadOverride("t-2", "y");
      store.clearPayloadOverride("t-1");
      const state = useFleetTargetOverridesStore.getState();
      expect(state.payloadOverrides["t-1"]).toBeUndefined();
      expect(state.payloadOverrides["t-2"]).toBe("y");
    });

    it("clearPayloadOverride is a no-op for unknown ids", () => {
      const before = useFleetTargetOverridesStore.getState().payloadOverrides;
      useFleetTargetOverridesStore.getState().clearPayloadOverride("nope");
      const after = useFleetTargetOverridesStore.getState().payloadOverrides;
      // Identity preserved when nothing changes — avoids spurious re-renders.
      expect(after).toBe(before);
    });

    it("setPayloadOverride replaces, never mutates in place", () => {
      const store = useFleetTargetOverridesStore.getState();
      store.setPayloadOverride("t-1", "a");
      const before = useFleetTargetOverridesStore.getState().payloadOverrides;
      store.setPayloadOverride("t-1", "b");
      const after = useFleetTargetOverridesStore.getState().payloadOverrides;
      expect(after).not.toBe(before);
    });
  });

  describe("skipped ids", () => {
    it("toggleSkipped flips membership", () => {
      const store = useFleetTargetOverridesStore.getState();
      store.toggleSkipped("t-1");
      expect(useFleetTargetOverridesStore.getState().skippedIds.has("t-1")).toBe(true);
      store.toggleSkipped("t-1");
      expect(useFleetTargetOverridesStore.getState().skippedIds.has("t-1")).toBe(false);
    });

    it("setSkipped(true/false) sets explicit state and is idempotent", () => {
      const store = useFleetTargetOverridesStore.getState();
      store.setSkipped("t-1", true);
      const afterFirstSkip = useFleetTargetOverridesStore.getState().skippedIds;
      store.setSkipped("t-1", true);
      // Identity preserved on no-op — Set was never replaced.
      expect(useFleetTargetOverridesStore.getState().skippedIds).toBe(afterFirstSkip);

      store.setSkipped("t-1", false);
      expect(useFleetTargetOverridesStore.getState().skippedIds.has("t-1")).toBe(false);
    });

    it("toggleSkipped replaces the Set so subscribers fire", () => {
      const store = useFleetTargetOverridesStore.getState();
      const before = useFleetTargetOverridesStore.getState().skippedIds;
      store.toggleSkipped("t-1");
      const after = useFleetTargetOverridesStore.getState().skippedIds;
      expect(after).not.toBe(before);
    });
  });

  describe("clear", () => {
    it("resets both payload overrides and skipped ids", () => {
      const store = useFleetTargetOverridesStore.getState();
      store.setPayloadOverride("t-1", "x");
      store.toggleSkipped("t-2");
      store.clear();
      const state = useFleetTargetOverridesStore.getState();
      expect(state.payloadOverrides).toEqual({});
      expect(state.skippedIds.size).toBe(0);
    });
  });
});
