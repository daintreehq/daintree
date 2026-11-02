import {
  approveCandidate,
  createPairingInvite,
  importIdentity,
  localShortCode,
  RelayClient,
  RelayError,
  verifiedDevices,
} from "@daintreehq/decisions-client";
import type { PendingPairing } from "@daintreehq/decisions-protocol";
import type {
  ApproveDecisionsPairingPayload,
  DecisionsDevice,
  DecisionsDevicesResult,
  DecisionsKeyRotationProblem,
  DecisionsPairingApproveResult,
  DecisionsPairingDeclineResult,
  DecisionsPairingStartResult,
  DecisionsPairingState,
  DecisionsRelayRequestFailure,
  DecisionsRevokeDeviceResult,
  DecisionsRotateKeysResult,
} from "../../../shared/types/decisions.js";
import { normalizeRelayOrigin } from "./decisionsSettings.js";
import {
  KeyRotationsClosedError,
  MissingKeysError,
  type KeyRotations,
  type RotationOutcome,
} from "./keyRotation.js";
import type { SealedKeyStore } from "./keyStore.js";
import type { RelayFetch } from "./relayCheck.js";
import { keyStorageObservation, relayRequests, type RelayRequests } from "./relayIdentity.js";

const OWNER_ROLE = "owner-desktop";

/** The relay identity this computer is recorded as, from the setting. */
export interface OwnerRecord {
  relayOrigin: string;
  installationId: string;
  deviceId: string;
}

export interface OwnerDevicesOptions extends OwnerRecord {
  keys: Pick<SealedKeyStore, "load">;
  /** The lifetime's key rotations, which approvals queue behind (#16010). */
  rotations: KeyRotations;
  fetchImpl?: RelayFetch;
  timeoutMs?: number;
  now?: () => number;
}

interface OwnerSession {
  origin: string;
  client: RelayClient;
  requests: RelayRequests;
}

/** An invitation this computer made, and the phone that answered it, as last shown. */
interface HeldInvitation {
  expiresAt: number;
  candidate: PendingPairing | null;
  /** The code computed here from `candidate`'s keys: what the person was shown. */
  code: string | null;
  /**
   * An approval was sent for `candidate`. The relay may have taken it even
   * if its answer never came back, so the invitation is reconciled against
   * the device list, never just declared expired by the clock.
   */
  approvalSent: boolean;
}

function isFailure(
  value: OwnerSession | DecisionsRelayRequestFailure
): value is DecisionsRelayRequestFailure {
  return "result" in value;
}

/**
 * The owner's view of its paired devices and its pairing invitations (#16009),
 * for one recorded relay identity in one enabled lifetime. The identity is
 * opened from the sealed keys once and reused, so a pairing that polls the
 * relay asks the keychain once. `dispose` ends it: requests in flight are
 * aborted and every invitation is forgotten.
 *
 * Approval certifies only the keys whose code the person was shown: the code
 * is computed here from the keys the phone sent, never taken from the relay,
 * and an approval names the code it saw, so a different answer arriving
 * between the read and the click is never approved.
 */
export class OwnerDevices {
  private session: Promise<OwnerSession | DecisionsRelayRequestFailure> | null = null;
  private readonly invitations = new Map<string, HeldInvitation>();
  private readonly controller = new AbortController();
  private readonly now: () => number;

