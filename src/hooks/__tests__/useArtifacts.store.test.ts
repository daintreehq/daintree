// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  MAX_ARTIFACTS_PER_TERMINAL,
  removeArtifactsForTerminal,
  useArtifacts,
  useHasArtifacts,
  __test_resetArtifactStore,
  __test_seedArtifactStore,
  __test_getArtifactStoreSize,
  __test_getArtifactsFor,
  __test_subscribeArtifactStore,
  __test_simulateArtifactDetected,
} from "@/hooks/useArtifacts";
import {
  getPanelStoreSnapshot,
  resetStoreAccessorsForTesting,
  setPanelStoreAccessor,
  type PanelStoreSnapshot,
} from "@/store/storeAccessors";
import type { Artifact } from "@shared/types";

type RegisteredPanel = PanelStoreSnapshot["panelsById"][string];
let registry: Record<string, RegisteredPanel> = {};

/** Registers panels in this view's panel store, the registry detections are checked against. */
function register(...ids: string[]): void {
  for (const id of ids) {
    registry[id] = { id, kind: "terminal", title: id, location: "grid" } as RegisteredPanel;
  }
}

function unregister(id: string): void {
  delete registry[id];
}

function moveTo(id: string, location: RegisteredPanel["location"]): void {
  registry[id] = { ...registry[id]!, location };
}

