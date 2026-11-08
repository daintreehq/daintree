// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { isCanopyUnread, type CanopySnapshot } from "@shared/types/ipc/canopy";
import { ALL_HOSTS_ID, useCanopyStore } from "../canopyStore";
import { CANOPY_LIST_MAX_WIDTH, CANOPY_LIST_MIN_WIDTH } from "@/components/Canopy/canopyListWidth";
import { CANOPY_DOCK_MAX_WIDTH, CANOPY_DOCK_MIN_WIDTH } from "@/components/Canopy/canopyDockWidth";

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

  afterEach(() =>
    useCanopyStore.setState({ mode: "unset", snapshot: null, isOpen: false, outdatedHost: false })
  );

  it("holds a snapshot from a host on the hosted service inert, flagged, until it is updated", () => {
    const hosted = Object.assign(base("on", 1), { tier: "free" });
    const card = { runId: "a" } as CanopySnapshot["cards"][number];
    useCanopyStore.getState().applySnapshot({ ...hosted, cards: [card], glances: [] });
    const held = useCanopyStore.getState();
    expect(held.outdatedHost).toBe(true);
    expect(held.snapshot).toMatchObject({ activated: false, cards: [], glances: [] });
    // The next snapshot, from a host that reads locally, clears the flag and is taken whole.
    useCanopyStore.getState().applySnapshot({ ...base("on", 2), cards: [card] });
    expect(useCanopyStore.getState().outdatedHost).toBe(false);
    expect(useCanopyStore.getState().snapshot?.cards).toHaveLength(1);
  });

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
    useCanopyStore
      .getState()
      .setOrder("all", { ids: ["b", "a"], rankedFor: 7, urgent: ["b"], band: ["b"] });
    vi.resetModules();
    const { useCanopyStore: reloaded } = await import("../canopyStore");
    expect(reloaded.getState().orders.all).toEqual({
      ids: ["b", "a"],
      rankedFor: null,
      urgent: [],
      band: [],
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
      (await viewOf("p1"))
        .getState()
        .setOrder("project", { ids: ["x"], rankedFor: 1, urgent: [], band: [] });
      (await viewOf("p2"))
        .getState()
        .setOrder("project", { ids: ["y"], rankedFor: 1, urgent: [], band: [] });
      expect((await viewOf("p1")).getState().orders.project?.ids).toEqual(["x"]);
      expect((await viewOf("p2")).getState().orders.project?.ids).toEqual(["y"]);
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  it("never drops the scope another view saved", async () => {
    vi.resetModules();
    const { useCanopyStore: other } = await import("../canopyStore");
    useCanopyStore
      .getState()
      .setOrder("all", { ids: ["a", "b"], rankedFor: 1, urgent: [], band: [] });
    other.getState().setOrder("project", { ids: ["c"], rankedFor: 1, urgent: [], band: [] });
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
    useCanopyStore
      .getState()
      .setOrder("all", { ids: ["mine"], rankedFor: 1, urgent: [], band: [] });
    useCanopyStore
      .getState()
      .setHostOrder("studio", { ids: ["theirs"], rankedFor: 1, urgent: [], band: [] });
    expect(stored()).toEqual({ "local|all": ["mine"], "studio|all": ["theirs"] });
    const reloaded = await reload();
    expect(reloaded.getState().orders.all?.ids).toEqual(["mine"]);
    expect(reloaded.getState().hostOrders.studio?.ids).toEqual(["theirs"]);
  });

  it("opens this machine on the order kept before orders were per host, and moves it", async () => {
    window.localStorage.setItem("daintree-canopy-order", JSON.stringify({ all: ["old"] }));
    const reloaded = await reload();
    expect(reloaded.getState().orders.all?.ids).toEqual(["old"]);
    reloaded.getState().setOrder("all", { ids: ["new"], rankedFor: 1, urgent: [], band: [] });
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

describe("going back to a dictated reply (#14778)", () => {
  afterEach(() =>
    useCanopyStore.setState({
      isOpen: false,
      hostId: null,
      mode: "unset",
      replyReveal: null,
      resume: null,
      workOf: null,
    })
  );

  it("opens on the host the row was listed under and asks for that row", () => {
    expect(useCanopyStore.getState().revealReply({ runId: "run-1", hostScope: "studio" })).toBe(
      true
    );
    const state = useCanopyStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.hostId).toBe("studio");
    expect(state.replyReveal).toMatchObject({ runId: "run-1", hostScope: "studio" });
  });

  it("puts All hosts back for a row listed there, whatever the panel shows now", () => {
    useCanopyStore.getState().open();
    useCanopyStore.getState().setHostId("studio");
    useCanopyStore.getState().revealReply({ runId: "6.studio.run-1", hostScope: ALL_HOSTS_ID });
    expect(useCanopyStore.getState().hostId).toBe(ALL_HOSTS_ID);
    expect(useCanopyStore.getState().replyReveal).toMatchObject({
      runId: "6.studio.run-1",
      hostScope: ALL_HOSTS_ID,
    });
  });

  it("wins over a remembered place and drops another assistant's narrowing when it opens", () => {
    useCanopyStore.setState({
      hostId: "studio",
      resume: { at: Date.now(), hostId: "studio", query: "lint", runId: "run-9", order: [] },
      workOf: { assistantId: "a-1", name: "Planner" },
    });
    useCanopyStore.getState().revealReply({ runId: "run-1", hostScope: null });
    const state = useCanopyStore.getState();
    expect(state.resume).toBeNull();
    expect(state.workOf).toBeNull();
    expect(state.hostId).toBeNull();
  });

  it("keeps the open panel's narrowing to one assistant's work", () => {
    const workOf = { assistantId: "a-1", name: "Planner" };
    useCanopyStore.setState({ isOpen: true, workOf });
    useCanopyStore.getState().revealReply({ runId: "run-1", hostScope: null });
    expect(useCanopyStore.getState().workOf).toBe(workOf);
  });

  it("is dropped by every way the panel closes", () => {
    const ask = () => useCanopyStore.getState().revealReply({ runId: "run-1", hostScope: null });
    ask();
    useCanopyStore.getState().toggle();
    expect(useCanopyStore.getState().replyReveal).toBeNull();
    ask();
    useCanopyStore
      .getState()
      .closeForTerminal({ at: Date.now(), hostId: null, query: "", runId: "run-1", order: [] });
    expect(useCanopyStore.getState().replyReveal).toBeNull();
  });

  it("does nothing while Canopy is hidden", () => {
    useCanopyStore.setState({ mode: "hidden" });
    expect(useCanopyStore.getState().revealReply({ runId: "run-1", hostScope: null })).toBe(false);
    expect(useCanopyStore.getState().isOpen).toBe(false);
    expect(useCanopyStore.getState().replyReveal).toBeNull();
  });

  it("settles only the request it was given, and a close drops what is left", () => {
    useCanopyStore.getState().revealReply({ runId: "run-1", hostScope: null });
    const first = useCanopyStore.getState().replyReveal!;
    useCanopyStore.getState().revealReply({ runId: "run-2", hostScope: null });
    const second = useCanopyStore.getState().replyReveal!;
    expect(second.id).not.toBe(first.id);

    useCanopyStore.getState().settleReplyReveal(first.id);
    expect(useCanopyStore.getState().replyReveal).toBe(second);
    useCanopyStore.getState().close();
    expect(useCanopyStore.getState().replyReveal).toBeNull();

    // A request settled and asked again is a new one, apart from the first.
    useCanopyStore.getState().revealReply({ runId: "run-1", hostScope: null });
    const third = useCanopyStore.getState().replyReveal!;
    useCanopyStore.getState().settleReplyReveal(first.id);
    expect(useCanopyStore.getState().replyReveal).toBe(third);
    useCanopyStore.getState().settleReplyReveal(third.id);
    expect(useCanopyStore.getState().replyReveal).toBeNull();
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

describe("the reading offer's callout", () => {
  const KEY = "daintree-canopy-reading-offer-dismissed";
  afterEach(() => window.localStorage.removeItem(KEY));
  const reload = async () => {
    vi.resetModules();
    return (await import("../canopyStore")).useCanopyStore;
  };

  it("stays dismissed across launches once put away", async () => {
    const store = await reload();
    expect(store.getState().readingOfferDismissed).toBe(false);
    store.getState().dismissReadingOffer();
    expect(store.getState().readingOfferDismissed).toBe(true);
    expect((await reload()).getState().readingOfferDismissed).toBe(true);
  });

  it("goes from a sibling view as soon as that view dismisses it", async () => {
    const store = await reload();
    window.localStorage.setItem(KEY, "1");
    window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
    expect(store.getState().readingOfferDismissed).toBe(true);
  });

  it("isn't brought back by a sibling's storage being cleared", async () => {
    const store = await reload();
    store.getState().dismissReadingOffer();
    window.localStorage.removeItem(KEY);
    window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
    expect(store.getState().readingOfferDismissed).toBe(true);
  });
});

describe("the list's width", () => {
  const KEY = "daintree-canopy-list-width";
  afterEach(() => {
    window.localStorage.removeItem(KEY);
    // Every reload's storage listener stays on the window, this file's own store's too.
    useCanopyStore.setState({ listWidth: null });
  });
  const reload = async () => {
    vi.resetModules();
    return (await import("../canopyStore")).useCanopyStore;
  };

  it("keeps the width the user chose across launches, and forgets it on a reset", async () => {
    const store = await reload();
    expect(store.getState().listWidth).toBeNull();
    store.getState().setListWidth(600);
    expect((await reload()).getState().listWidth).toBe(600);
    (await reload()).getState().setListWidth(null);
    expect((await reload()).getState().listWidth).toBeNull();
  });

  it("holds a width inside its bounds, whether set here or read back", async () => {
    const store = await reload();
    store.getState().setListWidth(CANOPY_LIST_MIN_WIDTH - 100);
    expect(store.getState().listWidth).toBe(CANOPY_LIST_MIN_WIDTH);
    window.localStorage.setItem(KEY, String(CANOPY_LIST_MAX_WIDTH * 4));
    expect((await reload()).getState().listWidth).toBe(CANOPY_LIST_MAX_WIDTH);
    // Not a width at all, rather than one read off its leading digits.
    for (const stored of ["wide", "", " \t ", "600px"]) {
      window.localStorage.setItem(KEY, stored);
      expect((await reload()).getState().listWidth).toBeNull();
    }
  });

  it("ignores a width that isn't a number, keeping the one it has", async () => {
    const store = await reload();
    store.getState().setListWidth(600);
    for (const width of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      store.getState().setListWidth(width);
      expect(store.getState().listWidth).toBe(600);
      expect(window.localStorage.getItem(KEY)).toBe("600");
    }
  });

  it("resets past a sibling's width whose news hasn't reached this view yet", async () => {
    const store = await reload();
    window.localStorage.setItem(KEY, "700");
    store.getState().setListWidth(null);
    expect(window.localStorage.getItem(KEY)).toBeNull();
    window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
    expect(store.getState().listWidth).toBeNull();
  });

  it("follows a sibling view's width as soon as that view sets it", async () => {
    const store = await reload();
    window.localStorage.setItem(KEY, "700");
    window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
    expect(store.getState().listWidth).toBe(700);
    window.localStorage.removeItem(KEY);
    window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
    expect(store.getState().listWidth).toBeNull();
  });
});

describe("the docked global assistant (#16214)", () => {
  const DOCKED = "daintree-canopy-global-docked";
  const WIDTH = "daintree-canopy-dock-width";
  afterEach(() => {
    window.localStorage.removeItem(DOCKED);
    window.localStorage.removeItem(WIDTH);
    useCanopyStore.setState({ globalDocked: false, dockWidth: null });
  });
  const reload = async () => {
    vi.resetModules();
    return (await import("../canopyStore")).useCanopyStore;
  };

  it("starts undocked, and keeps the dock and its width across launches", async () => {
    const store = await reload();
    expect(store.getState().globalDocked).toBe(false);
    expect(store.getState().dockWidth).toBeNull();
    store.getState().setGlobalDocked(true);
    store.getState().setDockWidth(500);
    const reloaded = await reload();
    expect(reloaded.getState().globalDocked).toBe(true);
    expect(reloaded.getState().dockWidth).toBe(500);
    reloaded.getState().setGlobalDocked(false);
    reloaded.getState().setDockWidth(null);
    const again = await reload();
    expect(again.getState().globalDocked).toBe(false);
    expect(again.getState().dockWidth).toBeNull();
  });

  it("holds the width inside its bounds, and ignores one that isn't a number", async () => {
    const store = await reload();
    store.getState().setDockWidth(CANOPY_DOCK_MIN_WIDTH - 100);
    expect(store.getState().dockWidth).toBe(CANOPY_DOCK_MIN_WIDTH);
    store.getState().setDockWidth(Number.NaN);
    expect(store.getState().dockWidth).toBe(CANOPY_DOCK_MIN_WIDTH);
    for (const stored of ["wide", "", "500px"]) {
      window.localStorage.setItem(WIDTH, stored);
      expect((await reload()).getState().dockWidth).toBeNull();
    }
    window.localStorage.setItem(WIDTH, String(CANOPY_DOCK_MAX_WIDTH * 2));
    expect((await reload()).getState().dockWidth).toBe(CANOPY_DOCK_MAX_WIDTH);
  });

  it("follows a sibling view's dock and width as soon as that view sets them", async () => {
    const store = await reload();
    window.localStorage.setItem(DOCKED, "1");
    window.dispatchEvent(new StorageEvent("storage", { key: DOCKED }));
    expect(store.getState().globalDocked).toBe(true);
    window.localStorage.setItem(WIDTH, "640");
    window.dispatchEvent(new StorageEvent("storage", { key: WIDTH }));
    expect(store.getState().dockWidth).toBe(640);
    window.localStorage.removeItem(DOCKED);
    window.dispatchEvent(new StorageEvent("storage", { key: DOCKED }));
    expect(store.getState().globalDocked).toBe(false);
  });
});

describe("taking up a dialog popped out into the Canopy window (#16338)", () => {
  const place = {
    hostId: "local",
    query: "deploy failed",
    selection: { kind: "worker" as const, runId: "run-2" },
    roleFilter: "workers" as const,
    unreadOnly: true,
    keptUnread: ["run-2"],
    archivedExpanded: true,
    trashExpanded: true,
    workOf: { assistantId: "assistant-1", name: "Planner" },
  };

  afterEach(() => {
    useCanopyStore.setState({
      isOpen: false,
      hostId: null,
      mode: "unset",
      roleFilter: "all",
      unreadOnly: false,
      archivedExpanded: false,
      trashExpanded: false,
      workOf: null,
      resume: null,
      replyReveal: null,
      popOutLanding: null,
    });
    delete window.__DAINTREE_HOST_ID__;
    window.localStorage.clear();
  });

  it("carries each filter over at once, and asks to land on the dialog's search and row", () => {
    useCanopyStore.setState({ isOpen: true, mode: "on" });

    useCanopyStore.getState().receivePopOut(place);

    const state = useCanopyStore.getState();
    expect(state.roleFilter).toBe("workers");
    expect(state.unreadOnly).toBe(true);
    expect(state.archivedExpanded).toBe(true);
    expect(state.trashExpanded).toBe(true);
    expect(state.workOf).toEqual(place.workOf);

    // And back the other way, over a window that had them set.
    useCanopyStore.getState().receivePopOut({
      ...place,
      roleFilter: "assistants",
      unreadOnly: false,
      archivedExpanded: false,
      trashExpanded: false,
      workOf: null,
    });
    const again = useCanopyStore.getState();
    expect(again.roleFilter).toBe("assistants");
    expect(again.unreadOnly).toBe(false);
    expect(again.archivedExpanded).toBe(false);
    expect(again.trashExpanded).toBe(false);
    expect(again.workOf).toBeNull();
    useCanopyStore.getState().receivePopOut(place);
    expect(state.popOutLanding).toMatchObject({
      query: "deploy failed",
      selection: { kind: "worker", runId: "run-2" },
      keptUnread: ["run-2"],
    });
  });

  it("names the window's own host as its own, and any other host or All hosts as given", () => {
    useCanopyStore.getState().receivePopOut(place);
    expect(useCanopyStore.getState().hostId).toBeNull();
    expect(useCanopyStore.getState().popOutLanding?.hostId).toBeNull();

    useCanopyStore.getState().receivePopOut({ ...place, hostId: "studio" });
    expect(useCanopyStore.getState().hostId).toBe("studio");
    expect(useCanopyStore.getState().popOutLanding?.hostId).toBe("studio");

    useCanopyStore.getState().receivePopOut({ ...place, hostId: ALL_HOSTS_ID });
    expect(useCanopyStore.getState().hostId).toBe(ALL_HOSTS_ID);
  });

  it("saves none of it for the next view to open with", () => {
    window.localStorage.clear();

    useCanopyStore.getState().receivePopOut({ ...place, hostId: "studio" });

    expect(window.localStorage.length).toBe(0);
  });

  it("keeps no read rows when Unread wasn't on", () => {
    useCanopyStore.getState().receivePopOut({ ...place, unreadOnly: false });
    expect(useCanopyStore.getState().popOutLanding?.keptUnread).toEqual([]);
  });

  it("replaces a landing still waiting, and settles only the one asked", () => {
    useCanopyStore.setState({
      replyReveal: { id: 1, runId: "run-9", hostScope: null },
      resume: { at: Date.now(), hostId: null, query: "old", runId: "run-9", order: [] },
    });
    useCanopyStore.getState().receivePopOut(place);
    const first = useCanopyStore.getState().popOutLanding!.id;
    expect(useCanopyStore.getState().replyReveal).toBeNull();
    expect(useCanopyStore.getState().resume).toBeNull();

    useCanopyStore.getState().receivePopOut({ ...place, query: "newer" });
    const second = useCanopyStore.getState().popOutLanding!.id;
    expect(second).not.toBe(first);

    useCanopyStore.getState().settlePopOutLanding(first);
    expect(useCanopyStore.getState().popOutLanding?.id).toBe(second);
    useCanopyStore.getState().settlePopOutLanding(second);
    expect(useCanopyStore.getState().popOutLanding).toBeNull();
  });

  it("opens on the landing's host, and forgets the landing once put away", () => {
    useCanopyStore.setState({ mode: "on" });
    useCanopyStore.getState().receivePopOut({ ...place, hostId: "studio" });
    useCanopyStore.getState().open();
    expect(useCanopyStore.getState().hostId).toBe("studio");

    useCanopyStore.getState().close();
    expect(useCanopyStore.getState().popOutLanding).toBeNull();
  });

  it.each([
    ["toggled shut", () => useCanopyStore.getState().toggle()],
    [
      "left for a terminal",
      () =>
        useCanopyStore
          .getState()
          .closeForTerminal({ at: Date.now(), hostId: null, query: "", runId: "a", order: [] }),
    ],
    [
      "hidden",
      () =>
        useCanopyStore.getState().applySnapshot({
          mode: "hidden",
          activated: false,
          dispositions: [],
          seen: [],
          reads: [],
          scope: null,
          active: false,
          busy: false,
          refreshedAt: null,
          cards: [],
          lastError: null,
          failedRuns: [],
          glances: [],
        }),
    ],
    [
      "asked for a dictated reply",
      () => useCanopyStore.getState().revealReply({ runId: "run-1", hostScope: null }),
    ],
  ])("forgets the landing once %s", (_label, leave) => {
    useCanopyStore.setState({ mode: "on", isOpen: true });
    useCanopyStore.getState().receivePopOut(place);

    leave();

    expect(useCanopyStore.getState().popOutLanding).toBeNull();
  });
});
