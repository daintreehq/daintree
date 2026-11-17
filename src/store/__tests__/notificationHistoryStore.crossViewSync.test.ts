// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationHistoryEntry } from "../slices/notificationHistorySlice";

/**
 * Cross-view reads of the shared notification inbox (#17191). Each project view
 * is its own V8 context with its own copy of the store over one localStorage
 * key; a view is simulated by a fresh module instance (`vi.resetModules` +
 * dynamic import) over one shared backing map. A sibling's write reaches a view
 * as a `storage` event, or, for a view that was frozen while it landed, as the
 * reveal that brings it back.
 */

const STORAGE_KEY = "daintree-notification-history";
const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const FLUSH_MS = 400;

type PersistedBlob = {
  version: number;
  state: { entries: NotificationHistoryEntry[]; snoozedThreads: Record<string, number> };
};

const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function installLocalStorage(initial: Record<string, string>): Map<string, string> {
  const backing = new Map<string, string>(Object.entries(initial));
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => {
        backing.set(key, value);
      },
      removeItem: (key: string) => {
        backing.delete(key);
      },
    },
    configurable: true,
    writable: true,
  });
  return backing;
}

function restoreLocalStorage(): void {
  if (originalLocalStorageDescriptor) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
    return;
  }
  delete (globalThis as Partial<typeof globalThis>).localStorage;
}

function makeEntry(overrides: Partial<NotificationHistoryEntry> = {}): NotificationHistoryEntry {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    type: overrides.type ?? "info",
    message: overrides.message ?? "msg",
    timestamp: overrides.timestamp ?? NOW - HOUR,
    seenAsToast: overrides.seenAsToast ?? false,
    summarized: overrides.summarized ?? false,
    countable: overrides.countable ?? true,
    archivedAt: overrides.archivedAt ?? null,
    correlationId: overrides.correlationId,
    supersedeKey: overrides.supersedeKey,
  };
}

function seed(
  entries: NotificationHistoryEntry[],
  snoozedThreads: Record<string, number> = {}
): Record<string, string> {
  return { [STORAGE_KEY]: JSON.stringify({ version: 2, state: { entries, snoozedThreads } }) };
}

function readBlob(backing: Map<string, string>): PersistedBlob {
  const blob: PersistedBlob = JSON.parse(backing.get(STORAGE_KEY)!);
  return blob;
}

type Listener = () => void;
const revealListeners = new Set<Listener>();
const warmActivatedListeners = new Set<Listener>();

function installElectronApp(): void {
  Object.defineProperty(window, "electron", {
    value: {
      app: {
        onViewRevealed: (callback: Listener) => {
          revealListeners.add(callback);
          return () => revealListeners.delete(callback);
        },
        onViewWarmActivated: (callback: Listener) => {
          warmActivatedListeners.add(callback);
          return () => warmActivatedListeners.delete(callback);
        },
      },
    },
    writable: true,
    configurable: true,
  });
}

function reveal(): void {
  for (const listener of [...revealListeners]) listener();
}

function warmActivate(): void {
  for (const listener of [...warmActivatedListeners]) listener();
}

/** Main's broadcast of a sibling's write: every other view hears it. */
function announceSiblingWrite(): void {
  window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
}

/** Loads a fresh copy of the store, as a newly built project view would. */
async function openView() {
  vi.resetModules();
  const module = await import("../slices/notificationHistorySlice");
  vi.advanceTimersByTime(FLUSH_MS);
  return module;
}

/** Loads a fresh view with its own `notify()` over its own store. */
async function openNotifyingView() {
  vi.resetModules();
  const history = await import("../slices/notificationHistorySlice");
  const { notify } = await import("../../lib/notify");
  vi.advanceTimersByTime(FLUSH_MS);
  return { store: history.useNotificationHistoryStore, notify };
}

function flush(): void {
  vi.advanceTimersByTime(FLUSH_MS);
}

