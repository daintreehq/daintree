import dns from "node:dns/promises";
import type { net as ElectronNet } from "electron";
import { MAX_DNTR_BYTES } from "./pluginArchiveConstants.js";
import { isPrivateOrLoopbackHostname } from "../schemas/plugin.js";

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
 */
export type GuardedFetchResult =
  | { ok: true; response: Response }
  | { ok: false; reason: "private-redirect" | "private-host" | "too-many-redirects" };

/** Spec-aligned cap (RFC 7231 recommends a limit; browsers default to ~20). */
const MAX_REDIRECT_HOPS = 5;

/**
 * Resolve `hostname` and report whether ANY answer is a private/loopback/
 * link-local IP. Closes the DNS-rebinding TOCTOU the literal-host guard can't
 * see: a public name that answers with `127.0.0.1` / `169.254.169.254` (cloud
 * metadata) / RFC1918 at connect time would otherwise stream straight into the
 * archive parser. `all: true` returns every A/AAAA record, so a split-horizon
 * answer can't sneak one private address past a public one.
 *
 * Resolution *failure* is not a private-host signal — return false and let
 * `net.fetch` surface the real network error in the caller's vocabulary.
 *
 * A hairline TOCTOU remains: `net.fetch` re-resolves DNS independently, so a
 * TTL-0 record flipped between this lookup and the connect could still differ.
 * Pinning the resolved IP into the connection is the only way to fully close it,
 * which Electron's net stack doesn't expose without a custom resolver; this
 * check shrinks the window to that sub-millisecond race for the local-attacker
 * threat model the SSRF guard targets.
 */
async function resolvesToPrivateAddress(hostname: string): Promise<boolean> {
  let records: Array<{ address: string }>;
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
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
 * hop via `init.signal`. Non-redirect responses (including the final 2xx and
 * any 4xx/5xx) are returned as-is for the caller to inspect.
 */
export async function fetchWithPrivateHostGuard(
  netFetch: typeof ElectronNet.fetch,
  url: string,
  init: RequestInit
): Promise<GuardedFetchResult> {
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    // Re-validate the RESOLVED IP before connecting, not just the literal host:
    // a public hostname can answer with a private/loopback address at connect
    // time (DNS rebinding). The literal-host guard below catches a private
    // `Location`; this catches a private *resolution* of the current hop.
    let currentHost = "";
    try {
      currentHost = new URL(currentUrl).hostname;
    } catch {
      // `currentUrl` is the caller's input or a parsed `Location`; an
      // unparseable value is defensive-only and just skips the DNS pre-check.
    }
    if (currentHost && (await resolvesToPrivateAddress(currentHost))) {
      return { ok: false, reason: "private-host" };
    }
    const response = await netFetch(currentUrl, { ...init, redirect: "manual" });
    // Electron surfaces a manual-mode redirect as an opaqueredirect/3xx with a
    // populated Location header; a normal response has no Location to follow.
    const location =
      response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!location) {
      return { ok: true, response };
    }
    // Drop the redirect response's socket before chasing the next hop.
    await response.body?.cancel().catch(() => {});
    let next: URL;
    try {
      next = new URL(location, currentUrl);
    } catch {
      // A malformed Location can't be followed — treat as a dead end and let
      // the caller's content gates reject the (already-cancelled) response.
      return { ok: true, response };
    }
    if (isPrivateOrLoopbackHostname(next.hostname) || urlHasCredentials(next)) {
      return { ok: false, reason: "private-redirect" };
    }
    currentUrl = next.toString();
  }
  return { ok: false, reason: "too-many-redirects" };
}
