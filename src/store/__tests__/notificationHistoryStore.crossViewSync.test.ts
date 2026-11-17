// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
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

function entryById(backing: Map<string, string>, id: string): NotificationHistoryEntry | undefined {
  return readBlob(backing).state.entries.find((e) => e.id === id);
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

/** Loads a fresh view with its own `notify()`, inbox, toaster and announcer. */
async function openNotifyingView() {
  vi.resetModules();
  const history = await import("../slices/notificationHistorySlice");
  const { notify } = await import("../../lib/notify");
  const { useNotificationStore } = await import("../notificationStore");
  const { useAnnouncerStore } = await import("../accessibilityAnnouncerStore");
  vi.advanceTimersByTime(FLUSH_MS);
  return {
    store: history.useNotificationHistoryStore,
    toasts: useNotificationStore,
    announcer: useAnnouncerStore,
    notify,
  };
}

function flush(): void {
  vi.advanceTimersByTime(FLUSH_MS);
}

describe("notificationHistoryStore cross-view sync (#17191)", () => {
  let addEventListenerSpy: MockInstance<typeof window.addEventListener>;

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
      window.removeEventListener(type, listener);
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
      viewB.getState().markIdsRead(["summed"]);
      const siblingId = viewB.getState().addEntry({ type: "info", message: "from B" });
      flush();
      announceSiblingWrite();

      const summed = viewA.getState().entries.find((e) => e.id === "summed");
      expect(viewA.getState().entries.some((e) => e.id === siblingId)).toBe(true);
      expect(summed).toMatchObject({ seenAsToast: true, summarized: true });
    });

    it("keeps an old row this view just marked read, so its Undo still finds it", async () => {
      const backing = installLocalStorage(
        seed([makeEntry({ id: "old", timestamp: NOW - 8 * DAY })])
      );
      const viewA = (await openView()).useNotificationHistoryStore;
      const viewB = (await openView()).useNotificationHistoryStore;

      viewA.getState().markIdsRead(["old"]);
      viewB.getState().addEntry({ type: "info", message: "from B" });
      flush();
      announceSiblingWrite();
      viewA.getState().markUnseenAsToast("old", { silent: true });
      flush();

      expect(entryById(backing, "old")?.seenAsToast).toBe(false);
    });

    it("takes up a sibling's copy of a row whose held archive hydration would drop", async () => {
      // Archived while the clock ran ahead; back on time, a sibling's write
      // carries the row active, and this view must show it as everyone does.
      installLocalStorage(seed([makeEntry({ id: "row" })]));
      const viewA = (await openView()).useNotificationHistoryStore;
      vi.setSystemTime(NOW + 10 * 60_000);
      viewA.getState().archiveEntry("row");
      flush();
      vi.setSystemTime(NOW);
      const viewB = (await openView()).useNotificationHistoryStore;
      viewB.getState().addEntry({ type: "info", message: "from B" });
      flush();
      announceSiblingWrite();

      expect(viewA.getState().entries.find((e) => e.id === "row")?.archivedAt).toBeNull();
    });

    it("ignores a write to another key", async () => {
      const backing = installLocalStorage(seed([makeEntry({ id: "kept" })]));
      const viewA = (await openView()).useNotificationHistoryStore;
      const before = viewA.getState().entries;
      backing.set(STORAGE_KEY, seed([makeEntry({ id: "not-yet-announced" })])[STORAGE_KEY]!);

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
      const rehydrate = vi.spyOn(viewA.persist, "rehydrate");

      warmActivate();
      reveal();

      expect(rehydrate).toHaveBeenCalledTimes(2);
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

      expect(readBlob(backing).state.entries.map((e) => e.id)).toEqual([
        "host-event-1",
        "existing",
      ]);
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
          historyId: "idle-background-closed:1:p1",
          context: { eventKind: "host" },
        });
      }
      flush();

      expect(readBlob(backing).state.entries.map((e) => e.id)).toEqual([
        "idle-background-closed:1:p1",
      ]);
    });

    it("toasts once, in the focused view, on the row a hidden view filed first", async () => {
      const backing = installLocalStorage(seed([]));
      const hidden = await openNotifyingView();
      const focused = await openNotifyingView();
      const event = {
        type: "info" as const,
        title: "Park released",
        message: "Fix the auth redirect — its gate came free",
        historyId: "park-released:run-1:1",
        context: { eventKind: "agent" as const },
      };
      const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);

      expect(hidden.notify(event)).toBe("");
      announceSiblingWrite();
      hasFocus.mockReturnValue(true);
      const toastId = focused.notify(event);
      flush();

      expect(toastId).not.toBe("");
      expect(focused.toasts.getState().notifications.map((n) => n.historyEntryId)).toEqual([
        "park-released:run-1:1",
      ]);
      expect(hidden.toasts.getState().notifications).toEqual([]);
      expect(readBlob(backing).state.entries).toMatchObject([
        { id: "park-released:run-1:1", seenAsToast: true },
      ]);
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
        context: { eventKind: "agent" as const },
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

  describe("a host event its source's rate limit holds back", () => {
    it("keeps the event's own unread row, announces it, and adds no summary row", async () => {
      installLocalStorage(seed([]));
      const view = await openNotifyingView();
      vi.spyOn(document, "hasFocus").mockReturnValue(true);

      for (const n of [1, 2, 3]) {
        view.notify({
          type: "info",
          message: `burst ${n}`,
          rateLimitKey: "park",
          context: { eventKind: "agent" },
        });
      }
      const returned = view.notify({
        type: "info",
        title: "Park released",
        message: "A parked agent — its gate came free",
        rateLimitKey: "park",
        historyId: "park-released:run-1:1",
        context: { eventKind: "agent" },
      });

      const active = view.store.getState().entries.filter((e) => !e.archivedAt);
      expect(returned).toBe("");
      expect(view.toasts.getState().notifications).toHaveLength(3);
      expect(active.find((e) => e.id === "park-released:run-1:1")?.seenAsToast).toBe(false);
      expect(active.map((e) => e.message).sort()).toEqual([
        "A parked agent — its gate came free",
        "burst 1",
        "burst 2",
        "burst 3",
      ]);
      expect(view.announcer.getState().polite?.msg).toBe(
        "Events suppressed — check notification inbox"
      );
    });
  });
});
