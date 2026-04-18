/**
 * Pattern-based scrubbing for free-text secrets in telemetry and diagnostic
 * bundles. Complements the key-based redaction in `TelemetryService.sanitizeEvent`
 * and `DiagnosticsCollector.redactDeep`.
 *
 * Apply at two boundaries only — Sentry `beforeSend` and DiagnosticsCollector
 * string output. NEVER call on the logger hot write path.
 *
 * All patterns use bounded quantifiers for ReDoS safety. See the
 * `secretScrubber.test.ts` sibling for the `safe-regex2` assertion that
 * guards this invariant.
 */

export const REDACTED = "[REDACTED]";

export interface SecretPattern {
  name: string;
  regex: RegExp;
  replacement: string;
}

// Order matters for overlapping sigils: more-specific patterns must run before
// less-specific ones. `sk-ant-` must precede `sk-` so Anthropic keys aren't
// half-redacted by the OpenAI pattern.
export const PATTERNS: readonly SecretPattern[] = [
  {
    name: "github-pat",
    regex: /\bghp_[A-Za-z0-9_]{36,255}\b/g,
    replacement: REDACTED,
  },
  {
    name: "github-fine-grained-pat",
    regex: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g,
    replacement: REDACTED,
  },
  {
    name: "github-app-token",
    // Covers `ghs_` (app server-to-server), `ghu_` (user-to-server), and `gho_` (OAuth).
    // All three appear in `gh` CLI output and git-credential-manager logs.
    regex: /\bgh[sou]_[A-Za-z0-9_]{36}\b/g,
    replacement: REDACTED,
  },
  {
    name: "anthropic-api-key",
    regex: /\bsk-ant-[A-Za-z0-9\-_]{90,255}\b/g,
    replacement: REDACTED,
  },
  {
    name: "openai-api-key",
    regex: /\bsk-[A-Za-z0-9]{48}\b/g,
    replacement: REDACTED,
  },
  {
    name: "stripe-secret-key",
    regex: /\bsk_(?:live|test)_[0-9a-zA-Z]{24,48}\b/g,
    replacement: REDACTED,
  },
  {
    name: "slack-token",
    regex: /\bxox[abprs]-[A-Za-z0-9-]{10,255}\b/g,
    replacement: REDACTED,
  },
  {
    name: "google-api-key",
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replacement: REDACTED,
  },
  {
    name: "aws-access-key-id",
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: REDACTED,
  },
  {
    name: "aws-secret-access-key",
    // A raw 40-char `[A-Za-z0-9/+=]{40}` regex would collide with base64 chunks,
    // hashes, and random IDs, so this requires the surrounding key name as context.
    // Covers credentials-file (`aws_secret_access_key = ...`), env (`AWS_SECRET_ACCESS_KEY=...`),
    // and STS JSON (`"SecretAccessKey": "..."`) forms. Case-insensitive so it also
    // matches `secret_access_key` alone without the `aws_` prefix.
    regex:
      /\b(?:aws_secret_access_key|secret_access_key|SecretAccessKey)["']?\s{0,8}[:=]\s{0,8}["']?[A-Za-z0-9/+=]{40}["']?/gi,
    replacement: REDACTED,
  },
  {
    name: "npm-token",
    regex: /\bnpm_[A-Za-z0-9]{36}\b/g,
    replacement: REDACTED,
  },
  {
    name: "azure-connection-string",
    regex:
      /DefaultEndpointsProtocol=https;AccountName=[a-zA-Z0-9]{3,24};AccountKey=[a-zA-Z0-9+/]{86}==/g,
    replacement: REDACTED,
  },
  {
    name: "pem-block",
    // CRITICAL: bounded `{1,100000}?` avoids quadratic backtracking on
    // malformed input where `-----END ...-----` is missing. Unbounded
    // `[\s\S]+?` would O(N^2)-scan to EOF per BEGIN occurrence. The upper
    // bound is generous enough for chained certificate bundles (a single
    // fullchain.pem is typically 4-8KB; multi-issuer bundles can reach
    // tens of KB). `safe-regex2` still passes at this bound.
    regex: /-----BEGIN [A-Z ]{1,64}-----[\s\S]{1,100000}?-----END [A-Z ]{1,64}-----/g,
    replacement: REDACTED,
  },
  {
    name: "jwt",
    regex: /\beyJ[A-Za-z0-9\-_]{1,8000}\.[A-Za-z0-9\-_]{1,8000}\.[A-Za-z0-9\-_]{1,8000}\b/g,
    replacement: REDACTED,
  },
  {
    name: "bearer-token",
    regex: /Bearer [A-Za-z0-9\-._~+/]{8,4000}={0,2}/g,
    replacement: `Bearer ${REDACTED}`,
  },
  {
    name: "oauth-query-param",
    // Matches the param at the start of a URL query, within a query (`&key=`),
    // or at the start of a form-urlencoded body (including bodies that appear
    // after a newline in a log line). The `m` flag makes `^` match line starts.
    // `(^|[?&])` keeps the preceding separator in the output so `&other=1` isn't
    // merged into the token. `code` is handled separately below because it is
    // too noisy to anchor at line starts — plain log lines like
    // `code=42 not found` should not be touched.
    regex: /(^|[?&])(access_token|refresh_token|client_secret)=[^&\s]{1,1000}/gm,
    replacement: `$1$2=${REDACTED}`,
  },
  {
    name: "oauth-code-query-param",
    // OAuth `code=` only when clearly inside a URL/form body, i.e. preceded by
    // `?` or `&`. Anchoring at line start would catch unrelated log output like
    // `code=42 not found`.
    regex: /([?&])code=[^&\s]{1,1000}/g,
    replacement: `$1code=${REDACTED}`,
  },
];

/**
 * Scrubs known secret sigils from free text. Idempotent — calling twice yields
 * the same result, because the `[REDACTED]` token contains no secret sigil.
 *
 * All patterns are linear-time with bounded quantifiers; total work is O(N·K)
 * where K is the number of patterns. No pre-truncation is applied, because any
 * length cap would have to slice at an arbitrary byte boundary and would leak
 * the leading bytes of a secret that straddled the cut point. Callers that
 * care about payload size apply their own truncation downstream (e.g.
 * `DiagnosticsCollector.truncateDiagnosticString` at 16 KB, Sentry's own field
 * caps).
 *
 * @param value arbitrary string; may contain log lines, stack traces, or URLs
 * @returns the input with recognized secrets replaced by `[REDACTED]`
 */
export function scrubSecrets(value: string): string {
  if (value.length === 0) return value;

  let out = value;
  for (const { regex, replacement } of PATTERNS) {
    out = out.replace(regex, replacement);
  }

  return out;
}
