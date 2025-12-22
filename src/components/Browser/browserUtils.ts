const ALLOWED_HOSTS = ["localhost", "127.0.0.1", "::1"];
const ALLOWED_PROTOCOLS = ["http:", "https:"];

export interface NormalizeResult {
  url?: string;
  error?: string;
}

export function normalizeBrowserUrl(input: string): NormalizeResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { error: "URL cannot be empty" };
  }

  let urlString = trimmed;

  // Map 0.0.0.0 to localhost (common dev server output)
  urlString = urlString.replace(/\b0\.0\.0\.0\b/g, "localhost");

  // Auto-prepend http:// if no protocol specified
  if (!urlString.includes("://")) {
    urlString = `http://${urlString}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { error: "Invalid URL format" };
  }

  // Validate protocol
  if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
    return { error: `Protocol "${parsed.protocol}" not allowed. Use http: or https:` };
  }

  // Validate hostname (only allow localhost variants)
  const hostname = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.includes(hostname)) {
    return { error: `Only localhost URLs are allowed (got "${hostname}")` };
  }

  // Strip username/password for security
  parsed.username = "";
  parsed.password = "";

  return { url: parsed.toString() };
}

export function isLocalhostUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    return ALLOWED_HOSTS.includes(hostname) && ALLOWED_PROTOCOLS.includes(parsed.protocol);
  } catch {
    return false;
  }
}

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
  const normalized = normalizeBrowserUrl(url);
  return !normalized.error && !!normalized.url;
}
