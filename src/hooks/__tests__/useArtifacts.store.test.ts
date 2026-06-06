import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  removeArtifactsForTerminal,
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
