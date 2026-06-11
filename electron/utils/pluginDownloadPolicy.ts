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
 */
export type GuardedFetchResult =
  | { ok: true; response: Response }
  | { ok: false; reason: "private-redirect" | "too-many-redirects" };

/** Spec-aligned cap (RFC 7231 recommends a limit; browsers default to ~20). */
const MAX_REDIRECT_HOPS = 5;

/**
 * `net.fetch` with manual redirect following so EVERY hop's host is revalidated
 * through {@link isPrivateOrLoopbackHostname}. The original-host guard alone is
 * bypassable: a public URL can 30x-redirect to loopback/link-local/RFC1918
 * (SSRF). Following manually lets us reject a private `Location` before the body
 * is ever read.
 *
 * This is a literal-host guard only — a DNS-rebinding TOCTOU remains (a public
 * hostname that resolves to a private address at connect time is not caught
 * here, since `net.fetch` resolves DNS internally). That residual is the same
 * gap documented on the manifest `allowedUrls` validator and is out of scope
 * for download-time validation; full mitigation needs a custom resolver.
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
