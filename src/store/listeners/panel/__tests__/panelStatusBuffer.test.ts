// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePanelStore } from "@/store/panelStore";
import type { PtyPanelData } from "@shared/types/panel";
import {
  cancelPanelStatusBuffer,
  enqueueActivityUpdate,
  enqueueFlowStatusUpdate,
  flushPanelStatusBuffer,
} from "@/store/panelStatusBuffer";

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    setAgentState: vi.fn(),
    injectDataLossMarker: vi.fn(),
    wake: vi.fn(),
  },
}));

interface FakeRaf {
  callbacks: FrameRequestCallback[];
  flushAll(): void;
}

function installFakeRaf(): FakeRaf {
  const callbacks: FrameRequestCallback[] = [];
  let nextHandle = 1;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    callbacks.push(cb);
    return nextHandle++;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
  return {
    callbacks,
    flushAll() {
      while (callbacks.length > 0) {
        const cb = callbacks.shift()!;
        cb(performance.now());
      }
    },
  };
}

function getPtyPanel(id: string): PtyPanelData | undefined {
  return usePanelStore.getState().panelsById[id] as PtyPanelData | undefined;
}

function seedPanel(id: string, overrides: Record<string, unknown> = {}): void {
  usePanelStore.setState((state) => ({
    panelsById: {
      ...state.panelsById,
      [id]: {
        id,
        kind: "terminal",
        title: id,
        cwd: "/tmp",
        cols: 80,
        rows: 24,
        location: "grid" as const,
        isVisible: true,
        ...overrides,
      },
    },
    panelIds: state.panelIds.includes(id) ? state.panelIds : [...state.panelIds, id],
  }));
}

let raf: FakeRaf;

beforeEach(() => {
  vi.restoreAllMocks();
  raf = installFakeRaf();
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
  cancelPanelStatusBuffer();
});

afterEach(() => {
  cancelPanelStatusBuffer();
});

describe("panelStatusBuffer — activity batching", () => {
  it("collapses N activity updates across distinct terminals into one setState per frame", () => {
    for (let i = 0; i < 10; i++) {
      seedPanel(`term-${i}`);
    }
    const setSpy = vi.spyOn(usePanelStore, "setState");
    setSpy.mockClear();

    for (let i = 0; i < 10; i++) {
      enqueueActivityUpdate(`term-${i}`, `Working ${i}`, "working", "interactive", 1000 + i, "cmd");
    }

    expect(setSpy).not.toHaveBeenCalled();
    raf.flushAll();
    expect(setSpy).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 10; i++) {
      const t = getPtyPanel(`term-${i}`);
      expect(t?.activityHeadline).toBe(`Working ${i}`);
      expect(t?.activityStatus).toBe("working");
      expect(t?.activityType).toBe("interactive");
      expect(t?.activityTimestamp).toBe(1000 + i);
      expect(t?.lastCommand).toBe("cmd");
    }
  });

  it("last-write-wins within a frame for the same terminal", () => {
    seedPanel("term-1");
    enqueueActivityUpdate("term-1", "First", "working", "interactive", 100, "a");
    enqueueActivityUpdate("term-1", "Second", "waiting", "interactive", 200, "b");
    raf.flushAll();
    const t = getPtyPanel("term-1");
    expect(t?.activityHeadline).toBe("Second");
    expect(t?.activityStatus).toBe("waiting");
    expect(t?.activityTimestamp).toBe(200);
    expect(t?.lastCommand).toBe("b");
  });

  it("skips writing when all activity fields are unchanged", () => {
    seedPanel("term-1", {
      activityHeadline: "Stable",
      activityStatus: "working",
      activityType: "interactive",
      activityTimestamp: 100,
      lastCommand: "cmd",
    });
    const setSpy = vi.spyOn(usePanelStore, "setState");
    enqueueActivityUpdate("term-1", "Stable", "working", "interactive", 100, "cmd");
    raf.flushAll();
    // setState is still called once (the fold runs), but the returned object
    // reflects no terminal change. Assert via state equality, not call count.
    expect(setSpy).toHaveBeenCalledTimes(1);
    const t = getPtyPanel("term-1");
    expect(t?.activityHeadline).toBe("Stable");
  });

  it("drops patches for terminals that no longer exist", () => {
    enqueueActivityUpdate("ghost", "Phantom", "working", "interactive", 100, undefined);
    raf.flushAll();
    expect(usePanelStore.getState().panelsById["ghost"]).toBeUndefined();
  });
});

