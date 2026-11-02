import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app, safeStorage } from "electron";
import type { KeyStore, StoredIdentity } from "@daintreehq/decisions-client";
import type { DecisionsKeyStorageFailure } from "../../../shared/types/decisions.js";
import {
  encryptWithKeychain,
  keychainKeyed,
  keychainLockedReason,
  keychainSessionFailure,
  SecretStorageTimeoutError,
  selectedLinuxBackend,
  withSecretStorageTimeout,
} from "../osKeychain.js";
import {
  ensureOwnerOnlyDir,
  OWNER_RW_FILE_MODE,
  resilientAtomicWriteFile,
  resilientUnlink,
  syncParentDirectory,
} from "../../utils/fs.js";

/**
 * How a key file is sealed: by the OS keychain, or, on Linux with no keyring,
 * under Chromium's fixed `basic_text` key, which only the person's explicit
 * confirmation allows.
 */
export type KeyProtection = "keychain" | "basic";

export type DecisionsKeyStoreErrorKind =
  /** The keychain gave this session no key (a dismissed or failed unlock); a restart asks again. */
  | "locked"
  /** There is no keychain to use. */
  | "unavailable"
  /** The keychain didn't answer in time, perhaps behind a password prompt. */
  | "timeout"
  /** Saving would have used the fixed `basic_text` key, which wasn't confirmed. */
  | "weak-storage-unconfirmed"
  /** The file is there but couldn't be opened or read as keys. */
  | "unreadable"
  /** The file is in a format this version doesn't know. */
  | "unsupported-format"
  /** What was handed to `save` isn't a stored identity. */
  | "invalid-identity"
  /** The enabled lifetime that owned this store has ended. */
  | "closed";

/** Every refusal names its kind; none carries key material or the file's contents. */
export class DecisionsKeyStoreError extends Error {
  constructor(
    readonly kind: DecisionsKeyStoreErrorKind,
    message: string
  ) {
    super(message);
    this.name = "DecisionsKeyStoreError";
  }
}

const READ_FAILURES: ReadonlySet<DecisionsKeyStoreErrorKind> = new Set([
  "locked",
  "unavailable",
  "timeout",
  "unreadable",
  "unsupported-format",
]);

/**
 * A refusal to read the keys that a person can act on, by its kind and
 * message; null for anything else, which callers let through.
 */
export function keyReadFailure(error: unknown): {
  kind: Exclude<DecisionsKeyStorageFailure, "weak-storage-unconfirmed">;
  reason: string;
} | null {
  if (!(error instanceof DecisionsKeyStoreError) || !READ_FAILURES.has(error.kind)) return null;
  return {
    kind: error.kind as Exclude<DecisionsKeyStorageFailure, "weak-storage-unconfirmed">,
    reason: error.message,
  };
}

/** What sealing would use right now, for setup to show before it saves anything. */
export type KeyStorageCheck =
  | { kind: "keychain" }
  | { kind: "weak"; reason: string }
  | { kind: "locked" | "unavailable" | "timeout"; reason: string };

const FORMAT_VERSION = 1;

/** On disk: the protection used and the sealed payload. Untrusted until the payload opens and agrees. */
interface KeyFileEnvelope {
  v: typeof FORMAT_VERSION;
  protection: KeyProtection;
  ciphertext: string;
}

/** Sealed: the identity, with the protection repeated so a rewritten envelope can't claim another. */
interface SealedPayload {
  v: typeof FORMAT_VERSION;
  protection: KeyProtection;
  identity: StoredIdentity;
}

type Operation = "read" | "save" | "check";

const OUTCOME: Record<Operation, string> = {
  read: "Decisions keys couldn't be read",
  save: "Decisions keys weren't saved",
  check: "Decisions keys can't be stored",
};

const WEAK_REASON =
  "No keyring is available, so Decisions keys could only be sealed with a fixed key, which doesn't protect them from anyone who can read the file";

const LEFT_AS_IS = "so it was left as it is";

export function decisionsKeyFilePath(): string {
  return join(app.getPath("userData"), "decisions", "keys.bin");
}

function keychainError(operation: Operation): DecisionsKeyStoreError {
  if (keychainSessionFailure() === "locked") {
    return new DecisionsKeyStoreError(
      "locked",
      `${keychainLockedReason()}, so ${OUTCOME[operation]} — restart Daintree to try again`
    );
  }
  return new DecisionsKeyStoreError(
    "unavailable",
    `Secure storage is unavailable on this device, so ${OUTCOME[operation]}`
  );
}

function unreadable(why: string): DecisionsKeyStoreError {
  return new DecisionsKeyStoreError("unreadable", `The Decisions key file ${why}, ${LEFT_AS_IS}`);
}

function closedError(): DecisionsKeyStoreError {
  return new DecisionsKeyStoreError("closed", "Decisions has stopped, so its keys can't be used");
}

/** Runs a keychain call, turning its deadline into this store's own refusal. */
async function keychainCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof SecretStorageTimeoutError) {
      throw new DecisionsKeyStoreError("timeout", error.message);
    }
    throw error;
  }
}

