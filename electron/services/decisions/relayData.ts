import { importIdentity, RelayClient, RelayError } from "@daintreehq/decisions-client";
import type {
  DecisionsRelayDeleteRefusal,
  DecisionsRelayDeleteResult,
  DecisionsSettings,
} from "../../../shared/types/decisions.js";
import { normalizeRelayOrigin } from "./decisionsSettings.js";
import { keyReadFailure, type SealedKeyStore } from "./keyStore.js";
import type { RelayFetch } from "./relayCheck.js";
import { NEVER_SENT, OWNER_ROLE, relayRequests } from "./relayIdentity.js";

/** The relay deletes its attachments page by page before its rows, so it gets longer than a setup request. */
const DELETE_TIMEOUT_MS = 60_000;
/** The only scope Daintree asks for: the stored content, never the relay's owner or devices. */
const SCOPE = "questions";

export interface RelayDeleteOptions {
  /** The relay the person confirmed. */
  origin: string;
  /** The setting as it reads now. */
  settings: DecisionsSettings;
  keys: Pick<SealedKeyStore, "load">;
  fetchImpl?: RelayFetch;
  /** Aborting it (quit) ends the request where it is. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

function refusal(error: RelayError): DecisionsRelayDeleteRefusal {
  if (error.status === 401 || error.status === 403) return "not-recognised";
  if (error.status === 429) return "rate-limited";
  return "rejected";
}

function isConfirmation(value: unknown): boolean {
  const answer = value as { ok?: unknown; scope?: unknown } | null;
  return typeof answer === "object" && answer?.ok === true && answer.scope === SCOPE;
}

/**
 * Deletes the relay's stored questions, answers and attachments (#16025)
 * with the library's signed `delete-data` request, scope `questions`. The
 * relay keeps its owner, its paired devices and the Worker itself; this
 * computer's history, keys and settings are untouched.
 *
 * Only for the relay the person confirmed, which must still be the one set
 * up here, signed with this computer's owner identity for it. The request is
 * sent once: another device can add content between two attempts, and a
 * second request would delete that too, so a repeat waits for the person.
 * Only the relay's own answer counts as deleted; anything short of it after
 * the request may have arrived is reported as unconfirmed, since the relay
 * deletes attachments before its rows and doesn't stop when the answer is lost.
 */
export async function deleteDecisionsRelayData(
  options: RelayDeleteOptions
): Promise<DecisionsRelayDeleteResult> {
  const { settings } = options;
  const origin = normalizeRelayOrigin(options.origin);
  if (origin === null || settings.relayOrigin !== origin) {
    return { result: "changed", origin: settings.relayOrigin };
  }
  let stored;
  try {
    stored = await options.keys.load();
  } catch (error) {
    const failure = keyReadFailure(error);
    if (failure) return { result: "key-storage", ...failure };
    throw error;
  }
  if (
    !stored ||
    stored.claimed === false ||
    (stored.role ?? OWNER_ROLE) !== OWNER_ROLE ||
    normalizeRelayOrigin(stored.config.relayOrigin) !== origin ||
    stored.config.installationId !== settings.installationId ||
    stored.config.deviceId !== settings.deviceId
  ) {
    return { result: "no-identity", origin };
  }
  const identity = await importIdentity(stored);
  const requests = await relayRequests(origin, {
    timeoutMs: options.timeoutMs ?? DELETE_TIMEOUT_MS,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const client = new RelayClient({ identity, fetch: requests.fetch, maxRetries: 0 });
  let answer: unknown;
  try {
    answer = await client.deleteData(SCOPE);
  } catch (error) {
    if (error instanceof RelayError) {
      if (error.code === "network_error") {
        const failure = requests.lastFailure() ?? { reason: "network", answered: true };
        return NEVER_SENT.has(failure.reason) && !failure.answered
          ? { result: "not-sent", origin, reason: failure.reason }
          : { result: "unconfirmed", origin, reason: failure.reason };
      }
      if (error.status >= 500) return { result: "unconfirmed", origin, reason: "server-error" };
      return { result: "refused", origin, reason: refusal(error), status: error.status };
    }
    // A success whose body wasn't JSON: something answered, but not as the relay does.
    if (error instanceof SyntaxError) {
      return { result: "unconfirmed", origin, reason: "unexpected-answer" };
    }
    throw error;
  }
  return isConfirmation(answer)
    ? { result: "deleted", origin }
    : { result: "unconfirmed", origin, reason: "unexpected-answer" };
}
