import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ emitter: null as null | import("node:events").EventEmitter }));
vi.mock("electron", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  ipc.emitter = new Emitter();
  return { ipcMain: ipc.emitter };
});

import { CHANNELS } from "../../ipc/channels.js";
import {
  CACHED_VIEW_FLUSH_TIMEOUT_MS,
  _resetCachedViewFlushForTests,
  installCachedViewFlushListeners,
  isCachedViewFlushPending,
  onCachedViewFlushSettled,
  sendViewCached,
} from "../cachedViewFlush.js";

let nextContentsId = 1;

class FakeContents extends EventEmitter {
  id = nextContentsId++;
  destroyed = false;
  sent: Array<{ channel: string; payload: unknown }> = [];
  throwOnSend = false;
  isDestroyed() {
    return this.destroyed;
  }
  send(channel: string, payload?: unknown) {
    if (this.throwOnSend) throw new Error("render frame disposed");
    this.sent.push({ channel, payload });
  }
  destroy() {
    this.destroyed = true;
    this.emit("destroyed");
  }
  /** The flush id main sent with its most recent cached edge, if any. */
  lastFlushId(): string | undefined {
    const last = this.sent.filter((s) => s.channel === CHANNELS.APP_VIEW_CACHED).at(-1);
    return (last?.payload as { flushId?: string } | undefined)?.flushId;
  }
}

const asWc = (wc: FakeContents) => wc as unknown as Electron.WebContents;
const fromRenderer = (channel: string, wc: FakeContents, arg: unknown) =>
  ipc.emitter!.emit(channel, { sender: wc }, arg);
const arm = (wc: FakeContents, armed = true) =>
  fromRenderer(CHANNELS.APP_VIEW_CACHED_FLUSH_ARMED, wc, armed);
const answer = (wc: FakeContents, flushId: unknown) =>
  fromRenderer(CHANNELS.APP_VIEW_CACHED_FLUSHED, wc, flushId);

describe("cachedViewFlush", () => {
  let uninstall: () => void;
  let settled: number[];
  let offSettled: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    uninstall = installCachedViewFlushListeners();
    settled = [];
    offSettled = onCachedViewFlushSettled((id) => settled.push(id));
  });

  afterEach(() => {
    offSettled();
    uninstall();
    _resetCachedViewFlushForTests();
    vi.useRealTimers();
    expect(ipc.emitter!.listenerCount(CHANNELS.APP_VIEW_CACHED_FLUSHED)).toBe(0);
    expect(ipc.emitter!.listenerCount(CHANNELS.APP_VIEW_CACHED_FLUSH_ARMED)).toBe(0);
  });

  it("caches a view with nothing to flush as before: no flush id, no hold", () => {
    const wc = new FakeContents();
    sendViewCached(asWc(wc));

    expect(wc.sent).toEqual([{ channel: CHANNELS.APP_VIEW_CACHED, payload: undefined }]);
    expect(isCachedViewFlushPending(asWc(wc))).toBe(false);
  });

  it("holds an armed view until its renderer answers for that edge", () => {
    const wc = new FakeContents();
    arm(wc);
    sendViewCached(asWc(wc));
    const flushId = wc.lastFlushId();
    expect(typeof flushId).toBe("string");
    expect(isCachedViewFlushPending(asWc(wc))).toBe(true);

    answer(wc, flushId);
    expect(isCachedViewFlushPending(asWc(wc))).toBe(false);
    expect(settled).toEqual([wc.id]);

    answer(wc, flushId);
    expect(settled).toEqual([wc.id]);
  });

  it("ignores an answer from another view, or for another edge", () => {
    const wc = new FakeContents();
    const other = new FakeContents();
    arm(wc);
    sendViewCached(asWc(wc));
    const flushId = wc.lastFlushId();

    answer(other, flushId);
    answer(wc, "stale-edge");
    answer(wc, 42);
    expect(isCachedViewFlushPending(asWc(wc))).toBe(true);
    expect(settled).toEqual([]);
  });

  it("lets go of a view whose renderer never answers once the wait runs out", () => {
    const wc = new FakeContents();
    arm(wc);
    sendViewCached(asWc(wc));

    vi.advanceTimersByTime(CACHED_VIEW_FLUSH_TIMEOUT_MS - 1);
    expect(isCachedViewFlushPending(asWc(wc))).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isCachedViewFlushPending(asWc(wc))).toBe(false);
    expect(settled).toEqual([wc.id]);
  });

  it("keeps holding until every overlapping edge is answered", () => {
    const wc = new FakeContents();
    arm(wc);
    sendViewCached(asWc(wc));
    const first = wc.lastFlushId();
    sendViewCached(asWc(wc));
    const second = wc.lastFlushId();
    expect(second).not.toBe(first);

    answer(wc, first);
    expect(isCachedViewFlushPending(asWc(wc))).toBe(true);
    expect(settled).toEqual([]);

    answer(wc, second);
    expect(isCachedViewFlushPending(asWc(wc))).toBe(false);
    expect(settled).toEqual([wc.id]);
  });

  it("stops holding views once their renderer has nothing registered, or is gone", () => {
    const disarmed = new FakeContents();
    arm(disarmed);
    arm(disarmed, false);
    sendViewCached(asWc(disarmed));
    expect(disarmed.lastFlushId()).toBeUndefined();

    const destroyed = new FakeContents();
    arm(destroyed);
    destroyed.destroy();
    // A destroyed view is never sent anything, so read the forgotten arm through one that reports alive.
    destroyed.destroyed = false;
    sendViewCached(asWc(destroyed));
    expect(destroyed.lastFlushId()).toBeUndefined();
  });

  it("releases at once when the edge can't be delivered", () => {
    const wc = new FakeContents();
    arm(wc);
    wc.throwOnSend = true;
    sendViewCached(asWc(wc));

    expect(isCachedViewFlushPending(asWc(wc))).toBe(false);
    expect(settled).toEqual([wc.id]);
  });

  it("reports nothing pending for a view that died mid-flush", () => {
    const wc = new FakeContents();
    arm(wc);
    sendViewCached(asWc(wc));
    wc.destroyed = true;

    expect(isCachedViewFlushPending(asWc(wc))).toBe(false);
  });
});
