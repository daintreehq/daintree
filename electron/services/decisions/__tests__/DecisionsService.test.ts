import { describe, expect, it, vi } from "vitest";
import { DecisionsService, type DecisionsStoreOpener } from "../DecisionsService.js";
import type { DaintreeLocalStore } from "../daintreeLocalStore.js";
import { defaultDecisionsSettings } from "../decisionsSettings.js";
import type {
  DecisionsSettings,
  DecisionsStatusEvent,
  PaneDecisionState,
} from "../../../../shared/types/decisions.js";
import { outstandingRows, row } from "./questionRows.js";
import type { RelayConnectionOptions } from "../relayConnection.js";

interface FakeStore {
  close: ReturnType<typeof vi.fn>;
}

function fakeStore(): FakeStore & DaintreeLocalStore {
  return { close: vi.fn(async () => {}) } as unknown as FakeStore & DaintreeLocalStore;
}

/** A service whose store opener hands out fakes, recording each one. */
function make(openStore?: DecisionsStoreOpener): DecisionsService {
  return new DecisionsService({ openStore: openStore ?? (async () => fakeStore()) });
}

function on(overrides: Partial<DecisionsSettings> = {}): DecisionsSettings {
  return { ...defaultDecisionsSettings(), enabled: true, ...overrides };
}

function recordStates(service: DecisionsService): string[] {
  const states: string[] = [];
  service.onStatusChanged((event: DecisionsStatusEvent) => states.push(event.status.state));
  return states;
}

