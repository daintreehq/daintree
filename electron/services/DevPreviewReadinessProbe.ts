import http from "node:http";
import https from "node:https";
import type {
  DevPreviewReadinessOutcome,
  DevPreviewReadinessRetryCause,
} from "../../shared/types/ipc/devPreview.js";

export const READINESS_TIMEOUT_MS = 30000;
export const READINESS_POLL_INTERVAL_MS = 500;
export const READINESS_REQUEST_TIMEOUT_MS = 5000;

interface ProbeResult {
  outcome: DevPreviewReadinessOutcome;
  status?: number;
  cause?: DevPreviewReadinessRetryCause;
}

/** One settled request, reported to the caller for the diagnostics timeline. */
export interface ReadinessAttempt {
  url: string;
  outcome: DevPreviewReadinessOutcome;
  status?: number;
  cause?: DevPreviewReadinessRetryCause;
  /** 1-based poll round this request belonged to. */
  attempt: number;
  elapsedMs: number;
  /** Budget left when the request settled; 0 once the deadline has passed. */
  remainingMs: number;
}

function buildReadinessUrls(url: string): string[] | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const urls = [parsed.toString()];
  if (parsed.hostname === "localhost") {
    for (const hostname of ["127.0.0.1", "[::1]"]) {
      const candidate = new URL(parsed.toString());
      candidate.hostname = hostname;
      urls.push(candidate.toString());
    }
  }

  return [...new Set(urls)];
}

/**
 * Issue one readiness GET and classify what came back.
 *
 * A final HTTP response proves the server is bound and serving, so 401/403/404
 * resolve as `reachable` rather than looping until the deadline — an auth-gated
 * dev server or one with no route at `/` is a working server, and interpreting
 * its status is the webview's job, not the probe's. 5xx stays separate because
 * frameworks answer 500 from a shell that is still compiling.
 *
 * `timeoutMs` is clamped by the caller to the budget left, so a single request
 * can never outlive the overall deadline.
 */
async function probeUrl(
  url: string,
  useHttps: boolean,
  signal: AbortSignal,
  timeoutMs: number
): Promise<ProbeResult> {
  const requestModule = useHttps ? https : http;

  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    let onAbort: () => void = () => {};
    const settle = (value: ProbeResult) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const retry = (cause: DevPreviewReadinessRetryCause) => settle({ outcome: "retry", cause });

    try {
      const req = requestModule.request(
        url,
        {
          method: "GET",
          timeout: timeoutMs,
          ...(useHttps ? { rejectUnauthorized: false } : {}),
        },
        (res) => {
          res.resume();
          const status = res.statusCode ?? 0;
          if (status >= 500 && status < 600) {
            settle({ outcome: "server-error", status });
          } else if (status >= 200 && status < 500) {
            settle({ outcome: "reachable", status });
          } else {
            // 1xx and anything out of range is not a completed final response;
            // never claim readiness from it.
            settle({ outcome: "retry", status, cause: "bad-status" });
          }
        }
      );
      onAbort = () => {
        req.destroy();
        retry("connection-error");
      };
      req.on("error", () => retry("connection-error"));
      req.on("timeout", () => {
        req.destroy();
        retry("request-timeout");
      });
      if (signal.aborted) {
        req.destroy();
        retry("connection-error");
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
        req.end();
      }
    } catch {
      retry("connection-error");
    }
  });
}

/**
 * Poll a dev server until it answers, or until `timeoutMs` is genuinely spent.
 *
 * The budget is a real deadline, not a between-rounds check: it is composed
 * once into an AbortSignal that every request shares, and each request's own
 * timeout is clamped to the time left, so a round of slow candidates cannot
 * overshoot the way a fixed 5s-per-candidate round could.
 *
 * A 5xx latches `hasSeen5xx` and requires a confirming success in a *later*
 * round — a Next.js 500 served from a compiling shell must not flip the panel
 * to "running" (#8294, #9317). The confirming round ends the candidate loop so
 * two loopback aliases in one pass cannot satisfy both halves back to back.
 */
export interface WaitForServerReadyOptions {
  onAttempt?: (attempt: ReadinessAttempt) => void;
  /**
   * Seeds the 5xx latch from an earlier probe of the same launch. A ready
   * marker or a new URL aborts the in-flight wait and starts another one;
   * without this the replacement forgets that the server has been serving a
   * compiling shell, and its next transient 200 publishes "running" — the exact
   * bug #8294 and #9317 fixed.
   */
  seenServerError?: boolean;
}

