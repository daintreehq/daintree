import { beforeEach, describe, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => ({ value: undefined as unknown }));
const loads = vi.hoisted(() => ({ constructed: 0, failNextConstruct: false, failNextOpen: false }));
const broadcast = vi.hoisted(() => vi.fn());
// The relay check's network: Chromium's, which tests answer by hand.
const netFetch = vi.hoisted(() =>
  vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
);

vi.mock("electron", () => ({ net: { fetch: netFetch }, app: {}, safeStorage: {} }));

vi.mock("../../../ipc/utils.js", () => ({ broadcastToProjectRenderers: broadcast }));

vi.mock("../../../store.js", () => ({
  store: {
    get: vi.fn((key: string) => (key === "decisions" ? saved.value : undefined)),
    set: vi.fn((key: string, value: unknown) => {
      if (key === "decisions") saved.value = value;
    }),
  },
}));

// Counts constructions; `failNextConstruct` fails the next one, once.
vi.mock("../DecisionsService.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../DecisionsService.js")>();
  class CountedDecisionsService extends actual.DecisionsService {
    constructor(options: ConstructorParameters<typeof actual.DecisionsService>[0] = {}) {
      if (loads.failNextConstruct) {
        loads.failNextConstruct = false;
        throw new Error("construct failed");
      }
      // A store that holds nothing, so starting never reaches the app database;
      // `failNextOpen` makes the next open fail, once.
      super({
        ...options,
        openStore: async () => {
          if (loads.failNextOpen) {
            loads.failNextOpen = false;
            throw new Error("store unavailable");
          }
          return { close: async () => {} } as never;
        },
      });
      loads.constructed += 1;
    }
  }
  return { ...actual, DecisionsService: CountedDecisionsService };
});

import { store } from "../../../store.js";
import { CHANNELS } from "../../../ipc/channels.js";
import { outstandingRows, row } from "./questionRows.js";
import { defaultDecisionsSettings } from "../decisionsSettings.js";
import { RelayCheckCancelledError } from "../relayCheck.js";
import {
  _resetDecisionsForTesting,
  checkRelay,
  getDecisionsPaneState,
  getDecisionsService,
  getDecisionsStatus,
  peekDecisionsService,
  setDecisionsEnabled,
  startDecisionsIfEnabled,
  stopDecisions,
} from "../index.js";

const RELAY = {
  relayOrigin: "https://relay.example.com",
  installationId: "inst_12345678",
  deviceId: "dev_12345678",
  hostId: "host_12345678",
};

