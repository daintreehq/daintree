import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REMOTE_GATEWAY_CONFIG,
  REMOTE_GATEWAY_LIMITS,
  REMOTE_PROTOCOL_VERSION,
  parseRemoteFrame,
  type RemoteEnvelope,
} from "../../../../shared/types/remote/index.js";
import type { RemoteAuthenticationService } from "../RemoteAuthenticationService.js";
import { RemoteAbuseGuard } from "../RemoteAbuseGuard.js";
import type { RemoteAuditService } from "../RemoteAuditService.js";
import type { RemoteConnection } from "../RemoteConnection.js";
import { RemoteGatewayService } from "../RemoteGatewayService.js";
import { isAllowedRemoteBindAddress, RemoteListener } from "../RemoteListener.js";
import type { RemotePairingService } from "../RemotePairingService.js";
import { RemoteProtocolRouter } from "../RemoteProtocolRouter.js";
import { RemoteSessionRegistry } from "../RemoteSessionRegistry.js";
import {
  generateSelfSignedRemoteTlsIdentity,
  type RemoteTlsIdentityService,
} from "../RemoteTlsIdentityService.js";

class FakeConnection implements RemoteConnection {
  readonly events = new EventEmitter();
  readonly sent: string[] = [];
  readonly closes: Array<{ code: number; reason: string }> = [];
  bufferedAmount = 0;

  constructor(
    readonly id: string,
    readonly sourceAddress = "192.168.1.20"
  ) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }

  onMessage(listener: (data: string) => void): () => void {
    this.events.on("message", listener);
    return () => this.events.off("message", listener);
  }

  onClose(listener: () => void): () => void {
    this.events.on("close", listener);
    return () => this.events.off("close", listener);
  }

  receive(envelope: unknown): void {
    this.events.emit("message", typeof envelope === "string" ? envelope : JSON.stringify(envelope));
  }

  disconnect(): void {
    this.events.emit("close");
  }
}

function hello(requestId = "hello-01") {
  return {
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    sessionId: "pending",
    kind: "request",
    type: "session.hello",
    requestId,
    payload: {
      supportedProtocol: { min: REMOTE_PROTOCOL_VERSION, max: REMOTE_PROTOCOL_VERSION },
      appVersion: "1.0.0",
      deviceId: "device-01",
      challenge: "challenge-value-01",
      signature: "signature-value-01",
    },
  };
}

function request(
  sessionId: string,
  type: "projects.list" | "agent.launch" | "console.subscribe" | "prompt.submit",
  index: number
) {
  const payload =
    type === "projects.list"
      ? {}
      : type === "agent.launch"
        ? {
            projectId: "project-01",
            worktreeId: "worktree-01",
            agentId: "codex",
            requestedPanelId: `panel-${index}`,
            idempotencyKey: `launch-${index}`,
          }
        : type === "console.subscribe"
          ? {
              projectId: "project-01",
              worktreeId: "worktree-01",
              panelId: "panel-01",
              launchGeneration: 1,
            }
          : {
              projectId: "project-01",
              worktreeId: "worktree-01",
              panelId: "panel-01",
              launchGeneration: 1,
              idempotencyKey: `prompt-${index}`,
              text: "hello",
            };
  return {
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    sessionId,
    kind: "request",
    type,
    requestId: `request-${index}`,
    payload,
  };
}

async function readyConnection(options?: {
  handler?: (envelope: RemoteEnvelope) => void;
  now?: () => number;
}) {
  const sessions = new RemoteSessionRegistry();
  const authentication = {
    authenticateClientChallenge: () => ({
      authenticated: true,
      deviceId: "device-01",
      capabilities: ["observe-projects"],
      hostSignature: "host-signature-value-01",
    }),
  } as unknown as RemoteAuthenticationService;
  const handler = vi.fn((_session, envelope: RemoteEnvelope) => options?.handler?.(envelope));
  const router = new RemoteProtocolRouter(
    sessions,
    authentication,
    "0.30.1",
    handler,
    options?.now
  );
  const connection = new FakeConnection("connection-01");
  router.attach(connection);
  connection.receive(hello());
  await vi.waitFor(() => expect(connection.sent).toHaveLength(1));
  const welcome = parseRemoteFrame(connection.sent[0]!);
  if (!welcome.ok) throw new Error("Expected welcome frame");
  const sessionId = welcome.envelope.sessionId;
  connection.receive({
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    sessionId,
    kind: "request",
    type: "session.ready",
    requestId: "ready-01",
    payload: { ready: true },
  });
  await vi.waitFor(() => expect(connection.sent).toHaveLength(2));
  return { connection, handler, router, sessions, sessionId };
}

