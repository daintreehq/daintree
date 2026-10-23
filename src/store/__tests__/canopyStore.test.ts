// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { isCanopyUnread, type CanopySnapshot } from "@shared/types/ipc/canopy";
import { ALL_HOSTS_ID, useCanopyStore } from "../canopyStore";

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

  it("opens on All hosts again once it is chosen, until another host is", () => {
    useCanopyStore.getState().open();
    useCanopyStore.getState().setHostId(ALL_HOSTS_ID);
    useCanopyStore.getState().close();
    useCanopyStore.getState().open();
    expect(useCanopyStore.getState().hostId).toBe(ALL_HOSTS_ID);
    useCanopyStore.getState().close();
    useCanopyStore.getState().toggle();
    expect(useCanopyStore.getState().hostId).toBe(ALL_HOSTS_ID);

    useCanopyStore.getState().setHostId("studio");
    useCanopyStore.getState().close();
    useCanopyStore.getState().open();
    expect(useCanopyStore.getState().hostId).toBeNull();
  });

  it("restores All hosts in a view opened after the choice", async () => {
    useCanopyStore.getState().setHostId(ALL_HOSTS_ID);
    vi.resetModules();
    const reloaded = (await import("../canopyStore")).useCanopyStore;
    expect(reloaded.getState().hostId).toBe(ALL_HOSTS_ID);
    useCanopyStore.getState().setHostId(null);
    vi.resetModules();
    expect((await import("../canopyStore")).useCanopyStore.getState().hostId).toBeNull();
  });
});

describe("role filter", () => {
  afterEach(() => window.localStorage.removeItem("daintree-canopy-role"));
  const reload = async () => {
    vi.resetModules();
    return (await import("../canopyStore")).useCanopyStore;
  };

  it("shows every role until one is chosen, and keeps the choice across launches", async () => {
    const store = await reload();
    expect(store.getState().roleFilter).toBe("all");
    store.getState().setRoleFilter("assistants");
    expect((await reload()).getState().roleFilter).toBe("assistants");
  });

  it("falls back to every role for a stored value it doesn't know", async () => {
    window.localStorage.setItem("daintree-canopy-role", "everything");
    expect((await reload()).getState().roleFilter).toBe("all");
  });
});

describe("assistant handbacks seen", () => {
  const KEY = "daintree-canopy-assistant-handbacks";
  afterEach(() => window.localStorage.removeItem(KEY));
  const reload = async () => {
    vi.resetModules();
    return (await import("../canopyStore")).useCanopyStore;
  };

  it("keeps the newest handback seen, never an older one", async () => {
    const store = await reload();
    store.getState().seeAssistantHandback("a", 2_000);
    store.getState().seeAssistantHandback("a", 1_000);
    expect(store.getState().assistantHandbacksSeen.a).toBe(2_000);
    expect((await reload()).getState().assistantHandbacksSeen.a).toBe(2_000);
  });

  it("merges what a sibling view stored meanwhile, keeping the newest of each", async () => {
    const store = await reload();
    store.getState().seeAssistantHandback("a", 1_000);
    window.localStorage.setItem(KEY, JSON.stringify({ a: 5_000, b: 3_000 }));
    store.getState().seeAssistantHandback("c", 4_000);
    expect(store.getState().assistantHandbacksSeen).toEqual({ a: 5_000, b: 3_000, c: 4_000 });
  });
});

describe("assistant handbacks seen across views", () => {
  const KEY = "daintree-canopy-assistant-handbacks";
  afterEach(() => window.localStorage.removeItem(KEY));

  it("merges a sibling view's write rather than taking it whole", async () => {
    vi.resetModules();
    const store = (await import("../canopyStore")).useCanopyStore;
    store.getState().seeAssistantHandback("a", 2_000);
    // A sibling raced it, writing from a copy that never had "a".
    window.localStorage.setItem(KEY, JSON.stringify({ b: 1_000 }));
    window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
    expect(store.getState().assistantHandbacksSeen).toEqual({ a: 2_000, b: 1_000 });
  });
});