describe("Decisions entry", () => {
  beforeEach(() => {
    saved.value = undefined;
    loads.failNextConstruct = false;
    loads.failNextOpen = false;
    vi.mocked(store.set).mockClear();
    broadcast.mockClear();
    netFetch.mockReset();
    _resetDecisionsForTesting();
  });

  it("reads no pane state, and makes no service, before Decisions runs", () => {
    saved.value = { enabled: true };

    expect(getDecisionsPaneState("pane-a")).toBeNull();
    expect(peekDecisionsService()).toBeNull();
  });

  it("pushes each pane's state to its own project's views, and reads it back", async () => {
    saved.value = { enabled: true };
    await startDecisionsIfEnabled();

    peekDecisionsService()!.observeQuestions([
      row(1),
      row(2, { origin: { pane_id: "pane-b", project_id: "project-2" } }),
    ]);

    const a = getDecisionsPaneState("pane-a");
    const b = getDecisionsPaneState("pane-b");
    expect(a?.openQuestions.map((q) => q.alias)).toEqual([1]);
    expect(b?.openQuestions.map((q) => q.alias)).toEqual([2]);
    expect(broadcast.mock.calls).toEqual([
      ["project-1", CHANNELS.EVENTS_PUSH, { name: "terminal:decision-state", payload: a }],
      ["project-2", CHANNELS.EVENTS_PUSH, { name: "terminal:decision-state", payload: b }],
    ]);
  });

  it("clears a pane's views once when turned off, then reads and pushes nothing", async () => {
    saved.value = { enabled: true };
    await startDecisionsIfEnabled();
    const service = peekDecisionsService()!;
    service.observeQuestions(outstandingRows());
    broadcast.mockClear();

    await setDecisionsEnabled(false);
    service.observeQuestions([row(4)]);

    expect(broadcast).toHaveBeenCalledExactlyOnceWith("project-1", CHANNELS.EVENTS_PUSH, {
      name: "terminal:decision-state",
      payload: {
        terminalId: "pane-a",
        openQuestions: [],
        waitingAnswers: [],
        needsAttention: [],
        revision: expect.any(Number),
      },
    });
    expect(getDecisionsPaneState("pane-a")).toBeNull();
  });

  it("pushes nothing at quit", async () => {
    saved.value = { enabled: true };
    await startDecisionsIfEnabled();
    peekDecisionsService()!.observeQuestions([row(1)]);
    broadcast.mockClear();

    await stopDecisions();

    expect(broadcast).not.toHaveBeenCalled();
  });

  it("makes no service at boot while the setting is off", async () => {
    saved.value = { enabled: false };

    await startDecisionsIfEnabled();

    expect(peekDecisionsService()).toBeNull();
    expect(getDecisionsStatus()).toEqual({ state: "off" });
  });

  it("makes no service at boot when the sanitiser turns a damaged record off", async () => {
    saved.value = { enabled: true, relayOrigin: "ftp://relay.example.com" };

    await startDecisionsIfEnabled();

    expect(peekDecisionsService()).toBeNull();
    expect(getDecisionsStatus()).toEqual({ state: "off" });
  });

  it("starts the service at boot when the setting is on", async () => {
    saved.value = { enabled: true, ...RELAY };

    await startDecisionsIfEnabled();

    expect(peekDecisionsService()?.getStatus()).toEqual({ state: "not-connected" });
    expect(peekDecisionsService()?.getSettings()?.relayOrigin).toBe(RELAY.relayOrigin);
  });

  it("reads on as not connected before the boot task has made the service", () => {
    saved.value = { enabled: true };

    expect(getDecisionsStatus()).toEqual({ state: "not-connected" });
    expect(peekDecisionsService()).toBeNull();
  });

  it("shares one service between concurrent callers", async () => {
    const [a, b] = await Promise.all([getDecisionsService(), getDecisionsService()]);
    expect(a).toBe(b);
  });

  it("retries a service that failed to be made", async () => {
    loads.failNextConstruct = true;
    await expect(getDecisionsService()).rejects.toThrow("construct failed");

    const made = await getDecisionsService();
    expect(made).toBe(peekDecisionsService());
    expect(made.getStatus()).toEqual({ state: "off" });
  });

  it("turns on at runtime, keeping every other field of the setting", async () => {
    saved.value = { enabled: false, ...RELAY, proxyAllowlisted: true };

    const status = await setDecisionsEnabled(true);

    expect(status).toEqual({ state: "not-connected", relayOrigin: RELAY.relayOrigin });
    expect(saved.value).toMatchObject({ enabled: true, ...RELAY, proxyAllowlisted: true });
    expect(peekDecisionsService()?.getStatus().state).toBe("not-connected");
  });

  it("records the first consent, and keeps its time when consent comes again", async () => {
    saved.value = { enabled: false };
    vi.spyOn(Date, "now").mockReturnValueOnce(1_761_955_200_000);

    const first = await setDecisionsEnabled(true, { consent: true });
    await setDecisionsEnabled(false);
    const again = await setDecisionsEnabled(true, { consent: true });

    expect(first).toEqual({ state: "not-connected", consentedAt: 1_761_955_200_000 });
    expect(again.consentedAt).toBe(1_761_955_200_000);
    expect(saved.value).toMatchObject({ enabled: true, consentedAt: 1_761_955_200_000 });
  });

  it("leaves consent unrecorded when a switch comes without it", async () => {
    saved.value = { enabled: false };

    const status = await setDecisionsEnabled(true);

    expect(status.consentedAt).toBeUndefined();
    expect(saved.value).toMatchObject({ consentedAt: null });
  });

  it("reports the saved consent with the switch off", () => {
    saved.value = { enabled: false, consentedAt: 1_761_955_200_000 };

    expect(getDecisionsStatus()).toEqual({ state: "off", consentedAt: 1_761_955_200_000 });
  });

  it("turns off at runtime, stopping the service and saving off", async () => {
    saved.value = { enabled: true };
    await startDecisionsIfEnabled();

    const status = await setDecisionsEnabled(false);

    expect(status).toEqual({ state: "off" });
    expect(saved.value).toMatchObject({ enabled: false });
    expect(peekDecisionsService()?.getStatus().state).toBe("off");
  });

  it("turning off when it was never on makes no service", async () => {
    saved.value = { enabled: false };
    const constructedBefore = loads.constructed;

    await setDecisionsEnabled(false);

    expect(peekDecisionsService()).toBeNull();
    expect(loads.constructed).toBe(constructedBefore);
  });

  it("turning on over a damaged relay record starts afresh without it", async () => {
    saved.value = { enabled: false, relayOrigin: "http://relay.example.com", hostId: RELAY.hostId };

    const status = await setDecisionsEnabled(true);

    expect(status).toEqual({ state: "not-connected" });
    expect(saved.value).toMatchObject({ enabled: true, relayOrigin: null, hostId: RELAY.hostId });
  });

  it("finishes rapid toggles on the last one asked", async () => {
    saved.value = { enabled: false };

    const results = await Promise.all([
      setDecisionsEnabled(true),
      setDecisionsEnabled(false),
      setDecisionsEnabled(true),
    ]);

    expect(results.map((s) => s.state)).toEqual(["not-connected", "off", "not-connected"]);
    expect(peekDecisionsService()?.getStatus().state).toBe("not-connected");
    expect(saved.value).toMatchObject({ enabled: true });
  });

  it("stops for good at quit, without writing the setting off", async () => {
    saved.value = { enabled: true };
    await startDecisionsIfEnabled();
    vi.mocked(store.set).mockClear();

    await stopDecisions();
    await startDecisionsIfEnabled();

    expect(peekDecisionsService()?.getStatus().state).toBe("off");
    expect(getDecisionsStatus()).toEqual({ state: "off" });
    expect(store.set).not.toHaveBeenCalled();
  });

  it("waits at quit for a service still being made, and leaves it stopped for good", async () => {
    saved.value = { enabled: true };
    const on = { ...defaultDecisionsSettings(), enabled: true };

    // A boot start that got the service before quit began, racing the stop.
    const making = getDecisionsService();
    const booted = making.then((service) => service.start(on));
    const stopping = stopDecisions();
    await Promise.all([booted, stopping]);

    const service = await making;
    expect(service.getStatus().state).toBe("off");
    await service.start(on);
    expect(service.getStatus().state).toBe("off");
  });

  it("saves a switch turned on during quit, but starts nothing", async () => {
    saved.value = { enabled: false };
    await stopDecisions();

    const status = await setDecisionsEnabled(true);

    expect(saved.value).toMatchObject({ enabled: true });
    expect(status).toEqual({ state: "off" });
    expect(peekDecisionsService()).toBeNull();
  });

  it("starts nothing at boot after quit, even with the setting on and no service made yet", async () => {
    saved.value = { enabled: true };
    const constructedBefore = loads.constructed;
    await stopDecisions();

    await startDecisionsIfEnabled();

    expect(peekDecisionsService()).toBeNull();
    expect(loads.constructed).toBe(constructedBefore);
  });

  it("makes no new service once quit has run", async () => {
    await stopDecisions();

    await expect(getDecisionsService()).rejects.toThrow("Decisions has stopped for this run");
    expect(peekDecisionsService()).toBeNull();
  });

  it("recovers from a runtime switch that failed, so the next one runs", async () => {
    saved.value = { enabled: false };
    loads.failNextConstruct = true;

    await expect(setDecisionsEnabled(true)).rejects.toThrow("construct failed");
    const status = await setDecisionsEnabled(true);

    expect(status).toEqual({ state: "not-connected" });
    expect(peekDecisionsService()?.getStatus().state).toBe("not-connected");
  });

  it("keeps the switch on when the store can't open, and the next turn-on opens it", async () => {
    saved.value = { enabled: false };
    loads.failNextOpen = true;

    await expect(setDecisionsEnabled(true)).rejects.toThrow("store unavailable");
    expect((saved.value as { enabled: boolean }).enabled).toBe(true);
    expect(getDecisionsStatus()).toEqual({ state: "not-connected" });
    expect(peekDecisionsService()?.getStore()).toBeNull();

    await setDecisionsEnabled(true);
    expect(peekDecisionsService()?.getStore()).not.toBeNull();
  });

  describe("relay check", () => {
    /** A fetch that never answers until its request is aborted. */
    function hangingFetch() {
      netFetch.mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          })
      );
    }

    it("refuses while Decisions is off, sending nothing", async () => {
      for (const value of [undefined, { enabled: false }]) {
        saved.value = value;

        await expect(checkRelay("https://relay.example.com")).rejects.toBeInstanceOf(
          RelayCheckCancelledError
        );
      }
      expect(netFetch).not.toHaveBeenCalled();
    });

    it("checks through Chromium's network without making a service or writing the setting", async () => {
      saved.value = { enabled: true };
      netFetch.mockImplementation(async (url) =>
        url.endsWith("/health")
          ? Response.json({ ok: true })
          : new Response("not found", { status: 404 })
      );

      await expect(checkRelay("relay.example.com/some/path")).resolves.toMatchObject({
        result: "not-a-relay",
        origin: "https://relay.example.com",
        endpoint: "info",
        status: 404,
      });
      expect(netFetch.mock.calls.map(([url]) => url)).toEqual([
        "https://relay.example.com/health",
        "https://relay.example.com/api/v1/info",
      ]);
      expect(peekDecisionsService()).toBeNull();
      expect(store.set).not.toHaveBeenCalled();
    });

    it("is cancelled by turning off, which doesn't wait for it", async () => {
      saved.value = { enabled: true };
      await startDecisionsIfEnabled();
      hangingFetch();

      const check = checkRelay("https://relay.example.com");
      await vi.waitFor(() => expect(netFetch).toHaveBeenCalled());
      await setDecisionsEnabled(false);

      await expect(check).rejects.toBeInstanceOf(RelayCheckCancelledError);
    });

    it("is cancelled by quit", async () => {
      saved.value = { enabled: true };
      hangingFetch();

      const check = checkRelay("https://relay.example.com");
      await vi.waitFor(() => expect(netFetch).toHaveBeenCalled());
      await stopDecisions();

      await expect(check).rejects.toBeInstanceOf(RelayCheckCancelledError);
      await expect(checkRelay("https://relay.example.com")).rejects.toBeInstanceOf(
        RelayCheckCancelledError
      );
      expect(netFetch).toHaveBeenCalledTimes(1);
    });

    it("isn't cancelled by turning on again", async () => {
      saved.value = { enabled: true, consentedAt: 1 };
      let answer!: (response: Response) => void;
      netFetch.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
      netFetch.mockImplementation(async () => new Response("gone", { status: 410 }));

      const check = checkRelay("https://relay.example.com");
      await vi.waitFor(() => expect(netFetch).toHaveBeenCalled());
      await setDecisionsEnabled(true);
      answer(Response.json({ ok: true }));

      await expect(check).resolves.toMatchObject({ result: "not-a-relay", status: 410 });
    });
  });
});
