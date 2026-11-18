import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeChild extends EventEmitter {
  posted: Array<{ type: string; [key: string]: unknown }> = [];
  constructor(readonly pid: number) {
    super();
  }
  postMessage(message: { type: string }): void {
    this.posted.push(message);
  }
  /** The worker's side: answer a message. */
  reply(message: unknown): void {
    this.emit("message", message);
  }
}

const state = vi.hoisted(() => ({ children: [] as unknown[] }));

vi.mock("electron", () => ({
  utilityProcess: {
    fork: () => {
      const child = new FakeChild(60_000 + state.children.length);
      state.children.push(child);
      return child;
    },
  },
}));
vi.mock("../../../utils/logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("../../processTerminationIntent.js", () => ({ noteTerminationIntent: vi.fn() }));

import { LocalSpeechHost } from "../localSpeechProcess.js";

const children = () => state.children as FakeChild[];

function handlers() {
  return { onMessage: vi.fn(), onLost: vi.fn() };
}

async function acquireLoaded(host: LocalSpeechHost, h = handlers(), dir = "/models/rev") {
  const forked = children().length;
  const leasing = host.acquire(dir, h);
  // A newly forked process answers its load; a reused one is loaded already.
  await new Promise((resolve) => setImmediate(resolve));
  if (children().length > forked) children().at(-1)!.reply({ type: "ready", loadMs: 5 });
  return { lease: await leasing, child: children().at(-1)!, h };
}

beforeEach(() => {
  state.children.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("LocalSpeechHost", () => {
  it("forks one process, loads the model into it, and routes the lease's messages", async () => {
    const host = new LocalSpeechHost(60_000);
    const { lease, child, h } = await acquireLoaded(host);
    expect(child.posted[0]).toEqual({ type: "load", dir: "/models/rev", threads: 2 });
    child.reply({ type: "text", session: lease.session, segment: 0, text: "hi" });
    child.reply({ type: "text", session: lease.session + 99, segment: 0, text: "other" });
    expect(h.onMessage).toHaveBeenCalledTimes(1);
    expect(lease.post({ type: "cut", session: lease.session })).toBe(true);
    expect(child.posted.at(-1)).toEqual({ type: "cut", session: lease.session });
  });

  it("reuses the loaded model for the next dictation, and a newer lease takes over", async () => {
    const host = new LocalSpeechHost(60_000);
    const first = await acquireLoaded(host);
    const second = await acquireLoaded(host);
    expect(children()).toHaveLength(1);
    expect(second.lease.session).toBeGreaterThan(first.lease.session);
    expect(first.lease.post({ type: "cut", session: first.lease.session })).toBe(false);
    second.child.reply({ type: "text", session: first.lease.session, segment: 0, text: "stale" });
    expect(first.h.onMessage).not.toHaveBeenCalled();
  });

  it("unloads the model once it has sat idle", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const host = new LocalSpeechHost(1_000);
    const { lease, child } = await acquireLoaded(host);
    lease.release();
    expect(child.posted.at(-1)).toEqual({ type: "end", session: lease.session });
    await vi.advanceTimersByTimeAsync(999);
    expect(child.posted.some((m) => m.type === "destroy")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.posted.at(-1)).toEqual({ type: "destroy" });
  });

  it("keeps the model loaded when a dictation starts before the idle timer runs out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const host = new LocalSpeechHost(1_000);
    const { lease } = await acquireLoaded(host);
    lease.release();
    await vi.advanceTimersByTimeAsync(500);
    await acquireLoaded(host);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(children()[0].posted.some((m) => m.type === "destroy")).toBe(false);
  });

  it("tells the lease when the process dies under it, and forks afresh next time", async () => {
    const host = new LocalSpeechHost(60_000);
    const { child, h } = await acquireLoaded(host);
    child.emit("exit", 9);
    expect(h.onLost).toHaveBeenCalledTimes(1);
    await acquireLoaded(host);
    expect(children()).toHaveLength(2);
  });

  it("rejects a lease when the model can't be loaded", async () => {
    const host = new LocalSpeechHost(60_000);
    const leasing = host.acquire("/models/rev", handlers());
    await vi.waitFor(() => expect(children()).toHaveLength(1));
    children()[0].reply({ type: "load-failed", message: "bad file" });
    await expect(leasing).rejects.toThrow(/couldn't be loaded/);
    expect(children()[0].posted.at(-1)).toEqual({ type: "destroy" });
  });

  it("refuses to give up the model while a dictation holds it", async () => {
    const host = new LocalSpeechHost(60_000);
    const { lease, child } = await acquireLoaded(host);
    await expect(host.releaseModel()).rejects.toThrow(/using/);
    lease.release();
    const released = host.releaseModel();
    expect(child.posted.at(-1)).toEqual({ type: "destroy" });
    child.emit("exit", 0);
    await released;
  });
});
