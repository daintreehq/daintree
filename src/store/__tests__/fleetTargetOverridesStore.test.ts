// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  useFleetTargetOverridesStore,
  __resetFleetTargetOverridesStoreForTesting,
  subscribeFleetTargetOverridesPruning,
} from "../fleetTargetOverridesStore";
import { useFleetArmingStore } from "../fleetArmingStore";

function resetArmingStore(): void {
  useFleetArmingStore.setState({
    armedIds: new Set<string>(),
    armOrder: [],
    armOrderById: {},
    lastArmedId: null,
    broadcastSignal: 0,
    previewArmedIds: new Set<string>(),
  });
}

beforeEach(() => {
  __resetFleetTargetOverridesStoreForTesting();
  resetArmingStore();
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

  describe("arming-store pruning subscription", () => {
    it("drops a disarmed pane's override + skip while keeping still-armed panes", () => {
      const overrides = useFleetTargetOverridesStore.getState();
      useFleetArmingStore.getState().armIds(["a", "b"]);
      overrides.setPayloadOverride("a", "for a");
      overrides.setPayloadOverride("b", "for b");
      overrides.setSkipped("a", true);
      overrides.setSkipped("b", true);

      const unsub = subscribeFleetTargetOverridesPruning();
      try {
        useFleetArmingStore.getState().disarmId("a");
        const state = useFleetTargetOverridesStore.getState();
        expect(state.payloadOverrides["a"]).toBeUndefined();
        expect(state.skippedIds.has("a")).toBe(false);
        // B is still armed — its entries must survive.
        expect(state.payloadOverrides["b"]).toBe("for b");
        expect(state.skippedIds.has("b")).toBe(true);
      } finally {
        unsub();
      }
    });

    it("clears everything in one shot when the fleet fully drains", () => {
      const overrides = useFleetTargetOverridesStore.getState();
      useFleetArmingStore.getState().armIds(["a", "b"]);
      overrides.setPayloadOverride("a", "x");
      overrides.setSkipped("b", true);

      const unsub = subscribeFleetTargetOverridesPruning();
      try {
        useFleetArmingStore.getState().clear();
        const state = useFleetTargetOverridesStore.getState();
        expect(state.payloadOverrides).toEqual({});
        expect(state.skippedIds.size).toBe(0);
      } finally {
        unsub();
      }
    });

    it("leaves untouched fields ref-identical when only one is pruned", () => {
      const overrides = useFleetTargetOverridesStore.getState();
      useFleetArmingStore.getState().armIds(["a", "b"]);
      // Only a skip on the disarmed pane; no payload overrides at all.
      overrides.setSkipped("a", true);
      const overridesBefore = useFleetTargetOverridesStore.getState().payloadOverrides;

      const unsub = subscribeFleetTargetOverridesPruning();
      try {
        useFleetArmingStore.getState().disarmId("a");
        const state = useFleetTargetOverridesStore.getState();
        expect(state.skippedIds.has("a")).toBe(false);
        // payloadOverrides never changed — identity preserved, no spurious re-render.
        expect(state.payloadOverrides).toBe(overridesBefore);
      } finally {
        unsub();
      }
    });

    it("is a no-op when every override/skip id is still armed", () => {
      const overrides = useFleetTargetOverridesStore.getState();
      useFleetArmingStore.getState().armIds(["a", "b"]);
      overrides.setPayloadOverride("a", "x");
      overrides.setSkipped("b", true);

      const unsub = subscribeFleetTargetOverridesPruning();
      try {
        const skippedBefore = useFleetTargetOverridesStore.getState().skippedIds;
        const overridesBefore = useFleetTargetOverridesStore.getState().payloadOverrides;
        // Arm a third pane — armedIds changes, but nothing needs pruning.
        useFleetArmingStore.getState().armId("c");
        const state = useFleetTargetOverridesStore.getState();
        expect(state.skippedIds).toBe(skippedBefore);
        expect(state.payloadOverrides).toBe(overridesBefore);
      } finally {
        unsub();
      }
    });

    it("reconciles stale entries on initial registration (disarm while torn down)", () => {
      const overrides = useFleetTargetOverridesStore.getState();
      // Pane "a" is armed and "ghost" is not — simulating a pane disarmed while
      // no subscription was registered. Both have entries.
      useFleetArmingStore.getState().armIds(["a"]);
      overrides.setPayloadOverride("a", "keep");
      overrides.setPayloadOverride("ghost", "stale");
      overrides.setSkipped("ghost", true);

      const unsub = subscribeFleetTargetOverridesPruning();
      try {
        const state = useFleetTargetOverridesStore.getState();
        expect(state.payloadOverrides["ghost"]).toBeUndefined();
        expect(state.skippedIds.has("ghost")).toBe(false);
        expect(state.payloadOverrides["a"]).toBe("keep");
      } finally {
        unsub();
      }
    });

    it("clears stale entries on registration when nothing is armed", () => {
      const overrides = useFleetTargetOverridesStore.getState();
      overrides.setPayloadOverride("ghost", "stale");
      overrides.setSkipped("ghost", true);

      const unsub = subscribeFleetTargetOverridesPruning();
      try {
        const state = useFleetTargetOverridesStore.getState();
        expect(state.payloadOverrides).toEqual({});
        expect(state.skippedIds.size).toBe(0);
      } finally {
        unsub();
      }
    });
  });
});
