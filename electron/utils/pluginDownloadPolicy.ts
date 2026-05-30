import { MAX_DNTR_BYTES } from "../services/PluginArchive.js";

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
