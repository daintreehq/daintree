import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => ({ value: undefined as unknown }));
const loads = vi.hoisted(() => ({ constructed: 0, failNextConstruct: false, failNextOpen: false }));
const broadcast = vi.hoisted(() => vi.fn());
// The relay check's network: Chromium's, which tests answer by hand.
const netFetch = vi.hoisted(() => vi.fn<(url: string, init: RequestInit) => Promise<Response>>());

vi.mock("electron", () => ({ net: { fetch: netFetch }, app: {}, safeStorage: {} }));

// The key file each service uses, in a directory of the test's own.
const keyFile = vi.hoisted(() => ({ path: "" }));
// Claim and restore are relayIdentity's; here only how the entry runs them.
const setupRuns = vi.hoisted(() => ({ claim: vi.fn(), restore: vi.fn() }));
vi.mock("../relayIdentity.js", () => ({
  claimDecisionsRelay: setupRuns.claim,
  restoreDecisionsIdentity: setupRuns.restore,
}));

// Building an archive and the relay's delete are their own modules'; here only how the entry runs them.
const dataRuns = vi.hoisted(() => ({ buildArchive: vi.fn(), deleteRelay: vi.fn() }));
vi.mock("../dataExport.js", () => ({ buildDecisionsArchive: dataRuns.buildArchive }));
vi.mock("../relayData.js", () => ({ deleteDecisionsRelayData: dataRuns.deleteRelay }));
// Atomic writes pass through, held while `writeHeld` is set so a test can act mid-write.
const writes = vi.hoisted(() => ({ held: null as null | Promise<void>, writing: false }));
vi.mock("../../../utils/fs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../utils/fs.js")>();
  return {
    ...actual,
    resilientAtomicWriteFile: async (
      ...args: Parameters<typeof actual.resilientAtomicWriteFile>
    ) => {
      writes.writing = true;
      await writes.held;
      try {
        return await actual.resilientAtomicWriteFile(...args);
      } finally {
        writes.writing = false;
      }
    },
  };
});
// The stored rows, in memory: `failErase` makes the next erase fail, once.
const storedRows = vi.hoisted(() => ({ count: 0, failErase: false }));

vi.mock("../../../ipc/utils.js", () => ({ broadcastToProjectRenderers: broadcast }));

// This machine's own windows, which the status push goes to.
const statusView = vi.hoisted(() => ({ send: vi.fn(), isDestroyed: () => false }));
vi.mock("../../../window/webContentsRegistry.js", () => ({
  getAllAppWebContents: () => [statusView],
}));

/**
 * Each relay connection the service makes, which here never touches a network:
 * its options (to report a status or a revocation as the real one would) and
 * how often it was started and stopped.
 */
/** The revocation hook the entry hands each service it makes. */
const entryHooks = vi.hoisted(() => ({
  onRelayRevoked: null as ((relay: import("../relayConnection.js").RelayBinding) => void) | null,
}));

