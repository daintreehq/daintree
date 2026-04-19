import { normalizeBrowserUrl as normalizeUrl } from "../../../shared/utils/urlUtils.js";
export {
  normalizeBrowserUrl,
  isLocalhostUrl,
  isImplicitlyAllowedHost,
  type NormalizeResult,
  type NormalizeBrowserUrlOptions,
} from "../../../shared/utils/urlUtils.js";

export function getDisplayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Return a cleaner display format without trailing slash for root paths
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    const search = parsed.search;
    return `${parsed.host}${path}${search}${parsed.hash}`;
  } catch {
    return url;
  }
}

export function extractHostPort(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host;
  } catch {
    return "localhost";
  }
}

export function isValidBrowserUrl(url: string | undefined | null): boolean {
  if (!url || !url.trim()) return false;
  // Pass an empty allow-list so non-loopback hosts return `{ url, requiresConfirmation }`
  // (valid shape) rather than an error. This keeps the webview area visible while the
  // approval prompt is shown instead of reverting to the empty-state placeholder.
  const normalized = normalizeUrl(url, { allowedHosts: [] });
  return !normalized.error && !!normalized.url;
}