export async function waitForServerReady(
  url: string,
  signal: AbortSignal,
  timeoutMs = READINESS_TIMEOUT_MS,
  options: WaitForServerReadyOptions = {}
): Promise<boolean> {
  const { onAttempt, seenServerError = false } = options;
  const deadline = performance.now() + timeoutMs;
  let useHttps: boolean;
  const urls = buildReadinessUrls(url);
  if (!urls) return false;

  try {
    useHttps = new URL(url).protocol === "https:";
  } catch {
    return false;
  }

  if (signal.aborted) return false;

  // Composed once, not per request: every candidate and every round shares this
  // signal, so the deadline fires exactly once and cancellation from the caller
  // (an output error aborting the in-flight poll) still propagates.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const probeSignal = AbortSignal.any([signal, timeoutSignal]);

  let hasSeen5xx = seenServerError;
  let awaitingConfirmation = false;
  let attempt = 0;
  // Last reported outcome per candidate. A poll against a refused port settles
  // identically every 500ms; reporting only changes keeps the timeline to one
  // row per candidate instead of flooding a 100-event ring.
  const lastReported = new Map<string, string>();

  const report = (candidateUrl: string, result: ProbeResult, elapsedMs: number) => {
    if (!onAttempt) return;
    const key = `${result.outcome}:${result.status ?? ""}:${result.cause ?? ""}`;
    if (lastReported.get(candidateUrl) === key) return;
    lastReported.set(candidateUrl, key);
    onAttempt({
      url: candidateUrl,
      outcome: result.outcome,
      ...(result.status !== undefined ? { status: result.status } : {}),
      ...(result.cause !== undefined ? { cause: result.cause } : {}),
      attempt,
      elapsedMs: Math.round(elapsedMs),
      remainingMs: Math.max(0, Math.round(deadline - performance.now())),
    });
  };

  while (performance.now() < deadline) {
    if (signal.aborted) return false;
    attempt += 1;

    for (const candidateUrl of urls) {
      if (signal.aborted) return false;
      // Clamp each request to what is actually left. Without this a round of
      // three candidates could spend 15s against a 30s budget that had 2s left.
      const budget = deadline - performance.now();
      if (budget <= 0) break;
      const requestTimeout = Math.min(READINESS_REQUEST_TIMEOUT_MS, Math.ceil(budget));

      const startedAt = performance.now();
      const result = await probeUrl(candidateUrl, useHttps, probeSignal, requestTimeout);
      report(candidateUrl, result, performance.now() - startedAt);

      if (result.outcome === "server-error") {
        hasSeen5xx = true;
        awaitingConfirmation = false;
      } else if (result.outcome === "reachable") {
        if (!hasSeen5xx || awaitingConfirmation) {
          if (signal.aborted) return false;
          return true;
        }
        // First success after a 5xx only arms the confirmation; a later
        // observation has to confirm it. Deliberately NOT breaking out of the
        // round: skipping the remaining candidates starves an alias that is the
        // only one answering when a sibling 5xxes every round, and the address
        // families must all stay reachable (#9752).
        awaitingConfirmation = true;
      }
    }

    if (signal.aborted) return false;

    // Sleep only up to the caller's deadline. A flat poll-interval wait
    // overshoots short timeouts by nearly a full interval — waitForServerReady(
    // url, signal, 100) used to take 500ms+ to report failure — and burns that
    // time on a round the loop condition is about to reject anyway.
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    const sleepMs = Math.min(READINESS_POLL_INTERVAL_MS, remaining);
    // A wait that consumes the rest of the budget ends the loop on its own
    // terms rather than on a clock reading taken after it. Node schedules
    // timers off libuv's millisecond-granular loop time, which is cached per
    // iteration and drifts from `performance.now()`, so re-deriving "is the
    // deadline past?" after waking could report a hair of budget left and buy
    // one extra unbudgeted round. That is a real overshoot in production and
    // was a CI flake here.
    const isFinalWait = remaining <= READINESS_POLL_INTERVAL_MS;

    try {
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        const onAbort = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }, sleepMs);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    } catch {
      return false;
    }

    if (isFinalWait) break;
  }

  return false;
}
