import dns from "node:dns/promises";
import type { net as ElectronNet } from "electron";
import { MAX_DNTR_BYTES } from "./pluginArchiveConstants.js";
import { isPrivateOrLoopbackHostname } from "../schemas/pluginIdentifiers.js";

export { MAX_DNTR_BYTES };

/**
 * Single download deadline shared by both `.dntr`-fetch paths — install-from-URL
 * (F24) and the manual update check (#9297). Set to the more lenient 30s: a
 * slow-but-valid server that passes the update check must not then fail the
 * follow-up reinstall, and vice-versa. Tightening install from 10s to 30s only
 * relaxes the gate, it never breaks a server that would otherwise have served a
 * valid archive.
 */
export const PLUGIN_DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * Union of the archive MIME types either download path is willing to accept.
 * `application/zip` is matched with or without a `; charset=…` parameter; the
 * remaining types are exact. Keeping a single predicate means a server that
 * passes one path's content-type gate passes the other's too.
 */
export function acceptedMime(contentType: string): boolean {
  const normalized = contentType.toLowerCase().trim();
  if (normalized.length === 0) return false;
  // An exact or `;`-prefixed match avoids near-misses like `application/zipper`.
  const matches = (type: string) => normalized === type || normalized.startsWith(`${type};`);
  return (
    matches("application/zip") ||
    matches("application/x-dntr") ||
    matches("application/octet-stream") ||
    matches("application/x-zip")
  );
}

/**
 * `.dntr`-suffix fallback for a URL whose server didn't send a recognised
 * archive MIME. Checked against the original user URL's pathname because
 * `response.url` is unreliable in Electron's net stack.
 */
export function dntrSuffixOk(pathname: string): boolean {
  return pathname.toLowerCase().endsWith(".dntr");
}

/**
 * Reject a URL that embeds credentials (`https://user:pass@host`). Both download
 * entry points reuse this so a pasted credentialed URL is never fetched and —
 * critically — never persisted as installer `originalUrl` provenance, where it
 * would later be re-fetched and surfaced in Settings. Rejecting (rather than
 * silently stripping) keeps the failure visible to the user.
 */
export function urlHasCredentials(parsed: URL): boolean {
  return parsed.username !== "" || parsed.password !== "";
}

/**
 * Outcome of {@link fetchWithPrivateHostGuard}: either a settled {@link Response}
 * or a structured rejection reason the caller maps to its own error vocabulary.
 * `private-redirect` means a hop's `Location` resolved to a private/loopback/
 * link-local host and the chain was abandoned before the body was read.
 * `private-host` means a hop's hostname *resolved via DNS* to a private/
 * loopback/link-local IP (the DNS-rebinding case the literal-host check misses).
 * `insecure-protocol` means a hop wasn't `https:` — e.g. a redirect that
 * downgrades `https→http`, which would deliver the archive over cleartext.
 */
export type GuardedFetchResult =
  /** `url` is the hop that answered: `response.url` is unreliable in Electron's net stack. */
  | { ok: true; response: Response; url: string }
  | {
      ok: false;
      reason:
        | "private-redirect"
        | "private-host"
        | "insecure-protocol"
        | "too-many-redirects"
        | "disallowed-host";
    };

/** Spec-aligned cap (RFC 7231 recommends a limit; browsers default to ~20). */
const MAX_REDIRECT_HOPS = 5;

type LookupAnswer = Array<{ address: string }>;

/**
 * `dns.lookup` is a blocking `getaddrinfo` on libuv's threadpool, which main's
 * `fs` work shares, and nothing can cancel it: a caller that gives up only
 * stops waiting. So lookups still running are tracked by hostname until they
 * settle: a retry of the same host joins the running lookup instead of
 * stacking another, and no more than {@link MAX_OUTSTANDING_LOOKUPS} run at
 * once, so cancelled downloads against a stalled resolver can't fill the pool.
 * Entries leave the map when their lookup settles; no answer is cached.
 */
const outstandingLookups = new Map<string, Promise<LookupAnswer>>();
const MAX_OUTSTANDING_LOOKUPS = 2;
const lookupSlotWaiters = new Set<() => void>();

/** Settle with `promise`, or reject with `signal.reason` as soon as it aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

/** Resolve once some outstanding lookup settles, or reject when `signal` aborts. */
function waitForLookupSlot(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      lookupSlotWaiters.delete(wake);
      reject(signal!.reason);
    };
    const wake = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    lookupSlotWaiters.add(wake);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function lookupAll(hostname: string, signal: AbortSignal | undefined): Promise<LookupAnswer> {
  for (;;) {
    signal?.throwIfAborted();
    const running = outstandingLookups.get(hostname);
    if (running) return untilAborted(running, signal);
    if (outstandingLookups.size < MAX_OUTSTANDING_LOOKUPS) break;
    await waitForLookupSlot(signal);
  }
  const lookup = dns.lookup(hostname, { all: true }).finally(() => {
    outstandingLookups.delete(hostname);
    // Every waiter rechecks: one may now join a lookup for its own host, the
    // rest go back to waiting.
    const waiters = [...lookupSlotWaiters];
    lookupSlotWaiters.clear();
    for (const wake of waiters) wake();
  });
  // Every caller may have given up by the time a lookup fails.
  lookup.catch(() => {});
  outstandingLookups.set(hostname, lookup);
  return untilAborted(lookup, signal);
}

