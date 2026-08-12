import { createHash, randomBytes, randomUUID, timingSafeEqual, verify } from "node:crypto";
import type {
  RemoteCapability,
  RemotePairedDevice,
  RemotePairingBootstrap,
} from "../../../shared/types/remote/index.js";
import {
  REMOTE_PROTOCOL_VERSION,
  RemoteCapabilitiesSchema,
  RemotePairingBootstrapSchema,
  RemotePairedDeviceSchema,
} from "../../../shared/types/remote/index.js";
import type { RemoteIdentityStore } from "./RemoteIdentityStore.js";
import type { RemoteIdentityService } from "./RemoteIdentityService.js";
import type { RemoteAuditService } from "./RemoteAuditService.js";

const PAIRING_WINDOW_MS = 5 * 60 * 1000;
const MAX_PAIRING_ATTEMPTS = 5;

interface PendingPairing {
  secretDigest: Buffer;
  expiresAt: number;
  attemptsRemaining: number;
  expiryTimer: ReturnType<typeof setTimeout>;
  verificationCode: string;
  candidate: PendingPairingCandidate | null;
}

export interface PendingPairingCandidate {
  pairingId: string;
  deviceId: string;
  displayName: string;
  platform: "ios" | "android";
  publicKey: string;
  verificationCode: string;
  state: "verification-required" | "awaiting-approval";
}

export interface BeginPairingRequestInput {
  pairingId: string;
  oneTimeSecret: string;
  deviceId: string;
  displayName: string;
  platform: "ios" | "android";
  publicKey: string;
}

export interface RemoteTlsFingerprintProvider {
  certificateFingerprint(): string;
}

export interface CompletePairingInput {
  pairingId: string;
  oneTimeSecret: string;
  deviceId: string;
  displayName: string;
  platform: "ios" | "android";
  publicKey: string;
  deviceProof: string;
  grantedCapabilities: RemoteCapability[];
}