describe("RemoteListener", () => {
  it("accepts only explicit private, link-local, unique-local, or loopback IPs", () => {
    for (const address of [
      "127.0.0.1",
      "192.168.1.10",
      "10.0.0.2",
      "169.254.1.2",
      "::1",
      "fd00::1",
    ]) {
      expect(isAllowedRemoteBindAddress(address)).toBe(true);
    }
    for (const address of ["0.0.0.0", "::", "8.8.8.8", "example.com", "not-an-address"]) {
      expect(isAllowedRemoteBindAddress(address)).toBe(false);
    }
  });

  it("serves TLS 1.3 WebSockets on the selected interface and cleans abrupt disconnects", async () => {
    const listener = new RemoteListener();
    const tls = await generateSelfSignedRemoteTlsIdentity(Date.now(), (size) => Buffer.alloc(size));
    const connected = vi.fn();
    listener.onConnection(connected);
    const port = await listener.start({ bindAddress: "127.0.0.1", port: 0 }, tls);
    const client = new WebSocket(`wss://127.0.0.1:${port}`, {
      rejectUnauthorized: false,
      minVersion: "TLSv1.3",
      perMessageDeflate: false,
    });
    await new Promise<void>((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });

    expect(connected).toHaveBeenCalledOnce();
    client.terminate();
    await listener.stop();
    expect(listener.isRunning()).toBe(false);
  });

  it("bounds concurrent sockets before allocating protocol sessions", async () => {
    const listener = new RemoteListener();
    const tls = await generateSelfSignedRemoteTlsIdentity(Date.now());
    const connected = vi.fn();
    listener.onConnection(connected);
    const port = await listener.start({ bindAddress: "127.0.0.1", port: 0 }, tls);
    const clients = Array.from(
      { length: REMOTE_GATEWAY_LIMITS.maxConcurrentConnections + 1 },
      () =>
        new WebSocket(`wss://127.0.0.1:${port}`, {
          rejectUnauthorized: false,
          minVersion: "TLSv1.3",
          perMessageDeflate: false,
        })
    );
    await Promise.all(
      clients.map(
        (client) =>
          new Promise<void>((resolve, reject) => {
            client.once("open", resolve);
            client.once("error", reject);
          })
      )
    );

    await vi.waitFor(() =>
      expect(connected).toHaveBeenCalledTimes(REMOTE_GATEWAY_LIMITS.maxConcurrentConnections)
    );
    for (const client of clients) client.terminate();
    await listener.stop();
  });
});

describe("RemoteAbuseGuard", () => {
  it("applies exponential temporary bans to the device and source pair only", () => {
    let now = 1_000;
    const guard = new RemoteAbuseGuard(() => now);

    expect(guard.recordViolation("device-01", "192.168.1.20")).toBe(1_000);
    expect(guard.isBanned("device-01", "192.168.1.20")).toBe(true);
    expect(guard.isBanned("device-01", "192.168.1.21")).toBe(false);
    now += 1_000;
    expect(guard.recordViolation("device-01", "192.168.1.20")).toBe(2_000);
    expect(guard.isBanned("device-02", "192.168.1.20")).toBe(false);
  });
});