describe("notificationHistoryStore cross-view sync (#17191)", () => {
  let addEventListenerSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    addEventListenerSpy = vi.spyOn(window, "addEventListener");
  });

  afterEach(() => {
    // Every module instance installs its own app-lifetime listener on the one
    // jsdom window; a stale view from an earlier test must not answer this
    // file's later events.
    for (const [type, listener] of addEventListenerSpy.mock.calls) {
      window.removeEventListener(type as string, listener as EventListener);
    }
    revealListeners.clear();
    warmActivatedListeners.clear();
    delete (window as { electron?: unknown }).electron;
    vi.useRealTimers();
    restoreLocalStorage();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  describe("a sibling's write", () => {
    it("takes up a sibling's read, archive, dismissal and addition", async () => {
      installLocalStorage(
        seed([
          makeEntry({ id: "read-there", timestamp: NOW - HOUR }),
          makeEntry({ id: "archived-there", timestamp: NOW - 2 * HOUR }),
          makeEntry({ id: "dismissed-there", timestamp: NOW - 3 * HOUR }),
        ])
      );
      const viewA = (await openView()).useNotificationHistoryStore;
      const viewB = (await openView()).useNotificationHistoryStore;
      expect(viewA.getState().unreadCount).toBe(3);

      viewB.getState().markIdsRead(["read-there"]);
      viewB.getState().archiveEntry("archived-there");
      viewB.getState().dismissEntry("dismissed-there");
      const addedId = viewB.getState().addEntry({ type: "error", message: "from B" });
      flush();
      announceSiblingWrite();

      const state = viewA.getState();
      expect(state.entries.map((e) => e.id)).toEqual([addedId, "read-there", "archived-there"]);
      expect(state.entries.find((e) => e.id === "read-there")?.seenAsToast).toBe(true);
      expect(state.entries.find((e) => e.id === "archived-there")?.archivedAt).not.toBeNull();
      expect(state.unreadCount).toBe(1);
    });

    it("takes up a sibling's snooze and its clear", async () => {
      installLocalStorage(seed([makeEntry({ id: "threaded", correlationId: "thread-1" })]));
      const viewA = (await openView()).useNotificationHistoryStore;
      const viewB = (await openView()).useNotificationHistoryStore;

      viewB.getState().snoozeThread("thread-1", NOW + DAY);
      flush();
      announceSiblingWrite();
      expect(viewA.getState().snoozedThreads).toEqual({ "thread-1": NOW + DAY });
      expect(viewA.getState().unreadCount).toBe(0);

      viewB.getState().clearAll();
      flush();
      announceSiblingWrite();
      expect(viewA.getState().entries).toEqual([]);
      expect(viewA.getState().snoozedThreads).toEqual({});
    });

    it("keeps a change this view hasn't written yet", async () => {
      const backing = installLocalStorage(seed([makeEntry({ id: "mine" })]));
      const viewA = (await openView()).useNotificationHistoryStore;
      const viewB = (await openView()).useNotificationHistoryStore;

      const siblingId = viewB.getState().addEntry({ type: "info", message: "from B" });
      flush();
      viewA.getState().markIdsRead(["mine"]);
      announceSiblingWrite();

      expect(viewA.getState().entries.find((e) => e.id === "mine")?.seenAsToast).toBe(true);
      expect(viewA.getState().entries.some((e) => e.id === siblingId)).toBe(true);
      expect(readBlob(backing).state.entries.find((e) => e.id === "mine")?.seenAsToast).toBe(true);
    });

    it("keeps the rows this view already summarized out of the next summary", async () => {
      installLocalStorage(seed([makeEntry({ id: "summed" })]));
      const viewA = (await openView()).useNotificationHistoryStore;
      const viewB = (await openView()).useNotificationHistoryStore;

      viewA.getState().markSummarized(["summed"]);
      viewB.getState().addEntry({ type: "info", message: "from B" });
      flush();
      announceSiblingWrite();

      expect(viewA.getState().entries.find((e) => e.id === "summed")?.summarized).toBe(true);
    });

    it("ignores a write to another key", async () => {
      installLocalStorage(seed([makeEntry({ id: "kept" })]));
      const viewA = (await openView()).useNotificationHistoryStore;
      const before = viewA.getState().entries;

      window.dispatchEvent(new StorageEvent("storage", { key: "some-other-key" }));

      expect(viewA.getState().entries).toBe(before);
    });
  });

  describe("a reveal", () => {
    it("catches up a view that missed a sibling's write while frozen", async () => {
      installElectronApp();
      installLocalStorage(seed([makeEntry({ id: "read-there" })]));
      const viewA = (await openView()).useNotificationHistoryStore;
      const viewB = (await openView()).useNotificationHistoryStore;

      viewB.getState().markIdsRead(["read-there"]);
      const addedId = viewB.getState().addEntry({ type: "info", message: "while away" });
      flush();
      expect(viewA.getState().unreadCount).toBe(1);

      warmActivate();

      expect(viewA.getState().entries.map((e) => e.id)).toEqual([addedId, "read-there"]);
      expect(viewA.getState().unreadCount).toBe(1);
      expect(viewA.getState().entries.find((e) => e.id === "read-there")?.seenAsToast).toBe(true);
    });

    it("catches up on the reveal itself", async () => {
      installElectronApp();
      installLocalStorage(seed([]));
      const viewA = (await openView()).useNotificationHistoryStore;
      const viewB = (await openView()).useNotificationHistoryStore;

      const addedId = viewB.getState().addEntry({ type: "info", message: "while away" });
      flush();
      reveal();

      expect(viewA.getState().entries.map((e) => e.id)).toContain(addedId);
    });

    it("keeps the rows a sibling left alone as the objects this view holds", async () => {
      installElectronApp();
      installLocalStorage(seed([makeEntry({ id: "untouched" }), makeEntry({ id: "read-there" })]));
      const viewA = (await openView()).useNotificationHistoryStore;
      const viewB = (await openView()).useNotificationHistoryStore;
      const untouched = viewA.getState().entries.find((e) => e.id === "untouched");

      viewB.getState().markIdsRead(["read-there"]);
      flush();
      announceSiblingWrite();

      expect(viewA.getState().entries.find((e) => e.id === "untouched")).toBe(untouched);
      expect(viewA.getState().entries.find((e) => e.id === "read-there")?.seenAsToast).toBe(true);
    });

    it("leaves the entries alone when nothing changed while away", async () => {
      installElectronApp();
      installLocalStorage(seed([makeEntry({ id: "kept" })]));
      const viewA = (await openView()).useNotificationHistoryStore;
      const before = viewA.getState().entries;

      warmActivate();
      reveal();

      expect(viewA.getState().entries).toBe(before);
    });
  });

  describe("an event every view hears (host broadcasts)", () => {
    it("holds one row when two views file the same id", async () => {
      const backing = installLocalStorage(seed([makeEntry({ id: "existing" })]));
      const viewA = (await openView()).useNotificationHistoryStore;
      const viewB = (await openView()).useNotificationHistoryStore;

      viewA.getState().addEntry({ id: "host-event-1", type: "info", message: "Project slept" });
      viewB.getState().addEntry({ id: "host-event-1", type: "info", message: "Project slept" });
      flush();

      const ids = readBlob(backing).state.entries.map((e) => e.id);
      expect(ids.filter((id) => id === "host-event-1")).toHaveLength(1);
      expect(ids).toContain("existing");
    });

    it("changes nothing when this view already holds the id", async () => {
      installLocalStorage(seed([]));
      const view = (await openView()).useNotificationHistoryStore;

      view.getState().addEntry({ id: "host-event-1", type: "info", message: "first" });
      view.getState().archiveEntry("host-event-1");
      const before = view.getState().entries;
      const returned = view
        .getState()
        .addEntry({ id: "host-event-1", type: "info", message: "again" });

      expect(returned).toBe("host-event-1");
      expect(view.getState().entries).toBe(before);
    });

    it("keeps the toasted copy read when a hidden view's unread copy lands first", async () => {
      const backing = installLocalStorage(seed([]));
      const focused = (await openView()).useNotificationHistoryStore;
      const hidden = await openView();

      hidden.useNotificationHistoryStore
        .getState()
        .addEntry({ id: "host-event-1", type: "info", message: "Park released" });
      hidden.flushNotificationHistory();
      focused.getState().addEntry({
        id: "host-event-1",
        type: "info",
        message: "Park released",
        seenAsToast: true,
      });
      flush();

      const row = readBlob(backing).state.entries.find((e) => e.id === "host-event-1");
      expect(row?.seenAsToast).toBe(true);
    });

    it("files one inbox row however many views hear the broadcast", async () => {
      const backing = installLocalStorage(seed([]));
      const views = [
        await openNotifyingView(),
        await openNotifyingView(),
        await openNotifyingView(),
      ];

      for (const view of views) {
        view.notify({
          type: "info",
          title: "Projects slept",
          message: "Put to sleep to free memory.",
          priority: "low",
          historyId: "idle-background-closed:idle:1",
        });
      }
      flush();

      const rows = readBlob(backing).state.entries.filter(
        (e) => e.id === "idle-background-closed:idle:1"
      );
      expect(rows).toHaveLength(1);
    });

    it("files no second row in a view that already took up a sibling's", async () => {
      const backing = installLocalStorage(seed([]));
      const early = await openNotifyingView();
      const late = await openNotifyingView();
      const event = {
        type: "info" as const,
        title: "Park released",
        message: "A parked agent — its gate came free",
        priority: "low" as const,
        historyId: "park-released:run-1:1",
      };

      early.notify(event);
      announceSiblingWrite();
      const before = late.store.getState().entries;
      late.notify(event);
      flush();

      expect(late.store.getState().entries).toBe(before);
      expect(readBlob(backing).state.entries.map((e) => e.id)).toEqual(["park-released:run-1:1"]);
    });

    it("reads a held row as seen when this view shows it as a toast", async () => {
      installLocalStorage(seed([]));
      const hidden = (await openView()).useNotificationHistoryStore;
      const focused = (await openView()).useNotificationHistoryStore;

      hidden.getState().addEntry({ id: "host-event-1", type: "info", message: "Park released" });
      announceSiblingWrite();
      expect(focused.getState().unreadCount).toBe(1);

      focused.getState().addEntry({
        id: "host-event-1",
        type: "info",
        message: "Park released",
        seenAsToast: true,
      });

      expect(focused.getState().entries).toHaveLength(1);
      expect(focused.getState().unreadCount).toBe(0);
    });

    it("doesn't bring back a row dismissed while a frozen view that filed it waited to thaw", async () => {
      const backing = installLocalStorage(seed([]));
      const frozen = (await openView()).useNotificationHistoryStore;
      const active = (await openView()).useNotificationHistoryStore;

      // A frozen view's IPC handlers run; its timers wait for the thaw.
      frozen.getState().addEntry({ id: "host-event-1", type: "info", message: "Project slept" });
      active.getState().addEntry({ id: "host-event-1", type: "info", message: "Project slept" });
      active.getState().dismissEntry("host-event-1");
      frozen.getState().addEntry({ type: "info", message: "pending until the thaw" });
      flush();

      expect(readBlob(backing).state.entries.some((e) => e.id === "host-event-1")).toBe(false);
    });
  });
});

describe("notify() for an event every view hears, rate-limited (#17191)", () => {
  afterEach(() => {
    vi.useRealTimers();
    restoreLocalStorage();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("keeps the event's own row and adds no summary row beside it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    installLocalStorage(seed([]));
    const view = await openNotifyingView();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);

    for (const n of [1, 2, 3]) {
      view.notify({ type: "info", message: `burst ${n}`, rateLimitKey: "park" });
    }
    const returned = view.notify({
      type: "info",
      title: "Park released",
      message: "A parked agent — its gate came free",
      rateLimitKey: "park",
      historyId: "park-released:run-1:1",
    });

    const active = view.store.getState().entries.filter((e) => !e.archivedAt);
    expect(returned).toBe("");
    expect(active.map((e) => e.id)).toContain("park-released:run-1:1");
    expect(active.map((e) => e.message).sort()).toEqual([
      "A parked agent — its gate came free",
      "burst 1",
      "burst 2",
      "burst 3",
    ]);
  });
});
