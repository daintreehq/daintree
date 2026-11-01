import {
  claimRelay,
  importIdentity,
  RelayClient,
  RelayError,
  type Identity,
  type RelayConfig,
  type StoredIdentity,
} from "@daintreehq/decisions-client";
import {
  decryptRecoveryBundle,
  newId,
  signString,
  verifyString,
  type RecoveryBundleFile,
} from "@daintreehq/decisions-crypto";
import { DevicesResponse } from "@daintreehq/decisions-protocol";
import type {
  ClaimDecisionsRelayPayload,
  DecisionsClaimRefusal,
  DecisionsConnectResult,
  DecisionsKeyStorageFailure,
  DecisionsKitRefusal,
  DecisionsRelayCheck,
  DecisionsRelayUnreachableReason,
  RestoreDecisionsIdentityPayload,
} from "../../../shared/types/decisions.js";
import { isRelayId, normalizeRelayOrigin } from "./decisionsSettings.js";
import { DecisionsKeyStoreError, isStoredIdentity, type SealedKeyStore } from "./keyStore.js";
import {
  checkDecisionsRelay,
  electronNetFetch,
  readCapped,
  relayOriginFromInput,
  requestFailureReason,
  type RelayFetch,
} from "./relayCheck.js";

/** The parts of the sealed key store a setup uses. */
export type SetupKeyStore = Pick<
  SealedKeyStore,
  "check" | "confirmWeakStorage" | "load" | "save" | "clear"
>;

export type DecisionsConnectFailure = Exclude<DecisionsConnectResult, { result: "saved" }>;

/** A setup's end: the identity it sealed (or found sealed already), or what stopped it. */
export type RelaySetupOutcome = { identity: RelayConfig } | { failure: DecisionsConnectFailure };

export interface RelaySetupOptions {
  keys: SetupKeyStore;
  fetchImpl?: RelayFetch;
  /** Aborting it (quit) ends the setup's requests where they are. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** The label the relay and the owner's devices show for this computer. */
const DEVICE_LABEL = "Daintree";
const REQUEST_TIMEOUT_MS = 10_000;
/** A claim, a device list or a push config is a few KiB; anything far bigger isn't a relay. */
const MAX_ANSWER_BYTES = 1024 * 1024;
/** A kit is one identity, a few KiB. */
export const MAX_RECOVERY_KIT_BYTES = 256 * 1024;
/** The library refuses fewer; more than this would hold the setup for minutes. */
const MIN_KIT_ITERATIONS = 100_000;
const MAX_KIT_ITERATIONS = 10_000_000;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

const OWNER_ROLE = "owner-desktop";

const KEY_STORAGE_FAILURES: ReadonlySet<string> = new Set<DecisionsKeyStorageFailure>([
  "locked",
  "unavailable",
  "timeout",
  "weak-storage-unconfirmed",
  "unreadable",
  "unsupported-format",
]);

/** Requests that never reached the relay: nothing it could have accepted. */
const NEVER_SENT: ReadonlySet<DecisionsRelayUnreachableReason> = new Set([
  "dns",
  "refused",
  "certificate",
]);

interface RelayRequests {
  fetch: typeof fetch;
  /** Why the latest request got no answer; null once one answered. */
  lastFailure(): DecisionsRelayUnreachableReason | null;
}

/**
 * The library's `fetch`, through Chromium's network stack and held to the
 * checked origin: no redirect, cookie or cache, and each request's deadline
 * covers its body, which is read to a cap before the library sees it. A
 * failure reaches the library carrying only its reason, never the network
 * error's text, which can name the URL.
 */
async function relayRequests(origin: string, options: RelaySetupOptions): Promise<RelayRequests> {
  const fetchImpl = options.fetchImpl ?? (await electronNetFetch());
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let failure: DecisionsRelayUnreachableReason | null = null;
  const fail = (reason: DecisionsRelayUnreachableReason): never => {
    failure = reason;
    throw new Error(reason);
  };
  const call = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    failure = null;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (URL.parse(url)?.origin !== origin) fail("network");
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        signal,
      });
    } catch (error) {
      const reason = requestFailureReason(error, deadline.aborted);
      return fail(reason === "redirect" ? "network" : reason);
    }
    let text: string | null;
    try {
      text = await readCapped(response, MAX_ANSWER_BYTES);
    } catch (error) {
      const reason = requestFailureReason(error, deadline.aborted);
      return fail(reason === "redirect" ? "network" : reason);
    }
    if (text === null) return fail("network");
    return new Response(NULL_BODY_STATUSES.has(response.status) ? null : text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return { fetch: call as typeof fetch, lastFailure: () => failure };
}

