import {
  exportRecoveryKit,
  importIdentity,
  type StoredIdentity,
} from "@daintreehq/decisions-client";
import type {
  DecisionsConnectResult,
  DecisionsKitCheckRefusal,
  DecisionsKitCoverage,
  DecisionsKitIdentityProblem,
  DecisionsRecoveryKitRecord,
  DecisionsSettings,
} from "../../../shared/types/decisions.js";
import { normalizeRelayOrigin } from "./decisionsSettings.js";
import type { SealedKeyStore } from "./keyStore.js";
import {
  MAX_RECOVERY_KIT_BYTES,
  coverageHolds,
  isOwner,
  keyCall,
  keysWork,
  kitCoverage,
  kitCovers,
  openRecoveryKit,
  sameIdentity,
  usable,
} from "./relayIdentity.js";

/** The relay and ids a kit is made for and checked against, as the setting records them. */
export interface RecordedIdentity {
  relayOrigin: string;
  installationId: string;
  deviceId: string;
}

/** An owner identity's relay, ids and epochs, as its sealed keys were last read or written (#18063). */
export interface ObservedOwnerKeys extends RecordedIdentity {
  coverage: DecisionsKitCoverage;
}

/** What stops a kit being made or checked before the kit itself is looked at. */
export type KitFailure =
  | { result: "no-identity"; reason: DecisionsKitIdentityProblem }
  | Extract<DecisionsConnectResult, { result: "key-storage" }>;

/** What sealed keys say about a kit's coverage: an owner's relay, ids and epochs; null for anything else. */
export function observedOwnerKeys(stored: StoredIdentity | null): ObservedOwnerKeys | null {
  if (!stored || stored.claimed === false || !isOwner(stored)) return null;
  const relayOrigin = normalizeRelayOrigin(stored.config.relayOrigin);
  if (relayOrigin === null) return null;
  return {
    relayOrigin,
    installationId: stored.config.installationId,
    deviceId: stored.config.deviceId,
    coverage: kitCoverage(stored),
  };
}

/** Two observations of owner keys name the same identity holding the same keys. */
export function sameOwnerKeys(
  a: ObservedOwnerKeys | null | undefined,
  b: ObservedOwnerKeys | null | undefined
): boolean {
  if (!a || !b) return (a ?? null) === (b ?? null);
  return (
    observes(a, b) &&
    a.coverage.epochs.length === b.coverage.epochs.length &&
    coverageHolds(a.coverage, b.coverage)
  );
}

/**
 * A kit verification as it stands against the owner keys last seen (#18063),
 * `before` being what the same key store saw just before them: marked out of
 * date once they hold a key the kit lacks or another current epoch. A
 * verification recorded before kits' epochs were held every key the keys
 * held then, and keys only ever gain epochs, so keys still on their one
 * epoch are what it covered, and keys seen to change since this run first
 * read them have moved past it; anything else can't be told from here.
 * Returns `record` itself when nothing changes.
 */
export function reconciledKit(
  record: DecisionsRecoveryKitRecord | null,
  observed: ObservedOwnerKeys | null,
  before: ObservedOwnerKeys | null = null
): DecisionsRecoveryKitRecord | null {
  if (record === null || record.outOfDate || !observes(observed, record)) return record;
  const held = observed.coverage;
  if (!record.coverage) {
    // Only an earlier build records a verification without epochs, so this run's reads all came after it.
    if (observes(before, record) && !coverageHolds(before.coverage, held)) {
      return { ...record, outOfDate: true };
    }
    const firstOnly = held.epochs.length === 1 && held.epochs[0]!.epoch === held.currentEpoch;
    return firstOnly ? { ...record, coverage: held } : record;
  }
  return coverageHolds(record.coverage, held) ? record : { ...record, outOfDate: true };
}

/**
 * How a verification stands against the owner keys read this run, for the
 * status: `current` only once keys read now are ones the kit holds, since a
 * mismatch whose recording failed is caught only by reading them again.
 */
export function kitStanding(
  record: DecisionsRecoveryKitRecord,
  observed: ObservedOwnerKeys | null
): "current" | "out-of-date" | "unknown" {
  const kit = reconciledKit(record, observed) ?? record;
  if (kit.outOfDate) return "out-of-date";
  return kit.coverage && observes(observed, kit) ? "current" : "unknown";
}

function observes(
  observed: ObservedOwnerKeys | null,
  record: RecordedIdentity
): observed is ObservedOwnerKeys {
  return (
    observed !== null &&
    observed.relayOrigin === record.relayOrigin &&
    observed.installationId === record.installationId &&
    observed.deviceId === record.deviceId
  );
}