beforeEach(() => {
  registry = {};
  setPanelStoreAccessor(() => ({
    panelsById: registry,
    panelIds: Object.keys(registry),
    tabGroups: new Map(),
  }));
});

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
    register("t1", "t2", "live-1", "live-cap", "ghost");
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

  it("turns away a packet that lands after its terminal's panel is removed", () => {
    __test_seedArtifactStore("t1", [makeArtifact({ id: "a1" })]);

    unregister("t1");
    removeArtifactsForTerminal("t1");

    // The production `artifactClient.onDetected` handler firing after teardown.
    const accepted = __test_simulateArtifactDetected("t1", [makeArtifact({ id: "a-late" })]);
    expect(accepted).toBe(false);
    expect(__test_getArtifactStoreSize()).toBe(0);
  });

  it("keeps taking another live terminal's packets", () => {
    __test_seedArtifactStore("t1", [makeArtifact({ id: "a1" })]);
    __test_seedArtifactStore("t2", [makeArtifact({ id: "b1" })]);

    unregister("t1");
    removeArtifactsForTerminal("t1");

    const accepted = __test_simulateArtifactDetected("t2", [makeArtifact({ id: "b2" })]);
    expect(accepted).toBe(true);
    expect(__test_getArtifactsFor("t2")).toHaveLength(2);
  });

  it("holds a trashed terminal's packets back and takes them again once it is restored", () => {
    moveTo("t1", "trash");
    expect(__test_simulateArtifactDetected("t1", [makeArtifact({ id: "a-trash" })])).toBe(false);
    expect(__test_getArtifactsFor("t1")).toBeUndefined();

    moveTo("t1", "dock");
    expect(__test_simulateArtifactDetected("t1", [makeArtifact({ id: "a-back" })])).toBe(true);
    expect(__test_getArtifactsFor("t1")!.map((artifact) => artifact.id)).toEqual(["a-back"]);
  });

  it("turns away packets for terminals another view holds, without storing them", () => {
    expect(__test_simulateArtifactDetected("elsewhere", [makeArtifact()])).toBe(false);
    expect(__test_simulateArtifactDetected("constructor", [makeArtifact()])).toBe(false);
    expect(__test_getArtifactStoreSize()).toBe(0);
  });

  it("keeps only live terminals' entries through churn and still turns every retired id away", () => {
    for (let i = 0; i < 100; i++) {
      register(`churn-${i}`);
      expect(__test_simulateArtifactDetected(`churn-${i}`, [makeArtifact({ id: `c${i}` })])).toBe(
        true
      );
      expect(__test_getArtifactsFor(`churn-${i}`)).toHaveLength(1);
      unregister(`churn-${i}`);
      removeArtifactsForTerminal(`churn-${i}`);
      expect(__test_getArtifactsFor(`churn-${i}`)).toBeUndefined();
    }
    __test_simulateArtifactDetected("t1", [makeArtifact()]);

    expect(__test_getArtifactStoreSize()).toBe(1);
    expect(__test_getArtifactsFor("t1")).toHaveLength(1);
    for (let i = 0; i < 100; i++) {
      expect(__test_simulateArtifactDetected(`churn-${i}`, [makeArtifact()])).toBe(false);
    }
    expect(__test_getArtifactStoreSize()).toBe(1);
  });

  it("takes a reused id's new packets, not its old ones, once its panel is registered again", () => {
    __test_simulateArtifactDetected("t1", [makeArtifact({ id: "old" })]);
    expect(__test_getArtifactsFor("t1")!.map((artifact) => artifact.id)).toEqual(["old"]);
    unregister("t1");
    removeArtifactsForTerminal("t1");
    expect(__test_simulateArtifactDetected("t1", [makeArtifact({ id: "late" })])).toBe(false);
    expect(__test_getArtifactsFor("t1")).toBeUndefined();

    register("t1");
    expect(__test_simulateArtifactDetected("t1", [makeArtifact({ id: "new" })])).toBe(true);

    expect(__test_getArtifactsFor("t1")!.map((artifact) => artifact.id)).toEqual(["new"]);
  });

  it("keeps every packet in a renderer with no panel registry wired", () => {
    resetStoreAccessorsForTesting();
    expect(getPanelStoreSnapshot()).toBeNull();

    expect(__test_simulateArtifactDetected("anywhere", [makeArtifact()])).toBe(true);
    expect(__test_getArtifactsFor("anywhere")).toHaveLength(1);
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

    unsubscribe();
  });

  it("keeps detecting for a live terminal after a user-initiated clearArtifacts (#10023 regression)", () => {
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
    const notified = listener.mock.calls[0]![1] as Artifact[];
    expect(notified).toHaveLength(MAX_ARTIFACTS_PER_TERMINAL);
    expect(notified[0]!.id).toBe("a1");
    expect(notified[notified.length - 1]!.id).toBe(`a${MAX_ARTIFACTS_PER_TERMINAL}`);

    unsubscribe();
  });

  it("an empty detection batch is a no-op — no store entry, no notification", () => {
    const listener = vi.fn();
    const unsubscribe = __test_subscribeArtifactStore(listener);

    const accepted = __test_simulateArtifactDetected("ghost", []);

    expect(accepted).toBe(true);
    expect(__test_getArtifactsFor("ghost")).toBeUndefined();
    expect(__test_getArtifactStoreSize()).toBe(0);
    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
  });

  it("applies the cap from a clean slate after a live clearArtifacts", () => {
    const { result } = renderHook(() => useArtifacts("live-cap"));

    act(() => {
      __test_simulateArtifactDetected(
        "live-cap",
        Array.from({ length: MAX_ARTIFACTS_PER_TERMINAL }, (_, i) => makeArtifact({ id: `a${i}` }))
      );
    });
    expect(__test_getArtifactsFor("live-cap")).toHaveLength(MAX_ARTIFACTS_PER_TERMINAL);
    act(() => {
      result.current.clearArtifacts();
    });
    expect(__test_getArtifactsFor("live-cap")).toBeUndefined();

    act(() => {
      __test_simulateArtifactDetected(
        "live-cap",
        Array.from({ length: MAX_ARTIFACTS_PER_TERMINAL + 10 }, (_, i) =>
          makeArtifact({ id: `b${i}` })
        )
      );
    });

    const stored = __test_getArtifactsFor("live-cap")!;
    expect(stored).toHaveLength(MAX_ARTIFACTS_PER_TERMINAL);
    expect(stored[0]!.id).toBe("b10");
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

describe("useHasArtifacts", () => {
  type Detected = (payload: { terminalId: string; artifacts: Artifact[] }) => void;
  let detected: Detected | null;
  /** One release per registration, so a second registration can't hide behind the first's. */
  let releases: ReturnType<typeof vi.fn>[];
  const onDetected = vi.fn((callback: Detected) => {
    detected = callback;
    const release = vi.fn();
    releases.push(release);
    return release;
  });

  beforeEach(() => {
    __test_resetArtifactStore();
    detected = null;
    releases = [];
    onDetected.mockClear();
    vi.stubGlobal("electron", { artifact: { onDetected } });
    register("t1", "t2");
  });

  afterEach(() => {
    // Unmount first: resetting the store under mounted owners would let their
    // cleanup drive the subscription count below zero.
    cleanup();
    __test_resetArtifactStore();
    vi.unstubAllGlobals();
  });

  it("collects a terminal's first batch with no overlay mounted to receive it", () => {
    const { result } = renderHook(() => useHasArtifacts("t1"));
    expect(result.current).toBe(false);

    act(() => detected?.({ terminalId: "t2", artifacts: [makeArtifact()] }));
    expect(result.current).toBe(false);

    act(() => detected?.({ terminalId: "t1", artifacts: [makeArtifact()] }));

    expect(result.current).toBe(true);
    expect(__test_getArtifactsFor("t1")).toHaveLength(1);
  });

  it("follows a change of terminal id", () => {
    const { result, rerender } = renderHook(({ id }) => useHasArtifacts(id), {
      initialProps: { id: "t1" },
    });

    rerender({ id: "t2" });
    act(() => detected?.({ terminalId: "t2", artifacts: [makeArtifact()] }));
    expect(result.current).toBe(true);

    act(() => removeArtifactsForTerminal("t2"));
    expect(result.current).toBe(false);
  });

  it("answers from artifacts collected before it mounted, and only for its terminal", () => {
    __test_seedArtifactStore("t1", [makeArtifact()]);

    expect(renderHook(() => useHasArtifacts("t1")).result.current).toBe(true);
    expect(renderHook(() => useHasArtifacts("t2")).result.current).toBe(false);
  });

  it("turns false when the terminal's artifacts are torn down", () => {
    __test_seedArtifactStore("t1", [makeArtifact()]);
    const { result } = renderHook(() => useHasArtifacts("t1"));

    act(() => removeArtifactsForTerminal("t1"));

    expect(result.current).toBe(false);
  });

  it("collects a reused id's first new batch once its panel is registered again", () => {
    const { result } = renderHook(() => useHasArtifacts("t1"));
    act(() => detected?.({ terminalId: "t1", artifacts: [makeArtifact({ id: "old" })] }));
    expect(result.current).toBe(true);

    unregister("t1");
    act(() => removeArtifactsForTerminal("t1"));
    act(() => detected?.({ terminalId: "t1", artifacts: [makeArtifact({ id: "late" })] }));
    expect(result.current).toBe(false);
    expect(__test_getArtifactsFor("t1")).toBeUndefined();

    register("t1");
    act(() => detected?.({ terminalId: "t1", artifacts: [makeArtifact({ id: "new" })] }));

    expect(result.current).toBe(true);
    expect(__test_getArtifactsFor("t1")!.map((artifact) => artifact.id)).toEqual(["new"]);
  });

  it("shares one detection subscription with the overlay and drops it with the last owner", () => {
    const presence = renderHook(() => useHasArtifacts("t1"));
    const overlay = renderHook(() => useArtifacts("t1"));
    expect(onDetected).toHaveBeenCalledTimes(1);

    presence.unmount();
    expect(releases[0]).not.toHaveBeenCalled();
    act(() => detected?.({ terminalId: "t1", artifacts: [makeArtifact()] }));
    expect(overlay.result.current.artifacts).toHaveLength(1);

    overlay.unmount();
    expect(releases[0]).toHaveBeenCalledTimes(1);
  });

  it("drops the subscription when the presence owner is the last to leave", () => {
    const overlay = renderHook(() => useArtifacts("t1"));
    const presence = renderHook(() => useHasArtifacts("t1"));

    overlay.unmount();
    expect(releases[0]).not.toHaveBeenCalled();
    presence.unmount();

    expect(onDetected).toHaveBeenCalledTimes(1);
    expect(releases[0]).toHaveBeenCalledTimes(1);
  });
});
