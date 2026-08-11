import { generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  REMOTE_CAPABILITIES,
  REMOTE_COMPANION_CAPABILITIES,
  type RemoteCapability,
  type RemotePairedDevice,
} from "../../../../shared/types/remote/index.js";
import type { SecretCipher } from "../../plugin/secretCipher.js";
import {
  RemoteAuthenticationService,
  type RemoteAuthenticationResult,
} from "../RemoteAuthenticationService.js";
import {
  RemoteCapabilityService,
  type RemoteSessionPolicySink,
} from "../RemoteCapabilityService.js";
import {
  REMOTE_IDENTITY_SCHEMA_VERSION,
  type RemoteIdentityStore,
  type StoredRemoteHostIdentity,
  type StoredRemoteTlsIdentity,
} from "../RemoteIdentityStore.js";
import {
  RemoteIdentityService,
  RemoteSecureStorageUnavailableError,
} from "../RemoteIdentityService.js";
import { RemotePairingService, type CompletePairingInput } from "../RemotePairingService.js";
import {
  generateSelfSignedRemoteTlsIdentity,
  RemoteTlsIdentityService,
} from "../RemoteTlsIdentityService.js";

class MemoryIdentityStore implements RemoteIdentityStore {
  host: StoredRemoteHostIdentity | null = null;
  tls: StoredRemoteTlsIdentity | null = null;
  devices = new Map<string, RemotePairedDevice>();

  getHostIdentity(): StoredRemoteHostIdentity | null {
    return this.host ? structuredClone(this.host) : null;
  }

  saveHostIdentity(identity: StoredRemoteHostIdentity): void {
    this.host = structuredClone(identity);
  }

  getTlsIdentity(hostId: string): StoredRemoteTlsIdentity | null {
    return this.tls?.hostId === hostId ? structuredClone(this.tls) : null;
  }

  saveTlsIdentity(identity: StoredRemoteTlsIdentity): void {
    this.tls = structuredClone(identity);
  }

  getDevice(deviceId: string): RemotePairedDevice | null {
    const device = this.devices.get(deviceId);
    return device ? structuredClone(device) : null;
  }

  listDevices(): RemotePairedDevice[] {
    return [...this.devices.values()].map((device) => structuredClone(device));
  }

  saveDevice(device: RemotePairedDevice): void {
    this.devices.set(device.id, structuredClone(device));
  }
}

function fakeCipher(available = true): SecretCipher {
  return {
    tier: () => (available ? "keychain" : "plaintext"),
    encrypt: (plaintext) =>
      available ? `cipher:${Buffer.from(plaintext).toString("base64")}` : null,
    decrypt: (ciphertext) => Buffer.from(ciphertext.slice("cipher:".length), "base64").toString(),
  };
}

function deviceKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    sign: (message: string) => sign(null, Buffer.from(message), privateKey).toString("base64url"),
  };
}

function validFingerprint(seed = "a"): string {
  return `sha256:${seed.repeat(43).slice(0, 43)}`;
}

const tlsFingerprintProvider = { certificateFingerprint: () => validFingerprint() };

function completeInput(
  bootstrap: { pairingId: string; oneTimeSecret: string },
  keys: ReturnType<typeof deviceKeys>,
  overrides: Partial<CompletePairingInput> = {}
): CompletePairingInput {
  const base = {
    pairingId: bootstrap.pairingId,
    oneTimeSecret: bootstrap.oneTimeSecret,
    deviceId: "device-01",
    displayName: "Justin's phone",
    platform: "ios" as const,
    publicKey: keys.publicKey,
    grantedCapabilities: [...REMOTE_COMPANION_CAPABILITIES],
  };
  const input = { ...base, ...overrides };
  return {
    ...input,
    deviceProof:
      overrides.deviceProof ??
      keys.sign(`${input.pairingId}.${input.oneTimeSecret}.${input.deviceId}`),
  };
}

function pairDevice(
  store: MemoryIdentityStore,
  identity: RemoteIdentityService,
  now: () => number,
  capabilities: RemoteCapability[] = [...REMOTE_COMPANION_CAPABILITIES]
) {
  const pairing = new RemotePairingService(store, identity, tlsFingerprintProvider, now, () =>
    "s".repeat(43)
  );
  const bootstrap = pairing.beginPairing({
    endpointHints: ["wss://192.0.2.1:45123"],
  });
  const keys = deviceKeys();
  const device = pairing.completePairing(
    completeInput(bootstrap, keys, { grantedCapabilities: capabilities })
  );
  return { device, keys };
}

