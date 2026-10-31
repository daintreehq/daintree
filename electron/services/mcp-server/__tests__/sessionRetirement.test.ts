import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../store.js", () => ({
  store: {
    get: vi.fn().mockReturnValue({ enabled: true, port: 0, apiKey: "test-api-key" }),
  },
}));

vi.mock("electron", () => ({
  app: { getVersion: () => "0.0.0-test" },
  webContents: { fromId: () => null },
  ipcMain: { on: () => undefined, removeListener: () => undefined },
}));

const sleep = vi.hoisted(() => ({ awake: 0 }));

vi.mock("../../SystemSleepService.js", () => ({
  getSystemSleepService: () => ({
    getAwakeTimeSince: () => sleep.awake,
    onWake: () => () => {},
  }),
}));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { AbusePolicy } from "../abusePolicy.js";
import { HttpLifecycle, type HttpLifecycleDeps } from "../httpLifecycle.js";
import { cleanupResourceSubscriptions } from "../sessionResources.js";
import { SessionStore, type SessionRetireReason } from "../sessionStore.js";
import { MCP_PANE_SESSION_CAP, MCP_SSE_IDLE_TIMEOUT_MS } from "../shared.js";
import {
  RETAINED_COLLECTIONS,
  findResidue,
  observeGrantEvent,
  seedSessionState,
  stateCollections,
  type ObservedGrantEvent,
} from "./helpers/sessionResidue.js";

/** The renderer every retired session is pinned to. */
const PIN = 41;
/** The renderer the surviving session is pinned to, so a misrouted push shows. */
const OTHER_PIN = 42;

const stores: SessionStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.drain();
    store.grantCache.dispose();
  }
  vi.restoreAllMocks();
});

function seed(store: SessionStore, sessionId: string, webContentsId = PIN) {
  const unsubscribe = vi.fn();
  const needles = seedSessionState(store, sessionId, {
    helpSessionId: `help-${sessionId}`,
    webContentsId,
    unsubscribe,
  });
  return { needles, unsubscribe };
}

/**
 * Exactly one `grant.revoked` per grant the seed issued, each with the route's
 * reason and each resolving the pinned renderer at the moment it fired — which
 * it can only do while the origin and pin are still bound.
 */
function expectGrantsRevokedToPin(
  events: ObservedGrantEvent[],
  sessionId: string,
  reason: SessionRetireReason
): void {
  const revoked = events.filter((e) => e.sessionId === sessionId && e.type === "grant.revoked");
  expect(revoked).toEqual([
    { sessionId, type: "grant.revoked", reason, target: PIN },
    { sessionId, type: "grant.revoked", reason, target: PIN },
  ]);
}

