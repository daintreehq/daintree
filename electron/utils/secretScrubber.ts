/**
 * Pattern-based scrubbing for free-text secrets in telemetry, diagnostic
 * bundles, log files, and IPC error envelopes. Complements the key-based
 * redaction in `TelemetryService.sanitizeEvent` and `DiagnosticsCollector.redactDeep`.
 *
 * Apply at outbound boundaries only — never on the in-memory `logBuffer` path
 * that feeds the diagnostics dock. Approved call sites:
 *   1. Sentry `beforeSend` (TelemetryService)
 *   2. DiagnosticsCollector string output
 *   3. Logger file-write (`writeToLogFile`) and console-mirror in `emit`/`emitError`
 *   4. Main-process emergency crash log (`emergencyLogMainFatal`)
 *   5. Pty-host emergency crash log (`emergencyLogFatal`)
 *   6. IPC error envelope (`sanitizeErrorForRenderer` in setup/security.ts)
 *   7. WorktreeLifecycleService tail-output scrub before renderer
 *   8. AgentInstallService progress stdout/stderr scrubbing
 *   9. AgentHelpService command output scrubbing
 *  10. AgentVersionService error-message scrubbing
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
    name: "gitlab-personal-token",
    regex: /\bglpat-[0-9a-zA-Z_-]{20}\b/g,
    replacement: REDACTED,
  },
  {
    name: "gitlab-deploy-token",
    regex: /\bgldt-[0-9a-zA-Z_-]{20}\b/g,
    replacement: REDACTED,
  },
  {
    name: "anthropic-api-key",
    // Also covers `sk-ant-oat01-` OAuth setup tokens — the `oat01-` infix is
    // within the `[A-Za-z0-9\-_]` charset and the body length falls inside {90,255}.
    regex: /\bsk-ant-[A-Za-z0-9\-_]{90,255}\b/g,
    replacement: REDACTED,
  },
  {
    name: "openai-project-key",
    // MUST precede `openai-api-key` so the shorter `sk-` prefix doesn't
    // greedily consume `sk-proj-`/`sk-svcacct-` and leave the body unredacted.
    regex: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{100,256}\b/g,
    replacement: REDACTED,
  },
  {
    name: "openrouter-api-key",
    // MUST precede `openai-api-key` so the generic `sk-` prefix doesn't
    // greedily consume `sk-or-v1-` and leave the body unredacted.
    regex: /\bsk-or-v1-[0-9a-f]{55,70}\b/g,
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
    name: "stripe-restricted-key",
    regex: /\brk_(?:live|test)_[0-9a-zA-Z]{24,48}\b/g,
    replacement: REDACTED,
  },
  {
    name: "slack-access-token",
    // MUST precede `slack-refresh-token` (more-specific `xoxe.xox[bp]-`
    // before broader `xoxe-`) AND `slack-token` (`xox[abprs]-` would
    // greedily consume `xox[bp]-` from `xoxe.xox[bp]-` tokens).
    regex: /\bxoxe\.xox[bp]-[A-Za-z0-9-]{160,180}\b/g,
    replacement: REDACTED,
  },
  {
    name: "slack-refresh-token",
    regex: /\bxoxe-[A-Z0-9-]{140,150}\b/g,
    replacement: REDACTED,
  },
  {
    name: "slack-token",
    regex: /\bxox[abprs]-[A-Za-z0-9-]{10,255}\b/g,
    replacement: REDACTED,
  },
  {
    name: "slack-app-token",
    // `xapp-` covers Socket Mode and Audit Logs API tokens (post-Dec-2020).
    regex: /\bxapp-[A-Za-z0-9-]{90,140}\b/g,
    replacement: REDACTED,
  },
  {
    name: "google-api-key",
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replacement: REDACTED,
  },
  {
    name: "aws-access-key-id",
    // Covers AKIA (IAM long-term), ASIA (STS short-term), and ABIA (STS variant).
    regex: /\bA[SKB]IA[0-9A-Z]{16}\b/g,
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
    name: "digitalocean-token",
    // Covers `dop_v1_` (personal), `doo_v1_` (OAuth), `dor_v1_` (refresh).
    regex: /\bdo[por]_v1_[A-Za-z0-9]{64}\b/g,
    replacement: REDACTED,
  },
  {
    name: "atlassian-token",
    // `ATATT3x` (API tokens) and `ATCTT3x` (Connect/access tokens). Body is
    // base64url-ish and frequently ends with `=` padding, so no trailing `\b`
    // (it would fail to match after a non-word `=` char). Upper bound 512 so
    // unusually long tokens don't leave a tail visible.
    regex: /\bAT[AC]TT3x[A-Za-z0-9+/=_-]{120,512}/g,
    replacement: REDACTED,
  },
  {
    name: "cloudflare-token",
    // `cfat_` (account), `cfut_` (user), `cfk_` (global key). 40-char body
    // followed by an 8-char hex checksum.
    regex: /\bcf(?:at|ut|k)_[A-Za-z0-9]{40}[0-9a-f]{8}\b/g,
    replacement: REDACTED,
  },
  {
    name: "supabase-key",
    regex: /\bsb_(?:publishable|secret)_[A-Za-z0-9_]{32,64}\b/g,
    replacement: REDACTED,
  },
  {
    name: "replicate-api-token",
    regex: /\br8_[A-Za-z0-9]{35,40}\b/g,
    replacement: REDACTED,
  },
  {
    name: "huggingface-api-token",
    regex: /\bhf_[A-Za-z0-9]{25,40}\b/g,
    replacement: REDACTED,
  },
  {
    name: "groq-api-key",
    regex: /\bgsk_[A-Za-z0-9]{40,64}\b/g,
    replacement: REDACTED,
  },
  {
    name: "linear-api-key",
    regex: /\blin_api_[A-Za-z0-9]{35,45}\b/g,
    replacement: REDACTED,
  },
  {
    name: "notion-api-key",
    regex: /\bntn_[A-Za-z0-9]{40,55}\b/g,
    replacement: REDACTED,
  },
  {
    name: "sendgrid-api-key",
    // Three-segment format: `SG.{22-char ID}.{43-char secret}`. No trailing
    // `\b` because the final segment can end with `-` (non-word char).
    regex: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g,
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
  {
    name: "url-basic-auth",
    // `https://user:pass@host/path` — promoted from DiagnosticsCollector so
    // every sink that calls scrubSecrets benefits. Capture group preserves
    // protocol; the replacement contains `<` / `>` (not in the credential
    // charset), so a second pass cannot re-match. The `<redacted>` placeholder
    // matches the convention DiagnosticsCollector previously used inline so
    // downstream consumers see no behavioral change.
    regex: /((https?):\/\/)[A-Za-z0-9%!$&'()*+,;=:._~-]{1,512}@/g,
    replacement: "$1<redacted>@",
  },
  {
    name: "generic-key-fallback",
    // Last-resort fallback for `.env`-shaped lines using common API key names.
    // The 16-char minimum body excludes short numeric values like `MAX_TOKENS=8192`,
    // and the listed key names exclude `MAX_TOKENS` / `TOTAL_TOKENS` / request-id
    // shapes by construction.
    regex:
      /\b(?:api_key|api_secret|access_key|secret_key|private_key|auth_token|auth_secret|client_secret|app_secret|app_key|slack_signing_secret)[ \t]{0,4}=[ \t]{0,4}[A-Za-z0-9/+_-]{16,512}/gi,
    replacement: REDACTED,
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
