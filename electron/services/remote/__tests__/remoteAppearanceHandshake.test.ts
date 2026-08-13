import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  REMOTE_PROTOCOL_VERSION,
  RemoteDiscoveryAdvertisementSchema,
  RemoteSessionWelcomeSchema,
  parseRemoteFrame,
  type RemoteEnvelope,
} from "../../../../shared/types/remote/index.js";
import { BUILT_IN_APP_SCHEMES, projectRemoteAppearance } from "../../../../shared/theme/index.js";
import type { RemoteAuthenticationService } from "../RemoteAuthenticationService.js";
import type { RemoteConnection } from "../RemoteConnection.js";
import { RemoteProtocolRouter } from "../RemoteProtocolRouter.js";
import { RemoteSessionRegistry } from "../RemoteSessionRegistry.js";

class TestConnection implements RemoteConnection {
  readonly events = new EventEmitter();
  readonly sent: string[] = [];
  readonly closes: Array<{ code: number; reason: string }> = [];
  readonly id = "appearance-connection";
  readonly sourceAddress = "192.168.1.20";
  bufferedAmount = 0;

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

  receive(value: unknown): void {
    this.events.emit("message", JSON.stringify(value));
  }
}

function hello() {
  return {
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    sessionId: "pending",
    kind: "request",
    type: "session.hello",
    requestId: "hello-appearance",
    payload: {
      supportedProtocol: { min: REMOTE_PROTOCOL_VERSION, max: REMOTE_PROTOCOL_VERSION },
      appVersion: "1.0.0",
      deviceId: "device-appearance",
      challenge: "challenge-appearance",
      signature: "signature-appearance",
    },
  };
}

function frames(connection: TestConnection): RemoteEnvelope[] {
  return connection.sent.map((frame) => {
    const parsed = parseRemoteFrame(frame);
    if (!parsed.ok) throw new Error(parsed.error.code);
    return parsed.envelope;
  });
}

function authenticatedRouter(authenticated = true) {
  const authenticateClientChallenge = vi.fn(() =>
    authenticated
      ? {
          authenticated: true as const,
          deviceId: "device-appearance",
          capabilities: ["observe-projects"] as const,
          hostSignature: "host-signature-appearance",
        }
      : { authenticated: false as const, reason: "invalid" as const }
  );
  const sessions = new RemoteSessionRegistry();
  const router = new RemoteProtocolRouter(
    sessions,
    { authenticateClientChallenge } as unknown as RemoteAuthenticationService,
    "0.30.1"
  );
  return { router, authenticateClientChallenge };
}

