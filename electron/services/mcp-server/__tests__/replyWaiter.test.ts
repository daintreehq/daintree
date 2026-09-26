import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalHandback } from "../../../../shared/types/handback.js";
import { NOTIFY_TARGET_SETTLE_MS } from "../../../../shared/types/terminalNotify.js";
import { MAX_OUTSTANDING_REPLY_WAITS, ReplyWaiterService } from "../replyWaiter.js";
import type { NotifyStateChange, NotifyTerminalInfo } from "../terminalNotify.js";

function setup() {
  const stateListeners = new Set<(payload: NotifyStateChange) => void>();
  const handbackListeners = new Set<(terminalId: string, handback: TerminalHandback) => void>();
  const killListeners = new Set<(terminalId: string) => void>();
  const screens = new Map<string, string>();
  const terminals = new Map<string, NotifyTerminalInfo>();
  const client = {
    getTerminalAsync: async (id: string) => terminals.get(id) ?? null,
    getSerializedStateAsync: async (id: string) => {
      const data = screens.get(id);
      return data === undefined ? null : { data };
    },
    on: () => undefined,
    off: () => undefined,
  };
  const service = new ReplyWaiterService({
    getPtyClient: () => client,
    onStateChanged: (listener) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    onHandbackObserved: (listener) => {
      handbackListeners.add(listener);
      return () => handbackListeners.delete(listener);
    },
    onKilled: (listener) => {
      killListeners.add(listener);
      return () => killListeners.delete(listener);
    },
    onTrashed: () => () => undefined,
  });
  const change = (terminalId: string, patch: Partial<NotifyStateChange> = {}) => {
    for (const listener of [...stateListeners]) {
      listener({
        terminalId,
        state: "waiting",
        previousState: "working",
        waitingReason: "prompt",
        timestamp: Date.now(),
        ...patch,
      });
    }
  };
  const handback = (terminalId: string, submissionToken?: string) => {
    for (const listener of [...handbackListeners]) {
      listener(terminalId, {
        message: "done",
        observedAt: Date.now(),
        truncated: false,
        ...(submissionToken !== undefined ? { submissionToken } : {}),
      });
    }
  };
  const kill = (terminalId: string) => {
    for (const listener of [...killListeners]) listener(terminalId);
  };
  return {
    service,
    screens,
    terminals,
    change,
    handback,
    kill,
    listenerCount: () => stateListeners.size + handbackListeners.size + killListeners.size,
  };
}