describe("DecisionsService", () => {
  it("is off until started, and on without a relay is not connected", async () => {
    const service = make();
    expect(service.getStatus()).toEqual({ state: "off" });

    await service.start(on());

    expect(service.getStatus()).toEqual({ state: "not-connected" });
    expect(service.getSettings()?.enabled).toBe(true);
  });

  it("starts nothing for settings that are off", async () => {
    const service = make();
    const states = recordStates(service);

    await service.start(defaultDecisionsSettings());

    expect(service.getStatus().state).toBe("off");
    expect(service.getSettings()).toBeNull();
    expect(states).toEqual([]);
  });

  it("reports each change once, and a repeat start is no change", async () => {
    const service = make();
    const states = recordStates(service);

    await service.start(on());
    await service.start(on({ proxyAllowlisted: true }));
    await service.stop();
    await service.stop();

    expect(states).toEqual(["not-connected", "off"]);
  });

  it("carries the newest settings when started again while running", async () => {
    const service = make();
    await service.start(on());
    await service.start(on({ relayOrigin: "https://relay.example.com" }));

    expect(service.getSettings()?.relayOrigin).toBe("https://relay.example.com");
  });

  it("can start again after a stop, and keeps its listeners across it", async () => {
    const service = make();
    const states = recordStates(service);

    await service.start(on());
    await service.stop();
    await service.start(on());

    expect(service.getStatus().state).toBe("not-connected");
    expect(states).toEqual(["not-connected", "off", "not-connected"]);
  });

  it("runs transitions in the order asked, without waiting between calls", async () => {
    const service = make();
    const states = recordStates(service);

    const steps = [service.start(on()), service.stop(), service.start(on())];
    await Promise.all(steps);

    expect(states).toEqual(["not-connected", "off", "not-connected"]);
  });

  it("refuses a start still queued when dispose is asked, and every start after", async () => {
    const service = make();
    const states = recordStates(service);

    const queued = service.start(on());
    const disposing = service.dispose();
    await Promise.all([queued, disposing]);
    await service.start(on());

    expect(service.getStatus().state).toBe("off");
    expect(states).toEqual([]);
  });

  it("reports off once on dispose, then drops its listeners", async () => {
    const service = make();
    const states = recordStates(service);
    await service.start(on());

    await service.dispose();
    await service.dispose();

    expect(states).toEqual(["not-connected", "off"]);
  });

  it("stops telling a listener that unsubscribed", async () => {
    const service = make();
    const listener = vi.fn();
    const off = service.onStatusChanged(listener);
    off();
    off();

    await service.start(on());

    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps telling the others when one listener throws", async () => {
    const service = make();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    service.onStatusChanged(() => {
      throw new Error("listener broke");
    });
    const states = recordStates(service);

    await service.start(on());

    expect(states).toEqual(["not-connected"]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("hands status out as a copy, never its own record", async () => {
    const service = make();
    const read = service.getStatus();
    read.state = "connected";

    expect(service.getStatus().state).toBe("off");
  });

  it("binds every published Decisions library", () => {
    const { libraries } = new DecisionsService();

    expect(typeof libraries.protocol.PROTOCOL_VERSION).toBe("number");
    expect(typeof libraries.client.RelaySocket).toBe("function");
    expect(Object.keys(libraries.crypto).length).toBeGreaterThan(0);
    expect(Object.keys(libraries.model).length).toBeGreaterThan(0);
  });

  it("forgets the lifetime's settings on stop and on dispose", async () => {
    const service = make();
    await service.start(on());
    await service.stop();
    expect(service.getSettings()).toBeNull();

    await service.start(on());
    await service.dispose();
    expect(service.getSettings()).toBeNull();
  });

  it("has no key store while off, and makes one only when it is first asked for", async () => {
    const keyFilePath = vi.fn(() => "/tmp/decisions-test/keys.bin");
    const service = new DecisionsService({ openStore: async () => fakeStore(), keyFilePath });
    expect(() => service.getKeyStore()).toThrow(/off/);

    await service.start(on());
    expect(keyFilePath).not.toHaveBeenCalled();

    const store = service.getKeyStore();
    await service.start(on({ proxyAllowlisted: true }));
    expect(service.getKeyStore()).toBe(store);
    expect(store.filePath).toBe("/tmp/decisions-test/keys.bin");
    expect(keyFilePath).toHaveBeenCalledTimes(1);
  });

  it("closes the lifetime's key store on stop, and a new lifetime gets its own", async () => {
    const service = new DecisionsService({
      openStore: async () => fakeStore(),
      keyFilePath: () => "/tmp/decisions-test/keys.bin",
    });
    await service.start(on());
    const first = service.getKeyStore();

    await service.stop();
    expect(() => service.getKeyStore()).toThrow(/off/);
    await expect(first.load()).rejects.toMatchObject({ kind: "closed" });

    await service.start(on());
    const second = service.getKeyStore();
    expect(second).not.toBe(first);

    await service.dispose();
    expect(() => service.getKeyStore()).toThrow(/off/);
    await expect(second.load()).rejects.toMatchObject({ kind: "closed" });
  });

  it("waits for the key store to close before a stop settles", async () => {
    const service = new DecisionsService({
      openStore: async () => fakeStore(),
      keyFilePath: () => "/tmp/decisions-test/keys.bin",
    });
    await service.start(on());
    let finishClosing!: () => void;
    vi.spyOn(service.getKeyStore(), "close").mockReturnValue(
      new Promise<void>((resolve) => (finishClosing = resolve))
    );

    let stopped = false;
    const stopping = service.stop().then(() => (stopped = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopped).toBe(false);

    finishClosing();
    await stopping;
    expect(stopped).toBe(true);
  });

  it("runs the next transition after one that failed", async () => {
    const service = make();
    const unreadable = {
      ...on(),
      get enabled(): boolean {
        throw new Error("unreadable settings");
      },
    } as DecisionsSettings;

    await expect(service.start(unreadable)).rejects.toThrow("unreadable settings");
    await service.start(on());

    expect(service.getStatus().state).toBe("not-connected");
  });
});

describe("DecisionsService store", () => {
  it("opens the store once per enabled lifetime and closes it when the lifetime ends", async () => {
    const opened: FakeStore[] = [];
    const service = make(async () => {
      const store = fakeStore();
      opened.push(store);
      return store;
    });

    await service.start(on());
    await service.start(on({ proxyAllowlisted: true }));
    expect(opened).toHaveLength(1);
    expect(service.getStore()).toBe(opened[0]);

    await service.stop();
    expect(opened[0].close).toHaveBeenCalledTimes(1);
    expect(service.getStore()).toBeNull();

    await service.start(on());
    expect(opened).toHaveLength(2);
    expect(service.getStore()).toBe(opened[1]);

    await service.dispose();
    expect(opened[1].close).toHaveBeenCalledTimes(1);
    expect(service.getStore()).toBeNull();
  });

  it("stays on without a store when it can't open, and tries again on the next start", async () => {
    let fail = true;
    const store = fakeStore();
    const service = make(async () => {
      if (fail) throw new Error("database unavailable");
      return store;
    });

    await expect(service.start(on())).rejects.toThrow("database unavailable");
    expect(service.getStatus().state).toBe("not-connected");
    expect(service.getStore()).toBeNull();

    fail = false;
    await service.start(on());
    expect(service.getStore()).toBe(store);
  });

  it("closes a store that finishes opening after dispose before that start settles, and never keeps it", async () => {
    let finishOpen!: () => void;
    let finishClose!: () => void;
    let cancelled: (() => boolean) | null = null;
    const store = fakeStore();
    store.close.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        })
    );
    const service = make(async (isCancelled) => {
      cancelled = isCancelled;
      await new Promise<void>((resolve) => {
        finishOpen = resolve;
      });
      return store;
    });

    const starting = service.start(on());
    await vi.waitFor(() => expect(cancelled).not.toBeNull());
    expect(cancelled!()).toBe(false);
    const disposing = service.dispose();
    expect(cancelled!()).toBe(true);

    let started = false;
    void starting.then(() => {
      started = true;
    });
    finishOpen();
    await vi.waitFor(() => expect(store.close).toHaveBeenCalledTimes(1));
    expect(service.getStore()).toBeNull();
    expect(started).toBe(false);

    finishClose();
    await Promise.all([starting, disposing]);

    expect(store.close).toHaveBeenCalledTimes(1);
    expect(service.getStore()).toBeNull();
    expect(service.getStatus().state).toBe("off");
  });

  it("reports off only once the store has finished closing", async () => {
    let finishClose!: () => void;
    const store = fakeStore();
    store.close.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        })
    );
    const service = make(async () => store);
    const states = recordStates(service);
    await service.start(on());

    const stopping = service.stop();
    await vi.waitFor(() => expect(store.close).toHaveBeenCalledTimes(1));
    expect(service.getStatus().state).toBe("not-connected");

    finishClose();
    await stopping;
    expect(states).toEqual(["not-connected", "off"]);
  });
});