function weakBackend(): boolean {
  return process.platform === "linux" && selectedLinuxBackend() === "basic_text";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Enough of the library's shape to tell keys from damage; the library checks the rest on import. */
export function isStoredIdentity(value: unknown): value is StoredIdentity {
  if (!isRecord(value) || value.v !== 1) return false;
  const { config, keys, epochs, currentEpoch } = value;
  return (
    isRecord(config) &&
    typeof config.relayOrigin === "string" &&
    typeof config.installationId === "string" &&
    typeof config.deviceId === "string" &&
    isRecord(keys) &&
    typeof keys.signing_private_pkcs8 === "string" &&
    typeof keys.signing_public === "string" &&
    typeof keys.exchange_private_pkcs8 === "string" &&
    typeof keys.exchange_public === "string" &&
    Array.isArray(epochs) &&
    epochs.every(
      (epoch) =>
        isRecord(epoch) && Number.isSafeInteger(epoch.epoch) && typeof epoch.raw === "string"
    ) &&
    Number.isSafeInteger(currentEpoch)
  );
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function parseEnvelope(text: string): KeyFileEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw unreadable("is damaged");
  }
  if (!isRecord(value)) throw unreadable("is damaged");
  if (value.v !== FORMAT_VERSION) {
    if (typeof value.v === "number") {
      throw new DecisionsKeyStoreError(
        "unsupported-format",
        `The Decisions key file was written by another version of Daintree, ${LEFT_AS_IS}`
      );
    }
    throw unreadable("is damaged");
  }
  const { protection, ciphertext } = value;
  if (
    (protection !== "keychain" && protection !== "basic") ||
    typeof ciphertext !== "string" ||
    ciphertext.length === 0 ||
    !BASE64.test(ciphertext)
  ) {
    throw unreadable("is damaged");
  }
  return { v: FORMAT_VERSION, protection, ciphertext };
}

/**
 * Opens a key file. A failure the keychain explains (no key this session, none
 * at all) is reported as that, so a locked keychain never reads as "no keys";
 * one the keychain can't explain means the file doesn't open with this
 * computer's key, which is reported as unreadable, never as missing.
 */
async function openEnvelope(envelope: KeyFileEnvelope): Promise<StoredIdentity> {
  let plaintext: string;
  try {
    const opened = await keychainCall(() =>
      withSecretStorageTimeout(
        safeStorage.decryptStringAsync(Buffer.from(envelope.ciphertext, "base64"))
      )
    );
    plaintext = opened.result;
  } catch (error) {
    if (error instanceof DecisionsKeyStoreError) throw error;
    if (envelope.protection === "keychain" && !(await keychainCall(keychainKeyed))) {
      throw keychainError("read");
    }
    throw unreadable("couldn't be decrypted on this computer");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(plaintext);
  } catch {
    throw unreadable("is damaged");
  }
  if (
    !isRecord(payload) ||
    payload.v !== FORMAT_VERSION ||
    payload.protection !== envelope.protection ||
    !isStoredIdentity(payload.identity)
  ) {
    throw unreadable("is damaged");
  }
  return payload.identity;
}

/**
 * Seals with the OS keychain wherever there is one. Only on Linux's
 * `basic_text` backend, and only when `allowWeak` says the person accepted it,
 * does it fall back to the fixed key; a real keyring that answers with the
 * fixed-key fallback (a dismissed unlock) is a keychain failure, never weak
 * storage.
 */
async function seal(identity: StoredIdentity, allowWeak: boolean): Promise<KeyFileEnvelope> {
  let protection: KeyProtection = "keychain";
  if (weakBackend()) {
    if (!allowWeak) {
      throw new DecisionsKeyStoreError(
        "weak-storage-unconfirmed",
        `${WEAK_REASON}. They weren't saved, because the weaker storage wasn't confirmed`
      );
    }
    protection = "basic";
  }
  const payload: SealedPayload = { v: FORMAT_VERSION, protection, identity };
  const plaintext = JSON.stringify(payload);
  let ciphertext: Buffer | null = null;
  if (protection === "basic") {
    // Fixed-key sealing asks no keychain, so it says nothing about one either.
    try {
      ciphertext = await keychainCall(() =>
        withSecretStorageTimeout(safeStorage.encryptStringAsync(plaintext))
      );
    } catch (error) {
      if (error instanceof DecisionsKeyStoreError) throw error;
    }
  } else {
    ciphertext = await keychainCall(() => encryptWithKeychain(plaintext));
  }
  if (ciphertext === null) throw keychainError("save");
  return { v: FORMAT_VERSION, protection, ciphertext: ciphertext.toString("base64") };
}

/**
 * The identity on disk wasn't what a conditional save expected when its turn
 * came, so nothing was written.
 */
export class KeyFileChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyFileChangedError";
  }
}

/**
 * Every store's operations on one key file, in the order asked, shared by
 * every store on that file: two stores on the same file (a lifetime's, and a
 * Host enrollment's) never interleave one's read with the other's write.
 */
const fileQueues = new Map<string, Promise<unknown>>();

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

