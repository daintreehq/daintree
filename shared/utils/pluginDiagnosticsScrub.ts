import type { PluginLogLine } from "../types/plugin.js";

const REDACTED = "[REDACTED]";

/**
 * Secret patterns scrubbed from plugin log lines before they leave the main
 * process in a diagnostics export. Deliberately shaped (provider-prefix or
 * key-name anchored) rather than length-based — a generic `[A-Za-z0-9]{32,}`
 * catch-all would shred git SHAs, UUIDs, and base64 chunks that are safe and
 * useful to a maintainer. The raw ring buffer is never scrubbed; only the
 * export pass runs these.
 */
const SECRET_PATTERNS: RegExp[] = [
  // GitHub tokens (personal, oauth, user-to-server, server-to-server, refresh).
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  // OpenAI keys, including project / service-account prefixes.
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g,
  // AWS access key ids.
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[A-Z0-9]{16}\b/g,
  // JSON Web Tokens (header.payload.signature).
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
];

// Authorization: Bearer <token> — keep the scheme, drop the credential.
const BEARER_PATTERN = /(authorization\s*[:=]\s*bearer\s+)([A-Za-z0-9._\-+/=]+)/gi;

// "token": "value" / "api_key": "value" etc. in JSON-ish text — keep the key,
// redact the value. Matches single or double quotes.
const JSON_SECRET_PATTERN =
  /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|secret|password|passwd|pwd)["']?\s*[:=]\s*["'])([^"']{4,})(["'])/gi;

/**
 * Replace common secret formats in `text` with `[REDACTED]`. Idempotent and
 * order-independent across the pattern set.
 */
export function scrubSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  out = out.replace(BEARER_PATTERN, (_m, prefix: string) => `${prefix}${REDACTED}`);
  out = out.replace(
    JSON_SECRET_PATTERN,
    (_m, prefix: string, _value: string, suffix: string) => `${prefix}${REDACTED}${suffix}`
  );
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * Scrub a single ring-buffer line for export — both the message and the
 * serialized `fields` string pass through {@link scrubSecrets}. Returns a new
 * object; the input line (the raw buffer entry) is never mutated.
 */
export function scrubLogLine(line: PluginLogLine): PluginLogLine {
  return {
    timestamp: line.timestamp,
    level: line.level,
    message: scrubSecrets(line.message),
    ...(line.fields !== undefined ? { fields: scrubSecrets(line.fields) } : {}),
  };
}