describe("RemoteIdentityService", () => {
  it("persists one stable signing identity encrypted at rest across service restarts", () => {
    const store = new MemoryIdentityStore();
    const first = new RemoteIdentityService(store, fakeCipher(), () => 1_000).publicIdentity();
    const restarted = new RemoteIdentityService(store, fakeCipher(), () => 2_000).publicIdentity();

    expect(restarted).toEqual(first);
    expect(store.host?.schemaVersion).toBe(REMOTE_IDENTITY_SCHEMA_VERSION);
    expect(store.host?.encryptedPrivateKey).toMatch(/^cipher:/);
    expect(store.host?.encryptedPrivateKey).not.toContain("BEGIN PRIVATE KEY");
    expect(first).not.toHaveProperty("privateKey");
    expect(first).not.toHaveProperty("encryptedPrivateKey");
  });

  it("fails closed with actionable recovery when protected storage is unavailable", () => {
    const identity = new RemoteIdentityService(new MemoryIdentityStore(), fakeCipher(false));
    let error: unknown;
    try {
      identity.publicIdentity();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(RemoteSecureStorageUnavailableError);
    expect(error).toMatchObject({ recovery: expect.stringContaining("keychain") });
  });

  it("rejects unsupported or tampered persisted identity material", () => {
    const store = new MemoryIdentityStore();
    new RemoteIdentityService(store, fakeCipher()).publicIdentity();
    store.host = { ...store.host!, schemaVersion: REMOTE_IDENTITY_SCHEMA_VERSION + 1 };
    expect(() => new RemoteIdentityService(store, fakeCipher()).publicIdentity()).toThrow(
      "Unsupported remote identity schema"
    );

    store.host = {
      ...store.host,
      schemaVersion: REMOTE_IDENTITY_SCHEMA_VERSION,
      fingerprint: validFingerprint(),
    };
    expect(() => new RemoteIdentityService(store, fakeCipher()).publicIdentity()).toThrow(
      "fingerprint"
    );
  });
});

describe("RemoteTlsIdentityService", () => {
  it("creates a valid self-signed TLS identity with a certificate pin", async () => {
    const material = await generateSelfSignedRemoteTlsIdentity(1_700_000_000_000);

    expect(material.certificate).toContain("BEGIN CERTIFICATE");
    expect(material.privateKey).toContain("BEGIN PRIVATE KEY");
    expect(material.certificateFingerprint).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/);
  });

  it("encrypts TLS private material and restores the stable certificate after restart", async () => {
    const store = new MemoryIdentityStore();
    const cipher = fakeCipher();
    const identity = new RemoteIdentityService(store, cipher, () => 1_000);
    const material = await generateSelfSignedRemoteTlsIdentity(1_000);
    const factory = vi.fn(async () => material);
    const first = new RemoteTlsIdentityService(store, identity, cipher, factory, () => 1_000);
    const created = await first.ensureIdentity();
    const restartedFactory = vi.fn(async () => {
      throw new Error("must restore instead of regenerating");
    });
    const restarted = new RemoteTlsIdentityService(
      store,
      new RemoteIdentityService(store, cipher),
      cipher,
      restartedFactory
    );

    expect(await restarted.ensureIdentity()).toEqual(created);
    expect(factory).toHaveBeenCalledOnce();
    expect(restartedFactory).not.toHaveBeenCalled();
    expect(store.tls?.encryptedPrivateKey).toMatch(/^cipher:/);
    expect(store.tls?.encryptedPrivateKey).not.toContain("BEGIN PRIVATE KEY");
    expect(restarted.certificateFingerprint()).toBe(created.certificateFingerprint);
  });

  it("fails closed before generating TLS material without protected storage", async () => {
    const store = new MemoryIdentityStore();
    const cipher = fakeCipher(false);
    const factory = vi.fn(generateSelfSignedRemoteTlsIdentity);
    const service = new RemoteTlsIdentityService(
      store,
      new RemoteIdentityService(store, cipher),
      cipher,
      factory
    );

    await expect(service.ensureIdentity()).rejects.toBeInstanceOf(
      RemoteSecureStorageUnavailableError
    );
    expect(factory).not.toHaveBeenCalled();
  });
});

