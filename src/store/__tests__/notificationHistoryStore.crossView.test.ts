import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationHistoryEntry } from "../slices/notificationHistorySlice";

/**
 * Cross-view write-merge coverage for the shared notification inbox (#15534).
 * Each project view is its own V8 context with its own copy of the store, all
 * writing one localStorage key. A view is simulated by a fresh module instance
 * (`vi.resetModules` + dynamic import) over one shared backing map. Storage is
 * debounced (300ms), so writes are driven with fake timers.
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

/** Loads a fresh copy of the store, as a newly built project view would. */
async function openView() {
  vi.resetModules();
  const { useNotificationHistoryStore } = await import("../slices/notificationHistorySlice");
  vi.advanceTimersByTime(FLUSH_MS);
  return useNotificationHistoryStore;
}

function flush(): void {
  vi.advanceTimersByTime(FLUSH_MS);
}

describe("notificationHistoryStore cross-view write merge (#15534)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreLocalStorage();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("keeps a sibling's added and archived entries when a stale view writes", async () => {
    const existing = makeEntry({ id: "existing" });
    const backing = installLocalStorage(seed([existing]));

    const viewA = await openView();
    const viewB = await openView();

    const siblingId = viewB.getState().addEntry({ type: "error", message: "from B" });
    const archivedAt = Date.now();
    viewB.getState().archiveEntry("existing");
    flush();

    vi.advanceTimersByTime(1000);
    const ownId = viewA.getState().addEntry({ type: "info", message: "from A" });
    flush();

    const written = readBlob(backing);
    expect(written.state.entries.map((e) => e.id)).toEqual([ownId, siblingId, "existing"]);
    expect(entryById(backing, siblingId)?.seenAsToast).toBe(false);
    expect(entryById(backing, "existing")?.archivedAt).toBe(archivedAt);
  });

  it("does not revert a sibling's read and snooze changes", async () => {
    const threaded = makeEntry({ id: "threaded", correlationId: "thread-1" });
    const other = makeEntry({ id: "other", timestamp: NOW - 2 * HOUR });
    const backing = installLocalStorage(seed([threaded, other]));

    const viewA = await openView();
    const viewB = await openView();

    viewB.getState().markIdsRead(["other"]);
    viewB.getState().snoozeThread("thread-1", NOW + DAY);
    flush();

    viewA.getState().addEntry({ type: "info", message: "from A" });
    flush();

    expect(entryById(backing, "other")?.seenAsToast).toBe(true);
    expect(readBlob(backing).state.snoozedThreads).toEqual({ "thread-1": NOW + DAY });
  });

  it("does not resurrect an entry a sibling dismissed", async () => {
    const doomed = makeEntry({ id: "doomed" });
    const kept = makeEntry({ id: "kept", timestamp: NOW - 2 * HOUR });
    const backing = installLocalStorage(seed([doomed, kept]));

    const viewA = await openView();
    const viewB = await openView();

    viewB.getState().dismissEntry("doomed");
    flush();

    viewA.getState().markIdsRead(["kept"]);
    flush();

    expect(entryById(backing, "doomed")).toBeUndefined();
    expect(entryById(backing, "kept")?.seenAsToast).toBe(true);
  });

  it("persists the writing view's own dismissal while keeping a sibling's addition", async () => {
    const doomed = makeEntry({ id: "doomed" });
    const backing = installLocalStorage(seed([doomed]));

    const viewA = await openView();
    const viewB = await openView();

    const siblingId = viewB.getState().addEntry({ type: "warning", message: "from B" });
    flush();

    viewA.getState().dismissEntry("doomed");
    flush();

    expect(readBlob(backing).state.entries.map((e) => e.id)).toEqual([siblingId]);
  });

  it("persists the writing view's own prune", async () => {
    const expired = makeEntry({ id: "expired", timestamp: NOW - HOUR, seenAsToast: true });
    const backing = installLocalStorage(seed([expired]));

    const viewA = await openView();
    const viewB = await openView();

    const siblingId = viewB.getState().addEntry({ type: "error", message: "from B" });
    flush();

    vi.setSystemTime(NOW + 8 * DAY);
    viewA.getState().pruneExpiredEntries();
    flush();

    expect(readBlob(backing).state.entries.map((e) => e.id)).toEqual([siblingId]);
  });

  it("holds the 200-entry cap, keeping both views' new entries", async () => {
    const old = Array.from({ length: 200 }, (_, i) =>
      makeEntry({ id: `old-${i}`, timestamp: NOW - DAY - i * 1000 })
    );
    const backing = installLocalStorage(seed(old));

    const viewA = await openView();
    const viewB = await openView();

    const siblingIds = Array.from({ length: 3 }, (_, i) => {
      vi.advanceTimersByTime(10);
      return viewB.getState().addEntry({ type: "error", message: `B ${i}` });
    });
    flush();

    vi.advanceTimersByTime(10);
    const ownId = viewA.getState().addEntry({ type: "error", message: "A" });
    flush();

    const ids = readBlob(backing).state.entries.map((e) => e.id);
    expect(ids).toHaveLength(200);
    expect(ids.slice(0, 4)).toEqual([ownId, ...siblingIds.reverse()]);
    expect(ids).not.toContain("old-199");
    expect(ids).toContain("old-195");
  });
});