describe("DecisionsService pane state", () => {
  function withPushes() {
    const pushes: Array<{ projectId: string; state: PaneDecisionState }> = [];
    const service = new DecisionsService({
      openStore: async () => fakeStore(),
      publishPaneState: (projectId, state) => pushes.push({ projectId, state }),
    });
    return { pushes, service };
  }

  it("holds and pushes nothing before it starts, whatever it is fed", () => {
    const { pushes, service } = withPushes();

    service.observeQuestions([row(1)]);

    expect(pushes).toEqual([]);
    expect(service.getPaneState("pane-a")).toBeNull();
  });

  it("pushes and answers each pane's state while running", async () => {
    const { pushes, service } = withPushes();
    await service.start(on());

    service.observeQuestions([row(1)]);

    expect(pushes).toEqual([
      { projectId: "project-1", state: expect.objectContaining({ terminalId: "pane-a" }) },
    ]);
    expect(service.getPaneState("pane-a")).toEqual(pushes[0]?.state);
    expect(service.getPaneState("pane-unknown")).toBeNull();
  });

  it("keeps a pane's state across a repeat start", async () => {
    const { pushes, service } = withPushes();
    await service.start(on());
    service.observeQuestions([row(1)]);

    await service.start(on({ proxyAllowlisted: true }));

    expect(service.getPaneState("pane-a")?.openQuestions).toHaveLength(1);
    expect(pushes).toHaveLength(1);
  });

  it("clears each pane's views fully once on stop, then pushes nothing while off", async () => {
    const { pushes, service } = withPushes();
    await service.start(on());
    service.observeQuestions(outstandingRows());

    await service.stop();
    await service.stop();
    service.observeQuestions([row(4)]);

    expect(pushes).toHaveLength(2);
    expect(pushes[1]).toEqual({
      projectId: "project-1",
      state: {
        terminalId: "pane-a",
        openQuestions: [],
        waitingAnswers: [],
        needsAttention: [],
        revision: expect.any(Number),
      },
    });
    expect(pushes[1]!.state.revision).toBeGreaterThan(pushes[0]!.state.revision);
    expect(service.getPaneState("pane-a")).toBeNull();
  });

  it("clears a pane fed while the store is still closing", async () => {
    let finishClose!: () => void;
    const store = fakeStore();
    store.close.mockImplementation(() => new Promise<void>((resolve) => (finishClose = resolve)));
    const pushes: PaneDecisionState[] = [];
    const service = new DecisionsService({
      openStore: async () => store,
      publishPaneState: (_projectId, state) => pushes.push(state),
    });
    await service.start(on());

    const stopping = service.stop();
    await vi.waitFor(() => expect(store.close).toHaveBeenCalledOnce());
    service.observeQuestions([row(1)]);
    finishClose();
    await stopping;

    expect(pushes.map((state) => state.openQuestions.length)).toEqual([1, 0]);
    expect(service.getPaneState("pane-a")).toBeNull();
  });

  it("pushes nothing for a stop still closing the store when quit begins", async () => {
    let finishClose!: () => void;
    const store = fakeStore();
    store.close.mockImplementation(() => new Promise<void>((resolve) => (finishClose = resolve)));
    const pushes: PaneDecisionState[] = [];
    const service = new DecisionsService({
      openStore: async () => store,
      publishPaneState: (_projectId, state) => pushes.push(state),
    });
    await service.start(on());
    service.observeQuestions([row(1)]);

    const stopping = service.stop();
    await vi.waitFor(() => expect(store.close).toHaveBeenCalledOnce());
    const disposing = service.dispose();
    finishClose();
    await Promise.all([stopping, disposing]);

    expect(pushes).toHaveLength(1);
  });

  it("outranks the last lifetime's pushes after it starts again", async () => {
    // A still clock, so only the service's own counter can order the pushes.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    try {
      const { pushes, service } = withPushes();
      await service.start(on());
      service.observeQuestions([row(1)]);
      await service.stop();

      await service.start(on());
      service.observeQuestions([row(1)]);

      expect(pushes.map(({ state }) => state.revision)).toEqual([1, 2, 3]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pushes nothing from the moment quit begins, and nothing after", async () => {
    const { pushes, service } = withPushes();
    await service.start(on());
    service.observeQuestions([row(1)]);

    const disposing = service.dispose();
    service.observeQuestions([row(1), row(2)]);
    await disposing;
    service.observeQuestions([row(3)]);

    expect(pushes).toHaveLength(1);
    expect(service.getPaneState("pane-a")).toBeNull();
  });
});

describe("DecisionsService relay connection", () => {
  const RELAY = {
    relayOrigin: "https://relay.example.com",
    installationId: "inst_12345678",
    deviceId: "dev_12345678",
  };

  /** A service whose connections are recorded, never run. */
  function connected(openStore?: DecisionsStoreOpener) {
    const events: string[] = [];
    const made: Array<{ options: RelayConnectionOptions; stopped: boolean }> = [];
    const revoked: unknown[] = [];
    const service = new DecisionsService({
      openStore:
        openStore ??
        (async () => {
          const store = fakeStore();
          store.close.mockImplementation(async () => {
            events.push("store closed");
          });
          return store;
        }),
      keyFilePath: () => "/nonexistent/keys.bin",
      onRelayRevoked: (relay) => revoked.push(relay),
      connect: (options) => {
        const record = { options, stopped: false };
        made.push(record);
        return {
          start: () => events.push(`started ${made.length}`),
          stop: () => {
            record.stopped = true;
            events.push(`stopped ${made.indexOf(record) + 1}`);
          },
        };
      },
    });
    return { service, events, made, revoked };
  }

  it("runs no connection without a complete relay identity", async () => {
    const { service, made } = connected();
    await service.start(
      on({ relayOrigin: RELAY.relayOrigin, installationId: RELAY.installationId })
    );
    expect(made).toHaveLength(0);
    expect(service.getStatus()).toEqual({ state: "not-connected" });
  });

  it("connects once the store is open, with the lifetime's store and keys, and shows what it reports", async () => {
    const { service, made, events } = connected();
    await service.start(on(RELAY));
    await service.start(on({ ...RELAY, proxyAllowlisted: true }));

    expect(made).toHaveLength(1);
    expect(events).toEqual(["started 1"]);
    expect(made[0]!.options.relay).toEqual(RELAY);
    expect(made[0]!.options.store).toBe(service.getStore());
    expect(made[0]!.options.keys).toBe(service.getKeyStore());

    made[0]!.options.onStatus({ state: "reconnecting", nextAttemptAt: 42 });
    expect(service.getStatus()).toEqual({ state: "reconnecting", nextAttemptAt: 42 });
    made[0]!.options.onStatus({ state: "not-connected", problem: "keys" });
    expect(service.getStatus()).toEqual({ state: "not-connected", problem: "keys" });
  });

  it("stops the connection before the store closes", async () => {
    const { service, events } = connected();
    await service.start(on(RELAY));
    await service.stop();
    expect(events).toEqual(["started 1", "stopped 1", "store closed"]);
    expect(service.getStatus()).toEqual({ state: "off" });
  });

  it("ignores what a stopped connection reports, and a revocation it reports late", async () => {
    const { service, made, revoked } = connected();
    await service.start(on(RELAY));
    const first = made[0]!;
    await service.stop();

    first.options.onStatus({ state: "connected" });
    first.options.onRevoked();
    expect(service.getStatus()).toEqual({ state: "off" });
    expect(revoked).toEqual([]);
  });

  it("passes on a revocation with the identity it was for", async () => {
    const { service, made, revoked } = connected();
    await service.start(on(RELAY));
    made[0]!.options.onRevoked();
    expect(revoked).toEqual([RELAY]);
  });

  it("is revoked, connecting nothing, for an identity the relay revoked", async () => {
    const { service, made } = connected();
    await service.start(on({ ...RELAY, revokedAt: 7 }));
    expect(made).toHaveLength(0);
    expect(service.getStatus()).toEqual({ state: "revoked" });

    const { service: running, made: runningMade } = connected();
    await running.start(on(RELAY));
    running.updateSettings(on({ ...RELAY, revokedAt: 7 }));
    expect(runningMade[0]!.stopped).toBe(true);
    expect(running.getStatus()).toEqual({ state: "revoked" });
  });

  it("swaps to a fresh connection when the identity changes, and none once it's gone", async () => {
    const { service, made, events } = connected();
    await service.start(on(RELAY));

    service.updateSettings(on({ ...RELAY, deviceId: "dev_87654321" }));
    expect(made).toHaveLength(2);
    expect(made[1]!.options.relay.deviceId).toBe("dev_87654321");

    service.updateSettings(on());
    expect(events).toEqual(["started 1", "stopped 1", "started 2", "stopped 2"]);
    expect(service.getStatus()).toEqual({ state: "not-connected" });
  });

  it("suspends the connection for a disconnect, and resumes it if that failed", async () => {
    const { service, made, events } = connected();
    await service.start(on(RELAY));
    made[0]!.options.onStatus({ state: "connected" });

    service.suspendConnection();
    expect(service.getStatus()).toEqual({ state: "not-connected" });
    service.resumeConnection();

    expect(events).toEqual(["started 1", "stopped 1", "started 2"]);
  });

  it("names the store as the problem when it can't open for a relay that's set up", async () => {
    const { service, made } = connected(async () => {
      throw new Error("database unavailable");
    });
    await expect(service.start(on(RELAY))).rejects.toThrow("database unavailable");
    expect(service.getStatus()).toEqual({ state: "not-connected", problem: "storage" });
    expect(made).toHaveLength(0);
  });
});