describe("RemoteProtocolRouter", () => {
  it("stages first-time pairing before authentication without dispatching product data", async () => {
    const sessions = new RemoteSessionRegistry();
    const candidate = {
      pairingId: "pair-01",
      deviceId: "device-01",
      displayName: "Portal phone",
      platform: "ios" as const,
      publicKey: "p".repeat(64),
      verificationCode: "381902",
      state: "verification-required" as const,
    };
    const beginPairingRequest = vi.fn(() => candidate);
    const verifyPairingRequest = vi.fn(() => ({
      ...candidate,
      state: "awaiting-approval" as const,
    }));
    const router = new RemoteProtocolRouter(sessions, {} as RemoteAuthenticationService, "0.30.1");
    router.setPairingService({
      beginPairingRequest,
      verifyPairingRequest,
    } as unknown as RemotePairingService);
    const connection = new FakeConnection("pairing-connection");
    router.attach(connection);
    connection.receive({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      sessionId: "pairing",
      kind: "request",
      type: "hosts.pair.begin",
      requestId: "pairing-begin",
      payload: {
        pairingId: "pair-01",
        oneTimeSecret: "s".repeat(43),
        deviceId: "device-01",
        deviceName: "Portal phone",
        platform: "ios",
        devicePublicKey: "p".repeat(64),
      },
    });
    await vi.waitFor(() => expect(connection.sent).toHaveLength(1));
    const beginResponse = parseRemoteFrame(connection.sent[0]!);
    expect(beginResponse).toMatchObject({
      ok: true,
      envelope: {
        type: "hosts.pair.verify",
        payload: { verificationCode: "381902", state: "match-required" },
      },
    });

    connection.receive({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      sessionId: "pairing",
      kind: "request",
      type: "hosts.pair.verify",
      requestId: "pairing-verify",
      payload: {
        pairingId: "pair-01",
        verificationProof: "signature-value-01",
      },
    });
    await vi.waitFor(() => expect(connection.sent).toHaveLength(2));
    const verifyResponse = parseRemoteFrame(connection.sent[1]!);
    expect(verifyResponse).toMatchObject({
      ok: true,
      envelope: {
        type: "hosts.pair.verify",
        payload: { state: "awaiting-approval" },
      },
    });
    expect(beginPairingRequest).toHaveBeenCalledOnce();
    expect(verifyPairingRequest).toHaveBeenCalledWith("pair-01", "signature-value-01");
    expect(connection.closes).toEqual([]);
  });

  it("audits connection and malformed-frame metadata without retaining transport content", async () => {
    const sessions = new RemoteSessionRegistry();
    const router = new RemoteProtocolRouter(sessions, {} as RemoteAuthenticationService, "0.30.1");
    const record = vi.fn();
    router.setAuditService({ record } as unknown as RemoteAuditService);
    const connection = new FakeConnection("connection-audit");
    router.attach(connection);
    connection.receive('{"secret":"transport-canary"');
    await vi.waitFor(() => expect(connection.closes).toHaveLength(1));
    connection.disconnect();

    expect(record.mock.calls.map(([event]) => event.operation)).toEqual([
      "connection.start",
      "frame.malformed",
      "connection.end",
    ]);
    expect(JSON.stringify(record.mock.calls)).not.toContain("transport-canary");
  });

  it("rejects product data before authentication and readiness", async () => {
    const sessions = new RemoteSessionRegistry();
    const authentication = {} as RemoteAuthenticationService;
    const router = new RemoteProtocolRouter(sessions, authentication, "0.30.1");
    const connection = new FakeConnection("connection-01");
    router.attach(connection);
    connection.receive(request("pending", "projects.list", 1));

    await vi.waitFor(() => expect(connection.closes[0]?.reason).toBe("AUTHENTICATION_REQUIRED"));
    expect(connection.sent.some((frame) => frame.includes('"code":"AUTHENTICATION_FAILED"'))).toBe(
      true
    );
  });

  it("negotiates, authenticates, readies, and only then dispatches application messages", async () => {
    const { connection, handler, sessionId } = await readyConnection();
    connection.receive(request(sessionId, "projects.list", 1));

    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    expect(connection.closes).toEqual([]);
  });

  it("closes malformed, oversized, mismatched-session, and slow-consumer connections", async () => {
    const malformed = await readyConnection();
    malformed.connection.receive("{");
    await vi.waitFor(() => expect(malformed.connection.closes[0]?.code).toBe(1008));

    const oversized = await readyConnection();
    oversized.connection.receive("x".repeat(REMOTE_GATEWAY_LIMITS.maxFrameBytes + 1));
    await vi.waitFor(() => expect(oversized.connection.closes[0]?.code).toBe(1009));

    const mismatch = await readyConnection();
    mismatch.connection.receive(request("wrong-session", "projects.list", 1));
    await vi.waitFor(() =>
      expect(mismatch.connection.closes[0]?.reason).toBe("AUTHENTICATION_FAILED")
    );

    const slow = new FakeConnection("slow");
    slow.bufferedAmount = REMOTE_GATEWAY_LIMITS.maxQueuedBytes;
    const sessions = new RemoteSessionRegistry();
    const auth = {
      authenticateClientChallenge: () => ({
        authenticated: true,
        deviceId: "device-02",
        capabilities: [],
        hostSignature: "host-signature-value-02",
      }),
    } as unknown as RemoteAuthenticationService;
    new RemoteProtocolRouter(sessions, auth, "0.30.1").attach(slow);
    slow.receive({ ...hello(), payload: { ...hello().payload, deviceId: "device-02" } });
    await vi.waitFor(() => expect(slow.closes[0]?.reason).toBe("QUEUE_OVERFLOW"));
  });

  it("enforces request, launch, prompt-byte, and console subscription limits", async () => {
    const requestRate = await readyConnection();
    for (let index = 0; index <= REMOTE_GATEWAY_LIMITS.maxRequestsPerMinute; index += 1) {
      requestRate.connection.receive(request(requestRate.sessionId, "projects.list", index));
    }
    await vi.waitFor(() =>
      expect(requestRate.connection.closes.at(-1)?.reason).toBe("RATE_LIMITED")
    );

    const launches = await readyConnection();
    for (let index = 0; index <= REMOTE_GATEWAY_LIMITS.maxLaunchesPerMinute; index += 1) {
      launches.connection.receive(request(launches.sessionId, "agent.launch", index));
    }
    await vi.waitFor(() =>
      expect(launches.connection.sent.some((frame) => frame.includes("Launch rate exceeded"))).toBe(
        true
      )
    );

    const prompt = await readyConnection();
    const oversizedPrompt = request(prompt.sessionId, "prompt.submit", 1);
    oversizedPrompt.payload.text = "😀".repeat(20_000);
    prompt.connection.receive(oversizedPrompt);
    await vi.waitFor(() =>
      expect(prompt.connection.sent.some((frame) => frame.includes("Prompt exceeds 64 KiB"))).toBe(
        true
      )
    );

    const subscriptions = await readyConnection();
    for (
      let index = 0;
      index <= REMOTE_GATEWAY_LIMITS.maxConsoleSubscriptionsPerSession;
      index += 1
    ) {
      subscriptions.connection.receive(
        request(subscriptions.sessionId, "console.subscribe", index)
      );
    }
    await vi.waitFor(() =>
      expect(
        subscriptions.connection.sent.some((frame) => frame.includes("Console subscription limit"))
      ).toBe(true)
    );
  });

  it("does not charge console acknowledgements against the request budget", async () => {
    const { connection, handler, sessions, sessionId } = await readyConnection();
    expect(sessions.reserveConsoleSubscription(connection.id, "subscribe-01")).toBe(true);
    expect(sessions.registerConsoleStream(connection.id, "subscribe-01", "stream-01")).toBe(true);
    expect(sessions.trackConsoleOutput(connection.id, "stream-01", 0, 1)).toBe(true);
    handler.mockClear();

    for (let index = 0; index <= REMOTE_GATEWAY_LIMITS.maxRequestsPerMinute; index += 1) {
      connection.receive({
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        sessionId,
        kind: "ack",
        type: "stream.ack",
        streamId: "stream-01",
        ack: 0,
      });
    }
    connection.receive(request(sessionId, "projects.list", 901));

    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    expect(connection.closes).toEqual([]);
  });

  it("shares launch throttling across a device's concurrent sessions", () => {
    const registry = new RemoteSessionRegistry();
    for (let index = 0; index < REMOTE_GATEWAY_LIMITS.maxLaunchesPerMinute; index += 1) {
      expect(
        registry.consumeDeviceLaunch(
          "device-01",
          1_000,
          60_000,
          REMOTE_GATEWAY_LIMITS.maxLaunchesPerMinute
        )
      ).toBe(true);
    }
    expect(
      registry.consumeDeviceLaunch(
        "device-01",
        1_000,
        60_000,
        REMOTE_GATEWAY_LIMITS.maxLaunchesPerMinute
      )
    ).toBe(false);
    expect(
      registry.isDeviceLaunchWithinRate(
        "device-01",
        1_000,
        60_000,
        REMOTE_GATEWAY_LIMITS.maxLaunchesPerMinute
      )
    ).toBe(true);
    expect(
      registry.isDeviceLaunchWithinRate(
        "device-01",
        61_001,
        60_000,
        REMOTE_GATEWAY_LIMITS.maxLaunchesPerMinute
      )
    ).toBe(false);
    expect(
      registry.consumeDeviceLaunch(
        "device-02",
        1_000,
        60_000,
        REMOTE_GATEWAY_LIMITS.maxLaunchesPerMinute
      )
    ).toBe(true);
  });

  it("tracks subscriptions by stream and releases bounded unacknowledged output on ACK", () => {
    const registry = new RemoteSessionRegistry();
    const connection = new FakeConnection("connection-stream");
    registry.create(connection);
    registry.authenticate(connection.id, "device-stream", []);
    registry.markReady(connection.id);

    expect(registry.reserveConsoleSubscription(connection.id, "subscribe-01")).toBe(true);
    expect(registry.registerConsoleStream(connection.id, "subscribe-01", "stream-01")).toBe(true);
    expect(
      registry.trackConsoleOutput(
        connection.id,
        "stream-01",
        0,
        REMOTE_GATEWAY_LIMITS.maxQueuedBytes - 1
      )
    ).toBe(true);
    expect(registry.trackConsoleOutput(connection.id, "stream-01", 1, 2)).toBe(false);
    expect(registry.acknowledgeConsoleOutput(connection.id, "stream-01", 0)).toBe(true);
    expect(registry.trackConsoleOutput(connection.id, "stream-01", 1, 2)).toBe(true);

    registry.removeConsoleStream(connection.id, "stream-01");
    for (
      let index = 0;
      index < REMOTE_GATEWAY_LIMITS.maxConsoleSubscriptionsPerSession;
      index += 1
    ) {
      expect(registry.reserveConsoleSubscription(connection.id, `subscribe-${index + 2}`)).toBe(
        true
      );
    }
    expect(registry.reserveConsoleSubscription(connection.id, "subscribe-overflow")).toBe(false);
  });

  it("drops only an overflowing console stream and emits a typed resync event", async () => {
    const { connection, router, sessions, sessionId } = await readyConnection();
    expect(sessions.reserveConsoleSubscription(connection.id, "subscribe-01")).toBe(true);
    router.sendApplicationEnvelope(connection.id, {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      sessionId,
      kind: "response",
      type: "console.snapshot",
      requestId: "subscribe-01",
      payload: {
        projectId: "project-01",
        worktreeId: "worktree-01",
        panelId: "panel-01",
        launchGeneration: 1,
        streamId: "stream-01",
        mode: "snapshot",
        throughSeq: 0,
        snapshot: { data: "", cols: 80, rows: 24 },
        chunks: [],
      },
    });
    connection.bufferedAmount = REMOTE_GATEWAY_LIMITS.maxQueuedBytes;

    router.sendApplicationEnvelope(connection.id, {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      sessionId,
      kind: "event",
      type: "console.output",
      streamId: "stream-01",
      seq: 1,
      payload: {
        streamId: "stream-01",
        panelId: "panel-01",
        launchGeneration: 1,
        seq: 1,
        data: "eA==",
        encoding: "base64",
        bytes: 1,
      },
    });

    expect(connection.closes).toEqual([]);
    expect(JSON.parse(connection.sent.at(-1)!)).toMatchObject({
      type: "console.resyncRequired",
      payload: { streamId: "stream-01", reason: "queue-overflow" },
    });
    expect(sessions.get(connection.id)?.subscriptions.has("stream-01")).toBe(false);
  });

  it("allows a capped snapshot above the ordinary queue limit without closing the session", async () => {
    const { connection, router, sessions, sessionId } = await readyConnection();
    expect(sessions.reserveConsoleSubscription(connection.id, "subscribe-01")).toBe(true);

    router.sendApplicationEnvelope(connection.id, {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      sessionId,
      kind: "response",
      type: "console.snapshot",
      requestId: "subscribe-01",
      payload: {
        projectId: "project-01",
        worktreeId: "worktree-01",
        panelId: "panel-01",
        launchGeneration: 1,
        streamId: "stream-01",
        mode: "snapshot",
        throughSeq: 0,
        snapshot: { data: "x".repeat(2 * 1024 * 1024), cols: 80, rows: 24 },
        chunks: [],
      },
    });

    expect(connection.closes).toEqual([]);
    expect(sessions.get(connection.id)?.subscriptions.has("stream-01")).toBe(true);
    expect(JSON.parse(connection.sent.at(-1)!)).toMatchObject({ type: "console.snapshot" });
  });

  it("drops registry state after abrupt connection close and enforces device/session caps", async () => {
    const ready = await readyConnection();
    expect(ready.sessions.size()).toBe(1);
    ready.connection.disconnect();
    expect(ready.sessions.size()).toBe(0);

    const registry = new RemoteSessionRegistry();
    for (let index = 0; index < REMOTE_GATEWAY_LIMITS.maxConcurrentDevices; index += 1) {
      const connection = new FakeConnection(`connection-${index}`);
      registry.create(connection);
      registry.authenticate(connection.id, `device-${index}`, []);
    }
    const overflow = new FakeConnection("overflow");
    registry.create(overflow);
    expect(() => registry.authenticate(overflow.id, "device-overflow", [])).toThrow("devices");

    const registry2 = new RemoteSessionRegistry();
    for (let index = 0; index < REMOTE_GATEWAY_LIMITS.maxSessionsPerDevice; index += 1) {
      const connection = new FakeConnection(`same-device-${index}`);
      registry2.create(connection);
      registry2.authenticate(connection.id, "device-01", []);
    }
    const excess = new FakeConnection("same-device-overflow");
    registry2.create(excess);
    expect(() => registry2.authenticate(excess.id, "device-01", [])).toThrow("sessions");
  });
});

