/* eslint-disable no-control-regex */
const ALLOWED_HOSTS = ["localhost", "127.0.0.1", "::1"];
const ALLOWED_PROTOCOLS = ["http:", "https:"];
const LOCALHOST_HINTS = ["localhost", "127.0.0.1", "0.0.0.0", "::1"] as const;
// Exclude C0 controls (\x00-\x1f), DEL (\x7f), and C1 controls (\x80-\x9f) from the URL
// path character class, preventing BEL/ESC/8-bit OSC escape bytes from being captured
// as part of the URL when terminals use OSC 8 hyperlinks.
const LOCALHOST_URL_REGEX =
  /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)(:\d+)?([^\s"'<>)\x00-\x1f\x7f\x80-\x9f]*)?/gi;

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

  const hostname = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.includes(hostname)) {
    return { error: `Only localhost URLs are allowed (got "${hostname}")` };
  }

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
