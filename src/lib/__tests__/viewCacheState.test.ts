// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetProjectViewCacheStateForTests,
  isProjectViewCached,
  subscribeProjectViewLifecycle,
  type ProjectViewLifecyclePhase,
} from "../viewCacheState";

type Emitters = {
  cached: () => void;
  warmActivated: () => void;
  revealed: () => void;
};

/**
 * Install a `window.electron.app` stub whose three lifecycle channels can be
 * fired on demand, mirroring what ProjectViewLifecycleController /
 * ProjectViewSwitchController send. Returns the emitters plus the per-channel
 * unsubscribe spies so listener hygiene is assertable.
 */
function installElectronStub(latchedCached = false): {
  emit: Emitters;
  offSpies: {
    cached: ReturnType<typeof vi.fn>;
    warmActivated: ReturnType<typeof vi.fn>;
    revealed: ReturnType<typeof vi.fn>;
  };
  registrationCounts: () => { cached: number; warmActivated: number; revealed: number };
} {
  const handlers: {
    cached: Array<() => void>;
    warm: Array<() => void>;
    revealed: Array<() => void>;
  } = { cached: [], warm: [], revealed: [] };
  const counts = { cached: 0, warmActivated: 0, revealed: 0 };
  const offCached = vi.fn();
  const offWarmActivated = vi.fn();
  const offRevealed = vi.fn();

  (window as unknown as { electron: unknown }).electron = {
    app: {
      onViewCached: (cb: () => void) => {
        counts.cached += 1;
        handlers.cached.push(cb);
        return offCached;
      },
      isViewCached: () => latchedCached,
      onViewWarmActivated: (cb: () => void) => {
        counts.warmActivated += 1;
        handlers.warm.push(cb);
        return offWarmActivated;
      },
      onViewRevealed: (cb: () => void) => {
        counts.revealed += 1;
        handlers.revealed.push(cb);
        return offRevealed;
      },
    },
  };

  return {
    emit: {
      cached: () => handlers.cached.forEach((h) => h()),
      warmActivated: () => handlers.warm.forEach((h) => h()),
      revealed: () => handlers.revealed.forEach((h) => h()),
    },
    offSpies: { cached: offCached, warmActivated: offWarmActivated, revealed: offRevealed },
    registrationCounts: () => ({ ...counts }),
  };
}