describe("RemoteGatewayService", () => {
  it("stays disabled by default and restarts cleanly on interface changes", async () => {
    let handler: ((connection: RemoteConnection) => void) | null = null;
    const listener = {
      onConnection: vi.fn((next) => {
        handler = next;
      }),
      start: vi.fn(async (config) => config.port || 45_123),
      stop: vi.fn(async () => undefined),
    } as unknown as RemoteListener;
    const router = { attach: vi.fn(), closeAll: vi.fn() } as unknown as RemoteProtocolRouter;
    const tls = { ensureIdentity: vi.fn(async () => ({})) } as unknown as RemoteTlsIdentityService;
    const pairing = { cancelAll: vi.fn() } as unknown as RemotePairingService;
    const authentication = { clear: vi.fn() } as unknown as RemoteAuthenticationService;
    const discovery = { start: vi.fn(), stop: vi.fn() };
    const gateway = new RemoteGatewayService(
      listener,
      router,
      tls,
      pairing,
      authentication,
      discovery
    );

    await gateway.applyConfig(DEFAULT_REMOTE_GATEWAY_CONFIG);
    expect(tls.ensureIdentity).not.toHaveBeenCalled();
    expect(gateway.status()).toEqual({ state: "disabled" });

    await gateway.applyConfig({ enabled: true, bindAddress: "192.168.1.10", port: 45_123 });
    expect(gateway.status()).toEqual({
      state: "listening",
      bindAddress: "192.168.1.10",
      port: 45_123,
    });
    expect(discovery.start).toHaveBeenCalledAfter(listener.start as ReturnType<typeof vi.fn>);

    await gateway.applyConfig({
      enabled: true,
      bindAddress: "192.168.1.10",
      port: 45_123,
      discoveryEnabled: false,
      displayName: "Quiet host",
    });
    expect(listener.start).toHaveBeenCalledOnce();
    expect(discovery.start).toHaveBeenLastCalledWith(
      45_123,
      expect.objectContaining({ discoveryEnabled: false, displayName: "Quiet host" })
    );

    await gateway.applyConfig({ enabled: true, bindAddress: "10.0.0.4", port: 45_123 });
    expect(listener.start).toHaveBeenCalledTimes(2);
    expect(listener.stop).toHaveBeenCalled();
    expect(handler).not.toBeNull();

    await gateway.stop();
    expect(router.closeAll).toHaveBeenCalled();
    expect(pairing.cancelAll).toHaveBeenCalled();
    expect(authentication.clear).toHaveBeenCalled();
    expect(gateway.status()).toEqual({ state: "disabled" });
  });

  it("fails closed and tears down partial resources when listener startup fails", async () => {
    const listener = {
      onConnection: vi.fn(),
      start: vi.fn(async () => {
        throw new Error("EADDRINUSE");
      }),
      stop: vi.fn(async () => undefined),
    } as unknown as RemoteListener;
    const gateway = new RemoteGatewayService(
      listener,
      { attach: vi.fn(), closeAll: vi.fn() } as unknown as RemoteProtocolRouter,
      { ensureIdentity: vi.fn(async () => ({})) } as unknown as RemoteTlsIdentityService,
      { cancelAll: vi.fn() } as unknown as RemotePairingService,
      { clear: vi.fn() } as unknown as RemoteAuthenticationService
    );

    await expect(
      gateway.applyConfig({ enabled: true, bindAddress: "127.0.0.1", port: 45_123 })
    ).rejects.toThrow("EADDRINUSE");
    expect(listener.stop).toHaveBeenCalled();
    expect(gateway.status()).toEqual({ state: "error", message: "EADDRINUSE" });
  });
});
