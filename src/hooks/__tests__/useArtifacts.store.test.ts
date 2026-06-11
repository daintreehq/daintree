// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  MAX_ARTIFACTS_PER_TERMINAL,
  removeArtifactsForTerminal,
  useArtifacts,
  __test_resetArtifactStore,
  __test_seedArtifactStore,
  __test_getArtifactStoreSize,
  __test_getArtifactsFor,
  __test_subscribeArtifactStore,
  __test_isTombstoned,
  __test_simulateArtifactDetected,
} from "@/hooks/useArtifacts";
import type { Artifact } from "@shared/types";

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "artifact-1",
    type: "code",
    content: "console.log('hi')",
    filename: "hello.ts",
    extractedAt: 1700000000000,
    ...overrides,
  };
}

describe("useArtifacts module-level store teardown", () => {
  beforeEach(() => {
    __test_resetArtifactStore();
  });

  it("shrinks the store when a terminal is removed", () => {
    __test_seedArtifactStore("t1", [makeArtifact({ id: "a1" }), makeArtifact({ id: "a2" })]);
    __test_seedArtifactStore("t2", [makeArtifact({ id: "b1" })]);
    expect(__test_getArtifactStoreSize()).toBe(2);

    removeArtifactsForTerminal("t1");

    expect(__test_getArtifactStoreSize()).toBe(1);
    expect(__test_getArtifactsFor("t1")).toBeUndefined();
    expect(__test_getArtifactsFor("t2")).toHaveLength(1);
  });

  it("tombstones the id so in-flight ARTIFACT_DETECTED packets are dropped", () => {
    __test_seedArtifactStore("t1", [makeArtifact({ id: "a1" })]);

    removeArtifactsForTerminal("t1");
    expect(__test_isTombstoned("t1")).toBe(true);

    // Simulate the production `artifactClient.onDetected` handler firing
    // after teardown — the tombstone must block re-insertion.
    const accepted = __test_simulateArtifactDetected("t1", [makeArtifact({ id: "a-late" })]);
    expect(accepted).toBe(false);
    expect(__test_getArtifactStoreSize()).toBe(0);
  });

  it("tombstone does not block other terminals' packets", () => {
    __test_seedArtifactStore("t1", [makeArtifact({ id: "a1" })]);
    __test_seedArtifactStore("t2", [makeArtifact({ id: "b1" })]);

    removeArtifactsForTerminal("t1");
    expect(__test_isTombstoned("t1")).toBe(true);
    expect(__test_isTombstoned("t2")).toBe(false);

    const accepted = __test_simulateArtifactDetected("t2", [makeArtifact({ id: "b2" })]);
    expect(accepted).toBe(true);
    expect(__test_getArtifactsFor("t2")).toHaveLength(2);
  });

  it("notifies subscribers with an empty array for the removed terminal", () => {
    __test_seedArtifactStore("t1", [makeArtifact({ id: "a1" })]);

    const listener = vi.fn();
    const unsubscribe = __test_subscribeArtifactStore(listener);

    removeArtifactsForTerminal("t1");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("t1", []);

    unsubscribe();
  });

  it("is a no-op for an unknown terminal id (no throw, no store growth)", () => {
    __test_seedArtifactStore("t1", [makeArtifact({ id: "a1" })]);
    const beforeSize = __test_getArtifactStoreSize();

    expect(() => removeArtifactsForTerminal("never-seen")).not.toThrow();
    expect(__test_getArtifactStoreSize()).toBe(beforeSize);
  });

  it("is idempotent — calling twice still notifies and still shrinks", () => {
    __test_seedArtifactStore("t1", [makeArtifact({ id: "a1" })]);
    const listener = vi.fn();
    const unsubscribe = __test_subscribeArtifactStore(listener);

    removeArtifactsForTerminal("t1");
    expect(() => removeArtifactsForTerminal("t1")).not.toThrow();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(1, "t1", []);
    expect(listener).toHaveBeenNthCalledWith(2, "t1", []);
    expect(__test_getArtifactStoreSize()).toBe(0);
    expect(__test_isTombstoned("t1")).toBe(true);

    unsubscribe();
  });

  it("does not tombstone the live terminal on user-initiated clearArtifacts, so newly detected artifacts still appear (#10023 regression)", () => {
    const { result } = renderHook(() => useArtifacts("live-1"));

    // Seed a detection so there is something to clear, mirroring a running agent.
    act(() => {
      __test_simulateArtifactDetected("live-1", [makeArtifact({ id: "a1" })]);
    });
    expect(result.current.artifacts).toHaveLength(1);

    // User clicks "Clear all" on the LIVE mounted terminal.
    act(() => {
      result.current.clearArtifacts();
    });
    expect(result.current.artifacts).toHaveLength(0);
    expect(__test_getArtifactsFor("live-1")).toBeUndefined();
    // The terminal must NOT be tombstoned — it is still mounted and running.
    expect(__test_isTombstoned("live-1")).toBe(false);

    // A new artifact detected after the clear must land, not be silently dropped.
    let accepted = false;
    act(() => {
      accepted = __test_simulateArtifactDetected("live-1", [makeArtifact({ id: "a-new" })]);
    });
    expect(accepted).toBe(true);
    expect(result.current.artifacts).toHaveLength(1);
    expect(result.current.artifacts[0]!.id).toBe("a-new");
  });

  it("caps a terminal's artifacts at the per-terminal limit, dropping the oldest", () => {
    const atCap = Array.from({ length: MAX_ARTIFACTS_PER_TERMINAL }, (_, i) =>
      makeArtifact({ id: `a${i}` })
    );
    __test_simulateArtifactDetected("t1", atCap);
    expect(__test_getArtifactsFor("t1")).toHaveLength(MAX_ARTIFACTS_PER_TERMINAL);
    expect(__test_getArtifactsFor("t1")![0]!.id).toBe("a0");

    __test_simulateArtifactDetected("t1", [makeArtifact({ id: "a-overflow" })]);

    const capped = __test_getArtifactsFor("t1")!;
    expect(capped).toHaveLength(MAX_ARTIFACTS_PER_TERMINAL);
    expect(capped[0]!.id).toBe("a1");
    expect(capped[capped.length - 1]!.id).toBe("a-overflow");
  });

  it("keeps only the newest artifacts when a single bulk detection exceeds the cap", () => {
    const bulk = Array.from({ length: MAX_ARTIFACTS_PER_TERMINAL + 10 }, (_, i) =>
      makeArtifact({ id: `a${i}` })
    );
    __test_simulateArtifactDetected("t1", bulk);

    const stored = __test_getArtifactsFor("t1")!;
    expect(stored).toHaveLength(MAX_ARTIFACTS_PER_TERMINAL);
    expect(stored[0]!.id).toBe("a10");
    expect(stored[stored.length - 1]!.id).toBe(`a${MAX_ARTIFACTS_PER_TERMINAL + 9}`);
  });

  it("caps terminals independently", () => {
    const overflow = Array.from({ length: MAX_ARTIFACTS_PER_TERMINAL + 5 }, (_, i) =>
      makeArtifact({ id: `a${i}` })
    );
    __test_simulateArtifactDetected("t1", overflow);
    __test_simulateArtifactDetected("t2", [makeArtifact({ id: "b1" })]);

    expect(__test_getArtifactsFor("t1")).toHaveLength(MAX_ARTIFACTS_PER_TERMINAL);
    expect(__test_getArtifactsFor("t2")).toHaveLength(1);
  });

  it("notifies subscribers with the capped array, not the uncapped merge", () => {
    const listener = vi.fn();
    const unsubscribe = __test_subscribeArtifactStore(listener);

    const overflow = Array.from({ length: MAX_ARTIFACTS_PER_TERMINAL + 1 }, (_, i) =>
      makeArtifact({ id: `a${i}` })
    );
    __test_simulateArtifactDetected("t1", overflow);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]![1]).toHaveLength(MAX_ARTIFACTS_PER_TERMINAL);

    unsubscribe();
  });

  it("removeArtifactsForTerminal still clears a capped terminal", () => {
    const overflow = Array.from({ length: MAX_ARTIFACTS_PER_TERMINAL + 5 }, (_, i) =>
      makeArtifact({ id: `a${i}` })
    );
    __test_simulateArtifactDetected("t1", overflow);

    removeArtifactsForTerminal("t1");

    expect(__test_getArtifactsFor("t1")).toBeUndefined();
    expect(__test_isTombstoned("t1")).toBe(true);
  });

  it("emits a fresh empty array reference on each call (callers can rely on !==)", () => {
    __test_seedArtifactStore("t1", [makeArtifact({ id: "a1" })]);
    const observed: Artifact[][] = [];
    const unsubscribe = __test_subscribeArtifactStore((_tid, arts) => {
      observed.push(arts);
    });

    removeArtifactsForTerminal("t1");
    removeArtifactsForTerminal("t1");

    expect(observed).toHaveLength(2);
    expect(observed[0]).not.toBe(observed[1]);
    expect(observed[0]).toEqual([]);
    expect(observed[1]).toEqual([]);

    unsubscribe();
  });
});