describe("RemotePairingService", () => {
  it("stages mobile proof for explicit desktop approval before persisting the device", () => {
    const now = 10_000;
    const deviceId = "portal-device";
    const displayName = "Justin's phone";
    const platform = "ios" as const;
    const grants = [...REMOTE_COMPANION_CAPABILITIES];
    const secret = "s".repeat(43);
    const endpointHints = ["wss://192.0.2.1:45123"];
    const store = new MemoryIdentityStore();
    const identity = new RemoteIdentityService(store, fakeCipher(), () => now);
    const pairing = new RemotePairingService(
      store,
      identity,
      tlsFingerprintProvider,
      () => now,
      () => secret
    );
    const bootstrap = pairing.beginPairing({ endpointHints });
    const keys = deviceKeys();

    const candidate = pairing.beginPairingRequest({
      pairingId: bootstrap.pairingId,
      oneTimeSecret: bootstrap.oneTimeSecret,
      deviceId,
      displayName,
      platform,
      publicKey: keys.publicKey,
    });
    expect(candidate.verificationCode).toBe(bootstrap.verificationCode);
    expect(candidate.verificationCode).toMatch(/^\d{6}$/);
    expect(store.listDevices()).toEqual([]);
    expect(() =>
      pairing.beginPairingRequest({
        pairingId: bootstrap.pairingId,
        oneTimeSecret: bootstrap.oneTimeSecret,
        deviceId: "replacement-device",
        displayName,
        platform,
        publicKey: keys.publicKey,
      })
    ).toThrow("already has a device candidate");

    const verified = pairing.verifyPairingRequest(
      bootstrap.pairingId,
      keys.sign(`${bootstrap.pairingId}.${deviceId}.${bootstrap.verificationCode}`)
    );
    expect(verified.state).toBe("awaiting-approval");
    expect(pairing.pendingApprovals()).toEqual([verified]);
    expect(store.listDevices()).toEqual([]);

    const device = pairing.approvePairing(bootstrap.pairingId, grants);
    expect(device).toMatchObject({
      id: deviceId,
      displayName,
      platform,
      publicKey: keys.publicKey,
      capabilities: grants,
      revokedAt: null,
    });
    expect(store.getDevice(deviceId)).toEqual(device);
    expect(pairing.pendingApprovals()).toEqual([]);
    expect(pairing.activePairingCount()).toBe(0);
  });

  it("pairs a device through signed short-lived material with explicit companion grants", () => {
    const store = new MemoryIdentityStore();
    const identity = new RemoteIdentityService(store, fakeCipher(), () => 10_000);
    const { device } = pairDevice(store, identity, () => 10_000);

    expect(device).toMatchObject({
      hostId: identity.publicIdentity().hostId,
      capabilities: REMOTE_COMPANION_CAPABILITIES,
      revokedAt: null,
    });
    expect(store.getDevice(device.id)).toEqual(device);
  });

  it("automatically destroys expired pairing material", () => {
    const store = new MemoryIdentityStore();
    const identity = new RemoteIdentityService(store, fakeCipher());
    let expire: (() => void) | null = null;
    const cancel = vi.fn();
    const pairing = new RemotePairingService(
      store,
      identity,
      tlsFingerprintProvider,
      Date.now,
      () => "s".repeat(43),
      (callback) => {
        expire = callback;
        return { unref: vi.fn() } as unknown as ReturnType<typeof setTimeout>;
      },
      cancel
    );
    const bootstrap = pairing.beginPairing({ endpointHints: [] });

    expect(pairing.activePairingCount()).toBe(1);
    expect(bootstrap.tlsCertificateFingerprint).toBe(validFingerprint());
    expect(expire).not.toBeNull();
    (expire as unknown as () => void)();
    expect(pairing.activePairingCount()).toBe(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(() => pairing.completePairing(completeInput(bootstrap, deviceKeys()))).toThrow(
      "unavailable"
    );
  });

  it("rejects altered, expired, and replayed pairing material", () => {
    let now = 10_000;
    const store = new MemoryIdentityStore();
    const identity = new RemoteIdentityService(store, fakeCipher(), () => now);
    const pairing = new RemotePairingService(
      store,
      identity,
      tlsFingerprintProvider,
      () => now,
      () => "s".repeat(43)
    );
    const keys = deviceKeys();

    const altered = pairing.beginPairing({
      endpointHints: [],
    });
    expect(() =>
      pairing.completePairing(
        completeInput(altered, keys, { oneTimeSecret: `x${altered.oneTimeSecret.slice(1)}` })
      )
    ).toThrow("invalid");

    const expired = pairing.beginPairing({
      endpointHints: [],
    });
    now = expired.expiresAt;
    expect(() => pairing.completePairing(completeInput(expired, keys))).toThrow("expired");

    now = 20_000;
    const used = pairing.beginPairing({
      endpointHints: [],
    });
    pairing.completePairing(completeInput(used, keys));
    expect(() => pairing.completePairing(completeInput(used, keys))).toThrow("already used");
  });

  it("rejects invalid device proof and the never-remotely-granted host administration capability", () => {
    const store = new MemoryIdentityStore();
    const identity = new RemoteIdentityService(store, fakeCipher());
    const pairing = new RemotePairingService(
      store,
      identity,
      tlsFingerprintProvider,
      Date.now,
      () => "s".repeat(43)
    );
    const keys = deviceKeys();
    const invalidProof = pairing.beginPairing({
      endpointHints: [],
    });
    expect(() =>
      pairing.completePairing(completeInput(invalidProof, keys, { deviceProof: "invalid" }))
    ).toThrow("proof");

    const admin = pairing.beginPairing({
      endpointHints: [],
    });
    expect(() =>
      pairing.completePairing(
        completeInput(admin, keys, { grantedCapabilities: ["administer-host"] })
      )
    ).toThrow("cannot be granted");
  });

  it("destroys a pairing window after the bounded number of failed attempts", () => {
    const store = new MemoryIdentityStore();
    const identity = new RemoteIdentityService(store, fakeCipher());
    const pairing = new RemotePairingService(
      store,
      identity,
      tlsFingerprintProvider,
      Date.now,
      () => "s".repeat(43)
    );
    const bootstrap = pairing.beginPairing({ endpointHints: [] });
    const keys = deviceKeys();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(() =>
        pairing.completePairing(completeInput(bootstrap, keys, { oneTimeSecret: "x".repeat(43) }))
      ).toThrow("invalid");
    }
    expect(pairing.activePairingCount()).toBe(0);
    expect(() => pairing.completePairing(completeInput(bootstrap, keys))).toThrow("unavailable");
  });
});

