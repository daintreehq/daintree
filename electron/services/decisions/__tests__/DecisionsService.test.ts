import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DecisionsService,
  type DecisionsServiceOptions,
  type DecisionsStoreOpener,
} from "../DecisionsService.js";
import type { DaintreeLocalStore } from "../daintreeLocalStore.js";
import { defaultDecisionsSettings } from "../decisionsSettings.js";
import type {
  DecisionsSettings,
  DecisionsStatusEvent,
  PaneDecisionState,
} from "../../../../shared/types/decisions.js";
import { outstandingRows, row } from "./questionRows.js";
import type { DecisionsRows } from "../localData.js";
import type { QuestionSource, RelayConnectionOptions } from "../relayConnection.js";
import type { QuestionRow } from "@daintreehq/decisions-client";

interface FakeStore {
  close: ReturnType<typeof vi.fn>;
}

function fakeStore(): FakeStore & DaintreeLocalStore {
  return {
    close: vi.fn(async () => {}),
    onCommit: () => () => {},
    listQuestions: async () => [],
    referencedAttachmentIds: vi.fn(async () => new Set<string>()),
  } as unknown as FakeStore & DaintreeLocalStore;
}

/** A key file nothing writes, so each start finds no deletion to finish. */
const ABSENT_KEY_FILE = join(tmpdir(), "decisions-service-test-absent", "keys.bin");