function digestSecret(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function pairingProofMessage(input: CompletePairingInput): string {
  return `${input.pairingId}.${input.oneTimeSecret}.${input.deviceId}`;
}

function stagedPairingProofMessage(candidate: PendingPairingCandidate): string {
  return `${candidate.pairingId}.${candidate.deviceId}.${candidate.verificationCode}`;
}

function verificationCode(pairingId: string, secret: string): string {
  const value = createHash("sha256").update(`${pairingId}.${secret}`).digest().readUInt32BE(0);
  return String(value % 1_000_000).padStart(6, "0");
}

export class RemotePairingService {
  private readonly pending = new Map<string, PendingPairing>();
  private audit: RemoteAuditService | null = null;

  constructor(
    private readonly store: RemoteIdentityStore,
    private readonly identity: RemoteIdentityService,
    private readonly tlsIdentity: RemoteTlsFingerprintProvider,
    private readonly now: () => number = Date.now,
    private readonly randomSecret: () => string = () => randomBytes(32).toString("base64url"),
    private readonly scheduleExpiry: (
      callback: () => void,
      delayMs: number
    ) => ReturnType<typeof setTimeout> = setTimeout,
    private readonly cancelExpiry: (timer: ReturnType<typeof setTimeout>) => void = clearTimeout
  ) {}

  setAuditService(audit: RemoteAuditService): void {
    this.audit = audit;
  }

  beginPairing(input: { endpointHints: string[] }): RemotePairingBootstrap {
    const pairingId = randomUUID();
    const oneTimeSecret = this.randomSecret();
    const expiresAt = this.now() + PAIRING_WINDOW_MS;
    const expiryTimer = this.scheduleExpiry(
      () => this.destroyPairing(pairingId),
      PAIRING_WINDOW_MS
    );
    if (typeof expiryTimer === "object" && "unref" in expiryTimer) expiryTimer.unref();
    this.pending.set(pairingId, {
      secretDigest: digestSecret(oneTimeSecret),
      expiresAt,
      attemptsRemaining: MAX_PAIRING_ATTEMPTS,
      expiryTimer,
      verificationCode: verificationCode(pairingId, oneTimeSecret),
      candidate: null,
    });
    return RemotePairingBootstrapSchema.parse({
      pairingId,
      oneTimeSecret,
      expiresAt,
      host: this.identity.publicIdentity(),
      tlsCertificateFingerprint: this.tlsIdentity.certificateFingerprint(),
      endpointHints: input.endpointHints,
      protocol: { min: REMOTE_PROTOCOL_VERSION, max: REMOTE_PROTOCOL_VERSION },
      verificationCode: verificationCode(pairingId, oneTimeSecret),
    });
  }

  beginPairingRequest(input: BeginPairingRequestInput): PendingPairingCandidate {
    const pending = this.requirePending(input.pairingId, input.oneTimeSecret);
    if (pending.candidate) {
      const existing = pending.candidate;
      if (
        existing.deviceId === input.deviceId &&
        existing.displayName === input.displayName &&
        existing.platform === input.platform &&
        existing.publicKey === input.publicKey
      ) {
        return structuredClone(existing);
      }
      throw new Error("Pairing window already has a device candidate");
    }
    try {
      this.assertDeviceMayPair(input.deviceId, input.publicKey);
    } catch (error) {
      this.destroyPairing(input.pairingId);
      throw error;
    }
    const candidate: PendingPairingCandidate = {
      pairingId: input.pairingId,
      deviceId: input.deviceId,
      displayName: input.displayName,
      platform: input.platform,
      publicKey: input.publicKey,
      verificationCode: pending.verificationCode,
      state: "verification-required",
    };
    pending.candidate = candidate;
    this.audit?.record({
      actorDeviceId: input.deviceId,
      operation: "pairing.attempt",
      result: "started",
    });
    return structuredClone(candidate);
  }

  verifyPairingRequest(pairingId: string, deviceProof: string): PendingPairingCandidate {
    const pending = this.pending.get(pairingId);
    const candidate = pending?.candidate;
    if (!pending || !candidate || this.now() >= pending.expiresAt) {
      if (pending) this.destroyPairing(pairingId);
      throw new Error("Pairing request is unavailable or expired");
    }
    if (!this.verifyProof(stagedPairingProofMessage(candidate), deviceProof, candidate.publicKey)) {
      pending.attemptsRemaining -= 1;
      if (pending.attemptsRemaining <= 0) this.destroyPairing(pairingId);
      throw new Error("Device pairing proof is invalid");
    }
    candidate.state = "awaiting-approval";
    return structuredClone(candidate);
  }

  pendingApprovals(): PendingPairingCandidate[] {
    return [...this.pending.values()]
      .map((entry) => entry.candidate)
      .filter(
        (candidate): candidate is PendingPairingCandidate =>
          candidate?.state === "awaiting-approval"
      )
      .map((candidate) => structuredClone(candidate));
  }

  approvePairing(pairingId: string, grantedCapabilities: RemoteCapability[]): RemotePairedDevice {
    const pending = this.pending.get(pairingId);
    const candidate = pending?.candidate;
    if (pending && this.now() >= pending.expiresAt) {
      this.destroyPairing(pairingId);
      throw new Error("Pairing request has expired");
    }
    if (!pending || !candidate || candidate.state !== "awaiting-approval") {
      throw new Error("Pairing request is not awaiting approval");
    }
    const capabilities = RemoteCapabilitiesSchema.parse(grantedCapabilities);
    if (capabilities.includes("administer-host")) {
      throw new Error("Host administration cannot be granted remotely");
    }
    const existing = this.store.getDevice(candidate.deviceId);
    const reauthorization =
      existing !== null &&
      existing.revokedAt !== null &&
      existing.publicKey === candidate.publicKey;
    const device = RemotePairedDeviceSchema.parse({
      id: candidate.deviceId,
      hostId: this.identity.publicIdentity().hostId,
      displayName: reauthorization ? existing!.displayName : candidate.displayName,
      platform: candidate.platform,
      publicKey: candidate.publicKey,
      capabilities: [...new Set(capabilities)],
      createdAt: reauthorization ? existing!.createdAt : this.now(),
      lastSeenAt: null,
      revokedAt: null,
      revocationReason: null,
    });
    this.store.saveDevice(device);
    this.destroyPairing(pairingId);
    this.audit?.record({
      actorDeviceId: device.id,
      operation: "pairing.result",
      result: "accepted",
    });
    return device;
  }

  rejectPairing(pairingId: string): void {
    const deviceId = this.pending.get(pairingId)?.candidate?.deviceId;
    this.destroyPairing(pairingId);
    this.audit?.record({
      actorDeviceId: deviceId,
      operation: "pairing.result",
      result: "rejected",
    });
  }

  completePairing(input: CompletePairingInput): RemotePairedDevice {
    this.audit?.record({
      actorDeviceId: input.deviceId,
      operation: "pairing.attempt",
      result: "started",
    });
    try {
      const device = this.performCompletePairing(input);
      this.audit?.record({
        actorDeviceId: input.deviceId,
        operation: "pairing.result",
        result: "accepted",
      });
      return device;
    } catch (error) {
      this.audit?.record({
        actorDeviceId: input.deviceId,
        operation: "pairing.result",
        result: "rejected",
      });
      throw error;
    }
  }

  private performCompletePairing(input: CompletePairingInput): RemotePairedDevice {
    const pending = this.pending.get(input.pairingId);
    if (!pending) throw new Error("Pairing window is unavailable or already used");
    if (this.now() >= pending.expiresAt) {
      this.destroyPairing(input.pairingId);
      throw new Error("Pairing window has expired");
    }

    const provided = digestSecret(input.oneTimeSecret);
    pending.attemptsRemaining -= 1;
    if (!timingSafeEqual(provided, pending.secretDigest)) {
      if (pending.attemptsRemaining <= 0) this.destroyPairing(input.pairingId);
      throw new Error("Pairing material is invalid");
    }

    let proofValid: boolean;
    try {
      proofValid = verify(
        null,
        Buffer.from(pairingProofMessage(input), "utf8"),
        input.publicKey,
        Buffer.from(input.deviceProof, "base64url")
      );
    } catch {
      proofValid = false;
    }
    if (!proofValid) {
      if (pending.attemptsRemaining <= 0) this.destroyPairing(input.pairingId);
      throw new Error("Device pairing proof is invalid");
    }

    const capabilities = RemoteCapabilitiesSchema.parse(input.grantedCapabilities);
    if (capabilities.includes("administer-host")) {
      this.destroyPairing(input.pairingId);
      throw new Error("Host administration cannot be granted remotely");
    }
    try {
      this.assertDeviceMayPair(input.deviceId, input.publicKey);
    } catch (error) {
      this.destroyPairing(input.pairingId);
      throw error;
    }
    const existing = this.store.getDevice(input.deviceId);
    const reauthorization =
      existing !== null && existing.revokedAt !== null && existing.publicKey === input.publicKey;

    const device = RemotePairedDeviceSchema.parse({
      id: input.deviceId,
      hostId: this.identity.publicIdentity().hostId,
      displayName: reauthorization ? existing!.displayName : input.displayName,
      platform: input.platform,
      publicKey: input.publicKey,
      capabilities: [...new Set(capabilities)],
      createdAt: reauthorization ? existing!.createdAt : this.now(),
      lastSeenAt: null,
      revokedAt: null,
      revocationReason: null,
    });
    this.store.saveDevice(device);
    this.destroyPairing(input.pairingId);
    return device;
  }

  cancelAll(): void {
    for (const pairingId of this.pending.keys()) this.destroyPairing(pairingId);
  }

  activePairingCount(): number {
    return this.pending.size;
  }

  private requirePending(pairingId: string, oneTimeSecret: string): PendingPairing {
    const pending = this.pending.get(pairingId);
    if (!pending) throw new Error("Pairing window is unavailable or already used");
    if (this.now() >= pending.expiresAt) {
      this.destroyPairing(pairingId);
      throw new Error("Pairing window has expired");
    }
    if (!timingSafeEqual(digestSecret(oneTimeSecret), pending.secretDigest)) {
      pending.attemptsRemaining -= 1;
      if (pending.attemptsRemaining <= 0) this.destroyPairing(pairingId);
      throw new Error("Pairing material is invalid");
    }
    return pending;
  }

  private verifyProof(message: string, signature: string, publicKey: string): boolean {
    try {
      return verify(
        null,
        Buffer.from(message, "utf8"),
        publicKey,
        Buffer.from(signature, "base64url")
      );
    } catch {
      return false;
    }
  }

  private assertDeviceMayPair(deviceId: string, publicKey: string): void {
    const existing = this.store.getDevice(deviceId);
    if (!existing) return;
    if (existing.revokedAt !== null && existing.publicKey === publicKey) return;
    throw new Error("Device identity is already paired");
  }

  private destroyPairing(pairingId: string): void {
    const pending = this.pending.get(pairingId);
    if (!pending) return;
    this.cancelExpiry(pending.expiryTimer);
    pending.secretDigest.fill(0);
    this.pending.delete(pairingId);
  }
}
