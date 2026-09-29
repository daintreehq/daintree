// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  createSyncedCollection,
  type SyncedCollectionDelta,
  type SyncedCollectionSnapshot,
} from "../sync/syncedCollection.js";
import { useSyncedCollection } from "../react/useSyncedCollection.js";

interface Row {
  id: string;
  v: number;
}
const key = (r: Row) => r.id;

type Handler = (...args: unknown[]) => unknown;

function fakeHost() {
  const handlers = new Map<string, Handler>();
  const posts: Array<{ channel: string; payload: unknown }> = [];
  // The empty revision-0 delta each collection announces itself with, kept
  // apart so the tests below index real deltas.
  const announcements: Array<{ channel: string; payload: unknown }> = [];
  return {
    handlers,
    posts,
    announcements,
    host: {
      registerHandler: vi.fn(async (channel: string, handler: Handler) => {
        handlers.set(channel, handler);
      }),
      postToPanel: vi.fn(async (channel: string, payload: unknown) => {
        const d = payload as SyncedCollectionDelta<unknown>;
        const hello = d.revision === 0 && d.upserts.length === 0 && d.removes.length === 0;
        (hello ? announcements : posts).push({ channel, payload });
      }),
    },
    snapshot: <T>(channel: string) =>
      handlers.get(`${channel}-snapshot`)!({}) as SyncedCollectionSnapshot<T>,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const delta = (
  revision: number,
  upserts: Row[],
  removes: string[] = [],
  epoch = "e1"
): SyncedCollectionDelta<Row> => ({
  epoch,
  revision,
  removes,
  upserts: upserts.map((r) => [r.id, r]),
});

const snap = (revision: number, rows: Row[], epoch = "e1"): SyncedCollectionSnapshot<Row> => ({
  epoch,
  revision,
  entries: rows.map((r) => [r.id, r]),
});

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"],
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("createSyncedCollection", () => {
  it("serves a snapshot and sends nothing until a view has pulled one", async () => {
    const h = fakeHost();
    const c = await createSyncedCollection<Row>(h.host, "rows", {
      key,
      initial: [{ id: "a", v: 1 }],
    });
    expect(h.handlers.has("rows-snapshot")).toBe(true);
    expect(h.announcements).toHaveLength(1);
    c.upsert({ id: "b", v: 1 });
    await vi.advanceTimersByTimeAsync(20);
    expect(h.posts).toEqual([]);
    expect(c.revision).toBe(1);

    const s = h.snapshot<Row>("rows");
    expect(s.revision).toBe(1);
    expect(s.entries.map(([k]) => k)).toEqual(["a", "b"]);
  });

  it("gathers a loop of changes into one delta with the next revision", async () => {
    const h = fakeHost();
    const c = await createSyncedCollection<Row>(h.host, "rows", { key });
    h.snapshot("rows");
    for (let i = 0; i < 1000; i++) c.upsert({ id: `r${i}`, v: i });
    c.remove("r0");
    await vi.advanceTimersByTimeAsync(20);
    expect(h.posts).toHaveLength(1);
    const d = h.posts[0]!.payload as SyncedCollectionDelta<Row>;
    expect(d.revision).toBe(1);
    expect(d.upserts).toHaveLength(999);
    expect(d.removes).toEqual(["r0"]);
    c.upsert({ id: "r1", v: 42 });
    await vi.advanceTimersByTimeAsync(20);
    expect((h.posts[1]!.payload as SyncedCollectionDelta<Row>).revision).toBe(2);
  });

  it("flushes pending changes before answering a snapshot, so the snapshot covers them", async () => {
    const h = fakeHost();
    const c = await createSyncedCollection<Row>(h.host, "rows", { key });
    h.snapshot("rows");
    c.upsert({ id: "a", v: 1 });
    const s = h.snapshot<Row>("rows");
    const d = h.posts[0]!.payload as SyncedCollectionDelta<Row>;
    expect(d.revision).toBe(s.revision);
    expect(s.entries).toEqual([["a", { id: "a", v: 1 }]]);
  });

  it("keeps a remove before a re-add so the view moves the key to the end too", async () => {
    const h = fakeHost();
    const c = await createSyncedCollection<Row>(h.host, "rows", {
      key,
      initial: [
        { id: "a", v: 1 },
        { id: "b", v: 1 },
      ],
    });
    h.snapshot("rows");
    c.remove("a");
    c.upsert({ id: "a", v: 2 });
    await c.flush();
    const d = h.posts[0]!.payload as SyncedCollectionDelta<Row>;
    expect(d.removes).toEqual(["a"]);
    expect(d.upserts.map(([k]) => k)).toEqual(["a"]);
    expect(c.values().map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("sends a replace as one reset delta and stops after dispose", async () => {
    const h = fakeHost();
    const c = await createSyncedCollection<Row>(h.host, "rows", {
      key,
      initial: [{ id: "a", v: 1 }],
    });
    h.snapshot("rows");
    c.replace([{ id: "z", v: 1 }]);
    await c.flush();
    expect(h.posts[0]!.payload).toMatchObject({
      reset: true,
      removes: [],
      upserts: [["z", { id: "z", v: 1 }]],
    });
    c.dispose();
    c.upsert({ id: "y", v: 1 });
    await vi.advanceTimersByTimeAsync(20);
    expect(h.posts).toHaveLength(1);
  });
});

function fakeBridge() {
  const subs = new Map<string, Set<(p: unknown) => void>>();
  const order: string[] = [];
  const invoke = vi.fn();
  const on = vi.fn((_pluginId: string, channel: string, cb: (p: unknown) => void) => {
    order.push(`on:${channel}`);
    let set = subs.get(channel);
    if (!set) subs.set(channel, (set = new Set()));
    set.add(cb);
    return () => set.delete(cb);
  });
  const recordingInvoke = (...args: unknown[]) => {
    order.push(`invoke:${String(args[1])}`);
    return invoke(...args);
  };
  vi.stubGlobal("electron", { plugin: { invoke: recordingInvoke, on, onPanel: vi.fn() } });
  return {
    invoke,
    order,
    push: (channel: string, payload: unknown) => {
      for (const cb of [...(subs.get(channel) ?? [])]) cb(payload);
    },
    subscribers: (channel: string) => subs.get(channel)?.size ?? 0,
  };
}

const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(20)));
const ids = (items: readonly Row[]) => items.map((r) => `${r.id}${r.v}`);

describe("useSyncedCollection", () => {
  it("subscribes before it pulls", async () => {
    const b = fakeBridge();
    b.invoke.mockResolvedValue(snap(0, []));
    renderHook(() => useSyncedCollection<Row>("acme", "rows"));
    await settle();
    expect(b.order).toEqual(["on:rows", "invoke:rows-snapshot"]);
  });

  it("holds deltas that arrive before the snapshot, dropping those it already covers", async () => {
    const b = fakeBridge();
    const pending = deferred<SyncedCollectionSnapshot<Row>>();
    b.invoke.mockReturnValue(pending.promise);
    const { result } = renderHook(() => useSyncedCollection<Row>("acme", "rows"));
    await settle();
    expect(result.current.loading).toBe(true);

    // Both pushed after the worker answered, but delivered before the answer.
    b.push("rows", delta(2, [{ id: "b", v: 1 }]));
    b.push("rows", delta(3, [{ id: "c", v: 1 }]));
    await act(async () =>
      pending.resolve(
        snap(2, [
          { id: "a", v: 1 },
          { id: "b", v: 1 },
        ])
      )
    );
    await settle();

    expect(ids(result.current.items)).toEqual(["a1", "b1", "c1"]);
    expect(result.current.revision).toBe(3);
    expect(result.current.loading).toBe(false);
    expect(b.invoke).toHaveBeenCalledTimes(1);
  });

  it("drops a stale delta that arrives after the snapshot", async () => {
    const b = fakeBridge();
    b.invoke.mockResolvedValue(snap(5, [{ id: "a", v: 5 }]));
    const { result } = renderHook(() => useSyncedCollection<Row>("acme", "rows"));
    await settle();
    b.push("rows", delta(4, [{ id: "a", v: 4 }]));
    b.push("rows", delta(5, [{ id: "a", v: 5 }]));
    b.push("rows", delta(6, [{ id: "a", v: 6 }], []));
    await settle();
    expect(ids(result.current.items)).toEqual(["a6"]);
    expect(b.invoke).toHaveBeenCalledTimes(1);
  });

  it("resyncs on a revision gap, keeping deltas that arrive during the re-pull", async () => {
    const b = fakeBridge();
    b.invoke.mockResolvedValueOnce(snap(1, [{ id: "a", v: 1 }]));
    const { result } = renderHook(() => useSyncedCollection<Row>("acme", "rows"));
    await settle();

    const repull = deferred<SyncedCollectionSnapshot<Row>>();
    b.invoke.mockReturnValueOnce(repull.promise);
    b.push("rows", delta(3, [{ id: "c", v: 1 }]));
    await settle();
    expect(b.invoke).toHaveBeenCalledTimes(2);
    b.push("rows", delta(4, [{ id: "d", v: 1 }]));
    await act(async () =>
      repull.resolve(
        snap(3, [
          { id: "a", v: 1 },
          { id: "b", v: 1 },
          { id: "c", v: 1 },
        ])
      )
    );
    await settle();
    expect(ids(result.current.items)).toEqual(["a1", "b1", "c1", "d1"]);
    expect(result.current.revision).toBe(4);
  });

  it("resyncs when the worker restarts, then ignores the old worker's late deltas", async () => {
    const b = fakeBridge();
    b.invoke.mockResolvedValueOnce(snap(7, [{ id: "a", v: 7 }], "old"));
    const { result } = renderHook(() => useSyncedCollection<Row>("acme", "rows"));
    await settle();

    b.invoke.mockResolvedValueOnce(snap(1, [{ id: "n", v: 1 }], "new"));
    b.push("rows", delta(1, [{ id: "n", v: 1 }], [], "new"));
    await settle();
    expect(ids(result.current.items)).toEqual(["n1"]);
    b.push("rows", delta(8, [{ id: "a", v: 8 }], [], "old"));
    b.push("rows", delta(2, [{ id: "m", v: 1 }], [], "new"));
    await settle();
    expect(ids(result.current.items)).toEqual(["n1", "m1"]);
    expect(b.invoke).toHaveBeenCalledTimes(2);
  });

  it("applies removes and resets", async () => {
    const b = fakeBridge();
    b.invoke.mockResolvedValue(
      snap(0, [
        { id: "a", v: 1 },
        { id: "b", v: 1 },
      ])
    );
    const { result } = renderHook(() => useSyncedCollection<Row>("acme", "rows"));
    await settle();
    b.push("rows", delta(1, [], ["a"]));
    await settle();
    expect(ids(result.current.items)).toEqual(["b1"]);
    b.push("rows", { ...delta(2, [{ id: "z", v: 1 }]), reset: true });
    await settle();
    expect(ids(result.current.items)).toEqual(["z1"]);
  });

  it("reports a failed pull, applies nothing meanwhile, and recovers on resync()", async () => {
    const b = fakeBridge();
    b.invoke.mockRejectedValueOnce(new Error("no handler"));
    const { result } = renderHook(() => useSyncedCollection<Row>("acme", "rows"));
    await settle();
    expect(result.current.error?.message).toBe("no handler");
    expect(result.current.loading).toBe(false);
    b.push("rows", delta(1, [{ id: "x", v: 1 }]));
    await settle();
    expect(result.current.items).toEqual([]);

    b.invoke.mockResolvedValueOnce(snap(1, [{ id: "x", v: 1 }]));
    act(() => result.current.resync());
    await settle();
    expect(result.current.error).toBeNull();
    expect(ids(result.current.items)).toEqual(["x1"]);
  });

  it("unsubscribes on unmount and on the signal", async () => {
    const b = fakeBridge();
    b.invoke.mockResolvedValue(snap(0, []));
    const controller = new AbortController();
    const { unmount } = renderHook(() =>
      useSyncedCollection<Row>("acme", "rows", { signal: controller.signal })
    );
    await settle();
    expect(b.subscribers("rows")).toBe(1);
    act(() => controller.abort());
    expect(b.subscribers("rows")).toBe(0);
    unmount();
  });

  it("mirrors the worker end to end through pulls and pushes delivered out of order", async () => {
    const h = fakeHost();
    const worker = await createSyncedCollection<Row>(h.host, "rows", { key });
    worker.upsertMany([
      { id: "a", v: 0 },
      { id: "b", v: 0 },
    ]);
    const b = fakeBridge();
    const answer = deferred<unknown>();
    // The worker answers at once; the answer reaches the view only later.
    b.invoke.mockImplementation(() => {
      const s = h.snapshot<Row>("rows");
      void Promise.resolve().then(() => answer.resolve(s));
      return new Promise((resolve) => setTimeout(() => resolve(answer.promise), 30));
    });
    const deliver = () => {
      for (const { channel, payload } of h.posts.splice(0)) b.push(channel, payload);
    };
    const { result } = renderHook(() => useSyncedCollection<Row>("acme", "rows"));
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));

    worker.upsert({ id: "c", v: 0 });
    worker.remove("a");
    await act(async () => void (await vi.advanceTimersByTimeAsync(20)));
    deliver();
    await settle();
    await settle();
    worker.upsert({ id: "b", v: 9 });
    await worker.flush();
    deliver();
    await settle();

    expect(result.current.items).toEqual(worker.values());
    expect(result.current.revision).toBe(worker.revision);
  });
});

describe("createSyncedCollection delivery", () => {
  it("retries the newest delta when its push fails, so views are not left stale", async () => {
    const h = fakeHost();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const c = await createSyncedCollection<Row>(h.host, "rows", { key });
      h.snapshot("rows");
      h.host.postToPanel.mockRejectedValueOnce(new Error("gone"));
      c.upsert({ id: "a", v: 1 });
      await vi.advanceTimersByTimeAsync(20);
      expect(h.posts).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.posts).toHaveLength(1);
      expect((h.posts[0]!.payload as SyncedCollectionDelta<Row>).revision).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("a restarted worker's announcement makes an open view resync", async () => {
    const b = fakeBridge();
    b.invoke.mockResolvedValueOnce(snap(4, [{ id: "a", v: 1 }], "old"));
    const { result } = renderHook(() => useSyncedCollection<Row>("acme", "rows"));
    await settle();

    const h = fakeHost();
    const worker = await createSyncedCollection<Row>(h.host, "rows", {
      key,
      initial: [{ id: "b", v: 1 }],
    });
    b.invoke.mockImplementationOnce(async () => h.snapshot("rows"));
    for (const { channel, payload } of h.announcements) b.push(channel, payload);
    await settle();
    expect(ids(result.current.items)).toEqual(["b1"]);
    expect(result.current.revision).toBe(worker.revision);
  });
});

describe("createSyncedCollection push limit", () => {
  const big = (id: string, size: number): Row & { pad: string } => ({
    id,
    v: 1,
    pad: "x".repeat(size),
  });

  it("splits a change set over the limit across consecutive revisions", async () => {
    const h = fakeHost();
    const c = await createSyncedCollection<Row>(h.host, "rows", { key, maxDeltaBytes: 4096 });
    h.snapshot("rows");
    for (let i = 0; i < 20; i++) c.upsert(big(`r${i}`, 1000));
    c.remove("r0");
    await c.flush();
    const deltas = h.posts.map((p) => p.payload as SyncedCollectionDelta<Row>);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((d) => d.revision)).toEqual(deltas.map((_, i) => i + 1));
    for (const d of deltas) expect(JSON.stringify(d).length).toBeLessThanOrEqual(4096);
    expect(deltas.flatMap((d) => d.upserts.map(([k]) => k))).toEqual(
      Array.from({ length: 19 }, (_, i) => `r${i + 1}`)
    );
    expect(c.revision).toBe(deltas.length);
  });

  it("converges when the final batch holds an item too large to push, with nothing after it", async () => {
    const h = fakeHost();
    const worker = await createSyncedCollection<Row>(h.host, "rows", { key, maxDeltaBytes: 4096 });
    const b = fakeBridge();
    b.invoke.mockImplementation(async () => h.snapshot("rows"));
    const { result } = renderHook(() => useSyncedCollection<Row>("acme", "rows"));
    await settle();

    worker.upsert({ id: "a", v: 1 });
    worker.upsert(big("huge", 10_000));
    await worker.flush();
    const [only] = h.posts.map((p) => p.payload as SyncedCollectionDelta<Row>);
    expect(h.posts).toHaveLength(1);
    expect(only).toMatchObject({ resync: true, removes: [], upserts: [] });
    for (const { channel, payload } of h.posts.splice(0)) b.push(channel, payload);
    await settle();
    await settle();

    expect(b.invoke).toHaveBeenCalledTimes(2);
    expect(result.current.items.map((r) => r.id)).toEqual(["a", "huge"]);
    expect(result.current.revision).toBe(worker.revision);
  });

  it("sends a resync instead of retrying a delta the host refused as too large", async () => {
    const h = fakeHost();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const worker = await createSyncedCollection<Row>(h.host, "rows", { key });
      const b = fakeBridge();
      b.invoke.mockImplementation(async () => h.snapshot("rows"));
      const { result } = renderHook(() => useSyncedCollection<Row>("acme", "rows"));
      await settle();

      h.host.postToPanel.mockRejectedValueOnce(
        new Error('PLUGIN_PAYLOAD_TOO_LARGE: plugin "acme" push exceeds the 1048576-byte limit')
      );
      worker.upsert({ id: "a", v: 1 });
      await worker.flush();
      await vi.advanceTimersByTimeAsync(0);
      const sent = h.posts.map((p) => p.payload as SyncedCollectionDelta<Row>);
      expect(sent).toEqual([
        { epoch: expect.any(String), revision: 2, resync: true, removes: [], upserts: [] },
      ]);
      for (const { channel, payload } of h.posts.splice(0)) b.push(channel, payload);
      await settle();
      await settle();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.host.postToPanel).toHaveBeenCalledTimes(3);
      expect(result.current.items).toEqual([{ id: "a", v: 1 }]);
      expect(result.current.revision).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("createSyncedCollection host contract", () => {
  it("accepts the real host API and the SDK's mock host", async () => {
    const { createMockHost } = await import("../testing.js");
    const host = createMockHost({ pluginId: "acme.demo" });
    const typed: import("../index.js").PluginHostApi = host;
    const c = await createSyncedCollection<Row>(typed, "rows", { key });
    c.upsert({ id: "a", v: 1 });
    expect(c.size).toBe(1);
    c.dispose();
  });
});
