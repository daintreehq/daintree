import { normalizeBrowserUrl as normalizeUrl } from "../../../shared/utils/urlUtils.js";
export {
  normalizeBrowserUrl,
  isLocalhostUrl,
  type NormalizeResult,
} from "../../../shared/utils/urlUtils.js";

export function getDisplayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Return a cleaner display format without trailing slash for root paths
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    const search = parsed.search;
    return `${parsed.host}${path}${search}`;
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
  const normalized = normalizeUrl(url);
  return !normalized.error && !!normalized.url;
}