/**
 * The library's `KeyStore` over one file, `userData/decisions/keys.bin`,
 * sealed by the OS keychain. Key material never touches the disk unsealed.
 *
 * - A missing file is the only "no keys": it is read without asking the keychain.
 * - A keychain that can't open existing keys is reported as locked or
 *   unavailable, and `save` reads the existing keys before replacing them, so
 *   such a keychain never overwrites them (a recovery import's overwrite included).
 * - On Linux with no keyring, `save` refuses until `confirmWeakStorage` is
 *   called; a file already sealed that way carries the consent forward, and
 *   the next save with a keyring present seals it properly.
 *
 * Operations run one at a time in the order asked, together with every other
 * store's on the same file. `close` ends the store for
 * the lifetime that made it: what was already asked finishes, anything later
 * is refused.
 */
export class SealedKeyStore implements KeyStore {
  private weakConfirmed = false;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly filePath: string) {}

  /**
   * What `save` would seal with right now. May show the OS keychain's prompt;
   * reads no file. `weak` means saving needs `confirmWeakStorage` first.
   */
  check(): Promise<KeyStorageCheck> {
    return this.enqueue(async () => {
      if (weakBackend()) return { kind: "weak", reason: WEAK_REASON };
      try {
        if (await keychainCall(keychainKeyed)) return { kind: "keychain" };
      } catch (error) {
        if (error instanceof DecisionsKeyStoreError && error.kind === "timeout") {
          return { kind: "timeout", reason: error.message };
        }
        throw error;
      }
      const failure = keychainError("check");
      return { kind: failure.kind as "locked" | "unavailable", reason: failure.message };
    });
  }

  /** The person accepted the fixed-key storage for new keys. Lasts for this store, until `clear`. */
  confirmWeakStorage(): void {
    this.weakConfirmed = true;
  }

  load(): Promise<StoredIdentity | null> {
    return this.enqueue(async () => {
      const envelope = await this.readEnvelope();
      return envelope ? await openEnvelope(envelope) : null;
    });
  }

  save(identity: StoredIdentity): Promise<void> {
    return this.saveIf(() => null, identity);
  }

  /**
   * Saves `identity` only if `refusal` finds nothing wrong with what the file
   * holds when the write's turn comes: one step, so nothing another store
   * writes meanwhile is replaced unseen. `refusal` answers why not, or null;
   * a refusal rejects with {@link KeyFileChangedError} and writes nothing.
   */
  saveIf(
    refusal: (current: StoredIdentity | null) => string | null,
    identity: StoredIdentity
  ): Promise<void> {
    // Copied now, so a caller changing its object after the call can't change what is saved.
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(JSON.stringify(identity)) as unknown;
    } catch {
      snapshot = null;
    }
    if (!isStoredIdentity(snapshot)) {
      return Promise.reject(
        new DecisionsKeyStoreError(
          "invalid-identity",
          "That isn't a complete Decisions identity, so it wasn't saved"
        )
      );
    }
    const next = snapshot;
    return this.enqueue(async () => {
      const existing = await this.readEnvelope();
      const current = existing ? await openEnvelope(existing) : null;
      const refused = refusal(current);
      if (refused !== null) throw new KeyFileChangedError(refused);
      const allowWeak = existing ? existing.protection === "basic" : this.weakConfirmed;
      const envelope = await seal(next, allowWeak);
      await ensureOwnerOnlyDir(dirname(this.filePath));
      await resilientAtomicWriteFile(this.filePath, JSON.stringify(envelope), "utf-8", {
        mode: OWNER_RW_FILE_MODE,
      });
    });
  }

  /** Removes the key file. Never asks the keychain, and never runs on its own after a failed read. */
  clear(): Promise<void> {
    return this.enqueue(async () => {
      this.weakConfirmed = false;
      try {
        await resilientUnlink(this.filePath);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    });
  }

  /**
   * Removes the key file only if `removable` holds for what it holds when the
   * removal's turn comes: one step, so keys another store saved meanwhile (a
   * Host enrolled again) are never removed unseen. Resolves whether it was
   * removed; rejects, removing nothing, when the file can't be opened.
   */
  clearIf(removable: (current: StoredIdentity | null) => boolean): Promise<boolean> {
    return this.enqueue(async () => {
      const existing = await this.readEnvelope();
      const current = existing ? await openEnvelope(existing) : null;
      if (current === null || !removable(current)) return false;
      this.weakConfirmed = false;
      try {
        await resilientUnlink(this.filePath);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      await syncParentDirectory(this.filePath);
      return true;
    });
  }

  /** Refuses anything asked from now on, and waits for what was asked before. */
  async close(): Promise<void> {
    this.closed = true;
    await this.queue;
  }

  private async readEnvelope(): Promise<KeyFileEnvelope | null> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    return parseEnvelope(text);
  }

  private enqueue<T>(step: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(closedError());
    const path = this.filePath;
    const run = (fileQueues.get(path) ?? Promise.resolve()).then(step);
    const settled = run.catch(() => {});
    this.queue = settled;
    fileQueues.set(path, settled);
    void settled.then(() => {
      if (fileQueues.get(path) === settled) fileQueues.delete(path);
    });
    return run;
  }
}
