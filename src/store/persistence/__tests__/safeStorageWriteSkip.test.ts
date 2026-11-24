// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeRecordByWriterDelta, type PersistWriteMerge } from "../persistWriteMerge";

const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function installCountingStorage() {
  const backing = new Map<string, string>();
  const storage = {
    getItem: vi.fn((key: string) => backing.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      backing.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      backing.delete(key);
    }),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
  const resetCounts = () => {
    storage.getItem.mockClear();
    storage.setItem.mockClear();
    storage.removeItem.mockClear();
  };
  const accesses = () =>
    storage.getItem.mock.calls.length +
    storage.setItem.mock.calls.length +
    storage.removeItem.mock.calls.length;
  return { backing, storage, resetCounts, accesses };
}

type Notes = { notes: Record<string, { text: string }>; order: string[] };

const mergeNotes: PersistWriteMerge<Notes> = ({ onDisk, incoming }) =>
  onDisk ? { state: { ...onDisk.state, ...incoming.state }, version: incoming.version } : incoming;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalLocalStorageDescriptor) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
  } else {
    delete (globalThis as Partial<typeof globalThis>).localStorage;
  }
});

describe("safe storage skips an unchanged persisted slice (#17055)", () => {
  const notes = { a: { text: "a" } };
  const order = ["a"];
  // Zustand's persist hands the adapter a fresh `{ state, version }` from
  // `partialize` on every set(), and partialize often rebuilds arrays
  // (`Array.from(set)`), so only field and item references repeat.
  const slice = () => ({ state: { notes, order: [...order] }, version: 1 });

  it("plain adapter: no serialization or storage access once the slice has landed", async () => {
    const { backing, resetCounts, accesses } = installCountingStorage();
    const { createSafeJSONStorage } = await import("../safeStorage");
    const storage = createSafeJSONStorage<Notes>();
    storage.setItem("plain", slice());
    expect(backing.get("plain")).toBe(JSON.stringify(slice()));

    resetCounts();
    const stringify = vi.spyOn(JSON, "stringify");
    for (let i = 0; i < 10; i += 1) storage.setItem("plain", slice());

    expect(stringify).not.toHaveBeenCalled();
    expect(accesses()).toBe(0);
  });

  it("merge adapter: no serialization or storage access once the write reached its fixed point", async () => {
    const { resetCounts, accesses } = installCountingStorage();
    const { createSafeJSONStorage } = await import("../safeStorage");
    const storage = createSafeJSONStorage<Notes>({ mergeOnWrite: mergeNotes });
    void storage.getItem("merged");
    storage.setItem("merged", slice());
    storage.setItem("merged", slice());

    resetCounts();
    const stringify = vi.spyOn(JSON, "stringify");
    for (let i = 0; i < 10; i += 1) storage.setItem("merged", slice());

    expect(stringify).not.toHaveBeenCalled();
    expect(accesses()).toBe(0);
  });

  it("still writes a changed field, a new version, and a slice after removeItem", async () => {
    const { backing } = installCountingStorage();
    const { createSafeJSONStorage } = await import("../safeStorage");
    const storage = createSafeJSONStorage<Notes>();
    storage.setItem("plain", slice());

    storage.setItem("plain", { state: { notes, order: ["b"] }, version: 1 });
    expect(JSON.parse(backing.get("plain")!).state.order).toEqual(["b"]);

    storage.setItem("plain", { state: { notes, order: ["a", "b"] }, version: 1 });
    expect(JSON.parse(backing.get("plain")!).state.order).toEqual(["a", "b"]);

    storage.setItem("plain", { state: { notes, order: ["a", "b"] }, version: 2 });
    expect(JSON.parse(backing.get("plain")!).version).toBe(2);

    const last = { state: { notes, order }, version: 2 };
    storage.setItem("plain", last);
    storage.removeItem("plain");
    storage.setItem("plain", { ...last });
    expect(backing.get("plain")).toBe(JSON.stringify(last));
  });

  it("debounced adapter: a shallow-equal slice neither serializes nor re-arms a flush", async () => {
    vi.useFakeTimers();
    const { resetCounts, accesses } = installCountingStorage();
    const { createDebouncedSafeJSONStorage } = await import("../safeStorage");
    const storage = createDebouncedSafeJSONStorage<Notes>(300, { mergeOnWrite: mergeNotes });
    void storage.getItem("voice");
    storage.setItem("voice", slice());
    vi.advanceTimersByTime(300);
    storage.setItem("voice", slice());
    vi.advanceTimersByTime(300);

    resetCounts();
    const stringify = vi.spyOn(JSON, "stringify");
    for (let i = 0; i < 60; i += 1) {
      storage.setItem("voice", slice());
      vi.advanceTimersByTime(16);
    }
    vi.advanceTimersByTime(300);

    expect(stringify).not.toHaveBeenCalled();
    expect(accesses()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("debounced adapter: a repeat of the queued slice keeps its original deadline", async () => {
    vi.useFakeTimers();
    const { backing } = installCountingStorage();
    const { createDebouncedSafeJSONStorage } = await import("../safeStorage");
    const storage = createDebouncedSafeJSONStorage<Notes>(300);

    storage.setItem("queued", slice());
    vi.advanceTimersByTime(150);
    const stringify = vi.spyOn(JSON, "stringify");
    storage.setItem("queued", slice());
    vi.advanceTimersByTime(149);
    expect(stringify).not.toHaveBeenCalled();
    expect(backing.has("queued")).toBe(false);

    vi.advanceTimersByTime(1);
    expect(stringify).toHaveBeenCalledTimes(1);
    stringify.mockRestore();
    expect(backing.get("queued")).toBe(JSON.stringify(slice()));
    expect(vi.getTimerCount()).toBe(0);
  });

  describe.each([
    ["plain", false],
    ["debounced", true],
  ])("%s adapter", (_kind, debounced) => {
    type Sessions = { sessions: Record<string, { v: string }> };
    const KEY = "sessions";

    async function setup() {
      vi.useFakeTimers();
      const counting = installCountingStorage();
      const { createSafeJSONStorage, createDebouncedSafeJSONStorage } =
        await import("../safeStorage");
      const mergeSessions: PersistWriteMerge<Sessions> = ({ baseline, onDisk, incoming }) =>
        onDisk
          ? {
              state: {
                sessions: mergeRecordByWriterDelta(
                  baseline?.state.sessions ?? {},
                  incoming.state.sessions,
                  onDisk.state.sessions ?? {}
                ),
              },
              version: incoming.version,
            }
          : incoming;
      const options = { mergeOnWrite: mergeSessions };
      const storage = debounced
        ? createDebouncedSafeJSONStorage<Sessions>(300, options)
        : createSafeJSONStorage<Sessions>(options);
      const write = (sessions: Sessions["sessions"]) => {
        storage.setItem(KEY, { state: { sessions }, version: 1 });
        vi.advanceTimersByTime(300);
      };
      const disk = (key = KEY): Sessions["sessions"] | undefined =>
        JSON.parse(counting.backing.get(key) ?? "null")?.state.sessions;
      return { ...counting, storage, write, disk };
    }

    it("re-merges the same slice after a read takes a sibling's entry into the baseline", async () => {
      const { backing, storage, write, disk } = await setup();
      const sessions = { a: { v: "a" } };
      void storage.getItem(KEY);
      for (let i = 0; i < 3; i += 1) write(sessions);

      backing.set(
        KEY,
        JSON.stringify({ state: { sessions: { ...sessions, b: { v: "b" } } }, version: 1 })
      );
      void storage.getItem(KEY);
      // The same references, but `b` is now in the baseline and missing from
      // the snapshot: a deletion the read made visible, not a repeat.
      write(sessions);

      expect(disk()).toEqual({ a: { v: "a" } });
    });

    it("retries a slice that hit the quota after an earlier one landed", async () => {
      const { backing, storage, write, disk } = await setup();
      const first = { a: { v: "a" } };
      const second = { b: { v: "b" } };
      void storage.getItem(KEY);
      write(first);
      write(first);

      const quota = vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
        if (key === KEY) throw new DOMException("Quota exceeded", "QuotaExceededError");
        backing.set(key, value);
      });
      vi.spyOn(console, "warn").mockImplementation(() => {});
      write(second);
      expect(disk()).toEqual(first);
      expect(disk(`${KEY}.__bak`)).toEqual(first);

      quota.mockRestore();
      write(second);
      expect(disk()).toEqual(second);
      expect(backing.get(`${KEY}.__bak`)).toBe(backing.get(KEY));
    });
  });
});

describe("debounced safe storage defers serialization to the flush (#17055)", () => {
  type Width = { width: number };

  it("serializes once per flush however many persisted updates queue", async () => {
    vi.useFakeTimers();
    const { backing, storage: ls } = installCountingStorage();
    const { createDebouncedSafeJSONStorage } = await import("../safeStorage");
    const storage = createDebouncedSafeJSONStorage<Width>(300);

    const stringify = vi.spyOn(JSON, "stringify");
    for (let width = 300; width < 360; width += 1) {
      storage.setItem("portal", { state: { width }, version: 0 });
    }
    expect(stringify).not.toHaveBeenCalled();
    expect(ls.setItem).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    expect(stringify).toHaveBeenCalledTimes(1);
    expect(JSON.parse(backing.get("portal")!).state.width).toBe(359);
  });

  async function queueTwoStores() {
    const { backing } = installCountingStorage();
    const { createDebouncedSafeJSONStorage } = await import("../safeStorage");
    const portal = createDebouncedSafeJSONStorage<Width>(300);
    const help = createDebouncedSafeJSONStorage<Width>(300, {
      mergeOnWrite: ({ incoming }) => incoming,
    });
    portal.setItem("portal", { state: { width: 420 }, version: 0 });
    help.setItem("help", { state: { width: 380 }, version: 0 });
    const widths = () => [
      JSON.parse(backing.get("portal") ?? "null")?.state.width,
      JSON.parse(backing.get("help") ?? "null")?.state.width,
    ];
    return { widths };
  }

  it.each(["pagehide", "beforeunload"])("flushes every pending key on %s", async (type) => {
    vi.useFakeTimers();
    const { widths } = await queueTwoStores();

    window.dispatchEvent(new Event(type));

    expect(widths()).toEqual([420, 380]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("flushes every pending key when the document hides, not when it shows", async () => {
    vi.useFakeTimers();
    const { widths } = await queueTwoStores();
    const hidden = vi.spyOn(document, "hidden", "get");

    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(widths()).toEqual([undefined, undefined]);

    hidden.mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(widths()).toEqual([420, 380]);
  });

  it("flushes every pending key on the project view's cached edge, and unsubscribes once drained", async () => {
    vi.useFakeTimers();
    const cachedFlushes = new Set<() => unknown>();
    const app = {
      onViewCachedFlush: (flush: () => unknown) => {
        cachedFlushes.add(flush);
        return () => cachedFlushes.delete(flush);
      },
    };
    vi.stubGlobal("electron", { app });
    try {
      const { widths } = await queueTwoStores();
      expect(cachedFlushes.size).toBe(1);

      for (const flush of [...cachedFlushes]) flush();

      expect(widths()).toEqual([420, 380]);
      expect(cachedFlushes.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lands the other pending writes when one cannot be serialized", async () => {
    vi.useFakeTimers();
    const { backing } = installCountingStorage();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { createDebouncedSafeJSONStorage } = await import("../safeStorage");
    const storage = createDebouncedSafeJSONStorage<{ size: bigint | number }>(300);

    storage.setItem("broken", { state: { size: 1n }, version: 0 });
    storage.setItem("fine", { state: { size: 2 }, version: 0 });
    window.dispatchEvent(new Event("pagehide"));

    expect(backing.has("broken")).toBe(false);
    expect(JSON.parse(backing.get("fine")!).state.size).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drains a pending write whose timer outlives the page's globals", async () => {
    vi.useFakeTimers();
    const { backing } = installCountingStorage();
    const { createDebouncedSafeJSONStorage } = await import("../safeStorage");
    const storage = createDebouncedSafeJSONStorage<Width>(300);
    storage.setItem("portal", { state: { width: 5 }, version: 0 });

    // What a torn-down jsdom page leaves: `window` is the global object there,
    // and teardown deletes its event methods along with `window` itself.
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("removeEventListener", undefined);
    try {
      expect(() => vi.advanceTimersByTime(300)).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(JSON.parse(backing.get("portal")!).state.width).toBe(5);
  });

  it("holds no lifecycle listener while nothing is pending", async () => {
    vi.useFakeTimers();
    installCountingStorage();
    const lifecycle = new Set(["pagehide", "beforeunload", "visibilitychange"]);
    const listening = new Set<string>();
    const track = (target: Window | Document) => {
      const add = target.addEventListener.bind(target);
      const remove = target.removeEventListener.bind(target);
      vi.spyOn(target, "addEventListener").mockImplementation((type, ...rest) => {
        if (lifecycle.has(type)) listening.add(type);
        add(type, ...rest);
      });
      vi.spyOn(target, "removeEventListener").mockImplementation((type, ...rest) => {
        listening.delete(type);
        remove(type, ...rest);
      });
    };
    track(window);
    track(document);
    const { createDebouncedSafeJSONStorage } = await import("../safeStorage");
    const portal = createDebouncedSafeJSONStorage<Width>(300);
    const help = createDebouncedSafeJSONStorage<Width>(300);
    expect([...listening]).toEqual([]);

    portal.setItem("portal", { state: { width: 1 }, version: 0 });
    help.setItem("help", { state: { width: 1 }, version: 0 });
    portal.setItem("portal", { state: { width: 2 }, version: 0 });
    expect([...listening].sort()).toEqual(["beforeunload", "pagehide", "visibilitychange"]);

    portal.flush("portal");
    expect(listening.size).toBe(3);

    help.removeItem("help");
    expect([...listening]).toEqual([]);

    portal.setItem("portal", { state: { width: 3 }, version: 0 });
    expect(listening.size).toBe(3);
    window.dispatchEvent(new Event("pagehide"));
    expect(JSON.parse(localStorage.getItem("portal")!).state.width).toBe(3);
    expect([...listening]).toEqual([]);
  });
});
