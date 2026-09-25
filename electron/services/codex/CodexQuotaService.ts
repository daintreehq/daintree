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

/** Unavailable answers are cached too, so a signed-out user isn't re-probed per view. */
const CACHE_TTL_MS = 30_000;

let cached: CodexQuotaResult | null = null;
let inFlight: Promise<CodexQuotaResult> | null = null;

function toWindow(raw: unknown): CodexQuotaWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const { usedPercent, windowDurationMins, resetsAt } = raw as Record<string, unknown>;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0) {
    return null;
  }
  if (
    typeof windowDurationMins !== "number" ||
    !Number.isFinite(windowDurationMins) ||
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
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return Promise.resolve(cached);
  if (inFlight) return inFlight;
  const request = fetchCodexQuota().then((result) => {
    cached = result;
    return result;
  });
  inFlight = request;
  void request.finally(() => {
    if (inFlight === request) inFlight = null;
  });
  return request;
}

export function resetCodexQuotaCacheForTests(): void {
  cached = null;
  inFlight = null;
}
