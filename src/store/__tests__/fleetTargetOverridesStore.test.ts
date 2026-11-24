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
    crossHostTargets: [],
  });
}

function armRemote(key: string): void {
  useFleetArmingStore.getState().armCrossHostTarget({
    key,
    hostId: "studio",
    hostName: "Studio",
    terminalId: key.slice(key.lastIndexOf(":") + 1),
    title: "remote",
  });
}

beforeEach(() => {
  __resetFleetTargetOverridesStoreForTesting();
  resetArmingStore();
});

describe("fleetTargetOverridesStore", () => {
  describe("payload overrides", () => {
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

  describe("snapshot consumption (#17518)", () => {
    const store = () => useFleetTargetOverridesStore.getState();

    it("drops what the snapshot took and keeps what changed or arrived since", () => {
      store().setPayloadOverride("taken", "sent");
      store().setPayloadOverride("edited", "sent");
      store().setSkipped("skipped", true);
      const snapshot = store().snapshot();

      store().setPayloadOverride("edited", "for the next draft");
      store().setPayloadOverride("added", "for the next draft");
      store().setSkipped("newly-skipped", true);
      store().consumeSnapshot(snapshot);

      expect(store().payloadOverrides).toEqual({
        edited: "for the next draft",
        added: "for the next draft",
      });
      expect([...store().skippedIds]).toEqual(["newly-skipped"]);
    });

    it("keeps an entry removed and set again to the same value since", () => {
      store().setPayloadOverride("t-1", "same");
      store().setSkipped("t-2", true);
      const snapshot = store().snapshot();

      store().clearPayloadOverride("t-1");
      store().setPayloadOverride("t-1", "same");
      store().toggleSkipped("t-2");
      store().toggleSkipped("t-2");
      store().consumeSnapshot(snapshot);

      expect(store().payloadOverrides).toEqual({ "t-1": "same" });
      expect(store().skippedIds.has("t-2")).toBe(true);
    });

    it("keeps an entry set again after a clear", () => {
      store().setSkipped("t-1", true);
      const snapshot = store().snapshot();

      store().clear();
      store().setSkipped("t-1", true);
      store().consumeSnapshot(snapshot);

      expect(store().skippedIds.has("t-1")).toBe(true);
    });

    it("tells an override and a skip on the same target apart", () => {
      store().setPayloadOverride("t-1", "sent");
      store().setSkipped("t-1", true);
      const snapshot = store().snapshot();

      store().setSkipped("t-1", false);
      store().setSkipped("t-1", true);
      store().consumeSnapshot(snapshot);

      expect(store().payloadOverrides).toEqual({});
      expect(store().skippedIds.has("t-1")).toBe(true);
    });

    it("leaves an untouched field ref-identical, and the state when nothing is left to take", () => {
      store().setPayloadOverride("t-1", "sent");
      store().setSkipped("t-2", true);
      const snapshot = store().snapshot();
      store().setPayloadOverride("t-1", "edited");
      const editedOverrides = store().payloadOverrides;
      const skipRevisionsBefore = store().skipRevisions;

      store().consumeSnapshot(snapshot);
      expect(store().payloadOverrides).toBe(editedOverrides);
      expect(store().skippedIds.size).toBe(0);
      expect(Object.keys(store().payloadRevisions)).toEqual(["t-1"]);
      expect(store().skipRevisions).toEqual({});
      // The earlier state's revisions are copied, never edited in place.
      expect(Object.keys(skipRevisionsBefore)).toEqual(["t-2"]);

      const settled = useFleetTargetOverridesStore.getState();
      store().consumeSnapshot(snapshot);
      expect(useFleetTargetOverridesStore.getState()).toBe(settled);
    });

    it("keeps what a send took as it stood when taken", () => {
      store().setPayloadOverride("t-1", "sent");
      store().setSkipped("t-2", true);
      const snapshot = store().snapshot();

      store().setPayloadOverride("t-1", "edited");
      store().setSkipped("t-2", false);

      expect(snapshot.payloadOverrides).toEqual({ "t-1": "sent" });
      expect([...snapshot.skippedIds]).toEqual(["t-2"]);
    });

    it("keeps an entry for a target pruned and set again since", () => {
      useFleetArmingStore.getState().armIds(["t-1", "t-2"]);
      const unsub = subscribeFleetTargetOverridesPruning();
      try {
        store().setSkipped("t-2", true);
        const snapshot = store().snapshot();

        useFleetArmingStore.getState().disarmId("t-2");
        expect(store().skippedIds.has("t-2")).toBe(false);
        useFleetArmingStore.getState().armId("t-2");
        store().setSkipped("t-2", true);
        store().consumeSnapshot(snapshot);

        expect(store().skippedIds.has("t-2")).toBe(true);
      } finally {
        unsub();
      }
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
        // A's revisions leave with its entries (#17518).
        expect(Object.keys(state.payloadRevisions)).toEqual(["b"]);
        expect(Object.keys(state.skipRevisions)).toEqual(["b"]);
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

    it("keeps another host's skips and overrides while local panes arm and disarm (#17182)", () => {
      const R1 = "host-fleet:studio:r-1";
      const R2 = "host-fleet:studio:r-2";
      const overrides = useFleetTargetOverridesStore.getState();
      useFleetArmingStore.getState().armId("a");
      armRemote(R1);
      armRemote(R2);
      overrides.setSkipped(R1, true);
      overrides.setPayloadOverride(R2, "for r-2");
      overrides.setPayloadOverride("a", "for a");

      const unsub = subscribeFleetTargetOverridesPruning();
      try {
        useFleetArmingStore.getState().armId("b");
        let state = useFleetTargetOverridesStore.getState();
        expect(state.skippedIds.has(R1)).toBe(true);
        expect(state.payloadOverrides[R2]).toBe("for r-2");

        useFleetArmingStore.getState().disarmId("b");
        // The last local pane leaves; two agents on the other host remain.
        useFleetArmingStore.getState().disarmId("a");
        state = useFleetTargetOverridesStore.getState();
        expect(state.payloadOverrides["a"]).toBeUndefined();
        expect(state.skippedIds.has(R1)).toBe(true);
        expect(state.payloadOverrides[R2]).toBe("for r-2");
      } finally {
        unsub();
      }
    });

    it("drops another host's entry once that agent leaves the fleet", () => {
      const R1 = "host-fleet:studio:r-1";
      const R2 = "host-fleet:studio:r-2";
      const overrides = useFleetTargetOverridesStore.getState();
      useFleetArmingStore.getState().armId("a");
      armRemote(R1);
      armRemote(R2);
      overrides.setSkipped(R1, true);
      overrides.setPayloadOverride(R1, "for r-1");
      overrides.setSkipped(R2, true);
      overrides.setPayloadOverride("a", "for a");

      const unsub = subscribeFleetTargetOverridesPruning();
      try {
        useFleetArmingStore.getState().disarmCrossHostTarget(R1);
        let state = useFleetTargetOverridesStore.getState();
        expect(state.skippedIds.has(R1)).toBe(false);
        expect(state.payloadOverrides[R1]).toBeUndefined();
        expect(state.skippedIds.has(R2)).toBe(true);
        expect(state.payloadOverrides["a"]).toBe("for a");

        useFleetArmingStore.getState().retainCrossHostTargetsFor(new Set());
        state = useFleetTargetOverridesStore.getState();
        expect(state.skippedIds.size).toBe(0);
        expect(state.payloadOverrides).toEqual({ a: "for a" });
      } finally {
        unsub();
      }
    });

    it("reconciles another host's stale entries on registration", () => {
      const R1 = "host-fleet:studio:r-1";
      const overrides = useFleetTargetOverridesStore.getState();
      armRemote(R1);
      overrides.setSkipped(R1, true);
      overrides.setSkipped("host-fleet:studio:gone", true);

      const unsub = subscribeFleetTargetOverridesPruning();
      try {
        const state = useFleetTargetOverridesStore.getState();
        expect([...state.skippedIds]).toEqual([R1]);
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