/** The relay's unsigned check, run before anything is staged or signed. */
function checkFirst(origin: string, options: RelaySetupOptions): Promise<DecisionsRelayCheck> {
  return checkDecisionsRelay(origin, {
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}

function failed(failure: DecisionsConnectFailure): RelaySetupOutcome {
  return { failure };
}

function keyStorageFailure(error: unknown): DecisionsConnectFailure | null {
  if (error instanceof DecisionsKeyStoreError && KEY_STORAGE_FAILURES.has(error.kind)) {
    return {
      result: "key-storage",
      kind: error.kind as DecisionsKeyStorageFailure,
      reason: error.message,
    };
  }
  return null;
}

/** Runs a key-store call, turning the refusals a person can act on into their observation. */
async function keyCall<T>(
  call: () => Promise<T>
): Promise<{ value: T } | { failure: DecisionsConnectFailure }> {
  try {
    return { value: await call() };
  } catch (error) {
    const failure = keyStorageFailure(error);
    if (failure) return { failure };
    throw error;
  }
}

function isOwner(stored: StoredIdentity): boolean {
  return (stored.role ?? OWNER_ROLE) === OWNER_ROLE;
}

function conflictWith(stored: StoredIdentity): DecisionsConnectFailure {
  return {
    result: "conflict",
    origin: normalizeRelayOrigin(stored.config.relayOrigin),
    unfinished: stored.claimed === false,
  };
}

/**
 * Checks sealing before anything is staged or sent, so a keychain that is
 * locked, missing or slow stops the setup before the relay hears of it.
 * Linux's fixed-key storage goes ahead only once the person accepted it.
 */
async function prepareSealing(
  keys: SetupKeyStore,
  acceptWeakStorage: boolean | undefined
): Promise<DecisionsConnectFailure | null> {
  const storage = await keys.check();
  switch (storage.kind) {
    case "keychain":
      return null;
    case "weak":
      if (acceptWeakStorage !== true) {
        return { result: "key-storage", kind: "weak-storage-unconfirmed", reason: storage.reason };
      }
      keys.confirmWeakStorage();
      return null;
    default:
      return { result: "key-storage", kind: storage.kind, reason: storage.reason };
  }
}

function claimRefusal(error: RelayError): DecisionsClaimRefusal | null {
  switch (error.code) {
    case "not_authenticated":
      return "wrong-secret";
    case "already_claimed":
      return "already-claimed";
    case "not_configured":
      return "not-configured";
    case "rate_limited":
      return "rate-limited";
    default:
      if (error.status === 429) return "rate-limited";
      return error.status >= 400 && error.status < 500 ? "rejected" : null;
  }
}

/**
 * Claims a fresh relay with its claim secret, and seals the owner identity
 * the claim registered (#16006).
 *
 * The library stages the new identity, sealed and marked unfinished, before
 * it sends the claim, so an answer lost on the way back can't leave the
 * relay owned by keys nobody holds: the next claim of the same relay
 * finishes with them. That stage is removed whenever this attempt made it
 * and the relay can't have taken it (it refused, or the request never left
 * this computer). It stays, and the observation says so, when the claim may
 * have arrived, or when an earlier attempt made it, since a refusal now says
 * nothing about whether that one arrived.
 */
export async function claimDecisionsRelay(
  payload: ClaimDecisionsRelayPayload,
  options: RelaySetupOptions
): Promise<RelaySetupOutcome> {
  const parsed = relayOriginFromInput(payload.url);
  if (!("origin" in parsed)) return failed({ result: "relay", check: parsed });
  const { origin } = parsed;
  const { keys } = options;

  const existing = await keyCall(() => keys.load());
  if ("failure" in existing) return existing;
  const stored = existing.value;
  const staged = stored?.claimed === false ? stored : null;
  if (stored && !staged) {
    // Sealed by a setup whose setting didn't save: taken up as it is.
    const same = isOwner(stored) && normalizeRelayOrigin(stored.config.relayOrigin) === origin;
    return same ? { identity: stored.config } : failed(conflictWith(stored));
  }
  if (staged && normalizeRelayOrigin(staged.config.relayOrigin) !== origin) {
    return failed(conflictWith(staged));
  }

  const sealing = await prepareSealing(keys, payload.acceptWeakStorage);
  if (sealing) return failed(sealing);

  const check = await checkFirst(origin, options);
  // A claimed relay goes ahead only to finish this computer's own unfinished
  // claim: the relay may have taken it and lost the answer.
  if (!(check.result === "unclaimed" || (check.result === "claimed" && staged))) {
    return failed({ result: "relay", check });
  }

  const requests = await relayRequests(origin, options);
  try {
    const { identity } = await claimRelay({
      origin,
      claimSecret: payload.claimSecret,
      label: DEVICE_LABEL,
      store: keys,
      fetch: requests.fetch,
    });
    return { identity: identity.config };
  } catch (error) {
    return failed(await claimFailure(error, origin, keys, staged !== null, requests));
  }
}

async function claimFailure(
  error: unknown,
  origin: string,
  keys: SetupKeyStore,
  stagedBefore: boolean,
  requests: RelayRequests
): Promise<DecisionsConnectFailure> {
  const storage = keyStorageFailure(error);
  if (storage) return storage;
  /** Removes a stage this attempt made, which the relay can't have taken. */
  const dropNewStage = async (): Promise<boolean> => {
    if (stagedBefore) return true;
    try {
      await keys.clear();
      return false;
    } catch {
      return true;
    }
  };
  if (error instanceof RelayError) {
    const refusal = claimRefusal(error);
    if (refusal === "already-claimed") {
      // The library only lets this through once the relay refused the
      // staged keys too, and it removes them itself.
      return { result: "refused", origin, reason: refusal, kept: false };
    }
    if (refusal) return { result: "refused", origin, reason: refusal, kept: await dropNewStage() };
    if (error.code === "network_error") {
      const reason = requests.lastFailure() ?? "network";
      const kept = NEVER_SENT.has(reason) ? await dropNewStage() : true;
      return { result: "unreachable", origin, reason, kept };
    }
    return { result: "unreachable", origin, reason: "server-error", kept: true };
  }
  // A success whose body didn't read: the relay may well have taken the claim.
  if (error instanceof SyntaxError) {
    return { result: "unreachable", origin, reason: "server-error", kept: true };
  }
  throw error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A kit's outer file, read without trusting it: bounded sizes and a KDF cost the setup can afford. */
function parseKit(text: string): RecoveryBundleFile | null {
  if (Buffer.byteLength(text, "utf8") > MAX_RECOVERY_KIT_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const { v, kdf, iterations, salt, nonce, ciphertext } = value;
  if (
    v !== 1 ||
    kdf !== "PBKDF2-SHA256" ||
    !Number.isSafeInteger(iterations) ||
    (iterations as number) < MIN_KIT_ITERATIONS ||
    (iterations as number) > MAX_KIT_ITERATIONS
  ) {
    return null;
  }
  for (const field of [salt, nonce, ciphertext]) {
    if (typeof field !== "string" || !BASE64URL.test(field)) return null;
  }
  return value as unknown as RecoveryBundleFile;
}

/** The kit's keys sign and verify, and it holds its current epoch's key. */
async function keysWork(identity: Identity): Promise<boolean> {
  if (!identity.epochs.has(identity.currentEpoch)) return false;
  try {
    const probe = `daintree-restore:${newId()}`;
    const signature = await signString(identity.keys.signing.privateKey, probe);
    return await verifyString(identity.keys.signing.publicKey, probe, signature);
  } catch {
    return false;
  }
}

/** The relay lists this identity as its owner, unrevoked, under the same keys. */
function relayRecognises(answer: unknown, identity: Identity): boolean {
  const parsed = DevicesResponse.safeParse(answer);
  if (!parsed.success) return false;
  const { installationId, deviceId } = identity.config;
  return (
    parsed.data.owner_device_id === deviceId &&
    parsed.data.devices.some(
      (device) =>
        device.device_id === deviceId &&
        device.role === OWNER_ROLE &&
        device.revoked_at === null &&
        device.cert.installation_id === installationId &&
        device.cert.signing_pub === identity.signingPub
    )
  );
}

function sameIdentity(a: StoredIdentity, b: StoredIdentity): boolean {
  return (
    a.claimed !== false &&
    isOwner(a) &&
    normalizeRelayOrigin(a.config.relayOrigin) === normalizeRelayOrigin(b.config.relayOrigin) &&
    a.config.installationId === b.config.installationId &&
    a.config.deviceId === b.config.deviceId &&
    a.keys.signing_public === b.keys.signing_public
  );
}

/**
 * Restores an owner identity from a recovery kit and seals it (#16006).
 * Everything is proven before anything is saved: the kit opens with the
 * passphrase, holds a confirmed owner identity for the relay that was
 * checked, its keys work, and the relay itself accepts a request signed with
 * them and lists them as its owner. A kit whose identity is already sealed
 * here is taken up without replacing the keys, which may hold newer epochs.
 */
export async function restoreDecisionsIdentity(
  payload: RestoreDecisionsIdentityPayload,
  options: RelaySetupOptions
): Promise<RelaySetupOutcome> {
  const parsed = relayOriginFromInput(payload.url);
  if (!("origin" in parsed)) return failed({ result: "relay", check: parsed });
  const { origin } = parsed;
  const { keys } = options;
  const refuse = (reason: DecisionsKitRefusal) => failed({ result: "kit-refused", origin, reason });

  const file = parseKit(payload.kit);
  if (!file) return refuse("not-a-kit");
  let body: unknown;
  try {
    body = await decryptRecoveryBundle(file, payload.passphrase);
  } catch {
    return refuse("wrong-passphrase");
  }
  if (
    !isRecord(body) ||
    body.kind !== "decisions-recovery-kit" ||
    !isStoredIdentity(body.identity)
  ) {
    return refuse("not-a-kit");
  }
  const stored = body.identity;
  if (stored.claimed === false) return refuse("unfinished");
  if (!isOwner(stored)) return refuse("not-owner");
  if (normalizeRelayOrigin(stored.config.relayOrigin) !== origin) return refuse("another-relay");
  if (!isRelayId(stored.config.installationId) || !isRelayId(stored.config.deviceId)) {
    return refuse("not-a-kit");
  }
  let identity: Identity;
  try {
    identity = await importIdentity(stored);
  } catch {
    return refuse("not-a-kit");
  }
  if (!(await keysWork(identity))) return refuse("not-a-kit");

  const existing = await keyCall(() => keys.load());
  if ("failure" in existing) return existing;
  const held = existing.value;
  if (held && !sameIdentity(held, stored)) return failed(conflictWith(held));
  if (!held) {
    const sealing = await prepareSealing(keys, payload.acceptWeakStorage);
    if (sealing) return failed(sealing);
  }

  const check = await checkFirst(origin, options);
  if (check.result !== "claimed") return failed({ result: "relay", check });

  const requests = await relayRequests(origin, options);
  let devices: unknown;
  try {
    devices = await new RelayClient({ identity, fetch: requests.fetch, maxRetries: 0 }).devices();
  } catch (error) {
    if (error instanceof RelayError) {
      if (error.code === "network_error") {
        const reason = requests.lastFailure() ?? "network";
        return failed({ result: "unreachable", origin, reason, kept: false });
      }
      if (error.retryable) {
        return failed({ result: "unreachable", origin, reason: "server-error", kept: false });
      }
      return refuse("not-recognised");
    }
    if (error instanceof SyntaxError) {
      return failed({ result: "unreachable", origin, reason: "server-error", kept: false });
    }
    throw error;
  }
  if (!relayRecognises(devices, identity)) return refuse("not-recognised");

  if (held) return { identity: held.config };
  const saved = await keyCall(() => keys.save(stored));
  if ("failure" in saved) return saved;
  return { identity: stored.config };
}
