import {
  addEpoch,
  importIdentity,
  RelayError,
  type Identity,
  type KeyStore,
  type RelayClient,
  type StoredIdentity,
} from "@daintreehq/decisions-client";
import { createEpochGrant, generateEpochKeyBytes, verifyDeviceCert } from "@daintreehq/decisions-crypto";
import type { DeviceInfo, DevicesResponse, EpochGrant } from "@daintreehq/decisions-protocol";

/**
 * What a staged epoch key was made for, sealed beside it in the identity. The
 * library stages a new key before the relay call and makes it current only
 * after, so the key alone survives a crash; this record says which operation
 * to finish with it.
 */
export interface PendingRotation {
  epoch: number;
  /** The device the rotation revokes; null for a rotation on its own. */
  revoke: string | null;
}

const PENDING_FIELD = "daintreePendingRotation";

type StoredWithPending = StoredIdentity & { [PENDING_FIELD]?: unknown };

/**
 * - `done`: the relay holds `epoch` and it is this computer's current key.
 *   `revoked` is the device it revoked, if any.
 * - `none`: nothing was pending.
 * - `superseded`: the relay's key moved past the pending one by another
 *   route, so it can't be sent; the key stays for reading what used it.
 * - `not-found`: the device to revoke isn't an active device on the relay.
 * - `unverified`: a remaining device's certificate doesn't verify against
 *   this computer's key, so nothing was sealed to it or sent.
 * - `conflict`: the relay kept refusing because its devices or key changed
 *   while this ran.
 * - `unconfirmed`: a request went out and no answer came back. The pending
 *   key is kept, and sent again until the relay holds it.
 * - `unsaved`: the relay took the rotation but the key couldn't be saved as
 *   current here. Still pending, so the next settle saves it.
 */
export type RotationOutcome =
  | { outcome: "done"; epoch: number; revoked: string | null }
  | { outcome: "none" }
  | { outcome: "superseded" }
  | { outcome: "not-found" }
  | { outcome: "unverified" }
  | { outcome: "conflict" }
  | { outcome: "unconfirmed"; error: RelayError }
  | { outcome: "unsaved"; error: unknown };

/** The lifetime ended: queued work is refused rather than run against closed keys. */
export class KeyRotationsClosedError extends Error {
  constructor() {
    super("Decisions has stopped, so its keys can't be rotated");
    this.name = "KeyRotationsClosedError";
  }
}

/** The keys are gone, or are an unfinished setup's: there's nothing to rotate. */
export class MissingKeysError extends Error {
  constructor() {
    super("Decisions has no keys to rotate");
    this.name = "MissingKeysError";
  }
}

class UnverifiedDeviceError extends Error {}

/** Sends a rotation again after the relay refused it as stale, at most this often. */
const MAX_SENDS = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The pending rotation the stored identity records, or null. A record that
 * doesn't name a staged key above the current one is ignored: there's no key
 * to send.
 */
export function pendingRotationOf(stored: StoredIdentity): PendingRotation | null {
  const value = (stored as StoredWithPending)[PENDING_FIELD];
  if (!isRecord(value)) return null;
  const { epoch, revoke } = value;
  if (!Number.isSafeInteger(epoch) || (epoch as number) <= stored.currentEpoch) return null;
  if (revoke !== null && (typeof revoke !== "string" || revoke.length === 0)) return null;
  if (!stored.epochs.some((entry) => entry.epoch === epoch)) return null;
  return { epoch: epoch as number, revoke };
}

function withoutPending(stored: StoredIdentity): StoredIdentity {
  const { [PENDING_FIELD]: _pending, ...rest } = stored as StoredWithPending;
  return rest;
}

function isActive(device: DeviceInfo): boolean {
  return device.revoked_at === null;
}

/**
 * Seals `raw` to every device, after checking each certificate the way the
 * library's own rotation does: issued by this owner for this installation and
 * device, never an owner, and signed by this computer's key. A key is never
 * sealed to a key the relay merely claims belongs to a device.
 */
async function sealTo(
  identity: Identity,
  devices: readonly DeviceInfo[],
  epoch: number,
  raw: Uint8Array
): Promise<EpochGrant[]> {
  for (const device of devices) {
    const cert = device.cert;
    const ok =
      cert.issuer_device_id === identity.config.deviceId &&
      cert.installation_id === identity.config.installationId &&
      cert.device_id === device.device_id &&
      cert.role === device.role &&
      cert.role !== "owner-desktop" &&
      (await verifyDeviceCert(cert, identity.keys.signing.publicKey).catch(() => false));
    if (!ok) throw new UnverifiedDeviceError();
  }
  const grants: EpochGrant[] = [];
  for (const device of devices) {
    grants.push(
      await createEpochGrant({
        issuerDeviceId: identity.config.deviceId,
        issuerSigningKey: identity.keys.signing.privateKey,
        installationId: identity.config.installationId,
        recipientDeviceId: device.device_id,
        recipientExchangePub: device.cert.exchange_pub,
        epoch,
        epochKeyRaw: raw,
      })
    );
  }
  return grants;
}

