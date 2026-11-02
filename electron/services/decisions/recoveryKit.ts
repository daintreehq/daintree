import {
  exportRecoveryKit,
  importIdentity,
  type StoredIdentity,
} from "@daintreehq/decisions-client";
import type {
  DecisionsConnectResult,
  DecisionsKitCheckRefusal,
  DecisionsKitIdentityProblem,
  DecisionsSettings,
} from "../../../shared/types/decisions.js";
import { normalizeRelayOrigin } from "./decisionsSettings.js";
import type { SealedKeyStore } from "./keyStore.js";
import {
  MAX_RECOVERY_KIT_BYTES,
  isOwner,
  keyCall,
  keysWork,
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

/** What stops a kit being made or checked before the kit itself is looked at. */
export type KitFailure =
  | { result: "no-identity"; reason: DecisionsKitIdentityProblem }
  | Extract<DecisionsConnectResult, { result: "key-storage" }>;

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
 * or recorded; the caller records a pass.
 */
export async function checkRecoveryKit(
  keys: Pick<SealedKeyStore, "load">,
  settings: DecisionsSettings,
  kit: string,
  passphrase: string
): Promise<
  | { verified: RecordedIdentity }
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
  return { verified: sealed.recorded };
}