describe("SessionStore retirement routes (#15624)", () => {
  function storeFixture() {
    const events: ObservedGrantEvent[] = [];
    const dropped = { abuse: [] as string[], bearer: [] as string[] };
    const store: SessionStore = new SessionStore((id) => cleanupResourceSubscriptions(id, store), {
      emitGrantLifecycle: (id, payload) => events.push(observeGrantEvent(store, id, payload)),
      dropAbuseState: (id) => dropped.abuse.push(id),
      dropBearerState: (id) => dropped.bearer.push(id),
    });
    stores.push(store);
    return { store, events, dropped };
  }

  function fakeTransport() {
    return { close: vi.fn().mockResolvedValue(undefined) };
  }

  function openSession(
    store: SessionStore,
    sessionId: string,
    transport: "sse" | "streamable-http",
    panePrincipal: string | null = null
  ) {
    const handle = fakeTransport();
    const idleTimer = store.armIdleTimer(sessionId, transport, panePrincipal);
    const entry = {
      transport: handle,
      server: { sendToolListChanged: vi.fn().mockResolvedValue(undefined) },
      idleTimer,
    } as never;
    if (transport === "sse") store.sessions.set(sessionId, entry);
    else store.httpSessions.set(sessionId, entry);
    return handle;
  }

  function openRelay(store: SessionStore, sessionId: string) {
    const handle = fakeTransport();
    store.relaySessions.set(sessionId, { transport: handle, server: {} } as never);
    store.sessionRelayMap.set(sessionId, {
      linkSessionId: "link-1",
      senderId: "b".repeat(64),
      helpSessionId: "relay-help",
      shellName: "shell",
    });
    return handle;
  }

  /** A pane session alongside every route: no idle timer, so no route reaps it by accident. */
  function survivor(store: SessionStore) {
    openSession(store, "survivor", "streamable-http", "survivor-pane");
    return seed(store, "survivor", OTHER_PIN).needles;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    sleep.awake = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  type Route = {
    name: string;
    reason: SessionRetireReason;
    open: (store: SessionStore) => { close: ReturnType<typeof vi.fn> };
    /** Seed, then end the session by this route. */
    retire: (store: SessionStore, seedTarget: () => void) => void;
  };

  const ROUTES: Route[] = [
    {
      name: "SSE idle expiry",
      reason: "session-idle",
      open: (store) => openSession(store, "target", "sse"),
      retire: (_store, seedTarget) => {
        // Seeded just before the deadline, so its grants are still live
        // rather than swept as expired on the way there.
        vi.advanceTimersByTime(MCP_SSE_IDLE_TIMEOUT_MS - 1_000);
        seedTarget();
        sleep.awake = MCP_SSE_IDLE_TIMEOUT_MS;
        vi.advanceTimersByTime(1_000);
      },
    },
    {
      name: "Streamable HTTP idle expiry",
      reason: "session-idle",
      open: (store) => openSession(store, "target", "streamable-http"),
      retire: (_store, seedTarget) => {
        vi.advanceTimersByTime(MCP_SSE_IDLE_TIMEOUT_MS - 1_000);
        seedTarget();
        sleep.awake = MCP_SSE_IDLE_TIMEOUT_MS;
        vi.advanceTimersByTime(1_000);
      },
    },
    {
      name: "expiry found on wake",
      reason: "session-idle",
      open: (store) => openSession(store, "target", "sse"),
      retire: (store, seedTarget) => {
        seedTarget();
        sleep.awake = MCP_SSE_IDLE_TIMEOUT_MS;
        store.recomputeIdleTimers();
      },
    },
    {
      name: "revokeSession on an SSE session",
      reason: "session-ended",
      open: (store) => openSession(store, "target", "sse"),
      retire: (store, seedTarget) => {
        seedTarget();
        expect(store.revokeSession("target")).toBe(true);
      },
    },
    {
      name: "revokeSession on a Streamable HTTP session",
      reason: "session-ended",
      open: (store) => openSession(store, "target", "streamable-http"),
      retire: (store, seedTarget) => {
        seedTarget();
        expect(store.revokeSession("target")).toBe(true);
      },
    },
    {
      name: "revokeSession on a relay session",
      reason: "session-ended",
      open: (store) => openRelay(store, "target"),
      retire: (store, seedTarget) => {
        seedTarget();
        expect(store.revokeSession("target")).toBe(true);
      },
    },
    {
      name: "the per-pane cap retiring the least recently used session",
      reason: "session-ended",
      open: (store) => openSession(store, "target", "sse", "capped-pane"),
      retire: (store, seedTarget) => {
        seedTarget();
        for (let i = 1; i < MCP_PANE_SESSION_CAP; i++) {
          openSession(store, `pane-${i}`, "sse", "capped-pane");
        }
        expect(store.sessions.has("target")).toBe(true);
        openSession(store, "pane-new", "sse", "capped-pane");
      },
    },
  ];

  it.each(ROUTES)(
    "$name leaves nothing behind and revokes grants to the pinned renderer",
    ({ reason, open, retire }) => {
      const { store, events, dropped } = storeFixture();
      const survivorNeedles = survivor(store);
      const transport = open(store);
      let seeded: ReturnType<typeof seed> | null = null;

      retire(store, () => {
        seeded = seed(store, "target");
        // Premise: the seed reached the collections the scan then reads.
        expect(findResidue(store, seeded.needles).length).toBeGreaterThan(20);
      });

      const { needles, unsubscribe } = seeded!;
      expect(findResidue(store, needles)).toEqual([]);
      expectGrantsRevokedToPin(events, "target", reason);
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(dropped.abuse).toContain("target");
      expect(dropped.bearer).toContain("target");
      expect(transport.close).toHaveBeenCalled();
      // Nothing of the session alongside was retired with it. Its grants and
      // elevation may have aged out on the idle routes' clock; these may not.
      expect(findResidue(store, survivorNeedles)).toEqual(
        expect.arrayContaining([
          "httpSessions[survivor]",
          "paneSessions[survivor]",
          "sessionTierMap[survivor]",
          "sessionWebContentsMap[survivor]",
          "sessionCredentialMap[survivor]",
          "sessionHelpIdMap[survivor]",
          "figureCounters[help-survivor]",
          "resourceSubscriptions[survivor]",
          "dedupResultCache[survivor]",
          "toolListRouteWatch.listed[survivor]",
          "resourceOwnership.byOwner[survivor]",
        ])
      );
      expect(
        events.filter((e) => e.sessionId === "survivor" && e.type === "grant.revoked")
      ).toEqual([]);
    }
  );

  it.each(ROUTES)("$name followed by a late onclose retires nothing twice", ({ open, retire }) => {
    const { store, events } = storeFixture();
    open(store);
    let unsubscribe: ReturnType<typeof vi.fn> | null = null;
    retire(store, () => {
      unsubscribe = seed(store, "target").unsubscribe;
    });
    const settled = events.length;

    store.retireSession("target", "session-ended");

    expect(events).toHaveLength(settled);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps a principal's ownership records through retirement and drain (#12487)", () => {
    const { store } = storeFixture();
    const ledger = store.resourceOwnership;
    openSession(store, "pane-session", "streamable-http", "pane-principal");
    ledger.bindPrincipal("pane-session", "pane-principal");
    const principal = ledger.ownerOf("pane-session");
    ledger.record(principal, [{ kind: "terminal", id: "terminal-held" }]);

    store.revokeSession("pane-session");

    expect(findResidue(store, ["pane-session"])).toEqual([]);
    expect(ledger.owns(principal, "terminal", "terminal-held")).toBe(true);
  });

  it("drain leaves nothing behind for any session", () => {
    const { store } = storeFixture();
    openSession(store, "sse-1", "sse");
    openSession(store, "http-1", "streamable-http");
    openSession(store, "pane-1", "streamable-http", "pane-principal");
    openRelay(store, "relay-1");
    const needles = ["sse-1", "http-1", "pane-1", "relay-1"].flatMap(
      (id) => seed(store, id).needles
    );

    store.drain();

    expect(findResidue(store, needles)).toEqual([]);
  });

  it("names a seeded or deliberately retained owner for every collection the store holds", () => {
    // The routes above can only find what the seed put there. A new Map or Set
    // on the store, or on a ledger it holds, fails here until `seedSessionState`
    // (or the session it is opened as) gives it a row — at which point every
    // route is checked against it — or `RETAINED_COLLECTIONS` says why a
    // session's traces may outlive it.
    const { store } = storeFixture();
    openSession(store, "sse-1", "sse");
    openSession(store, "http-1", "streamable-http");
    openSession(store, "pane-1", "streamable-http", "pane-principal");
    store.resourceOwnership.bindPrincipal("pane-1", "pane-principal");
    openRelay(store, "relay-1");
    const needles = ["sse-1", "http-1", "pane-1", "relay-1"].flatMap(
      (id) => seed(store, id).needles
    );
    const residue = findResidue(store, needles);

    const unseeded = stateCollections(store).filter(
      (path) =>
        !(path in RETAINED_COLLECTIONS) &&
        !residue.some((found) => found.startsWith(`${path}[`) || found.startsWith(`${path}{`))
    );

    expect(unseeded).toEqual([]);
  });
});

describe("HttpLifecycle retirement routes against a real store (#15624)", () => {
  const AUTH = "Bearer test-api-key";
  const harnesses: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of harnesses.splice(0)) await close();
  });

  async function startLifecycle() {
    const abusePolicy = new AbusePolicy({
      readConfig: () => ({
        auditEnabled: true,
        abusePolicyEnabled: true,
        abusePolicyMaxDenials: 1_000,
        abusePolicyWindowMs: 60_000,
      }),
    });
    const events: ObservedGrantEvent[] = [];
    let lc: HttpLifecycle | null = null;
    // Wired as `McpServerService` wires it, so every route's abuse, bearer and
    // subscription cleanup runs for real.
    const store: SessionStore = new SessionStore((id) => cleanupResourceSubscriptions(id, store), {
      emitGrantLifecycle: (id, payload) => events.push(observeGrantEvent(store, id, payload)),
      dropAbuseState: (id) => abusePolicy.dropSession(id),
      dropBearerState: (id) => lc?.detachBearerSession(id),
    });
    stores.push(store);
    const deps = {
      sessionStore: store,
      abusePolicy,
      auditService: {
        hydrate: vi.fn(),
        flushNow: vi.fn(),
        appendRecord: vi.fn(),
        appendGrantRecord: vi.fn(),
        recordAuth401: vi.fn(),
        getAuditStats: vi.fn(() => ({ auth401Count: 0 })),
      },
      turnOutcomeService: {
        flushNow: vi.fn(),
        getCurrentTurnIdForSession: vi.fn(() => null),
      },
      requestManifest: vi.fn().mockResolvedValue([]),
      dispatchAction: vi.fn(),
      handleWaitUntilIdle: vi.fn(),
      handleSkillsSearch: vi.fn(() => ({ skills: [] })),
      handleSkillsLoad: vi.fn(),
      handleProjectRunCheck: vi.fn(),
      handleTerminalGetStatusViewless: vi.fn(),
      handleTerminalReadLastMessageOwned: vi.fn(),
      isTerminalIdInUse: vi.fn(() => false),
      getCachedManifest: vi.fn(() => null),
      clearCachedManifest: vi.fn(),
      cleanupListeners: [],
      pendingManifests: new Map(),
      pendingDispatches: new Map(),
      setupIpcListeners: vi.fn(),
      emitStatusChange: vi.fn(),
      emitRuntimeStateChange: vi.fn(),
      setConfig: vi.fn(),
    } as unknown as HttpLifecycleDeps;
    const lifecycle = new HttpLifecycle(deps);
    lc = lifecycle;
    lifecycle.isEnabled = () => true;
    lifecycle.setApiKey("test-api-key");
    await lifecycle.start({} as never);
    const port = (lifecycle as unknown as { port: number }).port;
    harnesses.push(() => lifecycle.stop());

    /** The store, the lifecycle's bearer register and the abuse counters, scanned together. */
    const residue = (needles: readonly string[]): string[] => [
      ...findResidue(store, needles),
      ...findResidue(lifecycle, needles).map((path) => `httpLifecycle.${path}`),
      ...findResidue(abusePolicy, needles).map((path) => `abusePolicy.${path}`),
    ];

    const seedLive = (sessionId: string) => {
      const seeded = seed(store, sessionId);
      abusePolicy.recordDenial(sessionId, "tierMismatch");
      return seeded;
    };

    return {
      store,
      events,
      residue,
      seedLive,
      sseUrl: new URL(`http://127.0.0.1:${port}/sse`),
      mcpUrl: new URL(`http://127.0.0.1:${port}/mcp`),
    };
  }

  type Harness = Awaited<ReturnType<typeof startLifecycle>>;

  async function connectSse(h: Harness) {
    const headers = { Authorization: AUTH };
    const client = new Client({ name: "retirement-test", version: "1.0.0" });
    await client.connect(
      new SSEClientTransport(h.sseUrl, {
        eventSourceInit: { headers } as never,
        requestInit: { headers },
      })
    );
    const [sessionId] = [...h.store.sessions.keys()];
    return { client, sessionId: sessionId! };
  }

  async function connectStreamable(h: Harness) {
    const client = new Client({ name: "retirement-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(h.mcpUrl, {
      requestInit: { headers: { Authorization: AUTH } },
    });
    await client.connect(transport);
    return { client, transport, sessionId: transport.sessionId! };
  }

  function postMcp(h: Harness, body: unknown) {
    return fetch(h.mcpUrl, {
      method: "POST",
      headers: {
        Authorization: AUTH,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    });
  }

  const INITIALIZE = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "retirement-test", version: "1.0.0" },
    },
  };

  /** The one session the handshake in flight has written rows for. */
  function pendingSessionId(h: Harness): string {
    const [sessionId] = [...h.store.sessionTierMap.keys()];
    if (sessionId === undefined) throw new Error("no handshake in flight");
    return sessionId;
  }

  async function expectRetired(
    h: Harness,
    sessionId: string,
    seeded: { needles: string[]; unsubscribe: ReturnType<typeof vi.fn> }
  ) {
    await vi.waitFor(() => expect(h.residue(seeded.needles)).toEqual([]));
    expectGrantsRevokedToPin(h.events, sessionId, "session-ended");
    expect(seeded.unsubscribe).toHaveBeenCalledTimes(1);
    // A late close, and anything else still settling, retires nothing twice.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expectGrantsRevokedToPin(h.events, sessionId, "session-ended");
    expect(seeded.unsubscribe).toHaveBeenCalledTimes(1);
  }

  it("the client closing its /sse stream", async () => {
    const h = await startLifecycle();
    const { client, sessionId } = await connectSse(h);
    const seeded = h.seedLive(sessionId);
    const before = h.residue(seeded.needles);
    expect(before).toContain(`idleStartedAt[${sessionId}]`);
    expect(before.some((path) => path.startsWith("httpLifecycle.sessionToTokenHash"))).toBe(true);
    expect(before.some((path) => path.startsWith("abusePolicy.state"))).toBe(true);

    await client.close();

    await expectRetired(h, sessionId, seeded);
  });

  it("the /sse session server failing to connect", async () => {
    const h = await startLifecycle();
    let target: { sessionId: string; seeded: ReturnType<typeof seed> } | null = null;
    vi.spyOn(SSEServerTransport.prototype, "start").mockImplementationOnce(async function (
      this: SSEServerTransport
    ) {
      target = { sessionId: this.sessionId, seeded: h.seedLive(this.sessionId) };
      expect(h.residue(target.seeded.needles)).toContain(`idleStartedAt[${this.sessionId}]`);
      throw new Error("socket gone");
    });

    const response = await fetch(h.sseUrl, { headers: { Authorization: AUTH } });
    await response.body?.cancel();

    expect(response.status).toBe(500);
    await expectRetired(h, target!.sessionId, target!.seeded);
  });

  it("the client terminating its /mcp session with DELETE", async () => {
    const h = await startLifecycle();
    const { client, transport, sessionId } = await connectStreamable(h);
    const seeded = h.seedLive(sessionId);
    const before = h.residue(seeded.needles);
    expect(before).toContain(`httpIdleStartedAt[${sessionId}]`);
    expect(before.some((path) => path.startsWith("httpLifecycle.sessionToTokenHash"))).toBe(true);

    await transport.terminateSession();
    await client.close();

    await expectRetired(h, sessionId, seeded);
  });

  it("the /mcp transport closing", async () => {
    const h = await startLifecycle();
    const { client, sessionId } = await connectStreamable(h);
    const seeded = h.seedLive(sessionId);

    await h.store.httpSessions.get(sessionId)!.transport.close();
    await client.close();

    await expectRetired(h, sessionId, seeded);
  });

  it("an /mcp handshake the SDK answers without initializing", async () => {
    const h = await startLifecycle();
    const handleRequest = StreamableHTTPServerTransport.prototype.handleRequest;
    let target: { sessionId: string; seeded: ReturnType<typeof seed> } | null = null;
    vi.spyOn(StreamableHTTPServerTransport.prototype, "handleRequest").mockImplementationOnce(
      async function (this: StreamableHTTPServerTransport, ...args) {
        const sessionId = pendingSessionId(h);
        target = { sessionId, seeded: h.seedLive(sessionId) };
        return handleRequest.apply(this, args);
      }
    );

    const response = await postMcp(h, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    await response.body?.cancel();

    expect(response.status).toBe(400);
    await expectRetired(h, target!.sessionId, target!.seeded);
  });

  it("an /mcp handshake request throwing before the session initializes", async () => {
    const h = await startLifecycle();
    let target: { sessionId: string; seeded: ReturnType<typeof seed> } | null = null;
    vi.spyOn(StreamableHTTPServerTransport.prototype, "handleRequest").mockImplementationOnce(
      async function () {
        const sessionId = pendingSessionId(h);
        target = { sessionId, seeded: h.seedLive(sessionId) };
        throw new Error("request failed");
      }
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await postMcp(h, INITIALIZE);
    await response.body?.cancel();

    expect(response.status).toBe(500);
    await expectRetired(h, target!.sessionId, target!.seeded);
  });

  it("an /mcp handshake request throwing after the session initialized", async () => {
    const h = await startLifecycle();
    const handleRequest = StreamableHTTPServerTransport.prototype.handleRequest;
    let target: { sessionId: string; seeded: ReturnType<typeof seed> } | null = null;
    vi.spyOn(StreamableHTTPServerTransport.prototype, "handleRequest").mockImplementationOnce(
      async function (this: StreamableHTTPServerTransport, ...args) {
        await handleRequest.apply(this, args);
        const sessionId = this.sessionId!;
        target = { sessionId, seeded: h.seedLive(sessionId) };
        expect(h.residue(target.seeded.needles)).toContain(`httpIdleStartedAt[${sessionId}]`);
        throw new Error("request failed");
      }
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await postMcp(h, INITIALIZE);
    await response.text();

    await expectRetired(h, target!.sessionId, target!.seeded);
  });
});
