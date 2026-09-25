/**
 * Codex account quota, read through the app-server's `account/rateLimits/read`
 * (#12797). The method needs only the handshake — no thread, no tokens — so
 * each read is one short session on the shared transport.
 *
 * The protocol also pushes `account/rateLimits/updated`, but only inside a
 * session that runs a turn; a read-and-exit session never sees it, and holding
 * a server open to wait for it would pin one of the transport's two slots.
 * Freshness comes from the caller re-reading instead, behind a short cache so
 * several open views share one process.
 */

import { CodexAppServerError, runCodexAppServerSession } from "./CodexAppServerClient.js";
import type {
  CodexQuotaResult,
  CodexQuotaUnavailableReason,
  CodexQuotaWindow,
} from "../../../shared/types/ipc/agentQuota.js";

const CACHE_TTL_MS = 30_000;
/**
 * Unavailable answers are cached briefly too, so a signed-out user isn't
 * re-probed per open view, but short enough that Retry actually re-reads.
 */
const UNAVAILABLE_CACHE_TTL_MS = 5_000;

let cached: CodexQuotaResult | null = null;
let inFlight: Promise<CodexQuotaResult> | null = null;
let generation = 0;

function toWindow(raw: unknown): CodexQuotaWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const { usedPercent, windowDurationMins, resetsAt } = raw as Record<string, unknown>;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0) {
    return null;
  }
  if (
    typeof windowDurationMins !== "number" ||
    !Number.isInteger(windowDurationMins) ||
    windowDurationMins <= 0
  ) {
    return null;
  }
  return {
    usedPercent: Math.min(usedPercent, 100),
    windowDurationMins,
    // The protocol reports Unix seconds.
    resetsAt:
      typeof resetsAt === "number" && Number.isFinite(resetsAt) && resetsAt > 0
        ? Math.round(resetsAt * 1000)
        : null,
  };
}

/**
 * Normalise a `GetAccountRateLimitsResponse`. Only the top-level snapshot is
 * read: `rateLimitsByLimitId` breaks the same account down by model family,
 * and summing or picking from it would be a guess.
 */
export function normalizeCodexRateLimits(raw: unknown, fetchedAt: number): CodexQuotaResult {
  const unavailable = (reason: CodexQuotaUnavailableReason): CodexQuotaResult => ({
    status: "unavailable",
    reason,
    fetchedAt,
  });
  if (!raw || typeof raw !== "object") return unavailable("unsupported-response");
  const snapshot = (raw as Record<string, unknown>).rateLimits;
  if (!snapshot || typeof snapshot !== "object") return unavailable("unsupported-response");

  const { primary, secondary, planType } = snapshot as Record<string, unknown>;
  const sent = [primary, secondary].filter((value) => value !== null && value !== undefined);
  if (sent.length === 0) return unavailable("no-windows");

  const windows = sent.map(toWindow);
  // A window the server sent but we can't read is not the same as no window:
  // dropping it silently would show the other one as the whole picture.
  if (windows.some((window) => window === null)) return unavailable("unsupported-response");

  return {
    status: "ok",
    planType: typeof planType === "string" && planType.trim() ? planType : null,
    windows: (windows as CodexQuotaWindow[]).sort(
      (a, b) => a.windowDurationMins - b.windowDurationMins
    ),
    fetchedAt,
  };
}

function toUnavailableReason(error: unknown): CodexQuotaUnavailableReason {
  if (error instanceof CodexAppServerError) {
    if (error.reason === "cli-missing") return "cli-missing";
    if (error.reason === "timeout") return "timeout";
  }
  return "read-failed";
}

async function fetchCodexQuota(): Promise<CodexQuotaResult> {
  try {
    const raw = await runCodexAppServerSession((call) => call<unknown>("account/rateLimits/read"));
    return normalizeCodexRateLimits(raw, Date.now());
  } catch (error) {
    return { status: "unavailable", reason: toUnavailableReason(error), fetchedAt: Date.now() };
  }
}

/** Never rejects: every failure is an `unavailable` result. */
export function readCodexQuota(): Promise<CodexQuotaResult> {
  if (cached) {
    const ttl = cached.status === "ok" ? CACHE_TTL_MS : UNAVAILABLE_CACHE_TTL_MS;
    if (Date.now() - cached.fetchedAt < ttl) return Promise.resolve(cached);
  }
  return refreshCodexQuota();
}

/**
 * Ask Codex now, past the cache — what a user's Retry means. Still joins a
 * read already in flight rather than starting a second session.
 */
export function refreshCodexQuota(): Promise<CodexQuotaResult> {
  if (inFlight) return inFlight;
  const requestGeneration = generation;
  const request = fetchCodexQuota().then((result) => {
    if (requestGeneration === generation) cached = result;
    return result;
  });
  inFlight = request;
  void request.finally(() => {
    if (inFlight === request) inFlight = null;
  });
  return request;
}

export function resetCodexQuotaCacheForTests(): void {
  generation++;
  cached = null;
  inFlight = null;
}