describe("RemoteAuthenticationService", () => {
  it("authenticates device ownership by challenge and returns a verifiable host response", () => {
    const now = 50_000;
    const store = new MemoryIdentityStore();
    const identity = new RemoteIdentityService(store, fakeCipher(), () => now);
    const { device, keys } = pairDevice(store, identity, () => now);
    const authentication = new RemoteAuthenticationService(
      store,
      identity,
      () => now,
      () => "challenge-01"
    );
    const { challenge } = authentication.createChallenge(device.id);
    const result = authentication.authenticate({
      deviceId: device.id,
      challenge,
      signature: keys.sign(challenge),
    });

    expect(result).toMatchObject({ authenticated: true, capabilities: device.capabilities });
    const success = result as Extract<RemoteAuthenticationResult, { authenticated: true }>;
    expect(
      verify(
        null,
        Buffer.from(challenge),
        identity.publicIdentity().publicKey,
        Buffer.from(success.hostSignature, "base64url")
      )
    ).toBe(true);
    expect(store.getDevice(device.id)?.lastSeenAt).toBe(now);
    expect(
      authentication.authenticate({
        deviceId: device.id,
        challenge,
        signature: keys.sign(challenge),
      })
    ).toEqual({ authenticated: false, reason: "unknown-challenge" });
  });

  it("rejects expired challenges and revoked devices", () => {
    let now = 1_000;
    const store = new MemoryIdentityStore();
    const identity = new RemoteIdentityService(store, fakeCipher(), () => now);
    const { device, keys } = pairDevice(store, identity, () => now);
    const authentication = new RemoteAuthenticationService(store, identity, () => now);
    const expired = authentication.createChallenge(device.id);
    now = expired.expiresAt;
    expect(
      authentication.authenticate({
        deviceId: device.id,
        challenge: expired.challenge,
        signature: keys.sign(expired.challenge),
      })
    ).toEqual({ authenticated: false, reason: "expired" });

    const revoked = { ...device, revokedAt: now, revocationReason: "Lost phone" };
    store.saveDevice(revoked);
    const next = authentication.createChallenge(device.id);
    expect(
      authentication.authenticate({
        deviceId: device.id,
        challenge: next.challenge,
        signature: keys.sign(next.challenge),
      })
    ).toEqual({ authenticated: false, reason: "revoked" });
  });

  it("rejects bad signatures and challenges issued for a different device", () => {
    const store = new MemoryIdentityStore();
    const identity = new RemoteIdentityService(store, fakeCipher());
    const { device } = pairDevice(store, identity, Date.now);
    const authentication = new RemoteAuthenticationService(store, identity);
    const badSignature = authentication.createChallenge(device.id);
    expect(
      authentication.authenticate({
        deviceId: device.id,
        challenge: badSignature.challenge,
        signature: "invalid",
      })
    ).toEqual({ authenticated: false, reason: "bad-signature" });

    const wrongOwner = authentication.createChallenge(device.id);
    expect(
      authentication.authenticate({
        deviceId: "different-device",
        challenge: wrongOwner.challenge,
        signature: "invalid",
      })
    ).toEqual({ authenticated: false, reason: "unknown-challenge" });
  });
});