/** The devices a rotation seals its key to: every active one but owners and the one revoked. */
function recipients(list: DevicesResponse, revoke: string | null): DeviceInfo[] {
  return list.devices.filter(
    (device) => isActive(device) && device.role !== "owner-desktop" && device.device_id !== revoke
  );
}

/** The relay may or may not have acted on a request that drew this. */
function unanswered(error: unknown): error is RelayError {
  return (
    error instanceof RelayError &&
    (error.code === "network_error" || error.retryable || error.status >= 500)
  );
}

/** The relay refused the rotation as stale: its key or its devices moved since the read. */
function stale(error: unknown): boolean {
  return (
    error instanceof RelayError &&
    (error.code === "validation_error" ||
      error.code === "revision_conflict" ||
      error.code === "invalid_state" ||
      error.code === "not_found")
  );
}

/**
 * Revoking a device and rotating the content key (#16010), for one enabled
 * lifetime's keys. The library stages a new epoch key, seals it to every
 * remaining device, asks the relay to take it, and only then makes it
 * current; the relay takes a revocation, the new epoch and every grant in one
 * transaction. What can go wrong is local: a crash or a lost answer after the
 * relay took it would leave this computer sealing with the old key.
 *
 * So the staged key is saved with a record of what it is for, and it is never
 * thrown away once it might have been sent: until the relay holds its epoch,
 * every settle sends the same key again, sealed to the devices the relay
 * lists then. When the relay holds it, it becomes current. Nothing here makes
 * a second key for an epoch, so a request that lands late can only ever put
 * the pending key in force.
 *
 * Everything that reads or writes the identity's epochs runs one at a time
 * through `exclusive`: rotations, settles, the relay's own key events, and a
 * pairing approval, which seals the current key and so must not see one that
 * is about to change. This assumes one owner writes the relay's keys: another
 * computer restored from the same recovery kit could stage a different key
 * for the same epoch, and nothing local can tell which one the relay took.
 */
