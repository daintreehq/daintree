import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DecisionsBridge,
  MemoryKeyStore,
  MemoryLocalStore,
  loadIdentity,
  type QuestionOrigin,
  type QuestionRow,
  type WebSocketLike,
} from "@daintreehq/decisions-client";
import {
  generateDeviceKeys,
  generateEpochKeyBytes,
  serializeDeviceKeys,
} from "@daintreehq/decisions-crypto";
import { bytesToBase64Url } from "@daintreehq/decisions-protocol";

vi.mock("electron", () => ({
  net: { isOnline: () => true },
  powerMonitor: { on: vi.fn(), off: vi.fn() },
}));

import { powerMonitor } from "electron";
import {
  AttemptBridge,
  ObservedSocket,
  RetiredAttemptError,
  TrailingPump,
  holdingTerminalSink,
  inertAttemptDelivery,
  isRelaySocketUrl,
  retireable,
  socketBridgeStore,
  socketOriginOf,
  watchResume,
} from "../relayTransport.js";

function rawSocket(): WebSocketLike & { closed: Array<number | undefined> } {
  const closed: Array<number | undefined> = [];
  return {
    readyState: 1,
    send: vi.fn(),
    close: (code?: number) => {
      closed.push(code);
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    closed,
  };
}

const ORIGIN: QuestionOrigin = {
  host_id: "host_12345678",
  pane_id: "pane-1",
  terminal_generation: 3,
  ownership_principal: "principal-1",
  agent_incarnation: "incarnation-1",
  agent_session_id: null,
  worktree_id: "worktree-1",
} as QuestionOrigin;

afterEach(() => {
  vi.useRealTimers();
});

describe("ObservedSocket", () => {
  it("sees the close code before the library's handler runs, and forwards everything", () => {
    const raw = rawSocket();
    const seen: string[] = [];
    const socket = new ObservedSocket(raw, (code) => seen.push(`observed ${code}`));
    socket.onmessage = (event) => seen.push(`message ${String(event.data)}`);
    socket.onclose = (event) => seen.push(`library ${event.code}`);

    raw.onmessage?.({ data: "pong" });
    raw.onclose?.({ code: 4409, reason: "" });
    socket.send("ping");

    expect(seen).toEqual(["message pong", "observed 4409", "library 4409"]);
    expect(raw.send).toHaveBeenCalledWith("ping");
    expect(socket.readyState).toBe(1);
  });

  it("still observes a close after the library let go of its handlers", () => {
    const raw = rawSocket();
    const codes: number[] = [];
    const socket = new ObservedSocket(raw, (code) => codes.push(code));
    socket.onclose = null;

    raw.onclose?.({ code: 4401, reason: "" });

    expect(codes).toEqual([4401]);
  });

  it("detaches from the real socket and closes it", () => {
    const raw = rawSocket();
    const socket = new ObservedSocket(raw, () => {});

    socket.detach();

    expect(raw.onclose).toBeNull();
    expect(raw.onmessage).toBeNull();
    expect(raw.closed).toEqual([1000]);
  });
});

describe("relay socket address", () => {
  it("is the relay's origin as a socket origin, and nothing else", () => {
    const relay = "https://decisions.example.workers.dev";
    expect(socketOriginOf(relay)).toBe("wss://decisions.example.workers.dev");
    expect(
      isRelaySocketUrl("wss://decisions.example.workers.dev/api/v1/socket?ticket=t", relay)
    ).toBe(true);
    expect(isRelaySocketUrl("wss://elsewhere.example/api/v1/socket?ticket=t", relay)).toBe(false);
    expect(isRelaySocketUrl("ws://decisions.example.workers.dev/api/v1/socket", relay)).toBe(false);
    expect(isRelaySocketUrl("not a url", relay)).toBe(false);
    expect(isRelaySocketUrl("ws://localhost:8787/api/v1/socket", "http://localhost:8787")).toBe(
      true
    );
  });
});

describe("retireable", () => {
  it("passes calls through until retired, then refuses every method", async () => {
    let retired = false;
    const target = {
      durable: true,
      value: 1,
      async read() {
        return this.value;
      },
    };
    const guarded = retireable(target, () => retired);

    await expect(guarded.read()).resolves.toBe(1);
    expect(guarded.durable).toBe(true);

    retired = true;

    await expect(guarded.read()).rejects.toBeInstanceOf(RetiredAttemptError);
    expect(guarded.durable).toBe(true);
  });
});

describe("holdingTerminalSink", () => {
  it("finds every pane busy and types nothing", async () => {
    const located = await holdingTerminalSink.locate(ORIGIN);
    expect(located.state).toBe("alive");
    expect(located.target).toMatchObject({ paneId: "pane-1", terminalGeneration: 3 });
    expect(await holdingTerminalSink.isIdle(located.target!)).toBe(false);
    expect(await holdingTerminalSink.inject(located.target!, "answer", "inj-1")).toEqual({
      outcome: "held",
      reason: "socket-attempt",
    });
    expect(await holdingTerminalSink.hasMarker(located.target!, "inj-1")).toBe(false);
  });
});

describe("inertAttemptDelivery", () => {
  async function attemptBridge(store: MemoryLocalStore): Promise<DecisionsBridge> {
    const keys = new MemoryKeyStore();
    await keys.save({
      v: 1,
      config: {
        relayOrigin: "https://decisions.example.workers.dev",
        installationId: "inst_12345678",
        deviceId: "dev_12345678",
        label: "Test desktop",
      },
      keys: await serializeDeviceKeys(await generateDeviceKeys(true)),
      epochs: [{ epoch: 1, raw: bytesToBase64Url(generateEpochKeyBytes()) }],
      currentEpoch: 1,
    });
    return new DecisionsBridge({
      identity: await loadIdentity(keys),
      store,
      sink: holdingTerminalSink,
      pumpIntervalMs: 0,
    });
  }

  it("drains nothing once its bridge reopens delivery, and asks the lifetime about closure writes", async () => {
    const store = new MemoryLocalStore();
    const listed = vi.spyOn(store, "listQuestions");
    const reopened = await attemptBridge(store);
    // As 0.9.0's start leaves it: a reopened engine reads every row, and reports receipts, before any pane.
    reopened.delivery.stopped = false;
    await reopened.delivery.drain();
    expect(listed).toHaveBeenCalled();
    listed.mockClear();

    const attempt = await attemptBridge(store);
    const writing = Promise.resolve();
    inertAttemptDelivery(attempt.delivery, (id) => (id === "q1" ? writing : null));
    attempt.delivery.stopped = false;

    expect(await attempt.delivery.drain()).toEqual({
      delivered: 0,
      deferred: 0,
      needsAttention: 0,
      uncertain: 0,
    });
    expect(listed).not.toHaveBeenCalled();
    expect(attempt.delivery.closureWrite("q1")).toBe(writing);
    expect(attempt.delivery.closureWrite("q2")).toBeNull();
  });
});

describe("TrailingPump", () => {
  /**
   * The library's pump as 0.9.0 has it: a call while a pass runs joins that
   * pass, and each pass settles beside an advisory read it doesn't wait for.
   */
  function libraryPump() {
    const passes: Array<{ finish: () => void; fail: (error: Error) => void }> = [];
    let pumping: Promise<void> | null = null;
    let advisory: Promise<void> = Promise.resolve();
    const pass = (): Promise<void> => {
      if (pumping === null) {
        const core = new Promise<void>((finish, fail) => passes.push({ finish, fail })).finally(
          () => {
            pumping = null;
          }
        );
        pumping = core;
      }
      return Promise.all([pumping, advisory]).then(() => {});
    };
    const pump = new TrailingPump(pass, () => pumping);
    return {
      pump,
      passes,
      holdAdvisory: () => {
        let release!: () => void;
        advisory = new Promise<void>((resolve) => (release = resolve));
        return release;
      },
    };
  }

  const settledState = async (promise: Promise<void>) => {
    let state = "pending";
    promise.then(
      () => (state = "resolved"),
      () => (state = "rejected")
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    return state;
  };

  it("runs one pass when none is in flight", async () => {
    const { pump, passes } = libraryPump();
    const run = pump.run();
    expect(passes).toHaveLength(1);
    passes[0]!.finish();
    await run;
    await pump.settled();
    expect(passes).toHaveLength(1);
  });

  it("runs one more pass after the one in flight, shared by every call made meanwhile", async () => {
    const { pump, passes } = libraryPump();
    const first = pump.run();
    const second = pump.run();
    const third = pump.run();
    expect(passes).toHaveLength(1);

    passes[0]!.finish();
    await first;
    await vi.waitFor(() => expect(passes).toHaveLength(2));
    expect(await settledState(second)).toBe("pending");
    expect(await settledState(third)).toBe("pending");

    passes[1]!.finish();
    await Promise.all([second, third]);
    await pump.settled();
    expect(passes).toHaveLength(2);
  });

  it("queues another pass for a call made once the pass after has started", async () => {
    const { pump, passes } = libraryPump();
    void pump.run();
    void pump.run();
    passes[0]!.finish();
    await vi.waitFor(() => expect(passes).toHaveLength(2));

    const late = pump.run();
    passes[1]!.finish();
    await vi.waitFor(() => expect(passes).toHaveLength(3));
    expect(await settledState(late)).toBe("pending");
    passes[2]!.finish();
    await late;
  });

  it("still runs the pass after when the one in flight fails, and gives each caller the failure", async () => {
    const { pump, passes } = libraryPump();
    const first = pump.run();
    const joined = pump.run();
    passes[0]!.fail(new Error("relay gone"));
    await expect(first).rejects.toThrow("relay gone");
    await expect(joined).rejects.toThrow("relay gone");
    await vi.waitFor(() => expect(passes).toHaveLength(2));
    passes[1]!.finish();
    await expect(pump.settled()).resolves.toBeUndefined();
  });

  it("waits on the pass in flight alone, never on the advisory read beside it", async () => {
    const { pump, passes, holdAdvisory } = libraryPump();
    const releaseAdvisory = holdAdvisory();
    void pump.run();
    void pump.run();
    passes[0]!.finish();
    await vi.waitFor(() => expect(passes).toHaveLength(2));
    releaseAdvisory();
    passes[1]!.finish();
    await pump.settled();
  });

  it("reads the installed library's pass in flight, so a pump asked for during it runs another", async () => {
    const keys = new MemoryKeyStore();
    await keys.save({
      v: 1,
      config: {
        relayOrigin: "https://decisions.example.workers.dev",
        installationId: "inst_12345678",
        deviceId: "dev_12345678",
        label: "Test desktop",
      },
      keys: await serializeDeviceKeys(await generateDeviceKeys(true)),
      epochs: [{ epoch: 1, raw: bytesToBase64Url(generateEpochKeyBytes()) }],
      currentEpoch: 1,
    });
    const passes = async (bridge: typeof DecisionsBridge) => {
      const store = new MemoryLocalStore();
      const reads = vi.spyOn(store, "dueOutbox");
      const made = new bridge({
        identity: await loadIdentity(keys),
        store,
        sink: holdingTerminalSink,
        pumpIntervalMs: 0,
      });
      await Promise.all([made.pump(), made.pump()]);
      await made.idle();
      return reads.mock.calls.length;
    };
    // Each pass with nothing to send reads the outbox once.
    expect(await passes(DecisionsBridge)).toBe(1);
    expect(await passes(AttemptBridge)).toBe(2);
  });
});

describe("socketBridgeStore", () => {
  const question = (id: string) =>
    ({ question_id: id, alias: 1, origin: ORIGIN, delivery_status: "relay-queued" }) as never;

  it("shows a socket attempt no injection intents, whatever the store holds", async () => {
    const store = new MemoryLocalStore();
    await store.putIntent({
      injection_id: "inj-1",
      question_id: "q-1",
      answer_revision: 1,
      message_id: null,
      host_id: ORIGIN.host_id,
      pane_id: ORIGIN.pane_id,
      terminal_generation: 3,
      ownership_principal: ORIGIN.ownership_principal,
      agent_incarnation: ORIGIN.agent_incarnation,
      state: "intent",
      created_at: 1,
      updated_at: 1,
    });
    const view = socketBridgeStore(store, () => {});

    expect(await view.openIntents()).toEqual([]);
    expect(await store.openIntents()).toHaveLength(1);
    expect(await view.getIntent("inj-1")).toMatchObject({ state: "intent" });
  });

  it("passes on an answer made deliverable once its write is stored, and nothing else", async () => {
    const store = new MemoryLocalStore();
    await store.commitNewQuestion(question("q-1"), {
      id: "o-1",
      kind: "create",
      question_id: "q-1",
      payload: {},
      attempts: 0,
      next_attempt_at: 0,
      created_at: 0,
      last_error: null,
    });
    const received = vi.fn();
    const view = socketBridgeStore(store, received);

    await view.updateQuestion("q-1", { local_status: "open" });
    expect(received).not.toHaveBeenCalled();
    const written = view.updateQuestion("q-1", { delivery_status: "desktop-received" });
    expect(received).not.toHaveBeenCalled();
    await written;
    expect(received).toHaveBeenCalledTimes(1);

    const refused = socketBridgeStore(
      retireable(store, () => true),
      received
    ).updateQuestion("q-1", { delivery_status: "desktop-received" });
    await expect(refused).rejects.toBeInstanceOf(RetiredAttemptError);
    expect(received).toHaveBeenCalledTimes(1);
  });

  it("passes on a follow-up the inbox stored, once its write is stored (#16231)", async () => {
    const store = new MemoryLocalStore();
    await store.commitNewQuestion(question("q-1"), {
      id: "o-1",
      kind: "create",
      question_id: "q-1",
      payload: {},
      attempts: 0,
      next_attempt_at: 0,
      created_at: 0,
      last_error: null,
    });
    // Writes that commit only when the test says, as the store's own commit can lag.
    const commits: Array<{ commit: () => void; fail: () => void }> = [];
    const slow = new Proxy(store, {
      get(object, property) {
        if (property !== "updateQuestion") {
          const value: unknown = Reflect.get(object, property, object);
          return typeof value === "function"
            ? (value as (...args: unknown[]) => unknown).bind(object)
            : value;
        }
        return (id: string, patch: Partial<QuestionRow>) =>
          new Promise((resolve, reject) => {
            commits.push({
              commit: () => resolve(object.updateQuestion(id, patch)),
              fail: () => reject(new Error("refused")),
            });
          });
      },
    });
    const received = vi.fn();
    const view = socketBridgeStore(slow, received);

    const written = view.updateQuestion("q-1", { messages_json: "[]" });
    await Promise.resolve();
    await Promise.resolve();
    expect(received).not.toHaveBeenCalled();
    commits[0]!.commit();
    await written;
    expect(received).toHaveBeenCalledTimes(1);

    const failed = view.updateQuestion("q-1", { messages_json: "[]" });
    commits[1]!.fail();
    await expect(failed).rejects.toThrow("refused");
    expect(received).toHaveBeenCalledTimes(1);

    const refused = socketBridgeStore(
      retireable(store, () => true),
      received
    ).updateQuestion("q-1", { messages_json: "[]" });
    await expect(refused).rejects.toBeInstanceOf(RetiredAttemptError);
    expect(received).toHaveBeenCalledTimes(1);
  });
});

describe("watchResume", () => {
  it("listens to powerMonitor resume until stopped", () => {
    const onResume = vi.fn();
    const stop = watchResume(onResume);
    expect(powerMonitor.on).toHaveBeenCalledWith("resume", onResume);
    stop();
    expect(powerMonitor.off).toHaveBeenCalledWith("resume", onResume);
  });
});
