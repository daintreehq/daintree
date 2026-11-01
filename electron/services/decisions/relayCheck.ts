import {
  API_PREFIX,
  InfoResponse,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "@daintreehq/decisions-protocol";
import protocolPackage from "@daintreehq/decisions-protocol/package.json" with { type: "json" };
import type {
  DecisionsRelayCheck,
  DecisionsRelayEndpoint,
  DecisionsRelayUnreachableReason,
  DecisionsRelayVersions,
} from "../../../shared/types/decisions.js";
import { AppError } from "../../utils/errorTypes.js";
import { normalizeRelayOrigin } from "./decisionsSettings.js";

/**
 * Daintree's side of the comparison. The relay's worker and the libraries are
 * released together under one version, so the installed protocol package's
 * version is the relay release this build expects.
 */
export const DAINTREE_RELAY_VERSIONS: Readonly<DecisionsRelayVersions> = Object.freeze({
  protocolMin: MIN_PROTOCOL_VERSION,
  protocolMax: PROTOCOL_VERSION,
  workerVersion: protocolPackage.version,
});

const REQUEST_TIMEOUT_MS = 10_000;
/** `/health` and `/info` are a few hundred bytes; anything far bigger isn't a relay. */
const MAX_BODY_BYTES = 64 * 1024;
const WORKER_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const HAS_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
/** Whitespace, control characters and backslashes, which URL parsing would otherwise quietly reinterpret. */
const UNSAFE_CHARACTERS = /[\s\\\p{Cc}]/u;

export type RelayFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface RelayCheckOptions {
  fetchImpl?: RelayFetch;
  timeoutMs?: number;
  /** Aborting it ends the check with `RelayCheckCancelledError` rather than an observation. */
  signal?: AbortSignal;
}

/**
 * The check was called off (Decisions off or turned off, or quit), so it
 * observed nothing. An `AppError`, so it reaches the renderer as `CANCELLED`
 * without the IPC handler naming this module.
 */
export class RelayCheckCancelledError extends AppError {
  constructor() {
    // Keeps the name "AppError": the renderer recognises an AppError by it.
    super({ code: "CANCELLED", message: "The relay check was cancelled" });
  }
}

type Answer =
  | { kind: "json"; body: unknown }
  | { kind: "status"; status: number }
  | { kind: "not-json" }
  | { kind: "redirected" }
  | { kind: "unreachable"; reason: DecisionsRelayUnreachableReason };

/**
 * A typed relay address as its origin, or why it can't be used. A bare host
 * gets `https://`; a path, query or fragment is dropped. Only https is
 * accepted, and never a user name or password, which would also let
 * `https://good.example@other.example` read as the first host.
 */
export function relayOriginFromInput(
  input: string
): { origin: string } | Extract<DecisionsRelayCheck, { result: "invalid-url" }> {
  const trimmed = input.trim();
  if (trimmed === "" || UNSAFE_CHARACTERS.test(trimmed)) {
    return { result: "invalid-url", reason: "unparsable" };
  }
  const candidate = HAS_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = URL.parse(candidate);
  if (!url || url.hostname === "") return { result: "invalid-url", reason: "unparsable" };
  if (url.protocol !== "https:") return { result: "invalid-url", reason: "not-https" };
  if (url.username !== "" || url.password !== "") {
    return { result: "invalid-url", reason: "credentials" };
  }
  // The stored setting's own rule, so whatever passes here is what #16006 can save.
  const origin = normalizeRelayOrigin(url.href);
  return origin ? { origin } : { result: "invalid-url", reason: "unparsable" };
}

/**
 * Checks a relay through its two unsigned reads, `/health` then
 * `/api/v1/info`, and reports what it saw. Never follows a redirect, never
 * sends cookies or credentials, and never reports an error's own text: a
 * network error can name the URL it failed on.
 */
export async function checkDecisionsRelay(
  input: string,
  options: RelayCheckOptions = {}
): Promise<DecisionsRelayCheck> {
  const parsed = relayOriginFromInput(input);
  if (!("origin" in parsed)) return parsed;
  const { origin } = parsed;
  const fetchImpl = options.fetchImpl ?? (await electronNetFetch());
  const read = async (endpoint: DecisionsRelayEndpoint, path: string) => {
    if (options.signal?.aborted) throw new RelayCheckCancelledError();
    const answer = await getJson(fetchImpl, `${origin}${path}`, {
      timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
      signal: options.signal,
    });
    if (options.signal?.aborted) throw new RelayCheckCancelledError();
    return { answer, ended: unanswered(origin, endpoint, answer) };
  };

  const health = await read("health", "/health");
  if (health.ended) return health.ended;
  if (!isHealthy(health.answer)) return notARelay(origin, "health", "body");

  const info = await read("info", `${API_PREFIX}/info`);
  if (info.ended) return info.ended;
  const parsedInfo = info.answer.kind === "json" ? InfoResponse.safeParse(info.answer.body) : null;
  if (!parsedInfo?.success) return notARelay(origin, "info", "body");
  const relayInfo = parsedInfo.data;

  const relay: DecisionsRelayVersions = {
    protocolMin: relayInfo.protocol_min,
    protocolMax: relayInfo.protocol_max,
    workerVersion: relayInfo.worker_version,
  };
  if (
    relay.protocolMin < 1 ||
    relay.protocolMin > relay.protocolMax ||
    !WORKER_VERSION.test(relay.workerVersion)
  ) {
    return notARelay(origin, "info", "body");
  }
  const daintree = DAINTREE_RELAY_VERSIONS;
  const overlaps =
    Math.max(relay.protocolMin, daintree.protocolMin) <=
    Math.min(relay.protocolMax, daintree.protocolMax);
  const result = !overlaps
    ? "incompatible"
    : relayInfo.claimed
      ? "claimed"
      : relayInfo.claim_configured
        ? "unclaimed"
        : "claim-not-configured";
  return {
    result,
    origin,
    compatibility: {
      relay,
      daintree: { ...daintree },
      diverges:
        relay.workerVersion !== daintree.workerVersion ||
        relay.protocolMin !== daintree.protocolMin ||
        relay.protocolMax !== daintree.protocolMax,
    },
  };
}

function notARelay(
  origin: string,
  endpoint: DecisionsRelayEndpoint,
  answered: "redirect" | "body"
): DecisionsRelayCheck {
  return { result: "not-a-relay", origin, endpoint, answered, status: null };
}

/** An answer that ends the check before its body is read, as the observation to report. */
function unanswered(
  origin: string,
  endpoint: DecisionsRelayEndpoint,
  answer: Answer
): DecisionsRelayCheck | null {
  switch (answer.kind) {
    case "unreachable":
      return { result: "unreachable", origin, endpoint, reason: answer.reason };
    case "redirected":
      return notARelay(origin, endpoint, "redirect");
    case "status":
      // A relay that is there but failing (a Worker exception, Cloudflare's
      // rate limit) against an address with no such route at all.
      return answer.status >= 500 || answer.status === 429
        ? { result: "http-error", origin, endpoint, status: answer.status }
        : { result: "not-a-relay", origin, endpoint, answered: "status", status: answer.status };
    default:
      return null;
  }
}

function isHealthy(answer: Answer): boolean {
  return (
    answer.kind === "json" &&
    typeof answer.body === "object" &&
    answer.body !== null &&
    (answer.body as { ok?: unknown }).ok === true
  );
}

/**
 * One GET, its deadline covering the body as well as the headers. The body
 * is read to a cap, never with an unbounded `.json()`.
 */
async function getJson(
  fetchImpl: RelayFetch,
  url: string,
  { timeoutMs, signal }: { timeoutMs: number; signal: AbortSignal | undefined }
): Promise<Answer> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      signal: combined,
    });
  } catch (error) {
    return failedRequest(error);
  }
  const declared = Number(response.headers.get("content-length"));
  if (!response.ok || declared > MAX_BODY_BYTES) {
    void response.body?.cancel().catch(() => {});
    return response.ok ? { kind: "not-json" } : { kind: "status", status: response.status };
  }
  let text: string | null;
  try {
    text = await readCapped(response, MAX_BODY_BYTES);
  } catch (error) {
    return failedRequest(error);
  }
  if (text === null) return { kind: "not-json" };
  try {
    return { kind: "json", body: JSON.parse(text) as unknown };
  } catch {
    return { kind: "not-json" };
  }
}

/** The body as text, or null once it passes `max` bytes. */
async function readCapped(response: Response, max: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function failedRequest(error: unknown): Answer {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  // Chromium's network stack refuses a redirect under `redirect: "error"`
  // (and cancels one under "manual") with its own message, not a 3xx status.
  if (/redirect/i.test(message)) return { kind: "redirected" };
  return { kind: "unreachable", reason: unreachableReason(name, message) };
}

function unreachableReason(name: string, message: string): DecisionsRelayUnreachableReason {
  if (name === "TimeoutError" || /ERR_(CONNECTION_)?TIMED_OUT|ETIMEDOUT/.test(message)) {
    return "timeout";
  }
  if (/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ENOTFOUND|EAI_AGAIN/.test(message)) {
    return "dns";
  }
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/.test(message)) return "refused";
  if (/ERR_CERT_|ERR_SSL_|ERR_BAD_SSL|CERT_/.test(message)) return "certificate";
  return "network";
}

/** Chromium's network stack, so the system proxy and certificate store apply as they do elsewhere. */
async function electronNetFetch(): Promise<RelayFetch> {
  const { net } = await import("electron");
  return (url, init) => net.fetch(url, init);
}
