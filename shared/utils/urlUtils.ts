/* eslint-disable no-control-regex */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];
const ALLOWED_PROTOCOLS = ["http:", "https:"];
const LOCALHOST_HINTS = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"] as const;
// Exclude C0 controls (\x00-\x1f), DEL (\x7f), and C1 controls (\x80-\x9f) from the URL
// path character class, preventing BEL/ESC/8-bit OSC escape bytes from being captured
// as part of the URL when terminals use OSC 8 hyperlinks.
const LOCALHOST_URL_REGEX =
  /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)(:\d+)?([^\s"'<>)\x00-\x1f\x7f\x80-\x9f]*)?/gi;

// RFC-reserved TLDs that cannot be delegated in public DNS (RFC 6761, RFC 6762) plus
// `.internal` reserved by ICANN in July 2024 for private-use namespaces.
const LOCAL_TLD_SUFFIXES = [".localhost", ".test", ".local", ".internal"] as const;

export interface NormalizeResult {
  url?: string;
  error?: string;
  /** Set when the URL is syntactically valid but points to a host that requires user approval. */
  requiresConfirmation?: boolean;
  /** The lowercase hostname the user must approve (populated when requiresConfirmation is true). */
  hostname?: string;
}

export interface NormalizeBrowserUrlOptions {
  /** Hostnames the user has already approved for this project. When omitted, only loopback is allowed. */
  allowedHosts?: string[];
}

function stripBrackets(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "");
}

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.includes(hostname);
}

function isRfc1918Ipv4(hostname: string): boolean {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const a = Number(match[1]);
  const b = Number(match[2]);
  const c = Number(match[3]);
  const d = Number(match[4]);
  if ([a, b, c, d].some((o) => !Number.isFinite(o) || o < 0 || o > 255)) return false;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 link-local
  if (a === 169 && b === 254) return true;
  return false;
}

function isPrivateIpv6(hostname: string): boolean {
  // Link-local (fe80::/10) or unique-local (fc00::/7). Loopback ::1 handled by isLoopbackHost.
  if (!hostname.includes(":")) return false;
  const lower = hostname.toLowerCase();
  if (
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  ) {
    return true;
  }
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  return false;
}

/**
 * Hostnames that should be allowed without prompting the user. Covers RFC-reserved
 * local TLDs and private IP ranges that cannot route on the public internet.
 */
export function isImplicitlyAllowedHost(hostname: string): boolean {
  if (!hostname) return false;
  const host = stripBrackets(hostname.toLowerCase());
  if (isLoopbackHost(host)) return true;
  for (const suffix of LOCAL_TLD_SUFFIXES) {
    if (host === suffix.slice(1) || host.endsWith(suffix)) return true;
  }
  if (isRfc1918Ipv4(host)) return true;
  if (isPrivateIpv6(host)) return true;
  return false;
}

export function normalizeBrowserUrl(
  input: string,
  options?: NormalizeBrowserUrlOptions
): NormalizeResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { error: "URL cannot be empty" };
  }

  let urlString = trimmed;

  urlString = urlString.replace(/\b0\.0\.0\.0\b/g, "localhost");

  if (!urlString.includes("://")) {
    urlString = `http://${urlString}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { error: "Invalid URL format" };
  }

  if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
    return { error: `Protocol "${parsed.protocol}" not allowed. Use http: or https:` };
  }

  parsed.username = "";
  parsed.password = "";

  const hostname = stripBrackets(parsed.hostname.toLowerCase());
  const strict = !options;
  if (strict) {
    if (!isLoopbackHost(hostname)) {
      return { error: `Only localhost URLs are allowed (got "${hostname}")` };
    }
    return { url: parsed.toString() };
  }

  if (isImplicitlyAllowedHost(hostname)) {
    return { url: parsed.toString() };
  }

  const approved = options?.allowedHosts ?? [];
  if (approved.some((h) => h.toLowerCase() === hostname)) {
    return { url: parsed.toString() };
  }

  return {
    url: parsed.toString(),
    requiresConfirmation: true,
    hostname,
  };
}

export function isLocalhostUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return LOOPBACK_HOSTS.includes(hostname) && ALLOWED_PROTOCOLS.includes(parsed.protocol);
  } catch {
    return false;
  }
}

export function isSafeNavigationUrl(url: string): boolean {
  try {
    const protocol = new URL(url.trim()).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function stripAnsiAndOscCodes(text: string): string {
  return (
    text
      // OSC 8 hyperlinks — preserve the visible link text (BEL terminator).
      // Exclude \x1b from the params so this pattern cannot span across an
      // adjacent ST-terminated sequence and over-strip surrounding content.
      .replace(/\x1b\]8;;[^\x07\x1b]*\x07([^\x1b]*)\x1b\]8;;\x07/g, "$1")
      // OSC 8 hyperlinks — preserve the visible link text (ST terminator: ESC \)
      .replace(/\x1b\]8;;[^\x1b]*\x1b\\([^\x1b]*)\x1b\]8;;\x1b\\/g, "$1")
      // Other OSC sequences with BEL terminator (e.g. window title, colour palette)
      .replace(/\x1b\][^\x07\x1b]*\x07/g, "")
      // Other OSC sequences with ST terminator
      .replace(/\x1b\][^\x1b]*\x1b\\/g, "")
      // C1 OSC sequences (8-bit form: 0x9D … terminated by 0x9C ST or BEL)
      .replace(/\x9d[^\x9c\x07]*[\x9c\x07]/g, "")
      // CSI sequences: parameter bytes (0x30-0x3F), optional intermediate bytes
      // (0x20-0x2F), and a final byte (0x40-0x7E covers A-Z, a-z, @, ~, etc.).
      .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, "")
  );
}

function hasLocalhostHint(text: string): boolean {
  const lower = text.toLowerCase();
  for (const hint of LOCALHOST_HINTS) {
    if (lower.includes(hint)) {
      return true;
    }
  }
  return false;
}

function matchLocalhostUrls(text: string): string[] {
  LOCALHOST_URL_REGEX.lastIndex = 0;
  return Array.from(text.matchAll(LOCALHOST_URL_REGEX), (match) => match[0]);
}

export function extractLocalhostUrls(text: string): string[] {
  if (!text || !hasLocalhostHint(text)) {
    return [];
  }

  const matches = matchLocalhostUrls(text);
  const cleanMatches = text.includes("\x1b") ? matchLocalhostUrls(stripAnsiAndOscCodes(text)) : [];
  const allMatches = [...new Set([...matches, ...cleanMatches])];

  const normalized: string[] = [];
  for (const match of allMatches) {
    const result = normalizeBrowserUrl(match);
    if (result.url) {
      normalized.push(result.url);
    }
  }

  return [...new Set(normalized)];
}

export function looksLikeOAuthUrl(url: string): boolean {
  try {
    const params = new URL(url).searchParams;
    const hasClientId = params.has("client_id");
    const hasResponseType = params.has("response_type");
    const hasRedirectUri = params.has("redirect_uri");
    const hasCodeChallenge = params.has("code_challenge");
    return (
      hasClientId && (hasResponseType || hasRedirectUri) && (hasResponseType || hasCodeChallenge)
    );
  } catch {
    return false;
  }
}