describe("viewCacheState", () => {
  let stub: ReturnType<typeof installElectronStub>;

  beforeEach(() => {
    stub = installElectronStub();
  });

  afterEach(() => {
    __resetProjectViewCacheStateForTests();
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it("reports not-cached by default so a cold view is never demoted", () => {
    // A cold view never receives warm-activated — defaulting to cached would
    // permanently demote a view that main never cached.
    expect(isProjectViewCached()).toBe(false);
  });

  it("tracks cached -> active -> cached transitions", () => {
    expect(isProjectViewCached()).toBe(false);

    stub.emit.cached();
    expect(isProjectViewCached()).toBe(true);

    stub.emit.warmActivated();
    expect(isProjectViewCached()).toBe(false);

    stub.emit.cached();
    expect(isProjectViewCached()).toBe(true);
  });

  it("clears the cached flag on warm-activated, not only on revealed", () => {
    // Load-bearing: main only sends APP_VIEW_REVEALED while the view is still
    // the active project, so a superseded switch delivers warm-activated with
    // no revealed. If revealed owned the clear, that view would stay demoted.
    expect(isProjectViewCached()).toBe(false); // arms the module

    stub.emit.cached();
    expect(isProjectViewCached()).toBe(true);

    stub.emit.warmActivated();

    expect(isProjectViewCached()).toBe(false);
  });

  it("clears a stale cached flag if revealed arrives without warm-activated", () => {
    expect(isProjectViewCached()).toBe(false); // arms the module

    stub.emit.cached();
    expect(isProjectViewCached()).toBe(true);

    stub.emit.revealed();

    expect(isProjectViewCached()).toBe(false);
  });

  it("delivers distinct phases to subscribers in order", () => {
    const phases: ProjectViewLifecyclePhase[] = [];
    subscribeProjectViewLifecycle((phase) => phases.push(phase));

    stub.emit.cached();
    stub.emit.warmActivated();
    stub.emit.revealed();

    expect(phases).toEqual(["cached", "active", "revealed"]);
  });

  it("exposes the new state to a subscriber reading it during the callback", () => {
    const seen: boolean[] = [];
    subscribeProjectViewLifecycle(() => seen.push(isProjectViewCached()));

    stub.emit.cached();
    stub.emit.warmActivated();

    expect(seen).toEqual([true, false]);
  });

  it("does not re-emit cached when already cached", () => {
    const listener = vi.fn();
    subscribeProjectViewLifecycle(listener);

    stub.emit.cached();
    stub.emit.cached();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("registers exactly one underlying listener per channel across many subscribers", () => {
    subscribeProjectViewLifecycle(vi.fn());
    subscribeProjectViewLifecycle(vi.fn());
    subscribeProjectViewLifecycle(vi.fn());
    void isProjectViewCached();

    expect(stub.registrationCounts()).toEqual({ cached: 1, warmActivated: 1, revealed: 1 });
  });

  it("stops delivering to an unsubscribed listener without affecting the rest", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeProjectViewLifecycle(a);
    subscribeProjectViewLifecycle(b);

    offA();
    stub.emit.cached();

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith("cached");
  });

  it("keeps notifying the remaining listeners when one throws", () => {
    const after = vi.fn();
    subscribeProjectViewLifecycle(() => {
      throw new Error("bad subscriber");
    });
    subscribeProjectViewLifecycle(after);

    expect(() => stub.emit.cached()).not.toThrow();
    expect(after).toHaveBeenCalledWith("cached");
  });

  it("still tracks state when queried without any subscriber", () => {
    // Arming has to happen on the query path too — a query-only consumer of an
    // unarmed module would silently read "not cached" forever.
    expect(isProjectViewCached()).toBe(false);
    stub.emit.cached();
    expect(isProjectViewCached()).toBe(true);
  });

  it("seeds from preload's latch when the cached edge landed before arming", () => {
    // The signals are non-replaying edges and a cold switch is released at the
    // pre-React skeleton, so a switch storm can cache this view before this
    // module ever evaluates. Preload has tracked since before any page script,
    // so a late first query must report cached — not the false default that
    // would leave the view running full-rate terminal work.
    __resetProjectViewCacheStateForTests();
    delete (window as unknown as { electron?: unknown }).electron;
    stub = installElectronStub(true);

    expect(isProjectViewCached()).toBe(true);
  });

  it("still tracks live transitions after seeding from a cached latch", () => {
    __resetProjectViewCacheStateForTests();
    delete (window as unknown as { electron?: unknown }).electron;
    stub = installElectronStub(true);
    expect(isProjectViewCached()).toBe(true);

    stub.emit.warmActivated();

    expect(isProjectViewCached()).toBe(false);
  });

  it("tolerates a preload without the latch", () => {
    // Defensive: an older/partial bridge must degrade to the un-demoted answer
    // rather than throwing on the hot query path.
    __resetProjectViewCacheStateForTests();
    (window as unknown as { electron: unknown }).electron = {
      app: {
        onViewCached: () => vi.fn(),
        onViewWarmActivated: () => vi.fn(),
        onViewRevealed: () => vi.fn(),
      },
    };

    expect(isProjectViewCached()).toBe(false);
  });

  it("answers not-cached when the electron bridge is unavailable", () => {
    __resetProjectViewCacheStateForTests();
    delete (window as unknown as { electron?: unknown }).electron;

    expect(isProjectViewCached()).toBe(false);
    expect(() => subscribeProjectViewLifecycle(vi.fn())).not.toThrow();
  });

  it("detaches the underlying IPC listeners on reset", () => {
    subscribeProjectViewLifecycle(vi.fn());

    __resetProjectViewCacheStateForTests();

    // All three, not just cached — a regression that forgot one would leak a
    // listener per reset.
    expect(stub.offSpies.cached).toHaveBeenCalledTimes(1);
    expect(stub.offSpies.warmActivated).toHaveBeenCalledTimes(1);
    expect(stub.offSpies.revealed).toHaveBeenCalledTimes(1);
  });
});