/**
 * Resolve `hostname` and report whether ANY answer is a private/loopback/
 * link-local IP. Closes the DNS-rebinding TOCTOU the literal-host guard can't
 * see: a public name that answers with `127.0.0.1` / `169.254.169.254` (cloud
 * metadata) / RFC1918 at connect time would otherwise stream straight into the
 * archive parser. `all: true` returns every A/AAAA record, so a split-horizon
 * answer can't sneak one private address past a public one.
 *
 * Resolution *failure* is not a private-host signal — return false and let
 * `net.fetch` surface the real network error in the caller's vocabulary. An
 * aborted `signal` is not a failure: it rejects with `signal.reason` the
 * moment it fires, even though the lookup itself runs on to completion.
 *
 * A hairline TOCTOU remains: `net.fetch` re-resolves DNS independently, so a
 * TTL-0 record flipped between this lookup and the connect could still differ.
 * Pinning the resolved IP into the connection is the only way to fully close it,
 * which Electron's net stack doesn't expose without a custom resolver; this
 * check shrinks the window to that sub-millisecond race for the local-attacker
 * threat model the SSRF guard targets.
 */
export async function resolvesToPrivateAddress(
  hostname: string,
  signal?: AbortSignal
): Promise<boolean> {
  let records: LookupAnswer;
  try {
    records = await lookupAll(hostname, signal);
  } catch {
    signal?.throwIfAborted();
    return false;
  }
  return records.some((r) => isPrivateOrLoopbackHostname(r.address));
}

/**
 * `net.fetch` with manual redirect following so EVERY hop's host is revalidated
 * through {@link isPrivateOrLoopbackHostname}. The original-host guard alone is
 * bypassable: a public URL can 30x-redirect to loopback/link-local/RFC1918
 * (SSRF). Following manually lets us reject a private `Location` before the body
 * is ever read.
 *
 * Beyond the literal-host check, every hop's hostname is resolved via DNS and
 * the resolved IP is re-validated through {@link resolvesToPrivateAddress} —
 * closing the DNS-rebinding TOCTOU where a public hostname answers with a
 * private/loopback/link-local address at connect time (cloud-metadata SSRF).
 * A sub-millisecond residual remains because `net.fetch` re-resolves DNS itself;
 * see {@link resolvesToPrivateAddress} for why full closure needs a custom
 * resolver Electron's net stack doesn't expose.
 *
 * The caller still owns the timeout/size signal — it's threaded through every
 * hop via `init.signal`, and it governs each hop's DNS check as well as its
 * fetch: once it aborts, the call rejects with `signal.reason` and no further
 * `netFetch` starts, so a caller tells a user cancel from a deadline the same
 * way whichever step was running. Non-redirect responses (including the final
 * 2xx and any 4xx/5xx) are returned as-is for the caller to inspect.
 *
 * `isAllowedHost`, when given, must accept every hop's hostname — a caller
 * bound to a declared host list refuses a redirect off it before connecting.
 * `hops.isAllowedUrl` is the same refusal against the whole URL, and
 * `hops.initFor` lets a caller vary the request per hop — dropping a
 * provider's token once a redirect leaves its origin.
 */
export async function fetchWithPrivateHostGuard(
  netFetch: typeof ElectronNet.fetch,
  url: string,
  init: RequestInit,
  isAllowedHost?: (hostname: string) => boolean,
  hops?: {
    isAllowedUrl?: (hopUrl: URL) => boolean;
    initFor?: (hopUrl: URL) => RequestInit;
  }
): Promise<GuardedFetchResult> {
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    init.signal?.throwIfAborted();
    // Parse the current hop once to enforce two invariants before connecting:
    // (1) it must stay https — a redirect that downgrades to http would deliver
    // the archive over cleartext (MITM-substitutable); (2) re-validate the
    // RESOLVED IP, not just the literal host, since a public hostname can answer
    // with a private/loopback address at connect time (DNS rebinding). The
    // literal-host guard below catches a private `Location`; this catches a
    // private *resolution* of the current hop.
    let parsedHop: URL | null = null;
    try {
      parsedHop = new URL(currentUrl);
    } catch {
      // `currentUrl` is the caller's input or a parsed `Location`; an
      // unparseable value is defensive-only and just skips these pre-checks.
    }
    if (parsedHop && parsedHop.protocol !== "https:") {
      return { ok: false, reason: "insecure-protocol" };
    }
    if (isAllowedHost && (!parsedHop || !isAllowedHost(parsedHop.hostname))) {
      return { ok: false, reason: "disallowed-host" };
    }
    if (hops?.isAllowedUrl && (!parsedHop || !hops.isAllowedUrl(parsedHop))) {
      return { ok: false, reason: "disallowed-host" };
    }
    const hopInit = hops?.initFor && parsedHop ? hops.initFor(parsedHop) : init;
    const signal = hopInit.signal ?? init.signal ?? undefined;
    if (parsedHop && (await resolvesToPrivateAddress(parsedHop.hostname, signal))) {
      return { ok: false, reason: "private-host" };
    }
    // The answer and an abort can land in the same tick.
    signal?.throwIfAborted();
    const response = await netFetch(currentUrl, { ...hopInit, redirect: "manual" });
    // Electron surfaces a manual-mode redirect as an opaqueredirect/3xx with a
    // populated Location header; a normal response has no Location to follow.
    const location =
      response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!location) {
      return { ok: true, response, url: currentUrl };
    }
    // Drop the redirect response's socket before chasing the next hop.
    await response.body?.cancel().catch(() => {});
    let next: URL;
    try {
      next = new URL(location, currentUrl);
    } catch {
      // A malformed Location can't be followed — treat as a dead end and let
      // the caller's content gates reject the (already-cancelled) response.
      return { ok: true, response, url: currentUrl };
    }
    if (isPrivateOrLoopbackHostname(next.hostname) || urlHasCredentials(next)) {
      return { ok: false, reason: "private-redirect" };
    }
    currentUrl = next.toString();
  }
  return { ok: false, reason: "too-many-redirects" };
}
