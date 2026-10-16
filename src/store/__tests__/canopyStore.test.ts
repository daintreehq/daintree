// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { isCanopyUnread, type CanopySnapshot } from "@shared/types/ipc/canopy";
import { useCanopyStore } from "../canopyStore";

const SPAWNED = 1_000;

function mark(turn: number, readTurn: number, markedUnreadAt: number | null = null) {
  return { runId: "a", spawnedAt: SPAWNED, turn, readTurn, markedUnreadAt, version: 0 };
}

describe("isCanopyUnread", () => {
  it("has nothing unread on a run Canopy knows nothing about", () => {
    expect(isCanopyUnread(undefined)).toBe(false);
    expect(isCanopyUnread(null)).toBe(false);
  });

  it("is unread while a turn is unread, and read once read through it", () => {
    expect(isCanopyUnread(mark(3, 2))).toBe(true);
    expect(isCanopyUnread(mark(3, 3))).toBe(false);
  });

  it("stays unread when marked by hand, even with every turn read", () => {
    expect(isCanopyUnread(mark(3, 3, 9_000))).toBe(true);
  });
});

describe("mode", () => {
  const base = (mode: CanopySnapshot["mode"], sequence?: number): CanopySnapshot => ({
    ...(sequence !== undefined ? { sequence } : {}),
    mode,
    activated: mode === "on",
    tier: "free",
    dispositions: [],
    seen: [],
    reads: [],
    scope: null,
    active: false,
    busy: false,
    refreshedAt: null,
    cards: [],
    glances: [],
    lastError: null,
    failedRuns: [],
  });

  afterEach(() => useCanopyStore.setState({ mode: "unset", snapshot: null, isOpen: false }));

  it("takes the hydrated mode only until main has answered", () => {
    useCanopyStore.getState().seedMode("hidden");
    expect(useCanopyStore.getState().mode).toBe("hidden");
    useCanopyStore.getState().applySnapshot(base("on"));
    useCanopyStore.getState().seedMode("hidden");
    expect(useCanopyStore.getState().mode).toBe("on");
  });

  it("closes a panel held open when Canopy is hidden", () => {
    useCanopyStore.getState().applySnapshot(base("on"));
    useCanopyStore.getState().open();
    expect(useCanopyStore.getState().isOpen).toBe(true);
    useCanopyStore.getState().applySnapshot(base("hidden"));
    expect(useCanopyStore.getState().isOpen).toBe(false);
  });

  it("opens nothing while hidden, by open or by toggle", () => {
    useCanopyStore.getState().applySnapshot(base("hidden"));
    useCanopyStore.getState().open();
    expect(useCanopyStore.getState().isOpen).toBe(false);
    useCanopyStore.getState().toggle();
    expect(useCanopyStore.getState().isOpen).toBe(false);
  });

  it("never lets main's first answer, from before any service, paint over a newer push", () => {
    useCanopyStore.getState().applySnapshot(base("unset", 1));
    useCanopyStore.getState().applySnapshot(base("hidden", 0));
    expect(useCanopyStore.getState().mode).toBe("unset");
  });
});

describe("applySnapshot", () => {
  it("never lets an older snapshot paint over a newer one", () => {
    const snapshot = (sequence: number, refreshedAt: number): CanopySnapshot => ({
      sequence,
      refreshedAt,
      mode: "on",
      activated: true,
      tier: "free",
      dispositions: [],
      seen: [],
      reads: [],
      scope: null,
      active: false,
      busy: false,
      cards: [],
      glances: [],
      lastError: null,
      failedRuns: [],
    });
    useCanopyStore.setState({ snapshot: null, isOpen: false });
    useCanopyStore.getState().applySnapshot(snapshot(5, 500));
    useCanopyStore.getState().applySnapshot(snapshot(4, 400));
    expect(useCanopyStore.getState().snapshot?.refreshedAt).toBe(500);
    useCanopyStore.getState().applySnapshot(snapshot(6, 600));
    expect(useCanopyStore.getState().snapshot?.refreshedAt).toBe(600);
  });
});

