import { randomBytes, verify } from "node:crypto";
import type { RemoteCapability } from "../../../shared/types/remote/index.js";
import type { RemoteIdentityStore } from "./RemoteIdentityStore.js";
import type { RemoteIdentityService } from "./RemoteIdentityService.js";

const AUTH_CHALLENGE_TTL_MS = 60_000;

interface PendingChallenge {
  deviceId: string;
  expiresAt: number;
}

export type RemoteAuthenticationResult =
  | {
      authenticated: true;
      deviceId: string;
      capabilities: RemoteCapability[];
      hostSignature: string;
    }
  | {
      authenticated: false;
      reason:
        "unknown-challenge" | "expired" | "not-found" | "wrong-host" | "revoked" | "bad-signature";
    };

export class RemoteAuthenticationService {
  private readonly challenges = new Map<string, PendingChallenge>();
  private readonly clientChallenges = new Map<string, number>();

  constructor(
    private readonly store: RemoteIdentityStore,
    private readonly identity: RemoteIdentityService,
    private readonly now: () => number = Date.now,
    private readonly randomChallenge: () => string = () => randomBytes(32).toString("base64url")
  ) {}

  createChallenge(deviceId: string): { challenge: string; expiresAt: number } {
    const challenge = this.randomChallenge();
    const expiresAt = this.now() + AUTH_CHALLENGE_TTL_MS;
    this.challenges.set(challenge, { deviceId, expiresAt });
    return { challenge, expiresAt };
  }

  authenticate(input: {
    deviceId: string;
    challenge: string;
    signature: string;
  }): RemoteAuthenticationResult {
    const pending = this.challenges.get(input.challenge);
    this.challenges.delete(input.challenge);
    if (!pending || pending.deviceId !== input.deviceId) {
      return { authenticated: false, reason: "unknown-challenge" };
    }
    if (this.now() >= pending.expiresAt) return { authenticated: false, reason: "expired" };

    const device = this.store.getDevice(input.deviceId);
    if (!device) return { authenticated: false, reason: "not-found" };
    if (device.hostId !== this.identity.publicIdentity().hostId) {
      return { authenticated: false, reason: "wrong-host" };
    }
    if (device.revokedAt !== null) return { authenticated: false, reason: "revoked" };

    let signatureValid: boolean;
    try {
      signatureValid = verify(
        null,
        Buffer.from(input.challenge, "utf8"),
        device.publicKey,
        Buffer.from(input.signature, "base64url")
      );
    } catch {
      return { authenticated: false, reason: "bad-signature" };
    }
    if (!signatureValid) return { authenticated: false, reason: "bad-signature" };

    const updated = { ...device, lastSeenAt: this.now() };
    this.store.saveDevice(updated);
    return {
      authenticated: true,
      deviceId: device.id,
      capabilities: updated.capabilities,
      hostSignature: this.identity.signChallenge(input.challenge),
    };
  }

  authenticateClientChallenge(input: {
    deviceId: string;
    challenge: string;
    signature: string;
  }): RemoteAuthenticationResult {
    this.pruneClientChallenges();
    const replayKey = `${input.deviceId}:${input.challenge}`;
    if (this.clientChallenges.has(replayKey)) {
      return { authenticated: false, reason: "unknown-challenge" };
    }

    const device = this.store.getDevice(input.deviceId);
    if (!device) return { authenticated: false, reason: "not-found" };
    if (device.hostId !== this.identity.publicIdentity().hostId) {
      return { authenticated: false, reason: "wrong-host" };
    }
    if (device.revokedAt !== null) return { authenticated: false, reason: "revoked" };
    if (!this.verifySignature(input.challenge, input.signature, device.publicKey)) {
      return { authenticated: false, reason: "bad-signature" };
    }

    this.clientChallenges.set(replayKey, this.now() + AUTH_CHALLENGE_TTL_MS);
    const updated = { ...device, lastSeenAt: this.now() };
    this.store.saveDevice(updated);
    return {
      authenticated: true,
      deviceId: device.id,
      capabilities: updated.capabilities,
      hostSignature: this.identity.signChallenge(input.challenge),
    };
  }

  clear(): void {
    this.challenges.clear();
    this.clientChallenges.clear();
  }

  private verifySignature(challenge: string, signature: string, publicKey: string): boolean {
    try {
      return verify(
        null,
        Buffer.from(challenge, "utf8"),
        publicKey,
        Buffer.from(signature, "base64url")
      );
    } catch {
      return false;
    }
  }

  private pruneClientChallenges(): void {
    const now = this.now();
    for (const [key, expiresAt] of this.clientChallenges) {
      if (now >= expiresAt) this.clientChallenges.delete(key);
    }
  }
}