describe("RemoteCapabilityService", () => {
  it("re-reads least-privilege grants so changes immediately affect live authorization", () => {
    const store = new MemoryIdentityStore();
    const identity = new RemoteIdentityService(store, fakeCipher());
    const { device } = pairDevice(store, identity, Date.now, ["observe-projects"]);
    const sessions: RemoteSessionPolicySink = {
      closeDeviceSessions: vi.fn(),
      deviceCapabilitiesChanged: vi.fn(),
    };
    const capabilities = new RemoteCapabilityService(store, identity, sessions);

    expect(capabilities.authorize(device.id, "observe-projects").allowed).toBe(true);
    for (const capability of REMOTE_CAPABILITIES.filter((item) => item !== "observe-projects")) {
      expect(capabilities.authorize(device.id, capability)).toEqual({
        allowed: false,
        reason: "capability-denied",
      });
    }

    capabilities.setCapabilities(device.id, ["prompt-agents"]);
    expect(capabilities.authorize(device.id, "observe-projects").allowed).toBe(false);
    expect(capabilities.authorize(device.id, "prompt-agents").allowed).toBe(true);
    expect(sessions.deviceCapabilitiesChanged).toHaveBeenCalledWith(device.id, ["prompt-agents"]);
  });

  it("closes live sessions before durably revoking and denies cross-host ownership", () => {
    const now = 90_000;
    const store = new MemoryIdentityStore();
    const identity = new RemoteIdentityService(store, fakeCipher(), () => now);
    const { device } = pairDevice(store, identity, () => now);
    const closeDeviceSessions = vi.fn((deviceId: string) => {
      expect(store.getDevice(deviceId)?.revokedAt).toBeNull();
    });
    const capabilities = new RemoteCapabilityService(
      store,
      identity,
      { closeDeviceSessions, deviceCapabilitiesChanged: vi.fn() },
      () => now
    );

    capabilities.revoke(device.id, "Lost phone");
    expect(closeDeviceSessions).toHaveBeenCalledOnce();
    expect(capabilities.authorize(device.id, "observe-projects")).toEqual({
      allowed: false,
      reason: "revoked",
    });

    const foreign = { ...device, id: "foreign-device", hostId: "host-foreign", revokedAt: null };
    store.saveDevice(foreign);
    expect(capabilities.authorize(foreign.id, "observe-projects")).toEqual({
      allowed: false,
      reason: "wrong-host",
    });
  });

  it("never grants remote host administration after pairing", () => {
    const store = new MemoryIdentityStore();
    const identity = new RemoteIdentityService(store, fakeCipher());
    const { device } = pairDevice(store, identity, Date.now);
    const capabilities = new RemoteCapabilityService(store, identity, {
      closeDeviceSessions: vi.fn(),
      deviceCapabilitiesChanged: vi.fn(),
    });

    expect(() => capabilities.setCapabilities(device.id, ["administer-host"])).toThrow(
      "cannot be granted"
    );
  });
});

describe("remote identity SQLite migration", () => {
  it("adds only versioned host and device persistence without replaying older migrations", () => {
    const migration = readFileSync(
      new URL("../../persistence/migrations/0011_flawless_emma_frost.sql", import.meta.url),
      "utf8"
    );
    const statements = migration
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);

    expect(
      statements.some((statement) => statement.startsWith("CREATE TABLE `remote_devices`"))
    ).toBe(true);
    expect(
      statements.some((statement) => statement.startsWith("CREATE TABLE `remote_host_identities`"))
    ).toBe(true);
    expect(migration).toContain("`schema_version` integer NOT NULL");
    expect(migration).toContain("`revoked_at` integer");
    expect(migration).not.toContain("ALTER TABLE `projects`");
    expect(migration).not.toContain("ALTER TABLE `scratches`");

    const tlsMigration = readFileSync(
      new URL("../../persistence/migrations/0012_previous_spitfire.sql", import.meta.url),
      "utf8"
    );
    expect(tlsMigration).toContain("CREATE TABLE `remote_tls_identities`");
    expect(tlsMigration).toContain("`encrypted_private_key` text NOT NULL");
  });
});