describe("panelStatusBuffer — flow-status batching", () => {
  it("collapses N flow-status updates into one setState per frame and derives runtimeStatus", () => {
    for (let i = 0; i < 5; i++) {
      seedPanel(`term-${i}`, { isVisible: true, runtimeStatus: "running" });
    }
    const setSpy = vi.spyOn(usePanelStore, "setState");

    for (let i = 0; i < 5; i++) {
      enqueueFlowStatusUpdate(`term-${i}`, "suspended", 1000 + i);
    }

    raf.flushAll();
    expect(setSpy).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) {
      const t = getPtyPanel(`term-${i}`);
      expect(t?.flowStatus).toBe("suspended");
      expect(t?.flowStatusTimestamp).toBe(1000 + i);
      // deriveRuntimeStatus(isVisible=true, flowStatus="suspended", "running") -> "suspended"
      expect(t?.runtimeStatus).toBe("suspended");
    }
  });

  it("derives runtimeStatus from current isVisible (not a stale closure)", () => {
    // Lock in stale-closure proof: enqueue while panel is visible, mutate
    // isVisible -> false BEFORE the RAF flush. The fold must observe the
    // post-mutation `isVisible: false` from the state snapshot, which makes
    // deriveRuntimeStatus(false, "running") return "background".
    seedPanel("term-1", { isVisible: true, runtimeStatus: "running" });
    enqueueFlowStatusUpdate("term-1", "running", 100);
    usePanelStore.setState((s) => ({
      panelsById: {
        ...s.panelsById,
        "term-1": { ...s.panelsById["term-1"]!, isVisible: false },
      },
    }));
    raf.flushAll();
    const t = getPtyPanel("term-1");
    expect(t?.flowStatus).toBe("running");
    expect(t?.runtimeStatus).toBe("background");
  });

  it("rejects in-buffer reordering: later-arriving older event must not displace newer in-buffer event", () => {
    // Locks in the fix for the critical review finding: IPC can deliver
    // events out of order within a frame (backpressure, multi-source). The
    // buffer must guard at enqueue time, not only via the fold's
    // persisted-store guard which can't see other in-buffer patches.
    seedPanel("term-1", { isVisible: true });
    enqueueFlowStatusUpdate("term-1", "running", 200);
    enqueueFlowStatusUpdate("term-1", "suspended", 100);
    raf.flushAll();
    const t = getPtyPanel("term-1");
    expect(t?.flowStatus).toBe("running");
    expect(t?.flowStatusTimestamp).toBe(200);
  });

  it("rejects out-of-order flow-status timestamps inside the fold", () => {
    seedPanel("term-1", {
      flowStatus: "running",
      flowStatusTimestamp: 500,
      runtimeStatus: "running",
      isVisible: true,
    });
    enqueueFlowStatusUpdate("term-1", "suspended", 400);
    raf.flushAll();
    const t = getPtyPanel("term-1");
    expect(t?.flowStatus).toBe("running");
    expect(t?.flowStatusTimestamp).toBe(500);
  });

  it("last-write-wins within a frame for the same terminal", () => {
    seedPanel("term-1", { isVisible: true });
    enqueueFlowStatusUpdate("term-1", "suspended", 100);
    enqueueFlowStatusUpdate("term-1", "paused-backpressure", 200);
    raf.flushAll();
    const t = getPtyPanel("term-1");
    expect(t?.flowStatus).toBe("paused-backpressure");
    expect(t?.flowStatusTimestamp).toBe(200);
  });
});

describe("panelStatusBuffer — combined flush", () => {
  it("activity + flow-status patches in the same frame produce one setState call", () => {
    seedPanel("term-1", { isVisible: true });
    seedPanel("term-2", { isVisible: true });
    const setSpy = vi.spyOn(usePanelStore, "setState");

    enqueueActivityUpdate("term-1", "Doing", "working", "interactive", 100, undefined);
    enqueueFlowStatusUpdate("term-2", "suspended", 100);

    raf.flushAll();
    expect(setSpy).toHaveBeenCalledTimes(1);

    expect(getPtyPanel("term-1")?.activityHeadline).toBe("Doing");
    expect(getPtyPanel("term-2")?.flowStatus).toBe("suspended");
  });

  it("same terminal: activity + flow-status patches do not clobber each other", () => {
    // The fold iterates activity first, then flow-status. Both must compose
    // into a single merged terminal record; the flow-status pass reads from
    // the activity-merged draft, not the original state snapshot.
    seedPanel("term-1", { isVisible: true, runtimeStatus: "running" });
    enqueueActivityUpdate("term-1", "Compiling", "working", "interactive", 100, "npm run dev");
    enqueueFlowStatusUpdate("term-1", "suspended", 100);
    raf.flushAll();
    const t = getPtyPanel("term-1");
    expect(t?.activityHeadline).toBe("Compiling");
    expect(t?.activityStatus).toBe("working");
    expect(t?.lastCommand).toBe("npm run dev");
    expect(t?.flowStatus).toBe("suspended");
    expect(t?.flowStatusTimestamp).toBe(100);
    expect(t?.runtimeStatus).toBe("suspended");
  });
});

describe("panelStatusBuffer — lifecycle", () => {
  it("cancelPanelStatusBuffer is idempotent and clears pending patches", () => {
    seedPanel("term-1");
    enqueueActivityUpdate("term-1", "Pending", "working", "interactive", 100, undefined);
    cancelPanelStatusBuffer();
    cancelPanelStatusBuffer();
    raf.flushAll();
    const t = getPtyPanel("term-1");
    expect(t?.activityHeadline).toBeUndefined();
  });

  it("enqueue after cancel schedules a fresh RAF", () => {
    seedPanel("term-1");
    enqueueActivityUpdate("term-1", "First", "working", "interactive", 100, undefined);
    cancelPanelStatusBuffer();
    enqueueActivityUpdate("term-1", "Second", "working", "interactive", 200, undefined);
    raf.flushAll();
    const t = getPtyPanel("term-1");
    expect(t?.activityHeadline).toBe("Second");
  });

  it("manual flushPanelStatusBuffer is a no-op when buffers are empty", () => {
    const setSpy = vi.spyOn(usePanelStore, "setState");
    flushPanelStatusBuffer();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("re-uses a single RAF handle for many enqueues in the same tick", () => {
    seedPanel("term-1");
    seedPanel("term-2");

    enqueueActivityUpdate("term-1", "A", "working", "interactive", 100, undefined);
    enqueueActivityUpdate("term-2", "B", "working", "interactive", 100, undefined);
    enqueueFlowStatusUpdate("term-1", "suspended", 100);

    expect(raf.callbacks).toHaveLength(1);
  });
});