describe("ReplyWaiterService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the reply the moment the done marker for this send prints", async () => {
    const h = setup();
    h.screens.set("t-a", "Fact: honey never spoils.\nDAINTREE-DONE-abc123: fact END-abc123\n› Ask");
    const wait = h.service.wait({
      terminalId: "t-a",
      since: Date.now(),
      replyLines: 40,
      timeoutMs: 60_000,
    });
    wait.bind("t-a", "tok-1");

    h.handback("t-a", "tok-old");
    h.handback("t-a", "tok-1");
    const reply = await wait.promise;

    expect(reply).toMatchObject({ terminalId: "t-a", outcome: "handback" });
    expect(reply.reply?.text).toBe(
      "Fact: honey never spoils.\nDAINTREE-DONE-abc123: fact END-abc123"
    );
  });

  it("returns once the agent has stayed out of working for the settle window", async () => {
    const h = setup();
    h.screens.set("t-a", "All done.");
    const wait = h.service.wait({
      terminalId: "t-a",
      since: Date.now(),
      replyLines: 40,
      timeoutMs: 60_000,
    });
    let settled = false;
    void wait.promise.then(() => {
      settled = true;
    });

    h.change("t-a");
    await vi.advanceTimersByTimeAsync(NOTIFY_TARGET_SETTLE_MS - 100);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);

    await expect(wait.promise).resolves.toMatchObject({
      outcome: "settled",
      state: "waiting",
      waitingReason: "prompt",
      reply: { text: "All done." },
    });
  });

  it("returns at the timeout with the state and screen as they stand", async () => {
    const h = setup();
    h.screens.set("t-a", "still thinking");
    h.terminals.set("t-a", { agentState: "working", hasPty: true });
    const wait = h.service.wait({
      terminalId: "t-a",
      since: Date.now(),
      replyLines: 40,
      timeoutMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(5_000);

    await expect(wait.promise).resolves.toMatchObject({
      outcome: "timeout",
      state: "working",
      reply: { text: "still thinking" },
    });
  });

  it("binds a launch after the fact without missing a stop that came first", async () => {
    const h = setup();
    h.screens.set("t-new", "Launched and answered.");
    const since = Date.now();
    const wait = h.service.wait({ since, replyLines: 40, timeoutMs: 60_000 });

    h.change("t-new", { state: "working", previousState: "idle" });
    h.change("t-new");
    wait.bind("t-new");
    await vi.advanceTimersByTimeAsync(NOTIFY_TARGET_SETTLE_MS + 10);

    await expect(wait.promise).resolves.toMatchObject({ terminalId: "t-new", outcome: "settled" });
  });

  it("reports a closed terminal as closed, with no screen to quote", async () => {
    const h = setup();
    const wait = h.service.wait({
      terminalId: "t-a",
      since: Date.now(),
      replyLines: 40,
      timeoutMs: 60_000,
    });

    h.kill("t-a");

    await expect(wait.promise).resolves.toEqual({ terminalId: "t-a", outcome: "closed" });
  });

  it("ignores an earlier turn's handback while a send's own token is unbound", async () => {
    const h = setup();
    h.screens.set("t-a", "new answer");
    const wait = h.service.wait({
      terminalId: "t-a",
      since: Date.now(),
      replyLines: 40,
      timeoutMs: 60_000,
      expectsToken: true,
    });
    let done = false;
    void wait.promise.then(() => {
      done = true;
    });

    h.handback("t-a", "tok-old");
    await vi.advanceTimersByTimeAsync(10);
    expect(done).toBe(false);

    wait.bind("t-a", "tok-new");
    h.handback("t-a", "tok-new");
    await expect(wait.promise).resolves.toMatchObject({ outcome: "handback" });
  });

  it("replays a launch's handback that printed before it was bound", async () => {
    const h = setup();
    h.screens.set("t-new", "done");
    const wait = h.service.wait({ since: Date.now(), replyLines: 40, timeoutMs: 60_000 });

    h.handback("t-new");
    wait.bind("t-new");

    await expect(wait.promise).resolves.toMatchObject({ terminalId: "t-new", outcome: "handback" });
  });

  it("keeps a settle that held before the next turn began, when replayed late", async () => {
    const h = setup();
    h.screens.set("t-new", "first answer");
    const t0 = Date.now();
    const wait = h.service.wait({ since: t0, replyLines: 40, timeoutMs: 60_000 });

    h.change("t-new", { state: "working", previousState: "idle", timestamp: t0 + 1 });
    h.change("t-new", { timestamp: t0 + 2 });
    h.change("t-new", {
      state: "working",
      previousState: "waiting",
      timestamp: t0 + 2 + NOTIFY_TARGET_SETTLE_MS + 500,
    });
    wait.bind("t-new");

    await expect(wait.promise).resolves.toMatchObject({ outcome: "settled" });
  });

  it("returns at once as still going past the outstanding-wait cap", async () => {
    const h = setup();
    const held = Array.from({ length: MAX_OUTSTANDING_REPLY_WAITS }, (_, i) =>
      h.service.wait({ terminalId: `t-${i}`, since: Date.now(), replyLines: 0, timeoutMs: 60_000 })
    );
    const extra = h.service.wait({
      terminalId: "t-extra",
      since: Date.now(),
      replyLines: 0,
      timeoutMs: 60_000,
    });

    await expect(extra.promise).resolves.toMatchObject({ outcome: "timeout" });
    for (const wait of held) wait.cancel();
  });

  it("ends at once for a request that was already aborted", async () => {
    const h = setup();
    const controller = new AbortController();
    controller.abort();
    const wait = h.service.wait({
      terminalId: "t-a",
      since: Date.now(),
      replyLines: 40,
      timeoutMs: 60_000,
      signal: controller.signal,
    });

    await expect(wait.promise).resolves.toMatchObject({ outcome: "timeout" });
  });

  it("reports a launch that closed before it was bound as closed", async () => {
    const h = setup();
    const other = h.service.wait({
      terminalId: "t-other",
      since: Date.now(),
      replyLines: 40,
      timeoutMs: 60_000,
    });
    const wait = h.service.wait({ since: Date.now(), replyLines: 40, timeoutMs: 60_000 });

    h.kill("t-new");
    wait.bind("t-new");

    await expect(wait.promise).resolves.toEqual({ terminalId: "t-new", outcome: "closed" });
    other.cancel();
  });

  it("settles at once when the send failed, and unsubscribes when nothing waits", async () => {
    const h = setup();
    const wait = h.service.wait({
      terminalId: "t-a",
      since: Date.now(),
      replyLines: 40,
      timeoutMs: 60_000,
    });
    expect(h.listenerCount()).toBeGreaterThan(0);

    wait.cancel();

    await expect(wait.promise).resolves.toEqual({ terminalId: "", outcome: "closed" });
    expect(h.listenerCount()).toBe(0);
  });
});