/** The relay and ids the setting records; null until a relay is set up. */
export function recordedIdentity(settings: DecisionsSettings): RecordedIdentity | null {
  const { relayOrigin, installationId, deviceId } = settings;
  if (relayOrigin === null || installationId === null || deviceId === null) return null;
  return { relayOrigin, installationId, deviceId };
}

/**
 * The sealed identity the setting records, read from the key store: a
 * confirmed owner for the recorded relay and ids, whose keys work. Loading
 * may ask the keychain, so only what the person started calls this.
 */
async function sealedIdentity(
  keys: Pick<SealedKeyStore, "load">,
  settings: DecisionsSettings
): Promise<{ recorded: RecordedIdentity; stored: StoredIdentity } | { failure: KitFailure }> {
  const recorded = recordedIdentity(settings);
  if (!recorded) return { failure: { result: "no-identity", reason: "not-set-up" } };
  const loaded = await keyCall(() => keys.load());
  if ("failure" in loaded) {
    // keyCall turns only the key store's own refusals into an observation.
    if (loaded.failure.result !== "key-storage") throw new Error("Unexpected key store failure");
    return { failure: loaded.failure };
  }
  const stored = loaded.value;
  if (!stored) return { failure: { result: "no-identity", reason: "keys-missing" } };
  const matches =
    stored.claimed !== false &&
    isOwner(stored) &&
    normalizeRelayOrigin(stored.config.relayOrigin) === recorded.relayOrigin &&
    stored.config.installationId === recorded.installationId &&
    stored.config.deviceId === recorded.deviceId;
  if (!matches || !(await usable(stored))) {
    return { failure: { result: "no-identity", reason: "keys-mismatch" } };
  }
  return { recorded, stored };
}

/**
 * This computer's identity as a recovery kit file, locked with the
 * passphrase, in the library's own format, so the `decisions` CLI reads it
 * too. Only the encrypted file comes back; the passphrase goes no further.
 */
export async function makeRecoveryKit(
  keys: Pick<SealedKeyStore, "load">,
  settings: DecisionsSettings,
  passphrase: string
): Promise<{ recorded: RecordedIdentity; text: string } | { failure: KitFailure }> {
  const sealed = await sealedIdentity(keys, settings);
  if ("failure" in sealed) return sealed;
  const { stored } = sealed;
  const refuse = async () => {
    throw new Error("A recovery kit export never writes keys");
  };
  const file = await exportRecoveryKit(
    { load: async () => stored, save: refuse, clear: refuse },
    passphrase
  );
  const text = `${JSON.stringify(file, null, 2)}\n`;
  // Restore and verify refuse a bigger file, so one this big could never be used.
  if (Buffer.byteLength(text, "utf8") > MAX_RECOVERY_KIT_BYTES) {
    throw new Error("This identity is too large for a recovery kit");
  }
  return { recorded: sealed.recorded, text };
}

/**
 * Checks a kit file against the identity sealed here: it opens with the
 * passphrase, holds a confirmed owner identity whose keys work, that
 * identity is this computer's (relay, ids, signing and exchange keys), and
 * it holds every epoch key sealed here, byte for byte. Nothing is installed
 * or recorded; the caller records a pass with the epochs it was proven to hold.
 */
export async function checkRecoveryKit(
  keys: Pick<SealedKeyStore, "load">,
  settings: DecisionsSettings,
  kit: string,
  passphrase: string
): Promise<
  | { verified: RecordedIdentity; coverage: DecisionsKitCoverage }
  | { failure: KitFailure | { result: "kit-refused"; reason: DecisionsKitCheckRefusal } }
> {
  const refuse = (reason: DecisionsKitCheckRefusal) => ({
    failure: { result: "kit-refused" as const, reason },
  });
  const opened = await openRecoveryKit(kit, passphrase);
  if ("refusal" in opened) return refuse(opened.refusal);
  const candidate = opened.identity;
  try {
    if (!(await keysWork(await importIdentity(candidate)))) return refuse("not-a-kit");
  } catch {
    return refuse("not-a-kit");
  }
  const sealed = await sealedIdentity(keys, settings);
  if ("failure" in sealed) return sealed;
  if (!sameIdentity(candidate, sealed.stored)) return refuse("another-identity");
  if (!kitCovers(candidate, sealed.stored)) return refuse("missing-epochs");
  return { verified: sealed.recorded, coverage: kitCoverage(sealed.stored) };
}