  constructor(private readonly options: OwnerDevicesOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Whether this was made for the identity the setting records now. */
  matches(record: OwnerRecord): boolean {
    return (
      normalizeRelayOrigin(record.relayOrigin) === normalizeRelayOrigin(this.options.relayOrigin) &&
      record.installationId === this.options.installationId &&
      record.deviceId === this.options.deviceId
    );
  }

  dispose(): void {
    this.controller.abort();
    this.invitations.clear();
    this.session = null;
  }

  /** The relay's devices whose certificates verify, without this computer or revoked ones. */
  async list(): Promise<DecisionsDevicesResult> {
    const session = await this.open();
    if (isFailure(session)) return session;
    let listed;
    try {
      listed = await verifiedDevices(session.client);
    } catch (error) {
      return this.failure(error, session);
    }
    const self = this.options.deviceId;
    const devices: DecisionsDevice[] = listed
      .filter((device) => device.device_id !== self && device.revoked_at === null)
      .map((device) => ({
        deviceId: device.device_id,
        // The certificate's label is the one the owner signed at pairing.
        label: device.cert.label,
        role: device.cert.role,
        pairedAt: device.created_at,
        lastSeenAt: device.last_seen_at,
        pushEnabled: device.push_enabled,
      }));
    return { result: "listed", devices };
  }

  /** A one-time invitation for a phone, held here until it is approved, declined or lapses. */
  async invite(): Promise<DecisionsPairingStartResult> {
    const session = await this.open();
    if (isFailure(session)) return session;
    let invitation;
    try {
      invitation = await createPairingInvite(session.client, "phone", this.now());
    } catch (error) {
      if (error instanceof RelayError) {
        if (error.code === "forbidden") return { result: "full" };
        if (error.code === "rate_limited") return { result: "busy" };
      }
      return this.failure(error, session);
    }
    this.forgetLapsed();
    this.invitations.set(invitation.pairingId, {
      expiresAt: invitation.expiresAt,
      candidate: null,
      code: null,
      approvalSent: false,
    });
    return {
      result: "started",
      invitation: {
        pairingId: invitation.pairingId,
        url: invitation.url,
        expiresAt: invitation.expiresAt,
      },
    };
  }

  /** Whether a phone has answered the invitation, and if so the code its keys give. */
  async read(pairingId: string): Promise<DecisionsPairingState> {
    const held = this.invitations.get(pairingId);
    if (!held) return { state: "unknown" };
    if (held.expiresAt <= this.now()) {
      if (!(held.approvalSent && held.candidate)) {
        this.invitations.delete(pairingId);
        return { state: "expired" };
      }
      // An approval sent before the deadline may have landed: ask the device list.
      const session = await this.open();
      if (isFailure(session)) return session;
      const settled = await this.settledAs(held.candidate, session);
      if (!("result" in settled)) this.invitations.delete(pairingId);
      return settled;
    }
    const session = await this.open();
    if (isFailure(session)) return session;
    let pending: PendingPairing[];
    try {
      ({ pending } = await session.client.pendingPairings());
    } catch (error) {
      return this.failure(error, session);
    }
    const candidate = pending.find((entry) => entry.pairing_id === pairingId);
    if (!candidate) {
      if (!held.candidate) return { state: "waiting", expiresAt: held.expiresAt };
      // Only this computer approves or declines an answer, so one the relay
      // no longer lists was approved by a request whose answer was lost, or
      // lapsed there. The device list says which.
      const settled = await this.settledAs(held.candidate, session);
      if (!("result" in settled)) this.invitations.delete(pairingId);
      return settled;
    }
    const code = await localShortCode(candidate, pairingId);
    held.candidate = candidate;
    held.code = code;
    return {
      state: "responded",
      expiresAt: held.expiresAt,
      code,
      label: candidate.label,
      role: candidate.role,
    };
  }

  /**
   * Approves the phone whose code the person compared, and only that one. The
   * approval seals the current key to it, so it waits for any rotation
   * running, and settles one left pending, before it reads which key that is.
   */
  async approve(payload: ApproveDecisionsPairingPayload): Promise<DecisionsPairingApproveResult> {
    const settled = this.approvable(payload);
    if (settled) return settled;
    const session = await this.open();
    if (isFailure(session)) return session;
    return this.queued(session, () =>
      this.options.rotations.withCurrentKeys(session.client, () =>
        this.approveNow(payload, session)
      )
    );
  }

  /** Why an approval can't go ahead from what this computer holds; null when it can. */
  private approvable(
    payload: ApproveDecisionsPairingPayload
  ): { result: "changed" } | { result: "expired" } | null {
    const held = this.invitations.get(payload.pairingId);
    if (!held?.candidate || held.code !== payload.code) return { result: "changed" };
    if (held.expiresAt <= this.now()) {
      this.invitations.delete(payload.pairingId);
      return { result: "expired" };
    }
    return null;
  }

  private async approveNow(
    payload: ApproveDecisionsPairingPayload,
    session: OwnerSession
  ): Promise<DecisionsPairingApproveResult> {
    // Read again: a decline, a newer answer or the deadline may have come while it queued.
    const settled = this.approvable(payload);
    if (settled) return settled;
    const held = this.invitations.get(payload.pairingId);
    if (!held?.candidate) return { result: "changed" };
    const candidate = held.candidate;
    // The relay's own code for these keys disagrees with the one computed
    // here: something between the phone and this computer changed them.
    if (candidate.short_code !== held.code) {
      this.invitations.delete(payload.pairingId);
      await session.client.rejectPairing(payload.pairingId).catch(() => {});
      return { result: "changed" };
    }
    held.approvalSent = true;
    try {
      await approveCandidate(session.client, candidate);
    } catch (error) {
      if (error instanceof RelayError) {
        switch (error.code) {
          case "expired":
            this.invitations.delete(payload.pairingId);
            return { result: "expired" };
          case "forbidden":
            return { result: "full" };
          case "invalid_state":
          case "not_found": {
            // Settled already: an earlier approval whose answer was lost may be what settled it.
            const settled = await this.settledAs(candidate, session);
            if ("result" in settled) return settled;
            this.invitations.delete(payload.pairingId);
            return settled.state === "paired"
              ? { result: "paired", label: settled.label }
              : { result: "changed" };
          }
          case "validation_error":
          case "revision_conflict":
            this.invitations.delete(payload.pairingId);
            return { result: "changed" };
        }
      }
      return this.failure(error, session);
    }
    this.invitations.delete(payload.pairingId);
    return { result: "paired", label: candidate.label };
  }

  /**
   * Rejects the invitation on the relay, answered or not, so neither the
   * phone that answered nor anyone holding the link can use it. An
   * invitation the relay has already settled or that lapsed is declined
   * already.
   */
  async decline(pairingId: string): Promise<DecisionsPairingDeclineResult> {
    const held = this.invitations.get(pairingId);
    this.invitations.delete(pairingId);
    if (!held || held.expiresAt <= this.now()) return { result: "declined" };
    const session = await this.open();
    if (isFailure(session)) return session;
    try {
      await session.client.rejectPairing(pairingId);
    } catch (error) {
      if (
        error instanceof RelayError &&
        (error.code === "not_found" || error.code === "invalid_state" || error.code === "expired")
      ) {
        return { result: "declined" };
      }
      return this.failure(error, session);
    }
    return { result: "declined" };
  }

  /**
   * Revokes a paired device and rotates the key for the devices that remain
   * (#16010). This computer is never revoked from here.
   */
  async revoke(deviceId: string): Promise<DecisionsRevokeDeviceResult> {
    if (deviceId === this.options.deviceId) return { result: "not-found" };
    const session = await this.open();
    if (isFailure(session)) return session;
    return this.queued(session, async () => {
      const outcome = await this.options.rotations.rotate(session.client, deviceId);
      // Done is revoked either way: a device revoked by another route since
      // the list was read leaves only the rotation, and it's gone all the same.
      if (outcome.outcome === "done") return { result: "revoked", keyEpoch: outcome.epoch };
      if (outcome.outcome === "not-found") return { result: "not-found" };
      return this.unfinished(outcome, session);
    });
  }

  /** Rotates the key without revoking anyone. */
  async rotate(): Promise<DecisionsRotateKeysResult> {
    const session = await this.open();
    if (isFailure(session)) return session;
    return this.queued(session, async () => {
      const outcome = await this.options.rotations.rotate(session.client, null);
      if (outcome.outcome === "done") return { result: "rotated", keyEpoch: outcome.epoch };
      return this.unfinished(outcome, session);
    });
  }

  /**
   * Runs a call that takes its turn among the lifetime's rotations. What
   * stopped it is an observation, as for any signed request.
   */
  private async queued<T>(
    session: OwnerSession,
    call: () => Promise<T>
  ): Promise<T | DecisionsRelayRequestFailure> {
    try {
      return await call();
    } catch (error) {
      const observation = keyStorageObservation(error);
      if (observation) return observation;
      if (error instanceof KeyRotationsClosedError || error instanceof MissingKeysError) {
        return { result: "not-set-up" };
      }
      return this.failure(error, session);
    }
  }

  private unfinished(
    outcome: Exclude<RotationOutcome, { outcome: "done" }>,
    session: OwnerSession
  ): DecisionsKeyRotationProblem {
    switch (outcome.outcome) {
      case "unconfirmed":
        return { result: "unconfirmed", origin: session.origin };
      case "unsaved":
        return {
          result: "unsaved",
          reason:
            keyStorageObservation(outcome.error)?.reason ?? "The key file couldn't be written",
        };
      case "unverified":
        return { result: "unverified" };
      case "conflict":
      case "superseded":
      case "not-found":
      case "none":
        return { result: "conflict" };
    }
  }

  /**
   * What became of an answer the relay no longer holds open: `paired` if the
   * phone with those keys is now one of its devices, `expired` otherwise.
   */
  private async settledAs(
    candidate: PendingPairing,
    session: OwnerSession
  ): Promise<
    { state: "paired"; label: string } | { state: "expired" } | DecisionsRelayRequestFailure
  > {
    let listed;
    try {
      listed = await verifiedDevices(session.client);
    } catch (error) {
      return this.failure(error, session);
    }
    const device = listed.find(
      (entry) =>
        entry.device_id === candidate.device_id &&
        entry.revoked_at === null &&
        entry.cert.signing_pub === candidate.signing_pub &&
        entry.cert.exchange_pub === candidate.exchange_pub
    );
    return device ? { state: "paired", label: device.cert.label } : { state: "expired" };
  }

  private forgetLapsed(): void {
    const now = this.now();
    for (const [id, held] of this.invitations) {
      if (held.expiresAt <= now) this.invitations.delete(id);
    }
  }

  private open(): Promise<OwnerSession | DecisionsRelayRequestFailure> {
    const opening = (this.session ??= this.openSession());
    // A failure is asked again next time: the keychain may unlock, the file may appear.
    void opening.then((value) => {
      if (isFailure(value) && this.session === opening) this.session = null;
    });
    return opening;
  }

  private async openSession(): Promise<OwnerSession | DecisionsRelayRequestFailure> {
    let stored;
    try {
      stored = await this.options.keys.load();
    } catch (error) {
      const observation = keyStorageObservation(error);
      if (observation) return observation;
      throw error;
    }
    const origin = normalizeRelayOrigin(this.options.relayOrigin);
    if (
      origin === null ||
      !stored ||
      stored.claimed === false ||
      (stored.role ?? OWNER_ROLE) !== OWNER_ROLE ||
      normalizeRelayOrigin(stored.config.relayOrigin) !== origin ||
      stored.config.installationId !== this.options.installationId ||
      stored.config.deviceId !== this.options.deviceId
    ) {
      return { result: "not-set-up" };
    }
    let identity;
    try {
      identity = await importIdentity(stored);
    } catch {
      return { result: "not-set-up" };
    }
    const requests = await relayRequests(origin, {
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
      signal: this.controller.signal,
    });
    return {
      origin,
      requests,
      client: new RelayClient({ identity, fetch: requests.fetch, maxRetries: 0 }),
    };
  }

  /** What stopped a signed request, as an observation; anything unforeseen is thrown. */
  private failure(error: unknown, session: OwnerSession): DecisionsRelayRequestFailure {
    const { origin } = session;
    if (error instanceof RelayError) {
      if (error.code === "network_error") {
        const reason = session.requests.lastFailure()?.reason ?? "network";
        return { result: "unreachable", origin, reason };
      }
      if (error.code === "not_authenticated") {
        return { result: "refused", origin, reason: "not-recognised" };
      }
      if (error.code === "rate_limited" || error.status === 429) {
        return { result: "refused", origin, reason: "rate-limited" };
      }
      if (error.retryable || error.status >= 500) {
        return { result: "unreachable", origin, reason: "server-error" };
      }
    }
    // A success whose body didn't parse: the relay answered, but not as one.
    if (error instanceof SyntaxError)
      return { result: "unreachable", origin, reason: "server-error" };
    throw error;
  }
}