describe("authenticated appearance welcome", () => {
  it("keeps appearance additive for a legacy Portal parser and pins the contract to v1", () => {
    const appearance = projectRemoteAppearance(BUILT_IN_APP_SCHEMES[0]!, { revision: 1 });
    const payload = {
      protocolVersion: 1,
      sessionId: "new-host-session",
      capabilities: ["observe-projects"],
      appearance,
    };

    const legacyPortalResult = {
      protocolVersion: payload.protocolVersion,
      sessionId: payload.sessionId,
      capabilities: payload.capabilities,
    };
    expect(legacyPortalResult).toEqual({
      protocolVersion: 1,
      sessionId: "new-host-session",
      capabilities: ["observe-projects"],
    });
  });

  it("accepts a legacy v1 welcome that has no appearance field", () => {
    const parsed = RemoteSessionWelcomeSchema.safeParse({
      protocolVersion: 1,
      sessionId: "legacy-session",
      challenge: "legacy-challenge-01",
      signature: "legacy-signature-01",
      capabilities: ["observe-projects"],
      appVersion: "0.29.0",
      resumeAccepted: false,
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("Expected legacy welcome to parse");
    expect(parsed.data).not.toHaveProperty("appearance");
  });

  it("adds a valid snapshot only after client authentication without changing protocol version", async () => {
    const { router, authenticateClientChallenge } = authenticatedRouter();
    const appearance = projectRemoteAppearance(BUILT_IN_APP_SCHEMES[0]!, { revision: 4 });
    const appearanceProvider = vi.fn(() => appearance);
    router.setAppearanceProvider(appearanceProvider);
    const connection = new TestConnection();
    router.attach(connection);

    connection.receive(hello());
    await vi.waitFor(() => expect(connection.sent).toHaveLength(1));
    const welcome = frames(connection)[0]!;

    expect(welcome.type).toBe("session.welcome");
    if (welcome.type !== "session.welcome") throw new Error("Expected welcome");
    expect(welcome.protocolVersion).toBe(1);
    expect(welcome.payload.protocolVersion).toBe(1);
    expect(welcome.payload.appearance).toEqual(appearance);
    expect(authenticateClientChallenge.mock.invocationCallOrder[0]).toBeLessThan(
      appearanceProvider.mock.invocationCallOrder[0]!
    );
  });

  it("never evaluates or exposes appearance when authentication fails", async () => {
    const { router } = authenticatedRouter(false);
    const appearanceProvider = vi.fn(() =>
      projectRemoteAppearance(BUILT_IN_APP_SCHEMES[0]!, { revision: 1 })
    );
    router.setAppearanceProvider(appearanceProvider);
    const connection = new TestConnection();
    router.attach(connection);

    connection.receive(hello());
    await vi.waitFor(() => expect(connection.closes).toHaveLength(1));

    expect(appearanceProvider).not.toHaveBeenCalled();
    expect(connection.sent.join()).not.toContain('"appearance"');
  });

  it.each([
    [
      "pairing",
      {
        protocolVersion: 1,
        sessionId: "pending",
        kind: "request",
        type: "hosts.pair.begin",
        requestId: "pair-without-appearance",
        payload: {
          pairingId: "pairing-01",
          oneTimeSecret: "a".repeat(32),
          deviceId: "device-appearance",
          deviceName: "Phone",
          platform: "ios",
          devicePublicKey: "p".repeat(32),
        },
      },
    ],
    [
      "non-hello pre-auth traffic",
      {
        protocolVersion: 1,
        sessionId: "pending",
        kind: "request",
        type: "projects.list",
        requestId: "projects-without-auth",
        payload: {},
      },
    ],
  ])("does not disclose appearance during %s", async (_, frame) => {
    const { router } = authenticatedRouter();
    const appearanceProvider = vi.fn(() =>
      projectRemoteAppearance(BUILT_IN_APP_SCHEMES[0]!, { revision: 1 })
    );
    router.setAppearanceProvider(appearanceProvider);
    const connection = new TestConnection();
    router.attach(connection);

    connection.receive(frame);
    await vi.waitFor(() => expect(connection.sent).toHaveLength(1));

    expect(appearanceProvider).not.toHaveBeenCalled();
    expect(connection.sent[0]).not.toContain('"appearance"');
  });

  it("keeps discovery advertisements appearance-free", () => {
    const appearance = projectRemoteAppearance(BUILT_IN_APP_SCHEMES[0]!, { revision: 1 });
    const advertisement = {
      serviceType: "_daintree-portal._tcp",
      displayName: "Studio Mac",
      hostId: "host-01",
      protocolMin: 1,
      protocolMax: 1,
      appVersion: "0.30.1",
      platform: "macos",
      address: "192.168.1.20",
      port: 45123,
      fingerprintPrefix: "abcdefgh",
    };

    expect(RemoteDiscoveryAdvertisementSchema.safeParse(advertisement).success).toBe(true);
    expect(
      RemoteDiscoveryAdvertisementSchema.safeParse({ ...advertisement, appearance }).success
    ).toBe(false);
  });

  it.each([
    ["malformed", () => ({ version: 999 }) as never],
    [
      "provider failure",
      () => {
        throw new Error("projection failed");
      },
    ],
  ])("omits %s appearance without invalidating the authenticated session", async (_, provider) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { router } = authenticatedRouter();
    router.setAppearanceProvider(provider);
    const connection = new TestConnection();
    router.attach(connection);
    connection.receive(hello());
    await vi.waitFor(() => expect(connection.sent).toHaveLength(1));
    const welcome = frames(connection)[0]!;
    if (welcome.type !== "session.welcome") throw new Error("Expected welcome");

    expect(welcome.payload.appearance).toBeUndefined();
    connection.receive({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      sessionId: welcome.sessionId,
      kind: "request",
      type: "session.ready",
      requestId: "ready-appearance",
      payload: { ready: true },
    });
    await vi.waitFor(() => expect(connection.sent).toHaveLength(2));
    expect(frames(connection)[1]?.type).toBe("session.ready");
    expect(connection.closes).toEqual([]);
    expect(warning).toHaveBeenCalledOnce();
    expect(warning.mock.calls[0]).toEqual([
      "[RemoteProtocolRouter] Ignoring invalid appearance snapshot",
    ]);
    warning.mockRestore();
  });
});