const connections = vi.hoisted(
  () =>
    [] as Array<{
      options: import("../relayConnection.js").RelayConnectionOptions;
      started: number;
      stopped: number;
      keyFileAtStop?: boolean;
    }>
);

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
      entryHooks.onRelayRevoked = options.onRelayRevoked ?? null;
      super({
        ...options,
        keyFilePath: () => keyFile.path,
        openRows: async () => ({
          erase: () => {
            if (storedRows.failErase) {
              storedRows.failErase = false;
              throw new Error("database is locked");
            }
            storedRows.count = 0;
          },
          exist: () => storedRows.count > 0,
        }),
        connect: (connectionOptions) => {
          const made: (typeof connections)[number] = {
            options: connectionOptions,
            started: 0,
            stopped: 0,
          };
          connections.push(made);
          return {
            start: () => {
              made.started += 1;
            },
            stop: () => {
              made.stopped += 1;
              made.keyFileAtStop = existsSync(keyFile.path);
            },
          };
        },
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

/** An entry status: what it observed, and the revision it was read at. */
function withRevision<T extends object>(status: T): T & { revision: number } {
  return { ...status, revision: expect.any(Number) as unknown as number };
}

/** What the status pushes to this machine's windows carried, in order. */
function pushedStatuses(): Array<Record<string, unknown>> {
  return statusView.send.mock.calls
    .filter(
      ([channel, event]) =>
        channel === CHANNELS.EVENTS_PUSH &&
        (event as { name: string }).name === "decisions:status-changed"
    )
    .map(([, event]) => (event as { payload: Record<string, unknown> }).payload);
}

/** What the renderer recognises: an AppError by name, and its code. */
const CANCELLED = { name: "AppError", code: "CANCELLED" };
import {
  _resetDecisionsForTesting,
  checkRelay,
  claimRelay,
  deleteLocalData,
  deleteRelayData,
  disconnectRelay,
  exportData,
  getDecisionsPaneState,
  getDecisionsService,
  getDecisionsStatus,
  peekDecisionsService,
  restoreIdentity,
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
  beforeAll(() => {
    keyFile.path = join(mkdtempSync(join(tmpdir(), "decisions-entry-")), "keys.bin");
  });

  afterAll(() => {
    rmSync(join(keyFile.path, ".."), { recursive: true, force: true });
  });

  beforeEach(() => {
    rmSync(keyFile.path, { force: true });
    setupRuns.claim.mockReset();
    setupRuns.restore.mockReset();
    dataRuns.buildArchive.mockReset();
    dataRuns.deleteRelay.mockReset();
    storedRows.count = 0;
    storedRows.failErase = false;
    writes.held = null;
    rmSync(`${keyFile.path}.erasing`, { force: true });
    saved.value = undefined;
    loads.failNextConstruct = false;
    loads.failNextOpen = false;
    vi.mocked(store.set).mockClear();
    broadcast.mockClear();
    netFetch.mockReset();
    statusView.send.mockClear();
    connections.length = 0;
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
    expect(await getDecisionsStatus()).toEqual(withRevision({ state: "off" }));
  });

  it("makes no service at boot when the sanitiser turns a damaged record off", async () => {
    saved.value = { enabled: true, relayOrigin: "ftp://relay.example.com" };

    await startDecisionsIfEnabled();

    expect(peekDecisionsService()).toBeNull();
    expect(await getDecisionsStatus()).toEqual(withRevision({ state: "off" }));
  });

  it("starts the service at boot when the setting is on", async () => {
    saved.value = { enabled: true, ...RELAY };

    await startDecisionsIfEnabled();

    expect(peekDecisionsService()?.getStatus()).toEqual({ state: "not-connected" });
    expect(peekDecisionsService()?.getSettings()?.relayOrigin).toBe(RELAY.relayOrigin);
  });

  it("reads on as not connected before the boot task has made the service", async () => {
    saved.value = { enabled: true };

    expect(await getDecisionsStatus()).toEqual(withRevision({ state: "not-connected" }));
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

    expect(status).toEqual(
      withRevision({ state: "not-connected", relayOrigin: RELAY.relayOrigin })
    );
    expect(saved.value).toMatchObject({ enabled: true, ...RELAY, proxyAllowlisted: true });
    expect(peekDecisionsService()?.getStatus().state).toBe("not-connected");
  });

  it("records the first consent, and keeps its time when consent comes again", async () => {
    saved.value = { enabled: false };
    vi.spyOn(Date, "now").mockReturnValueOnce(1_761_955_200_000);

    const first = await setDecisionsEnabled(true, { consent: true });
    await setDecisionsEnabled(false);
    const again = await setDecisionsEnabled(true, { consent: true });

    expect(first).toEqual(withRevision({ state: "not-connected", consentedAt: 1_761_955_200_000 }));
    expect(again.consentedAt).toBe(1_761_955_200_000);
    expect(saved.value).toMatchObject({ enabled: true, consentedAt: 1_761_955_200_000 });
  });

  it("leaves consent unrecorded when a switch comes without it", async () => {
    saved.value = { enabled: false };

    const status = await setDecisionsEnabled(true);

    expect(status.consentedAt).toBeUndefined();
    expect(saved.value).toMatchObject({ consentedAt: null });
  });

  it("reports the saved consent with the switch off", async () => {
    saved.value = { enabled: false, consentedAt: 1_761_955_200_000 };

    expect(await getDecisionsStatus()).toEqual(
      withRevision({ state: "off", consentedAt: 1_761_955_200_000 })
    );
  });

  it("turns off at runtime, stopping the service and saving off", async () => {
    saved.value = { enabled: true };
    await startDecisionsIfEnabled();

    const status = await setDecisionsEnabled(false);

    expect(status).toEqual(withRevision({ state: "off" }));
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

    expect(status).toEqual(withRevision({ state: "not-connected" }));
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
    expect(await getDecisionsStatus()).toEqual(withRevision({ state: "off" }));
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
    expect(status).toEqual(withRevision({ state: "off" }));
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

    expect(status).toEqual(withRevision({ state: "not-connected" }));
    expect(peekDecisionsService()?.getStatus().state).toBe("not-connected");
  });

  it("keeps the switch on when the store can't open, and the next turn-on opens it", async () => {
    saved.value = { enabled: false };
    loads.failNextOpen = true;

    await expect(setDecisionsEnabled(true)).rejects.toThrow("store unavailable");
    expect((saved.value as { enabled: boolean }).enabled).toBe(true);
    expect(await getDecisionsStatus()).toEqual(withRevision({ state: "not-connected" }));
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

        await expect(checkRelay("https://relay.example.com")).rejects.toMatchObject(CANCELLED);
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
      await expect(check).rejects.toMatchObject(CANCELLED);
    });

    it("is cancelled by quit", async () => {
      saved.value = { enabled: true };
      hangingFetch();

      const check = checkRelay("https://relay.example.com");
      await vi.waitFor(() => expect(netFetch).toHaveBeenCalled());
      await stopDecisions();

      await expect(check).rejects.toBeInstanceOf(RelayCheckCancelledError);
      await expect(check).rejects.toMatchObject(CANCELLED);
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

  describe("relay setup", () => {
    const SECRET = "claim-secret-0123456789abcdef";
    const CLAIMED = {
      relayOrigin: "https://relay.example.com",
      installationId: "inst_12345678",
      deviceId: "dev_12345678",
      label: "Daintree",
    };
    const REFUSED = {
      result: "refused",
      origin: "https://relay.example.com",
      reason: "wrong-secret",
      kept: false,
    } as const;

    it("records a claimed relay's origin and ids with a host id minted for this computer", async () => {
      saved.value = { enabled: true, consentedAt: 5, proxyAllowlisted: true };
      await startDecisionsIfEnabled();
      const service = peekDecisionsService()!;
      setupRuns.claim.mockResolvedValue({ identity: CLAIMED });
      writeFileSync(keyFile.path, "sealed");

      const result = await claimRelay({ url: "relay.example.com", claimSecret: SECRET });

      expect(result).toEqual({
        result: "saved",
        status: withRevision({
          state: "not-connected",
          relayOrigin: CLAIMED.relayOrigin,
          consentedAt: 5,
          keysStored: true,
        }),
      });
      expect(setupRuns.claim).toHaveBeenCalledExactlyOnceWith(
        { url: "relay.example.com", claimSecret: SECRET },
        { keys: service.getKeyStore(), signal: expect.any(AbortSignal) }
      );
      expect(saved.value).toEqual({
        ...defaultDecisionsSettings(),
        enabled: true,
        consentedAt: 5,
        proxyAllowlisted: true,
        relayOrigin: CLAIMED.relayOrigin,
        installationId: CLAIMED.installationId,
        deviceId: CLAIMED.deviceId,
        hostId: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/),
      });
      expect(JSON.stringify(saved.value)).not.toContain(SECRET);
      expect(service.getSettings()?.relayOrigin).toBe(CLAIMED.relayOrigin);
    });

    it("records a restored identity the same way", async () => {
      saved.value = { enabled: true };
      setupRuns.restore.mockResolvedValue({ identity: CLAIMED });

      const result = await restoreIdentity({
        url: "https://relay.example.com",
        kit: "{}",
        passphrase: "correct horse battery staple",
      });

      expect(result).toMatchObject({
        result: "saved",
        status: { relayOrigin: CLAIMED.relayOrigin },
      });
      expect(saved.value).toMatchObject({
        relayOrigin: CLAIMED.relayOrigin,
        installationId: CLAIMED.installationId,
        deviceId: CLAIMED.deviceId,
      });
      expect(JSON.stringify(saved.value)).not.toContain("correct horse");
    });

    it("reports what stopped a claim and leaves the setting as it was", async () => {
      saved.value = { enabled: true };
      await startDecisionsIfEnabled();
      vi.mocked(store.set).mockClear();
      setupRuns.claim.mockResolvedValue({ failure: REFUSED });

      await expect(claimRelay({ url: "relay.example.com", claimSecret: SECRET })).resolves.toEqual(
        REFUSED
      );
      expect(store.set).not.toHaveBeenCalled();
    });

    it("refuses while off without making a service", async () => {
      saved.value = { enabled: false };

      await expect(
        claimRelay({ url: "relay.example.com", claimSecret: SECRET })
      ).rejects.toMatchObject(CANCELLED);
      await expect(disconnectRelay()).rejects.toMatchObject(CANCELLED);
      expect(setupRuns.claim).not.toHaveBeenCalled();
      expect(peekDecisionsService()).toBeNull();
    });

    it("refuses to claim or restore over a relay already set up", async () => {
      saved.value = { enabled: true, ...RELAY };

      await expect(claimRelay({ url: "relay.example.com", claimSecret: SECRET })).resolves.toEqual({
        result: "conflict",
        origin: RELAY.relayOrigin,
        unfinished: false,
      });
      await expect(
        restoreIdentity({ url: "relay.example.com", kit: "{}", passphrase: "correct horse" })
      ).resolves.toEqual({ result: "conflict", origin: RELAY.relayOrigin, unfinished: false });
      expect(setupRuns.claim).not.toHaveBeenCalled();
      expect(setupRuns.restore).not.toHaveBeenCalled();
    });

    it("disconnects by removing the key file and the relay's ids, keeping the switch and consent", async () => {
      saved.value = { enabled: true, consentedAt: 5, proxyAllowlisted: true, ...RELAY };
      await startDecisionsIfEnabled();
      writeFileSync(keyFile.path, "sealed");

      const status = await disconnectRelay();

      expect(existsSync(keyFile.path)).toBe(false);
      expect(status).toEqual(withRevision({ state: "not-connected", consentedAt: 5 }));
      expect(saved.value).toEqual({
        ...defaultDecisionsSettings(),
        enabled: true,
        consentedAt: 5,
        proxyAllowlisted: true,
      });
      expect(peekDecisionsService()?.getSettings()?.relayOrigin).toBeNull();
    });

    it("reports keys stored on this computer from the file alone", async () => {
      saved.value = { enabled: true };
      await startDecisionsIfEnabled();
      expect(await getDecisionsStatus()).toEqual(withRevision({ state: "not-connected" }));

      writeFileSync(keyFile.path, "sealed");

      expect(await getDecisionsStatus()).toEqual(
        withRevision({ state: "not-connected", keysStored: true })
      );
    });

    it("turns off only once a claim in flight has settled, keeping what it recorded", async () => {
      saved.value = { enabled: true, consentedAt: 5 };
      await startDecisionsIfEnabled();
      let finish!: (outcome: unknown) => void;
      setupRuns.claim.mockImplementation(() => new Promise((resolve) => (finish = resolve)));

      const claim = claimRelay({ url: "relay.example.com", claimSecret: SECRET });
      await vi.waitFor(() => expect(setupRuns.claim).toHaveBeenCalled());
      let off = false;
      const turningOff = setDecisionsEnabled(false).then(() => (off = true));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(off).toBe(false);

      finish({ identity: CLAIMED });
      await claim;
      await turningOff;

      expect(saved.value).toMatchObject({ enabled: false, relayOrigin: CLAIMED.relayOrigin });
    });

    it("aborts a claim's requests at quit", async () => {
      saved.value = { enabled: true };
      await startDecisionsIfEnabled();
      let signal!: AbortSignal;
      setupRuns.claim.mockImplementation(
        (_payload: unknown, options: { signal: AbortSignal }) =>
          new Promise((resolve) => {
            signal = options.signal;
            signal.addEventListener("abort", () => resolve({ failure: REFUSED }));
          })
      );

      const claim = claimRelay({ url: "relay.example.com", claimSecret: SECRET });
      await vi.waitFor(() => expect(setupRuns.claim).toHaveBeenCalled());
      await stopDecisions();

      expect(signal.aborted).toBe(true);
      await expect(claim).resolves.toEqual(REFUSED);
    });
  });
  describe("relay connection", () => {
    const CLAIMED = {
      relayOrigin: "https://relay.example.com",
      installationId: "inst_12345678",
      deviceId: "dev_12345678",
      label: "Daintree",
    };
    const SECRET = "claim-secret-0123456789abcdef";

    it("connects at boot once a relay is set up, and not before", async () => {
      saved.value = { enabled: true };
      await startDecisionsIfEnabled();
      expect(connections).toHaveLength(0);
      await stopDecisions();
      _resetDecisionsForTesting();

      saved.value = { enabled: true, ...RELAY };
      await startDecisionsIfEnabled();
      expect(connections).toHaveLength(1);
      expect(connections[0]!.started).toBe(1);
      expect(connections[0]!.options.relay).toEqual({
        relayOrigin: RELAY.relayOrigin,
        installationId: RELAY.installationId,
        deviceId: RELAY.deviceId,
      });
    });

    it("pushes what the connection observes to this machine's windows, newest revision last", async () => {
      saved.value = { enabled: true, ...RELAY };
      await startDecisionsIfEnabled();
      const [connection] = connections;

      const seen: Array<Record<string, unknown>> = [];
      for (const next of [
        { state: "connecting" as const },
        { state: "reconnecting" as const, nextAttemptAt: 9_000 },
        { state: "connected" as const },
      ]) {
        connection!.options.onStatus(next);
        await vi.waitFor(() => expect(pushedStatuses().at(-1)?.state).toBe(next.state));
        seen.push(pushedStatuses().at(-1)!);
      }

      expect(seen[1]).toMatchObject({
        state: "reconnecting",
        nextAttemptAt: 9_000,
        relayOrigin: RELAY.relayOrigin,
      });
      const revisions = pushedStatuses().map((status) => status.revision as number);
      expect([...revisions].sort((a, b) => a - b)).toEqual(revisions);
      expect(revisions.at(-1)).toBeGreaterThan(revisions[0]!);
      // A read now is as new as the last push, never older.
      expect((await getDecisionsStatus()).revision).toBe(revisions.at(-1));
    });

    it("records a revocation against the identity, and connects with it no more", async () => {
      saved.value = { enabled: true, consentedAt: 5, ...RELAY };
      await startDecisionsIfEnabled();
      const [connection] = connections;

      connection!.options.onStatus({ state: "revoked" });
      connection!.options.onRevoked();

      expect(saved.value).toMatchObject({ ...RELAY, revokedAt: expect.any(Number) });
      expect((await getDecisionsStatus()).state).toBe("revoked");

      await setDecisionsEnabled(false);
      const status = await setDecisionsEnabled(true);
      expect(status.state).toBe("revoked");
      expect(connections).toHaveLength(1);
    });

    it("records a revocation only against the identity the setting now holds", async () => {
      saved.value = { enabled: true, consentedAt: 5, ...RELAY };
      await startDecisionsIfEnabled();

      entryHooks.onRelayRevoked!({
        relayOrigin: RELAY.relayOrigin,
        installationId: RELAY.installationId,
        deviceId: "dev_87654321",
      });
      expect((saved.value as { revokedAt?: unknown }).revokedAt ?? null).toBeNull();
      expect(connections[0]!.stopped).toBe(0);

      entryHooks.onRelayRevoked!({
        relayOrigin: RELAY.relayOrigin,
        installationId: RELAY.installationId,
        deviceId: RELAY.deviceId,
      });
      expect(saved.value).toMatchObject({ revokedAt: expect.any(Number) });
      expect(connections[0]!.stopped).toBe(1);
    });

    it("stops the connection before it removes the keys it runs on", async () => {
      saved.value = { enabled: true, consentedAt: 5, ...RELAY };
      await startDecisionsIfEnabled();
      writeFileSync(keyFile.path, "sealed");

      await disconnectRelay();

      expect(connections[0]!.stopped).toBe(1);
      expect(connections[0]!.keyFileAtStop).toBe(true);
      expect(existsSync(keyFile.path)).toBe(false);
      expect(connections).toHaveLength(1);
    });

    it("connects again after a revoked identity is disconnected and a relay claimed", async () => {
      saved.value = { enabled: true, consentedAt: 5, ...RELAY, revokedAt: 99 };
      await startDecisionsIfEnabled();
      expect((await getDecisionsStatus()).state).toBe("revoked");
      expect(connections).toHaveLength(0);

      writeFileSync(keyFile.path, "sealed");
      await disconnectRelay();
      setupRuns.claim.mockResolvedValue({ identity: CLAIMED });
      await claimRelay({ url: "relay.example.com", claimSecret: SECRET });

      expect(saved.value).toMatchObject({ revokedAt: null, deviceId: CLAIMED.deviceId });
      expect(connections).toHaveLength(1);
      expect(connections[0]!.started).toBe(1);
    });

    it("pushes the status after a setup that failed, since it may have kept keys", async () => {
      saved.value = { enabled: true, consentedAt: 5 };
      await startDecisionsIfEnabled();
      await vi.waitFor(() => expect(pushedStatuses().length).toBeGreaterThan(0));
      const before = pushedStatuses().at(-1)!.revision as number;
      setupRuns.claim.mockImplementation(async () => {
        writeFileSync(keyFile.path, "staged");
        return {
          failure: {
            result: "unreachable",
            origin: CLAIMED.relayOrigin,
            reason: "timeout",
            kept: true,
          },
        };
      });

      await claimRelay({ url: "relay.example.com", claimSecret: SECRET });

      await vi.waitFor(() => expect(pushedStatuses().at(-1)?.keysStored).toBe(true));
      expect(pushedStatuses().at(-1)!.revision as number).toBeGreaterThan(before);
    });

    it("keeps pushes in order when changes overlap, the last carrying the newest status", async () => {
      saved.value = { enabled: true, ...RELAY };
      await startDecisionsIfEnabled();
      const [connection] = connections;

      connection!.options.onStatus({ state: "connecting" });
      connection!.options.onStatus({ state: "reconnecting", nextAttemptAt: 9_000 });
      connection!.options.onStatus({ state: "connected" });

      await vi.waitFor(() => expect(pushedStatuses().at(-1)?.state).toBe("connected"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const revisions = pushedStatuses().map((status) => status.revision as number);
      expect([...revisions].sort((a, b) => a - b)).toEqual(revisions);
      expect(pushedStatuses().at(-1)).toMatchObject({ state: "connected" });
      expect((await getDecisionsStatus()).revision).toBe(revisions.at(-1));
    });

    it("stops the connection when turned off, and pushes nothing at quit", async () => {
      saved.value = { enabled: true, ...RELAY };
      await startDecisionsIfEnabled();
      await setDecisionsEnabled(false);
      expect(connections[0]!.stopped).toBe(1);
      await vi.waitFor(() => expect(pushedStatuses().at(-1)?.state).toBe("off"));

      await setDecisionsEnabled(true);
      expect(connections).toHaveLength(2);
      await vi.waitFor(() => expect(pushedStatuses().at(-1)?.state).toBe("not-connected"));
      connections[1]!.options.onStatus({ state: "connecting" });
      statusView.send.mockClear();

      await stopDecisions();
      connections[1]!.options.onStatus({ state: "connected" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(pushedStatuses()).toEqual([]);
      expect(connections[1]!.stopped).toBe(1);
    });
  });

  describe("data (#16025)", () => {
    const PASSPHRASE = "a long export passphrase";
    const ARCHIVE = {
      fileName: "decisions-export-2026-11-01.dxz.json",
      text: '{"v":1,"kdf":"PBKDF2-SHA256"}',
      questions: 2,
      auditEvents: 5,
    };

    function exportTarget(): string {
      return join(keyFile.path, "..", ARCHIVE.fileName);
    }

    it("exports the archive to the file picked, readable by its owner alone", async () => {
      saved.value = { enabled: true, ...RELAY };
      await startDecisionsIfEnabled();
      dataRuns.buildArchive.mockResolvedValue({ archive: ARCHIVE });
      const chooser = vi.fn(async () => exportTarget());

      await expect(exportData({ passphrase: PASSPHRASE }, chooser)).resolves.toEqual({
        result: "saved",
        path: exportTarget(),
        questions: 2,
        auditEvents: 5,
      });

      expect(chooser).toHaveBeenCalledWith(ARCHIVE.fileName);
      expect(dataRuns.buildArchive).toHaveBeenCalledWith(
        expect.objectContaining({ passphrase: PASSPHRASE })
      );
      expect(readFileSync(exportTarget(), "utf8")).toBe(ARCHIVE.text);
      if (process.platform !== "win32") expect(statSync(exportTarget()).mode & 0o777).toBe(0o600);
      rmSync(exportTarget(), { force: true });
    });

    it("writes nothing when no file is picked, or Decisions turned off while the dialog was open", async () => {
      saved.value = { enabled: true, ...RELAY };
      await startDecisionsIfEnabled();
      dataRuns.buildArchive.mockResolvedValue({ archive: ARCHIVE });

      await expect(exportData({ passphrase: PASSPHRASE }, async () => null)).resolves.toEqual({
        result: "cancelled",
      });
      await expect(
        exportData({ passphrase: PASSPHRASE }, async () => {
          await setDecisionsEnabled(false);
          return exportTarget();
        })
      ).resolves.toEqual({ result: "cancelled" });
      expect(existsSync(exportTarget())).toBe(false);
    });

    it("drops an archive whose store closed while the dialog was open, even with Decisions on again", async () => {
      saved.value = { enabled: true, ...RELAY };
      await startDecisionsIfEnabled();
      dataRuns.buildArchive.mockResolvedValue({ archive: ARCHIVE });

      await expect(
        exportData({ passphrase: PASSPHRASE }, async () => {
          await setDecisionsEnabled(false);
          await setDecisionsEnabled(true);
          return exportTarget();
        })
      ).resolves.toEqual({ result: "cancelled" });
      await expect(
        exportData({ passphrase: PASSPHRASE }, async () => {
          await deleteLocalData();
          return exportTarget();
        })
      ).resolves.toEqual({ result: "cancelled" });
      expect(existsSync(exportTarget())).toBe(false);
    });

    it("holds a local deletion asked for mid-write until the archive is written", async () => {
      saved.value = { enabled: true, ...RELAY };
      await startDecisionsIfEnabled();
      storedRows.count = 3;
      dataRuns.buildArchive.mockResolvedValue({ archive: ARCHIVE });
      let release!: () => void;
      writes.held = new Promise<void>((resolve) => (release = resolve));

      const exporting = exportData({ passphrase: PASSPHRASE }, async () => exportTarget());
      await vi.waitFor(() => expect(writes.writing).toBe(true));
      const deleting = deleteLocalData();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(storedRows.count).toBe(3);

      release();
      await expect(exporting).resolves.toMatchObject({ result: "saved" });
      await expect(deleting).resolves.toMatchObject({ result: "deleted" });
      expect(storedRows.count).toBe(0);
      rmSync(exportTarget(), { force: true });
    });

    it("hands back what stopped the archive being built, opening no dialog", async () => {
      saved.value = { enabled: true };
      await startDecisionsIfEnabled();
      dataRuns.buildArchive.mockResolvedValue({ failure: { result: "no-identity" } });
      const chooser = vi.fn(async () => exportTarget());

      await expect(exportData({ passphrase: PASSPHRASE }, chooser)).resolves.toEqual({
        result: "no-identity",
      });
      expect(chooser).not.toHaveBeenCalled();
    });

    it("says the history isn't open when the lifetime has no store", async () => {
      saved.value = { enabled: true };
      loads.failNextOpen = true;
      await expect(startDecisionsIfEnabled()).rejects.toThrow("store unavailable");

      await expect(exportData({ passphrase: PASSPHRASE }, async () => null)).resolves.toEqual({
        result: "store-unavailable",
      });
      expect(dataRuns.buildArchive).not.toHaveBeenCalled();
    });

    it("refuses a passphrase shorter than the archive's encryption takes", async () => {
      saved.value = { enabled: true };

      await expect(
        exportData({ passphrase: "short" }, async () => exportTarget())
      ).rejects.toMatchObject({ code: "VALIDATION" });
      expect(dataRuns.buildArchive).not.toHaveBeenCalled();
    });

    it("refuses to export or delete while off, making no service", async () => {
      saved.value = { enabled: false, ...RELAY };

      await expect(exportData({ passphrase: PASSPHRASE }, async () => null)).rejects.toMatchObject(
        CANCELLED
      );
      await expect(deleteRelayData({ origin: RELAY.relayOrigin })).rejects.toMatchObject(CANCELLED);
      await expect(deleteLocalData()).rejects.toMatchObject(CANCELLED);
      expect(peekDecisionsService()).toBeNull();
    });

    it("deletes the relay's data for the relay confirmed, with the setting as it reads now", async () => {
      saved.value = { enabled: true, ...RELAY };
      await startDecisionsIfEnabled();
      dataRuns.deleteRelay.mockResolvedValue({ result: "deleted", origin: RELAY.relayOrigin });

      await expect(deleteRelayData({ origin: RELAY.relayOrigin })).resolves.toEqual({
        result: "deleted",
        origin: RELAY.relayOrigin,
      });
      expect(dataRuns.deleteRelay).toHaveBeenCalledWith(
        expect.objectContaining({
          origin: RELAY.relayOrigin,
          settings: expect.objectContaining({ relayOrigin: RELAY.relayOrigin }),
          signal: expect.any(AbortSignal),
        })
      );
    });

    it("aborts a relay deletion's request at quit", async () => {
      saved.value = { enabled: true, ...RELAY };
      await startDecisionsIfEnabled();
      dataRuns.deleteRelay.mockImplementation(
        (options: { signal: AbortSignal }) =>
          new Promise((resolve) => {
            options.signal.addEventListener("abort", () =>
              resolve({ result: "unconfirmed", origin: RELAY.relayOrigin, reason: "network" })
            );
          })
      );

      const deleting = deleteRelayData({ origin: RELAY.relayOrigin });
      await vi.waitFor(() => expect(dataRuns.deleteRelay).toHaveBeenCalled());
      await stopDecisions();

      await expect(deleting).resolves.toMatchObject({ result: "unconfirmed" });
    });

    it("deletes this computer's rows, keys and relay record, keeping the switch and consent", async () => {
      saved.value = { enabled: true, consentedAt: 5, proxyAllowlisted: true, ...RELAY };
      await startDecisionsIfEnabled();
      writeFileSync(keyFile.path, "sealed");
      storedRows.count = 3;

      await expect(deleteLocalData()).resolves.toEqual({
        result: "deleted",
        status: withRevision({ state: "not-connected", consentedAt: 5 }),
      });

      expect(storedRows.count).toBe(0);
      expect(existsSync(keyFile.path)).toBe(false);
      expect(saved.value).toEqual({
        ...defaultDecisionsSettings(),
        enabled: true,
        consentedAt: 5,
        proxyAllowlisted: true,
      });
      expect(peekDecisionsService()?.getSettings()?.relayOrigin).toBeNull();
      expect(peekDecisionsService()?.getStore()).not.toBeNull();
      // Every window hears the relay record go, not only the one that asked.
      await vi.waitFor(() =>
        expect(pushedStatuses().at(-1)).toEqual(
          withRevision({ state: "not-connected", consentedAt: 5 })
        )
      );
    });

    it("leaves everything as it was when the rows can't be deleted", async () => {
      saved.value = { enabled: true, consentedAt: 5, ...RELAY };
      await startDecisionsIfEnabled();
      writeFileSync(keyFile.path, "sealed");
      storedRows.count = 3;
      storedRows.failErase = true;

      await expect(deleteLocalData()).resolves.toEqual({ result: "failed", reason: "storage" });

      expect(storedRows.count).toBe(3);
      expect(readFileSync(keyFile.path, "utf8")).toBe("sealed");
      expect(saved.value).toMatchObject({ enabled: true, consentedAt: 5, ...RELAY });
    });
  });
});