export class KeyRotations {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly keys: KeyStore) {}

  /** Runs `step` once everything queued before it has finished. Refused once closed. */
  exclusive<T>(step: () => Promise<T>): Promise<T> {
    const run = this.tail.then(() => {
      if (this.closed) throw new KeyRotationsClosedError();
      return step();
    });
    this.tail = run.catch(() => {});
    return run;
  }

  /** Refuses new work, and waits for what is running to finish. */
  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
  }

  /**
   * Finishes a rotation a crash or a lost answer left pending, and points
   * `client` at the keys as they stand afterwards. Throws what a relay read
   * threw, and for keys that are gone.
   */
  settle(client: RelayClient): Promise<RotationOutcome> {
    return this.exclusive(() => this.settleNow(client));
  }

  /**
   * Runs `step` alone, after settling any pending rotation, with `client` on
   * the keys as they then stand: a pairing approval seals the current key.
   * A pending rotation that can't be settled yet leaves the current key as it
   * is; only what the relay read threw stops `step`.
   */
  withCurrentKeys<T>(client: RelayClient, step: () => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      await this.settleNow(client);
      return step();
    });
  }

  /**
   * Revokes `revoke` (or nobody) and rotates the key, after settling any
   * rotation already pending. The client is pointed at the new keys.
   */
  rotate(client: RelayClient, revoke: string | null): Promise<RotationOutcome> {
    return this.exclusive(async () => {
      const settled = await this.settleNow(client);
      switch (settled.outcome) {
        case "done":
          // What was pending was this very request, finished now.
          if (settled.revoked === revoke) return settled;
          break;
        case "none":
        case "superseded":
          break;
        default:
          // A pending key that can't be settled yet is sent before any other.
          return settled;
      }
      return this.rotateNow(client, revoke);
    });
  }

  /**
   * The relay's ledger says it holds `epoch` (`device.key_rotated`, or the
   * epoch of a `device.revoked`). A pending key for exactly that epoch
   * becomes current, so the bridge that applies the event next reloads it.
   */
  confirm(epoch: number): Promise<boolean> {
    return this.exclusive(async () => {
      const stored = await this.keys.load();
      if (!stored || stored.claimed === false) return false;
      const pending = pendingRotationOf(stored);
      if (pending === null || pending.epoch !== epoch) return false;
      await this.promote(await importIdentity(stored), pending);
      return true;
    });
  }

  private async loadIdentity(): Promise<Identity> {
    const stored = await this.keys.load();
    if (!stored || stored.claimed === false) throw new MissingKeysError();
    return importIdentity(stored);
  }

  private async settleNow(client: RelayClient): Promise<RotationOutcome> {
    const identity = await this.loadIdentity();
    client.identity = identity;
    const pending = pendingRotationOf(identity.stored);
    if (pending === null) return { outcome: "none" };
    return this.send(client, identity, pending);
  }

  private async rotateNow(client: RelayClient, revoke: string | null): Promise<RotationOutcome> {
    const identity = await this.loadIdentity();
    client.identity = identity;
    const list = await client.devices();
    if (
      revoke !== null &&
      !list.devices.some(
        (device) =>
          device.device_id === revoke && isActive(device) && device.role !== "owner-desktop"
      )
    ) {
      return { outcome: "not-found" };
    }
    const epoch = list.key_epoch + 1;
    // A relay behind this computer would have the new key overwrite one that
    // was in force here, and with it the means to read what it sealed.
    if (epoch <= identity.currentEpoch) return { outcome: "conflict" };
    const raw = generateEpochKeyBytes();
    let grants: EpochGrant[];
    try {
      grants = await sealTo(identity, recipients(list, revoke), epoch, raw);
    } catch (error) {
      if (error instanceof UnverifiedDeviceError) return { outcome: "unverified" };
      throw error;
    }
    const pending: PendingRotation = { epoch, revoke };
    // The key and what it is for are saved in one write, before anything is sent.
    const staged = await addEpoch(
      this.keys,
      { ...identity, stored: { ...identity.stored, [PENDING_FIELD]: pending } as StoredIdentity },
      epoch,
      raw,
      { makeCurrent: false }
    );
    client.identity = staged;
    return this.send(client, staged, pending, { list, grants });
  }

  /**
   * Sends the pending key until the relay holds its epoch, refreshing the
   * device list and the grants whenever the relay refuses one as stale.
   */
  private async send(
    client: RelayClient,
    identity: Identity,
    pending: PendingRotation,
    first?: { list: DevicesResponse; grants: EpochGrant[] }
  ): Promise<RotationOutcome> {
    const raw = identity.epochs.get(pending.epoch)?.raw;
    if (!raw) return { outcome: "superseded" };
    let prepared = first;
    for (let sends = 0; ; sends += 1) {
      const list = prepared?.list ?? (await client.devices());
      if (list.key_epoch === pending.epoch) {
        return this.finish(client, identity, pending, list);
      }
      if (list.key_epoch !== pending.epoch - 1) {
        // The relay's key moved some other way: the pending one can't be
        // sent at an epoch the relay won't take. It stays as a past key.
        await this.keys.save(withoutPending(identity.stored));
        client.identity = await importIdentity(withoutPending(identity.stored));
        return { outcome: "superseded" };
      }
      if (sends >= MAX_SENDS) return { outcome: "conflict" };
      // A device revoked by another route since leaves just the rotation to do.
      const target =
        pending.revoke !== null &&
        list.devices.some((device) => device.device_id === pending.revoke && isActive(device))
          ? pending.revoke
          : null;
      let grants: EpochGrant[];
      if (prepared) {
        grants = prepared.grants;
      } else {
        try {
          grants = await sealTo(identity, recipients(list, target), pending.epoch, raw);
        } catch (error) {
          if (error instanceof UnverifiedDeviceError) return { outcome: "unverified" };
          throw error;
        }
      }
      prepared = undefined;
      try {
        if (target !== null) await client.revokeDevice(target, pending.epoch, grants);
        else await client.rotateEpoch(pending.epoch, grants);
      } catch (error) {
        if (unanswered(error)) return { outcome: "unconfirmed", error };
        if (stale(error)) continue;
        throw error;
      }
      return this.finish(client, identity, pending, null, target);
    }
  }

  /** The relay holds the pending epoch: make it current here and forget the record. */
  private async finish(
    client: RelayClient,
    identity: Identity,
    pending: PendingRotation,
    list: DevicesResponse | null,
    target: string | null = pending.revoke
  ): Promise<RotationOutcome> {
    let promoted: Identity;
    try {
      promoted = await this.promote(identity, pending);
    } catch (error) {
      return { outcome: "unsaved", error };
    }
    client.identity = promoted;
    // Read back from the relay, the device is revoked only if the list says so.
    const revoked =
      list === null
        ? target
        : target !== null &&
            list.devices.some((device) => device.device_id === target && !isActive(device))
          ? target
          : null;
    return { outcome: "done", epoch: pending.epoch, revoked };
  }

  private async promote(identity: Identity, pending: PendingRotation): Promise<Identity> {
    const raw = identity.epochs.get(pending.epoch)?.raw;
    if (!raw) throw new Error("The pending epoch key is missing");
    return addEpoch(
      this.keys,
      { ...identity, stored: withoutPending(identity.stored) },
      pending.epoch,
      raw,
      { makeCurrent: true }
    );
  }
}