/** A service whose store opener hands out fakes, recording each one. */
function make(openStore?: DecisionsStoreOpener): DecisionsService {
  return new DecisionsService({
    openStore: openStore ?? (async () => fakeStore()),
    keyFilePath: () => ABSENT_KEY_FILE,
  });
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

    // Starting only names the file, to look for a deletion that stopped partway beside it.
    await service.start(on());
    expect(keyFilePath).toHaveBeenCalledTimes(1);

    const store = service.getKeyStore();
    await service.start(on({ proxyAllowlisted: true }));
    expect(service.getKeyStore()).toBe(store);
    expect(store.filePath).toBe("/tmp/decisions-test/keys.bin");
    expect(keyFilePath).toHaveBeenCalledTimes(2);
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
      keyFilePath: () => ABSENT_KEY_FILE,
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

  it("shows each pane what the store holds when it starts, and again after each commit", async () => {
    let rows = [row(1)];
    const listeners = new Set<() => void>();
    const store = {
      ...fakeStore(),
      onCommit: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      listQuestions: async () => rows,
    } as unknown as DaintreeLocalStore;
    const pushes: PaneDecisionState[] = [];
    const service = new DecisionsService({
      openStore: async () => store,
      keyFilePath: () => ABSENT_KEY_FILE,
      publishPaneState: (_projectId, state) => pushes.push(state),
    });

    await service.start(on());
    expect(service.getPaneState("pane-a")?.openQuestions).toHaveLength(1);

    rows = [row(1), row(2)];
    for (const listener of listeners) listener();
    for (const listener of listeners) listener();
    await vi.waitFor(() => expect(service.getPaneState("pane-a")?.openQuestions).toHaveLength(2));
    expect(pushes).toHaveLength(2);

    await service.stop();
    expect(listeners.size).toBe(0);
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
      keyFilePath: () => ABSENT_KEY_FILE,
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
      keyFilePath: () => ABSENT_KEY_FILE,
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
  function connected(
    openStore?: DecisionsStoreOpener,
    openQuestions?: DecisionsServiceOptions["openQuestions"]
  ) {
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
      ...(openQuestions ? { openQuestions } : {}),
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

  it("closes the store only once a stopped connection has settled its deliveries", async () => {
    const events: string[] = [];
    let settle!: () => void;
    const service = new DecisionsService({
      openStore: async () => {
        const store = fakeStore();
        store.close.mockImplementation(async () => {
          events.push("store closed");
        });
        return store;
      },
      keyFilePath: () => "/nonexistent/keys.bin",
      connect: () => ({
        start: () => {},
        stop: () => {
          events.push("connection stopped");
          return new Promise<void>((resolve) => {
            settle = () => {
              events.push("deliveries settled");
              resolve();
            };
          });
        },
      }),
    });
    await service.start(on(RELAY));

    const stopping = service.stop();
    await vi.waitFor(() => expect(events).toEqual(["connection stopped"]));
    settle();
    await stopping;
    expect(events).toEqual(["connection stopped", "deliveries settled", "store closed"]);
  });

  it("hands delivery this machine's host id as the running settings name it", async () => {
    const delivery = {
      principalFor: () => null,
      getPtyClient: () => null,
      holdWakes: () => ({ queueWake: () => {}, cancelQueued: () => {}, release: () => {} }),
      watchPanes: () => () => {},
    };
    const made: RelayConnectionOptions[] = [];
    const service = new DecisionsService({
      openStore: async () => fakeStore(),
      keyFilePath: () => "/nonexistent/keys.bin",
      delivery,
      connect: (options) => {
        made.push(options);
        return { start: () => {}, stop: () => {} };
      },
    });
    await service.start(on({ ...RELAY, hostId: "host_aaaaaaaa" }));

    expect(made[0].delivery?.watchPanes).toBe(delivery.watchPanes);
    expect(made[0].delivery?.hostId()).toBe("host_aaaaaaaa");
    await service.stop();
    expect(made[0].delivery?.hostId()).toBeNull();
  });

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
    // The lifetime's own store, watched for question writes on the way through.
    const lifetimeStore = service.getStore() as unknown as FakeStore;
    await made[0]!.options.store.close();
    expect(lifetimeStore.close).toHaveBeenCalledTimes(1);
    expect(made[0]!.options.keys).toBe(service.getKeyStore());

    made[0]!.options.onStatus({ state: "reconnecting", nextAttemptAt: 42 });
    expect(service.getStatus()).toEqual({ state: "reconnecting", nextAttemptAt: 42 });
    made[0]!.options.onStatus({ state: "not-connected", problem: "keys" });
    expect(service.getStatus()).toEqual({ state: "not-connected", problem: "keys" });
  });

  it("hands the connection the open store's attachments, and lets an ask they hold finish before the store closes", async () => {
    const { service, made, events } = connected();
    await service.start(on(RELAY));
    const attachments = made[0]!.options.attachments!;
    expect(attachments.spool).toBeDefined();
    let started = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const asking = attachments.register(async () => {
      started = true;
      await held;
      events.push("ask settled");
    });
    await vi.waitFor(() => expect(started).toBe(true));

    const stopping = service.stop();
    await vi.waitFor(() => expect(events).toContain("stopped 1"));
    expect(events).not.toContain("store closed");
    release();
    await Promise.all([asking, stopping]);

    expect(events).toEqual(["started 1", "stopped 1", "ask settled", "store closed"]);
    await expect(attachments.register(async () => "late")).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("hands every connection of a lifetime the same trusted policy, and changes it in place", async () => {
    const { service, made } = connected();
    await service.start(on(RELAY));
    const policy = service.getPolicy();
    expect(policy?.get("design-review/final")?.minRequirement).toBe("human-required");
    expect(made[0]!.options.policy).toBe(policy);
    expect(policy?.resolve({ requested: "proxy-ok" }).requirement).toBe("human-required");

    service.updateSettings(on({ ...RELAY, proxyAllowlisted: true }));
    expect(service.getPolicy()).toBe(policy);
    expect(policy?.resolve({ requested: "proxy-ok" }).requirement).toBe("proxy-ok");

    // Another relay identity gets a new connection on the same policy.
    service.updateSettings(on({ ...RELAY, proxyAllowlisted: true, deviceId: "dev_87654321" }));
    expect(made).toHaveLength(2);
    expect(made[1]!.options.policy).toBe(policy);

    await service.start(on({ ...RELAY, proxyAllowlisted: false, deviceId: "dev_87654321" }));
    expect(service.getPolicy()).toBe(policy);
    expect(policy?.resolve({ requested: "proxy-ok" }).requirement).toBe("human-required");
  });

  it("drops the policy with the lifetime, and the next lifetime starts from the saved settings", async () => {
    const { service } = connected();
    await service.start(on({ ...RELAY, proxyAllowlisted: true }));
    const first = service.getPolicy();
    await service.stop();
    expect(service.getPolicy()).toBeNull();

    // A change to stopped settings changes nothing, and the next start takes what it is given.
    service.updateSettings(on({ ...RELAY, proxyAllowlisted: true }));
    expect(service.getPolicy()).toBeNull();
    await service.start(on(RELAY));
    const second = service.getPolicy();
    expect(second).not.toBe(first);
    expect(second?.resolve({ requested: "proxy-ok" }).requirement).toBe("human-required");
    expect(second?.get("design-review/final")).toBeDefined();
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

  it("passes on a revocation with the identity it was for, and stops connecting with it", async () => {
    const { service, made, revoked } = connected();
    await service.start(on(RELAY));
    made[0]!.options.onRevoked();
    expect(revoked).toEqual([RELAY]);
    expect(made[0]!.stopped).toBe(true);
    expect(service.getStatus()).toEqual({ state: "revoked" });

    // Settings read before the revocation was recorded don't bring it back.
    await service.start(on(RELAY));
    service.updateSettings(on({ ...RELAY, proxyAllowlisted: true }));
    expect(made).toHaveLength(1);
    expect(service.getStatus()).toEqual({ state: "revoked" });

    // Another identity, or none, is a fresh start.
    service.updateSettings(on());
    service.updateSettings(on(RELAY));
    expect(made).toHaveLength(2);
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

  it("starts a replacement connection only once the one stopped before it has settled", async () => {
    const events: string[] = [];
    const settles: Array<() => void> = [];
    const made: RelayConnectionOptions[] = [];
    const service = new DecisionsService({
      openStore: async () => fakeStore(),
      keyFilePath: () => "/nonexistent/keys.bin",
      connect: (options) => {
        made.push(options);
        const n = made.length;
        return {
          start: () => events.push(`started ${n}`),
          stop: () => {
            events.push(`stopped ${n}`);
            return new Promise<void>((resolve) => {
              settles.push(() => {
                events.push(`settled ${n}`);
                resolve();
              });
            });
          },
        };
      },
    });
    await service.start(on(RELAY));

    // Another identity: a disconnect and a new claim.
    service.updateSettings(on({ ...RELAY, deviceId: "dev_87654321" }));
    await Promise.resolve();
    expect(events).toEqual(["started 1", "stopped 1"]);

    settles[0]!();
    await vi.waitFor(() =>
      expect(events).toEqual(["started 1", "stopped 1", "settled 1", "started 2"])
    );
    expect(made[1]!.relay.deviceId).toBe("dev_87654321");
  });

  it.each([
    ["a stop", (service: DecisionsService) => service.stop()],
    ["a suspension", (service: DecisionsService) => service.suspendConnection()],
  ] as const)(
    "starts no replacement still waiting on a settling connection after %s",
    async (_label, end) => {
      const settles: Array<() => void> = [];
      const made: RelayConnectionOptions[] = [];
      const stopped: number[] = [];
      const service = new DecisionsService({
        openStore: async () => fakeStore(),
        keyFilePath: () => "/nonexistent/keys.bin",
        connect: (options) => {
          made.push(options);
          const n = made.length;
          return {
            start: () => {},
            stop: () => {
              stopped.push(n);
              return new Promise<void>((resolve) => settles.push(resolve));
            },
          };
        },
      });
      await service.start(on(RELAY));
      service.updateSettings(on({ ...RELAY, deviceId: "dev_87654321" }));

      const ending = end(service);
      settles[0]!();
      await ending;
      await new Promise((resolve) => setImmediate(resolve));
      expect(made).toHaveLength(1);
      expect(stopped).toEqual([1]);
    }
  );

  it("resolves a suspension only once its connection has settled, so the keys can go", async () => {
    let settle!: () => void;
    const service = new DecisionsService({
      openStore: async () => fakeStore(),
      keyFilePath: () => "/nonexistent/keys.bin",
      connect: () => ({
        start: () => {},
        stop: () =>
          new Promise<void>((resolve) => {
            settle = resolve;
          }),
      }),
    });
    await service.start(on(RELAY));

    let suspended = false;
    const suspending = service.suspendConnection().then(() => {
      suspended = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(suspended).toBe(false);
    settle();
    await suspending;
    expect(suspended).toBe(true);
  });

  it("names the store as the problem when it can't open for a relay that's set up", async () => {
    const { service, made } = connected(async () => {
      throw new Error("database unavailable");
    });
    await expect(service.start(on(RELAY))).rejects.toThrow("database unavailable");
    expect(service.getStatus()).toEqual({ state: "not-connected", problem: "storage" });
    expect(made).toHaveLength(0);
  });
  /** Routes the service opens for agents' questions, with what became of each. */
  function questionRoutes(events: string[] = []) {
    const opened: Array<{
      source: QuestionSource;
      previous: Promise<void>;
      closed: number;
      release: () => void;
    }> = [];
    const openQuestions = (source: QuestionSource, previous: Promise<void>) => {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const record = { source, previous, closed: 0, release };
      opened.push(record);
      events.push(`questions opened ${opened.length}`);
      return {
        listenerPort: async () => (record.closed > 0 ? null : 4100),
        close: () => {
          record.closed += 1;
          events.push(`questions closed ${opened.indexOf(record) + 1}`);
          return released.then(() => {
            events.push(`questions released ${opened.indexOf(record) + 1}`);
          });
        },
      };
    };
    return { opened, openQuestions };
  }

  const SOURCE: QuestionSource = {
    identity: () => null,
    live: () => null,
    store: {} as QuestionSource["store"],
    policy: {} as QuestionSource["policy"],
  };

  it("opens agents' questions once the connection's identity is ready, and only for the current one", async () => {
    const routes = questionRoutes();
    const { service, made } = connected(undefined, routes.openQuestions);
    await service.start(on(RELAY));
    expect(routes.opened).toHaveLength(0);

    made[0]!.options.onQuestionsReady!(SOURCE);
    expect(routes.opened.map((route) => route.source)).toEqual([SOURCE]);

    // A connection the service let go of opens nothing.
    const first = made[0]!;
    await service.updateSettings(on({ ...RELAY, deviceId: "dev_another1" }));
    first.options.onQuestionsReady!(SOURCE);
    expect(routes.opened).toHaveLength(1);
    expect(routes.opened[0]!.closed).toBe(1);
    routes.opened[0]!.release();
    await service.stop();
  });

  it("hands a launch the route's port once the connection opens it, waiting while its identity loads", async () => {
    const routes = questionRoutes();
    const { service, made } = connected(undefined, routes.openQuestions);
    await service.start(on(RELAY));

    const port = service.questionsPort(60_000);
    let settled = false;
    void port.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    made[0]!.options.onQuestionsReady!(SOURCE);
    await expect(port).resolves.toBe(4100);
    // Once open, a launch is answered at once.
    await expect(service.questionsPort(60_000)).resolves.toBe(4100);
    routes.opened[0]!.release();
    await service.stop();
  });

  it("answers a launch with no port at once while there is no relay, or the connection stopped", async () => {
    const routes = questionRoutes();
    const bare = connected(undefined, routes.openQuestions);
    await bare.service.start(on());
    await expect(bare.service.questionsPort(60_000)).resolves.toBeNull();
    await bare.service.stop();

    const { service, made } = connected(undefined, routes.openQuestions);
    await service.start(on(RELAY));
    made[0]!.options.onStatus({ state: "not-connected", problem: "keys" });
    await expect(service.questionsPort(60_000)).resolves.toBeNull();
    await service.stop();
    await expect(service.questionsPort(60_000)).resolves.toBeNull();
  });

  it("wakes a waiting launch with no port when the connection halts, the lifetime stops, or the wait is up", async () => {
    const routes = questionRoutes();
    const halted = connected(undefined, routes.openQuestions);
    await halted.service.start(on(RELAY));
    const haltedPort = halted.service.questionsPort(60_000);
    halted.made[0]!.options.onStatus({ state: "revoked" });
    await expect(haltedPort).resolves.toBeNull();
    await halted.service.stop();

    const stopped = connected(undefined, routes.openQuestions);
    await stopped.service.start(on(RELAY));
    const stoppedPort = stopped.service.questionsPort(60_000);
    await stopped.service.stop();
    await expect(stoppedPort).resolves.toBeNull();

    const slow = connected(undefined, routes.openQuestions);
    await slow.service.start(on(RELAY));
    await expect(slow.service.questionsPort(10)).resolves.toBeNull();
    await slow.service.stop();
  });

  it("closes the questions when the connection stops for the lifetime, is revoked or let go", async () => {
    for (const end of [
      (options: RelayConnectionOptions) =>
        options.onStatus({ state: "not-connected", problem: "keys" }),
      (options: RelayConnectionOptions) => options.onStatus({ state: "revoked" }),
      (options: RelayConnectionOptions) => options.onRevoked(),
    ]) {
      const routes = questionRoutes();
      const { service, made } = connected(undefined, routes.openQuestions);
      await service.start(on(RELAY));
      made[0]!.options.onQuestionsReady!(SOURCE);

      made[0]!.options.onStatus({ state: "reconnecting", nextAttemptAt: 1 });
      expect(routes.opened[0]!.closed).toBe(0);
      end(made[0]!.options);
      expect(routes.opened[0]!.closed).toBe(1);
      routes.opened[0]!.release();
      await service.stop();
      expect(routes.opened[0]!.closed).toBe(1);
    }
  });

  it("waits for the questions to let go of the listener before the lifetime ends", async () => {
    const events: string[] = [];
    const routes = questionRoutes(events);
    const { service, made } = connected(undefined, routes.openQuestions);
    await service.start(on(RELAY));
    made[0]!.options.onQuestionsReady!(SOURCE);

    let stopped = false;
    const stopping = service.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopped).toBe(false);
    expect(service.getStatus().state).not.toBe("off");
    routes.opened[0]!.release();
    await stopping;
    expect(events.filter((event) => event.startsWith("questions"))).toEqual([
      "questions opened 1",
      "questions closed 1",
      "questions released 1",
    ]);
    expect(service.getStatus()).toEqual({ state: "off" });
  });

  it("feeds the panes every question row at the start and after each question write", async () => {
    let rows = [row(1)];
    const pushes: string[] = [];
    const store = Object.assign(fakeStore(), {
      listQuestions: vi.fn(async () => rows),
      updateQuestion: vi.fn(async () => null),
      getMeta: vi.fn(async () => null),
    });
    const service = new DecisionsService({
      openStore: async () => store,
      keyFilePath: () => "/nonexistent/keys.bin",
      publishPaneState: (_projectId, state) =>
        pushes.push(`${state.terminalId}:${state.openQuestions.length}`),
      connect: (options) => {
        connection = options;
        return { start: () => {}, stop: () => {} };
      },
    });
    let connection: RelayConnectionOptions | null = null;
    await service.start(on(RELAY));
    await vi.waitFor(() => expect(pushes).toEqual(["pane-a:1"]));

    rows = [];
    await connection!.store.getMeta("k");
    expect(store.listQuestions).toHaveBeenCalledTimes(1);
    await connection!.store.updateQuestion("q_1", { local_status: "cancelled" });
    await vi.waitFor(() => expect(pushes).toEqual(["pane-a:1", "pane-a:0"]));
    expect(store.listQuestions).toHaveBeenCalledTimes(2);

    await service.stop();
    rows = [row(2)];
    await connection!.store.updateQuestion("q_2", { local_status: "open" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.listQuestions).toHaveBeenCalledTimes(2);
  });

  it("opens a connection's questions only once the route they replace has let go of the listener", async () => {
    const routes = questionRoutes();
    const { service, made } = connected(undefined, routes.openQuestions);
    await service.start(on(RELAY));
    made[0]!.options.onQuestionsReady!(SOURCE);

    service.updateSettings(on({ ...RELAY, deviceId: "dev_another1" }));
    made[1]!.options.onQuestionsReady!(SOURCE);
    expect(routes.opened).toHaveLength(2);
    let previousSettled = false;
    void routes.opened[1]!.previous.then(() => {
      previousSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(previousSettled).toBe(false);

    routes.opened[0]!.release();
    await vi.waitFor(() => expect(previousSettled).toBe(true));
    routes.opened[1]!.release();
    await service.stop();
  });

  it("serves no questions when it is given no way to open them", async () => {
    const { service, made } = connected();
    await service.start(on(RELAY));
    expect(() => made[0]!.options.onQuestionsReady!(SOURCE)).not.toThrow();
    await service.stop();
  });
});

describe("DecisionsService deleting local data", () => {
  const RELAY = {
    relayOrigin: "https://relay.example.com",
    installationId: "inst_12345678",
    deviceId: "dev_12345678",
    hostId: "host_12345678",
  };
  const KEYS = '{"v":1,"protection":"keychain","ciphertext":"sealed"}';

  /**
   * A service over a key file of its own, rows held in memory, and a setting
   * that `forgetIdentity` clears; `log` records the order things happened in.
   */
  function setup(
    options: {
      rows?: number;
      failErase?: boolean;
      forgetFails?: boolean;
      /** Holds the rows from the deletion until it settles. */
      rowsReady?: Promise<void>;
      /** A stopped connection settles its deliveries only when this does. */
      connectionSettled?: Promise<void>;
    } = {}
  ) {
    const dir = mkdtempSync(join(tmpdir(), "decisions-service-erase-"));
    const keyFile = join(dir, "keys.bin");
    const log: string[] = [];
    const rows = { count: options.rows ?? 2 };
    const pushes: PaneDecisionState[] = [];
    const stores: Array<FakeStore & DaintreeLocalStore> = [];
    /** The question rows every store opened here holds. */
    const questions: QuestionRow[] = [];
    let forgetFails = options.forgetFails ?? false;
    const decisionRows: DecisionsRows = {
      erase: () => {
        log.push("erase rows");
        if (options.failErase) throw new Error("database is locked");
        rows.count = 0;
      },
      exist: () => rows.count > 0,
    };
    const service = new DecisionsService({
      keyFilePath: () => keyFile,
      openStore: async () => {
        log.push("open store");
        const store = Object.assign(fakeStore(), {
          listQuestions: async () => (rows.count > 0 ? [...questions] : []),
        });
        store.close.mockImplementation(async () => {
          log.push("close store");
        });
        stores.push(store);
        return store;
      },
      openRows: async () => {
        log.push("open rows");
        await options.rowsReady;
        return decisionRows;
      },
      forgetIdentity: () => {
        if (forgetFails) throw new Error("settings unwritable");
        log.push("forget relay");
        return on();
      },
      publishPaneState: (_projectId, state) => pushes.push(state),
      // Recorded, never run: no socket opens in these tests.
      connect: () => ({
        start: () => log.push("connect"),
        stop: () => {
          log.push("disconnect");
          return options.connectionSettled?.then(() => {
            log.push("deliveries settled");
          });
        },
      }),
    });
    return {
      service,
      dir,
      keyFile,
      log,
      rows,
      pushes,
      stores,
      questions,
      allowForget: () => {
        forgetFails = false;
      },
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  it("feeds the panes from the store a deletion reopens, never the one it closed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decisions-service-erase-feed-"));
    try {
      const stores: Array<
        FakeStore & DaintreeLocalStore & { listQuestions: ReturnType<typeof vi.fn> }
      > = [];
      const connections: RelayConnectionOptions[] = [];
      const service = new DecisionsService({
        keyFilePath: () => join(dir, "keys.bin"),
        openStore: async () => {
          const store = Object.assign(fakeStore(), {
            listQuestions: vi.fn(async () => []),
            updateQuestion: vi.fn(async () => null),
          });
          stores.push(store);
          return store;
        },
        openRows: async () => ({
          erase: () => {
            throw new Error("database is locked");
          },
          exist: () => true,
        }),
        forgetIdentity: () => on(RELAY),
        connect: (options) => {
          connections.push(options);
          return { start: () => {}, stop: () => {} };
        },
      });
      await service.start(on(RELAY));
      await vi.waitFor(() => expect(stores[0]!.listQuestions).toHaveBeenCalledTimes(1));

      await service.eraseLocalData();
      expect(service.getStore()).toBe(stores[1]);
      expect(connections).toHaveLength(2);
      await vi.waitFor(() => expect(stores[1]!.listQuestions).toHaveBeenCalledTimes(1));

      await connections[1]!.store.updateQuestion("q_1", { local_status: "open" });
      await vi.waitFor(() => expect(stores[1]!.listQuestions).toHaveBeenCalledTimes(2));
      expect(stores[0]!.listQuestions).toHaveBeenCalledTimes(1);
      await service.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sweeps from the spool what no create names, as a lifetime starts and once a deletion reopens the store", async () => {
    const t = setup();
    const spool = join(t.dir, "spool");
    const plant = (name: string) => {
      mkdirSync(spool, { recursive: true });
      writeFileSync(join(spool, name), "ciphertext");
    };
    try {
      writeFileSync(t.keyFile, KEYS);
      plant("left_by_a_crash");
      await t.service.start(on(RELAY));
      await vi.waitFor(() => expect(readdirSync(spool)).toEqual([]));

      plant("queued_before_the_deletion");
      await expect(t.service.eraseLocalData()).resolves.toEqual({ result: "deleted" });
      await vi.waitFor(() => expect(readdirSync(spool)).toEqual([]));
      expect(t.stores[1]!.referencedAttachmentIds).toHaveBeenCalled();
    } finally {
      t.cleanup();
    }
  });

  it("closes the store and keys first, deletes everything, then opens an empty store", async () => {
    const t = setup();
    try {
      writeFileSync(t.keyFile, KEYS);
      await t.service.start(on(RELAY));
      const keyStore = t.service.getKeyStore();
      t.service.observeQuestions([row(1)]);
      t.log.length = 0;

      await expect(t.service.eraseLocalData()).resolves.toEqual({ result: "deleted" });

      // The connection stops before the store closes, and nothing reconnects once the relay is forgotten.
      expect(t.log).toEqual([
        "disconnect",
        "close store",
        "open rows",
        "erase rows",
        "forget relay",
        "open store",
      ]);
      expect(t.rows.count).toBe(0);
      expect(existsSync(t.keyFile)).toBe(false);
      await expect(keyStore.load()).rejects.toMatchObject({ kind: "closed" });
      expect(t.service.getStore()).toBe(t.stores[1]);
      expect(t.service.getSettings()?.relayOrigin).toBeNull();
      expect(t.service.getStatus()).toEqual({ state: "not-connected" });
      // The pane that showed a question is told it has nothing now.
      expect(t.pushes.at(-1)).toMatchObject({ terminalId: "pane-a", openQuestions: [] });
      expect(t.service.getPaneState("pane-a")).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  it("closes the store for a deletion only once the connection's deliveries have settled", async () => {
    let settle!: () => void;
    const t = setup({ connectionSettled: new Promise<void>((resolve) => (settle = resolve)) });
    try {
      writeFileSync(t.keyFile, KEYS);
      await t.service.start(on(RELAY));
      t.log.length = 0;
      // Another identity: its connection waits on the first to settle, and must not start mid-deletion.
      t.service.updateSettings(on({ ...RELAY, deviceId: "dev_87654321" }));

      const erasing = t.service.eraseLocalData();
      await new Promise((resolve) => setImmediate(resolve));
      expect(t.log).toEqual(["disconnect"]);
      settle();
      await erasing;
      expect(t.log.slice(0, 3)).toEqual(["disconnect", "deliveries settled", "close store"]);
      expect(t.log.filter((entry) => entry === "connect")).toHaveLength(0);
    } finally {
      t.cleanup();
    }
  });

  it("changes nothing when the rows can't be deleted, and carries on with a store", async () => {
    const t = setup({ failErase: true });
    try {
      writeFileSync(t.keyFile, KEYS);
      t.questions.push(row(1));
      await t.service.start(on(RELAY));

      await expect(t.service.eraseLocalData()).resolves.toEqual({
        result: "failed",
        reason: "storage",
      });

      expect(readFileSync(t.keyFile, "utf8")).toBe(KEYS);
      expect(t.rows.count).toBe(2);
      expect(t.service.getSettings()?.relayOrigin).toBe(RELAY.relayOrigin);
      expect(t.service.getStore()).toBe(t.stores[1]);
      // Nothing changed, so the relay connection comes back on the same identity.
      expect(t.log.slice(-2)).toEqual(["open store", "connect"]);
      expect(t.service.getPaneState("pane-a")).not.toBeNull();
    } finally {
      t.cleanup();
    }
  });

  it("holds no store after a deletion that didn't finish, and the next start finishes it first", async () => {
    const t = setup({ forgetFails: true });
    try {
      writeFileSync(t.keyFile, KEYS);
      await t.service.start(on(RELAY));

      await expect(t.service.eraseLocalData()).resolves.toEqual({
        result: "incomplete",
        erased: true,
      });
      expect(t.service.getStore()).toBeNull();

      t.allowForget();
      await t.service.stop();
      t.log.length = 0;
      await t.service.start(on(RELAY));

      expect(t.log).toEqual(["open rows", "forget relay", "open store"]);
      expect(t.service.getStore()).not.toBeNull();
      expect(existsSync(t.keyFile)).toBe(false);
    } finally {
      t.cleanup();
    }
  });

  it("keeps the store closed on a retry while the earlier deletion still can't finish", async () => {
    const t = setup({ forgetFails: true });
    try {
      writeFileSync(t.keyFile, KEYS);
      await t.service.start(on(RELAY));
      await t.service.eraseLocalData();

      await expect(t.service.eraseLocalData()).resolves.toEqual({
        result: "incomplete",
        erased: true,
      });

      expect(t.service.getStore()).toBeNull();
      expect(t.log.filter((step) => step === "open store")).toHaveLength(1);
    } finally {
      t.cleanup();
    }
  });

  it("puts back keys a deletion set aside but never committed before the store opens", async () => {
    const t = setup();
    try {
      writeFileSync(`${t.keyFile}.erasing`, KEYS);

      await t.service.start(on(RELAY));

      expect(readFileSync(t.keyFile, "utf8")).toBe(KEYS);
      // Restored keys connect again once the store has opened.
      expect(t.log).toEqual(["open rows", "open store", "connect"]);
    } finally {
      t.cleanup();
    }
  });

  it("refuses while off", async () => {
    const t = setup();
    try {
      await expect(t.service.eraseLocalData()).rejects.toThrow(/off/);
      expect(t.log).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  it("makes no key store or rotation while a deletion runs, so nothing can write the key file back (#16010)", async () => {
    let rowsReady!: () => void;
    const t = setup({ rowsReady: new Promise<void>((resolve) => (rowsReady = resolve)) });
    try {
      writeFileSync(t.keyFile, KEYS);
      await t.service.start(on(RELAY));
      const before = t.service.getKeyRotations();

      const erasing = t.service.eraseLocalData();
      await vi.waitFor(() => expect(t.log).toContain("open rows"));
      expect(() => t.service.getKeyStore()).toThrow(/deleting/);
      expect(() => t.service.getKeyRotations()).toThrow(/deleting/);
      rowsReady();
      await expect(erasing).resolves.toEqual({ result: "deleted" });

      // The lifetime's old queue is closed; a new one comes once the deletion is done.
      await expect(before.exclusive(async () => "ran")).rejects.toThrow(/stopped/);
      expect(t.service.getKeyRotations()).not.toBe(before);
    } finally {
      t.cleanup();
    }
  });

  it("finishes a deletion under way before quit ends the lifetime, and opens no store after", async () => {
    let rowsReady!: () => void;
    const t = setup({ rowsReady: new Promise<void>((resolve) => (rowsReady = resolve)) });
    try {
      await t.service.start(on(RELAY));
      t.log.length = 0;

      const erasing = t.service.eraseLocalData();
      await vi.waitFor(() => expect(t.log).toContain("open rows"));
      const disposing = t.service.dispose();
      rowsReady();

      await expect(erasing).resolves.toEqual({ result: "deleted" });
      await disposing;
      expect(t.log).toEqual([
        "disconnect",
        "close store",
        "open rows",
        "erase rows",
        "forget relay",
      ]);
      expect(t.service.getStore()).toBeNull();
      expect(t.service.getStatus()).toEqual({ state: "off" });
    } finally {
      t.cleanup();
    }
  });

  it("refuses a deletion still waiting its turn when quit begins", async () => {
    const t = setup();
    try {
      await t.service.start(on(RELAY));
      t.log.length = 0;

      const erasing = t.service.eraseLocalData();
      const disposing = t.service.dispose();

      await expect(erasing).rejects.toThrow(/off/);
      await disposing;
      expect(t.rows.count).toBe(2);
      expect(t.log).toEqual(["disconnect", "close store"]);
    } finally {
      t.cleanup();
    }
  });
});