describe("orders", () => {
  afterEach(() => window.localStorage.removeItem("daintree-canopy-order"));

  it("opens a view loaded later on the order last shown, to be placed afresh", async () => {
    useCanopyStore.getState().setOrder("all", { ids: ["b", "a"], rankedFor: 7, urgent: ["b"] });
    vi.resetModules();
    const { useCanopyStore: reloaded } = await import("../canopyStore");
    expect(reloaded.getState().orders.all).toEqual({
      ids: ["b", "a"],
      rankedFor: null,
      urgent: [],
    });
    expect(reloaded.getState().orders.project).toBeUndefined();
  });

  it("keeps each project's own order apart", async () => {
    const viewOf = async (projectId: string) => {
      window.history.replaceState(null, "", `/?projectId=${projectId}`);
      vi.resetModules();
      return (await import("../canopyStore")).useCanopyStore;
    };
    try {
      (await viewOf("p1")).getState().setOrder("project", { ids: ["x"], rankedFor: 1, urgent: [] });
      (await viewOf("p2")).getState().setOrder("project", { ids: ["y"], rankedFor: 1, urgent: [] });
      expect((await viewOf("p1")).getState().orders.project?.ids).toEqual(["x"]);
      expect((await viewOf("p2")).getState().orders.project?.ids).toEqual(["y"]);
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  it("never drops the scope another view saved", async () => {
    vi.resetModules();
    const { useCanopyStore: other } = await import("../canopyStore");
    useCanopyStore.getState().setOrder("all", { ids: ["a", "b"], rankedFor: 1, urgent: [] });
    other.getState().setOrder("project", { ids: ["c"], rankedFor: 1, urgent: [] });
    vi.resetModules();
    const { useCanopyStore: reloaded } = await import("../canopyStore");
    expect(reloaded.getState().orders.all?.ids).toEqual(["a", "b"]);
    expect(reloaded.getState().orders.project?.ids).toEqual(["c"]);
  });
});

describe("orders per host", () => {
  const stored = (): unknown =>
    JSON.parse(window.localStorage.getItem("daintree-canopy-order") ?? "{}");
  const reload = async () => {
    vi.resetModules();
    return (await import("../canopyStore")).useCanopyStore;
  };
  afterEach(() => {
    window.localStorage.removeItem("daintree-canopy-order");
    delete window.__DAINTREE_HOST_ID__;
  });

  it("keys each host's order by the host, and never mixes them", async () => {
    useCanopyStore.getState().setOrder("all", { ids: ["mine"], rankedFor: 1, urgent: [] });
    useCanopyStore.getState().setHostOrder("studio", { ids: ["theirs"], rankedFor: 1, urgent: [] });
    expect(stored()).toEqual({ "local|all": ["mine"], "studio|all": ["theirs"] });
    const reloaded = await reload();
    expect(reloaded.getState().orders.all?.ids).toEqual(["mine"]);
    expect(reloaded.getState().hostOrders.studio?.ids).toEqual(["theirs"]);
  });

  it("opens this machine on the order kept before orders were per host, and moves it", async () => {
    window.localStorage.setItem("daintree-canopy-order", JSON.stringify({ all: ["old"] }));
    const reloaded = await reload();
    expect(reloaded.getState().orders.all?.ids).toEqual(["old"]);
    reloaded.getState().setOrder("all", { ids: ["new"], rankedFor: 1, urgent: [] });
    expect(stored()).toEqual({ "local|all": ["new"] });
  });

  it("never opens another host's list on this machine's old order", async () => {
    window.localStorage.setItem("daintree-canopy-order", JSON.stringify({ all: ["old"] }));
    window.__DAINTREE_HOST_ID__ = { id: "studio" };
    const reloaded = await reload();
    // A window on the studio host: its own list is the studio's, which has no order yet.
    expect(reloaded.getState().orders.all).toBeUndefined();
    // This machine, shown from there, still opens on its own.
    expect(reloaded.getState().hostOrders.local?.ids).toEqual(["old"]);
  });
});

describe("the host shown", () => {
  afterEach(() => {
    useCanopyStore.setState({ isOpen: false, hostId: null, mode: "unset" });
    delete window.__DAINTREE_HOST_ID__;
  });

  it("opens on the window's own host every time", () => {
    useCanopyStore.getState().open();
    useCanopyStore.getState().setHostId("studio");
    expect(useCanopyStore.getState().hostId).toBe("studio");
    // Asked to open while already open: what it shows stands.
    useCanopyStore.getState().open();
    expect(useCanopyStore.getState().hostId).toBe("studio");
    useCanopyStore.getState().close();
    useCanopyStore.getState().toggle();
    expect(useCanopyStore.getState().hostId).toBeNull();
  });

  it("takes the window's own host as no other host", () => {
    window.__DAINTREE_HOST_ID__ = { id: "studio" };
    useCanopyStore.getState().setHostId("studio");
    expect(useCanopyStore.getState().hostId).toBeNull();
    useCanopyStore.getState().setHostId("local");
    expect(useCanopyStore.getState().hostId).toBe("local");
  });
});
