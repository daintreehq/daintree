/* eslint-disable no-control-regex */
import ipaddr from "ipaddr.js";

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];
const ALLOWED_PROTOCOLS = ["http:", "https:"];
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

// ipaddr.process() normalizes IPv4-mapped IPv6 to IPv4 before classification,
// so ::ffff:127.0.0.1 → loopback, ::ffff:8.8.8.8 → unicast (denied).
// No explicit "ipv4Mapped" entry needed — process() handles it implicitly.
const PRIVATE_IP_RANGES = new Set(["loopback", "private", "linkLocal", "uniqueLocal"]);

function isPrivateIp(hostname: string): boolean {
  try {
    return PRIVATE_IP_RANGES.has(ipaddr.process(hostname).range());
  } catch {
    return false;
  }
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
  if (isPrivateIp(host)) return true;
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

/**
 * True for the stable dev-preview proxy origin: an `http://*.localhost` subdomain (#9100).
 * Chromium maps every `*.localhost` host to loopback as a Secure Context, so these never reach
 * the public network — but `isLocalhostUrl` (exact loopback only) rejects them, so the
 * dev-preview webview guards must accept this shape separately. Kept HTTP-only on purpose:
 * the proxy serves plain HTTP, and widening to HTTPS would admit a subdomain we never bind.
 * Bare `localhost` is intentionally excluded here (that is `isLocalhostUrl`'s job).
 */
export function isDevPreviewProxyUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:") return false;
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return hostname.endsWith(".localhost") && hostname.length > ".localhost".length;
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
      // Tolerate non-empty params (GNU ls, gcc, systemd emit id=...).
      .replace(/\x1b\]8;[^\x07\x1b]*;([^\x07\x1b]*)\x07([^\x1b]*)\x1b\]8;[^\x07\x1b]*;\x07/g, "$2")
      // OSC 8 hyperlinks — preserve the visible link text (ST terminator: ESC \)
      .replace(/\x1b\]8;[^\x1b]*;([^\x1b]*)\x1b\\([^\x1b]*)\x1b\]8;[^\x1b]*;\x1b\\/g, "$2")
      // DCS / SOS / PM / APC string sequences (7-bit C1) — strip entirely.
      // Payloads like Kitty Graphics protocol, Sixel images, and tmux passthrough
      // can contain "localhost" substrings that would leak as false positives.
      .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, "")
      // DCS / SOS / PM / APC string sequences (8-bit C1 equivalents)
      .replace(/[\x90\x98\x9e\x9f][^\x9c]*\x9c/g, "")
      // Other OSC sequences with BEL terminator (e.g. window title, colour palette)
      .replace(/\x1b\][^\x07\x1b]*\x07/g, "")
      // Other OSC sequences with ST terminator
      .replace(/\x1b\][^\x1b]*\x1b\\/g, "")
      // C1 OSC sequences (8-bit form: 0x9D … terminated by 0x9C ST or BEL)
      .replace(/\x9d[^\x9c\x07]*[\x9c\x07]/g, "")
      // CSI sequences: parameter bytes (0x30-0x3F), optional intermediate bytes
      // (0x20-0x2F), and a final byte (0x40-0x7E covers A-Z, a-z, @, ~, etc.).
      // Accept both the 7-bit introducer (ESC [) and the 8-bit C1 form (0x9B).
      .replace(/(?:\x1b\[|\x9b)[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, "")
  );
}

const LOCALHOST_HINT_REGEX = /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1/i;

function hasLocalhostHint(text: string): boolean {
  return LOCALHOST_HINT_REGEX.test(text);
}

function matchLocalhostUrls(text: string): string[] {
  return Array.from(text.matchAll(LOCALHOST_URL_REGEX), (match) => match[0]);
}

export function extractLocalhostUrls(text: string): string[] {
  if (!text || !hasLocalhostHint(text)) {
    return [];
  }

  const matches = matchLocalhostUrls(text);
  const cleanMatches =
    text.includes("\x1b") || /[\x90\x98\x9e\x9f\x9d]/.test(text)
      ? matchLocalhostUrls(stripAnsiAndOscCodes(text))
      : [];
  const allMatches = [...new Set([...matches, ...cleanMatches])];

  const normalized: string[] = [];
  for (const match of allMatches) {
    const trimmed = match.replace(/[.,;]+$/, "");
    const result = normalizeBrowserUrl(trimmed);
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

/** Longest origin rendered before the label is clipped. Hosts this long are hostile. */
const MAX_ORIGIN_LENGTH = 64;

/**
 * The origin to show as the source of a guest-page dialog, or `null` when there is no
 * origin worth claiming.
 *
 * Returning `null` rather than a placeholder is the point: this label is the user's only
 * evidence about who is speaking, so a guess is worse than an absence. `extractHostPort`
 * answers "localhost" for anything it cannot parse, which is fine for a display URL and
 * wrong here.
 *
 * `host` rather than `hostname` keeps the port, which is what distinguishes two dev
 * servers on the same machine.
 */
export function formatDialogOrigin(url: string | undefined | null): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    // No bidi-control stripping here on purpose: a host carrying one fails WHATWG URL
    // parsing outright, so it never reaches this line — it leaves through the `catch`
    // above as `null`. Stripping would be a defence that can never fire.
    const host = parsed.host;
    if (!host) return null;
    return host.length > MAX_ORIGIN_LENGTH ? `${host.slice(0, MAX_ORIGIN_LENGTH)}…` : host;
  }
  if (parsed.protocol === "file:") return "Local file";
  // data:, blob:, about:, and anything else carry no host a user could act on.
  return null;
}
