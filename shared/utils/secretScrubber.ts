/**
 * Pattern-based scrubbing for free-text secrets in telemetry, diagnostic
 * bundles, log files, and IPC error envelopes. Complements the key-based
 * redaction in `TelemetryService.sanitizeEvent` and `DiagnosticsCollector.redactDeep`.
 *
 * Apply at outbound boundaries only — never on the main-app in-memory
 * `logBuffer` path that feeds the diagnostics dock. (The plugin log ring is a
 * separate buffer that is itself an outbound boundary — see call site 12.)
 * Approved call sites:
 *   1. Sentry `beforeSend` (TelemetryService)
 *   2. DiagnosticsCollector string output
 *   3. Logger `emit`/`emitError` (scrubbed once, shared by file write + console mirror)
 *   4. Main-process emergency crash log (`emergencyLogMainFatal`)
 *   5. Pty-host emergency crash log (`emergencyLogFatal`)
 *   6. IPC error envelope (`sanitizeErrorForRenderer` in setup/security.ts)
 *   7. WorktreeLifecycleService tail-output scrub before renderer
 *   8. AgentInstallService progress stdout/stderr scrubbing
 *   9. AgentHelpService command output scrubbing
 *  10. AgentVersionService error-message scrubbing
 *  11. WorktreeLifecycleService full-output teardown log write (writeTeardownLog)
 *  12. PluginService.recordPluginLog (plugin log ring buffer + console mirror)
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
  /**
   * Regex-source fragment that matches a substring of EVERY possible match of
   * `regex` — usually the pattern's literal sigil (`\bghp_`). Fragments are
   * OR-joined into a single pre-scan probe so `scrubSecrets` can skip all
   * per-pattern passes on the (overwhelmingly common) secret-free input.
   * Soundness is enforced end-to-end by the per-pattern fixtures in
   * `secretScrubber.test.ts`: an over-narrow probe makes `scrubSecrets` return
   * the fixture input unredacted and the test fails. Omit when no case-stable
   * anchor exists (e.g. `i`-flagged patterns) — the full pattern source is
   * folded into the probe instead, which is always sound.
   */
  probe?: string;
}

// Order matters for overlapping sigils: more-specific patterns must run before
// less-specific ones. `sk-ant-` must precede `sk-` so Anthropic keys aren't
// half-redacted by the OpenAI pattern.
export const PATTERNS: readonly SecretPattern[] = [
  {
    name: "github-pat",
    regex: /\bghp_[A-Za-z0-9_]{36,255}\b/g,
    probe: String.raw`\bghp_`,
    replacement: REDACTED,
  },
  {
    name: "github-fine-grained-pat",
    regex: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g,
    probe: String.raw`\bgithub_pat_`,
    replacement: REDACTED,
  },
  {
    name: "github-app-token",
    // Covers `ghs_` (app server-to-server), `ghu_` (user-to-server), and `gho_` (OAuth).
    // All three appear in `gh` CLI output and git-credential-manager logs.
    regex: /\bgh[sou]_[A-Za-z0-9_]{36}\b/g,
    probe: String.raw`\bgh[sou]_`,
    replacement: REDACTED,
  },
  {
    name: "gitlab-personal-token",
    regex: /\bglpat-[0-9a-zA-Z_-]{20}\b/g,
    probe: String.raw`\bglpat-`,
    replacement: REDACTED,
  },
  {
    name: "gitlab-deploy-token",
    regex: /\bgldt-[0-9a-zA-Z_-]{20}\b/g,
    probe: String.raw`\bgldt-`,
    replacement: REDACTED,
  },
  {
    name: "anthropic-api-key",
    // Also covers `sk-ant-oat01-` OAuth setup tokens — the `oat01-` infix is
    // within the `[A-Za-z0-9\-_]` charset and the body length falls inside {90,255}.
    regex: /\bsk-ant-[A-Za-z0-9\-_]{90,255}\b/g,
    probe: String.raw`\bsk-ant-`,
    replacement: REDACTED,
  },
  {
    name: "openai-project-key",
    // MUST precede `openai-api-key` so the shorter `sk-` prefix doesn't
    // greedily consume `sk-proj-`/`sk-svcacct-` and leave the body unredacted.
    regex: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{100,256}\b/g,
    probe: String.raw`\bsk-(?:proj|svcacct|admin)-`,
    replacement: REDACTED,
  },
  {
    name: "openrouter-api-key",
    // MUST precede `openai-api-key` so the generic `sk-` prefix doesn't
    // greedily consume `sk-or-v1-` and leave the body unredacted.
    regex: /\bsk-or-v1-[0-9a-f]{55,70}\b/g,
    probe: String.raw`\bsk-or-v1-`,
    replacement: REDACTED,
  },
  {
    name: "openai-api-key",
    regex: /\bsk-[A-Za-z0-9]{48}\b/g,
    probe: String.raw`\bsk-`,
    replacement: REDACTED,
  },
  {
    name: "stripe-secret-key",
    regex: /\bsk_(?:live|test)_[0-9a-zA-Z]{24,48}\b/g,
    probe: String.raw`\bsk_(?:live|test)_`,
    replacement: REDACTED,
  },
  {
    name: "stripe-restricted-key",
    regex: /\brk_(?:live|test)_[0-9a-zA-Z]{24,48}\b/g,
    probe: String.raw`\brk_(?:live|test)_`,
    replacement: REDACTED,
  },
  {
    name: "slack-access-token",
    // MUST precede `slack-refresh-token` (more-specific `xoxe.xox[bp]-`
    // before broader `xoxe-`) AND `slack-token` (`xox[abprs]-` would
    // greedily consume `xox[bp]-` from `xoxe.xox[bp]-` tokens).
    regex: /\bxoxe\.xox[bp]-[A-Za-z0-9-]{160,180}\b/g,
    probe: String.raw`\bxoxe\.xox[bp]-`,
    replacement: REDACTED,
  },
  {
    name: "slack-refresh-token",
    regex: /\bxoxe-[A-Z0-9-]{140,150}\b/g,
    probe: String.raw`\bxoxe-`,
    replacement: REDACTED,
  },
  {
    name: "slack-token",
    regex: /\bxox[abprs]-[A-Za-z0-9-]{10,255}\b/g,
    probe: String.raw`\bxox[abprs]-`,
    replacement: REDACTED,
  },
  {
    name: "slack-app-token",
    // `xapp-` covers Socket Mode and Audit Logs API tokens (post-Dec-2020).
    regex: /\bxapp-[A-Za-z0-9-]{90,140}\b/g,
    probe: String.raw`\bxapp-`,
    replacement: REDACTED,
  },
  {
    name: "google-api-key",
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    probe: String.raw`\bAIza`,
    replacement: REDACTED,
  },
  {
    name: "aws-access-key-id",
    // Covers AKIA (IAM long-term), ASIA (STS short-term), and ABIA (STS variant).
    regex: /\bA[SKB]IA[0-9A-Z]{16}\b/g,
    probe: String.raw`\bA[SKB]IA`,
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
    probe: String.raw`\bnpm_`,
    replacement: REDACTED,
  },
  {
    name: "digitalocean-token",
    // Covers `dop_v1_` (personal), `doo_v1_` (OAuth), `dor_v1_` (refresh).
    regex: /\bdo[por]_v1_[A-Za-z0-9]{64}\b/g,
    probe: String.raw`\bdo[por]_v1_`,
    replacement: REDACTED,
  },
  {
    name: "atlassian-token",
    // `ATATT3x` (API tokens) and `ATCTT3x` (Connect/access tokens). Body is
    // base64url-ish and frequently ends with `=` padding, so no trailing `\b`
    // (it would fail to match after a non-word `=` char). Upper bound 512 so
    // unusually long tokens don't leave a tail visible.
    regex: /\bAT[AC]TT3x[A-Za-z0-9+/=_-]{120,512}/g,
    probe: String.raw`\bAT[AC]TT3x`,
    replacement: REDACTED,
  },
  {
    name: "cloudflare-token",
    // `cfat_` (account), `cfut_` (user), `cfk_` (global key). 40-char body
    // followed by an 8-char hex checksum.
    regex: /\bcf(?:at|ut|k)_[A-Za-z0-9]{40}[0-9a-f]{8}\b/g,
    probe: String.raw`\bcf(?:at|ut|k)_`,
    replacement: REDACTED,
  },
  {
    name: "supabase-key",
    regex: /\bsb_(?:publishable|secret)_[A-Za-z0-9_]{32,64}\b/g,
    probe: String.raw`\bsb_(?:publishable|secret)_`,
    replacement: REDACTED,
  },
  {
    name: "replicate-api-token",
    regex: /\br8_[A-Za-z0-9]{35,40}\b/g,
    probe: String.raw`\br8_`,
    replacement: REDACTED,
  },
  {
    name: "huggingface-api-token",
    regex: /\bhf_[A-Za-z0-9]{25,40}\b/g,
    probe: String.raw`\bhf_`,
    replacement: REDACTED,
  },
  {
    name: "groq-api-key",
    regex: /\bgsk_[A-Za-z0-9]{40,64}\b/g,
    probe: String.raw`\bgsk_`,
    replacement: REDACTED,
  },
  {
    name: "linear-api-key",
    regex: /\blin_api_[A-Za-z0-9]{35,45}\b/g,
    probe: String.raw`\blin_api_`,
    replacement: REDACTED,
  },
  {
    name: "notion-api-key",
    regex: /\bntn_[A-Za-z0-9]{40,55}\b/g,
    probe: String.raw`\bntn_`,
    replacement: REDACTED,
  },
  {
    name: "sendgrid-api-key",
    // Three-segment format: `SG.{22-char ID}.{43-char secret}`. No trailing
    // `\b` because the final segment can end with `-` (non-word char).
    regex: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g,
    probe: String.raw`\bSG\.`,
    replacement: REDACTED,
  },
  {
    name: "azure-connection-string",
    regex:
      /DefaultEndpointsProtocol=https;AccountName=[a-zA-Z0-9]{3,24};AccountKey=[a-zA-Z0-9+/]{86}==/g,
    probe: "DefaultEndpointsProtocol=",
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
    probe: "-----BEGIN ",
    replacement: REDACTED,
  },
  {
    name: "jwt",
    regex: /\beyJ[A-Za-z0-9\-_]{1,8000}\.[A-Za-z0-9\-_]{1,8000}\.[A-Za-z0-9\-_]{1,8000}\b/g,
    probe: String.raw`\beyJ`,
    replacement: REDACTED,
  },
  {
    name: "bearer-token",
    regex: /Bearer [A-Za-z0-9\-._~+/]{8,4000}={0,2}/g,
    probe: "Bearer ",
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
    probe: "(?:access_token|refresh_token|client_secret)=",
    replacement: `$1$2=${REDACTED}`,
  },
  {
    name: "oauth-code-query-param",
    // OAuth `code=` only when clearly inside a URL/form body, i.e. preceded by
    // `?` or `&`. Anchoring at line start would catch unrelated log output like
    // `code=42 not found`.
    regex: /([?&])code=[^&\s]{1,1000}/g,
    probe: String.raw`[?&]code=`,
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
    name: "vercel-token",
    // Covers `vcp_` (personal), `vci_` (CI), `vca_` (account), `vcr_` (refresh), `vck_` (key).
    regex: /\bvc[piakr]_[A-Za-z0-9]{24,40}\b/g,
    probe: String.raw`\bvc[piakr]_`,
    replacement: REDACTED,
  },
  {
    name: "perplexity-api-key",
    regex: /\bpplx-[a-f0-9]{48}\b/g,
    probe: String.raw`\bpplx-`,
    replacement: REDACTED,
  },
  {
    name: "xai-api-key",
    regex: /\bxai-[A-Za-z0-9]{80}\b/g,
    probe: String.raw`\bxai-`,
    replacement: REDACTED,
  },
  {
    name: "together-api-key",
    // No trailing `\b` because the body charset includes `-` and `_` (non-word
    // chars), so a token ending in either would silently slip past a boundary.
    regex: /\btgp_v1_[A-Za-z0-9_-]{43}/g,
    probe: String.raw`\btgp_v1_`,
    replacement: REDACTED,
  },
  {
    name: "resend-api-key",
    regex: /\bre_[A-Za-z0-9]{48}\b/g,
    probe: String.raw`\bre_[A-Za-z0-9]{48}\b`,
    replacement: REDACTED,
  },
  {
    name: "heroku-api-key-v2",
    // MUST precede `heroku-oauth-token` so the broader `HRKU-` prefix doesn't
    // greedily consume `HRKU-AA` and leave the body visible.
    // No trailing `\b`: body charset includes `-` and `_` (non-word).
    regex: /\bHRKU-AA[0-9a-zA-Z_-]{58}/g,
    probe: String.raw`\bHRKU-AA`,
    replacement: REDACTED,
  },
  {
    name: "heroku-oauth-token",
    // No trailing `\b`: body charset includes `-` and `_` (non-word) so tokens
    // ending in either would silently miss the boundary check.
    regex: /\bHRKU-[A-Za-z0-9_-]{60}/g,
    probe: String.raw`\bHRKU-`,
    replacement: REDACTED,
  },
  {
    name: "telegram-bot-token",
    // A bare `[0-9]{8,12}:[A-Za-z0-9_-]{35}` would collide with Unix-timestamp +
    // 35-char-alphanumeric strings in log lines, so this requires the surrounding
    // key name as context — same precedent as `aws-secret-access-key` above.
    regex: /\btelegram(?:_bot)?_token\s{0,4}[:=]\s{0,4}[0-9]{8,12}:[A-Za-z0-9_-]{35}\b/gi,
    replacement: REDACTED,
  },
  {
    name: "datadog-key",
    // A bare `{32,40}` lowercase-hex run is just an MD5 or SHA1 hash, so this
    // requires the key name as context. Covers both DD_API_KEY (32 hex) and
    // DD_APP_KEY (40 hex) in one pattern; no trailing `\b` because the closing
    // `["']?` may be a non-word char (mirrors `aws-secret-access-key`).
    regex:
      /\b(?:DD_API_KEY|DD_APP_KEY|datadog_api_key|datadog_app_key)["']?\s{0,8}[:=]\s{0,8}["']?[a-f0-9]{32,40}["']?/gi,
    replacement: REDACTED,
  },
  {
    name: "pulumi-api-token",
    regex: /\bpul-[a-f0-9]{40}\b/g,
    probe: String.raw`\bpul-`,
    replacement: REDACTED,
  },
  {
    name: "rubygems-api-token",
    regex: /\brubygems_[a-f0-9]{48}\b/g,
    probe: String.raw`\brubygems_`,
    replacement: REDACTED,
  },
  {
    name: "readme-api-token",
    regex: /\brdme_[a-z0-9]{70}\b/g,
    probe: String.raw`\brdme_`,
    replacement: REDACTED,
  },
  {
    name: "huggingface-org-api-token",
    // Organization-level tokens use `api_org_` prefix, distinct from user-level
    // `hf_` tokens already covered above.
    regex: /\bapi_org_[A-Za-z]{34}\b/g,
    probe: String.raw`\bapi_org_`,
    replacement: REDACTED,
  },
  {
    name: "age-secret-key",
    // Base58-encoded (Crockford alphabet) body. Fixed 58-char secret.
    regex: /\bAGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}\b/g,
    probe: "AGE-SECRET-KEY-1",
    replacement: REDACTED,
  },
  {
    name: "infracost-api-token",
    regex: /\bico-[A-Za-z0-9]{32}\b/g,
    probe: String.raw`\bico-`,
    replacement: REDACTED,
  },
  {
    name: "artifactory-api-key",
    regex: /\bAKCp[A-Za-z0-9]{69}\b/g,
    probe: String.raw`\bAKCp`,
    replacement: REDACTED,
  },
  {
    name: "artifactory-reference-token",
    regex: /\bcmVmd[A-Za-z0-9]{59}\b/g,
    probe: String.raw`\bcmVmd`,
    replacement: REDACTED,
  },
  {
    name: "grafana-service-account-token",
    // Format: glsa_<32 alnum>_<8 hex>. Trailing `\b` safe because body ends in hex.
    regex: /\bglsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8}\b/g,
    probe: String.raw`\bglsa_`,
    replacement: REDACTED,
  },
  {
    name: "easypost-api-token",
    regex: /\bEZAK[A-Za-z0-9]{54}\b/g,
    probe: String.raw`\bEZAK`,
    replacement: REDACTED,
  },
  {
    name: "easypost-test-api-token",
    regex: /\bEZTK[A-Za-z0-9]{54}\b/g,
    probe: String.raw`\bEZTK`,
    replacement: REDACTED,
  },
  {
    name: "maxmind-license-key",
    // Format: <6 alnum>_<29 alnum>_mmk. Trailing `\b` safe because body ends in `k`.
    regex: /\b[A-Za-z0-9]{6}_[A-Za-z0-9]{29}_mmk\b/g,
    probe: String.raw`_mmk\b`,
    replacement: REDACTED,
  },
  {
    name: "doppler-api-token",
    regex: /\bdp\.pt\.[A-Za-z0-9]{43}\b/g,
    probe: String.raw`\bdp\.pt\.`,
    replacement: REDACTED,
  },
  {
    name: "scalingo-api-token",
    // No trailing `\b`: body charset includes `-` and `_` (non-word).
    regex: /\btk-us-[A-Za-z0-9_-]{48}/g,
    probe: String.raw`\btk-us-`,
    replacement: REDACTED,
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

// Pre-scan probes: one alternation per case-sensitivity class, OR-joining each
// pattern's `probe` fragment (falling back to the full pattern source when no
// fragment is declared). A string that matches neither probe cannot match any
// pattern, so `scrubSecrets` skips all per-pattern passes — the overwhelmingly
// common case for log lines. Probes must be a superset of the patterns: false
// probe hits only cost the full scan; a false miss would leak, which is why
// fragments fall back to the full source and the fixtures in
// `secretScrubber.test.ts` assert end-to-end through `scrubSecrets`.
// Split by case class because a single `i`-flagged alternation defeats V8's
// fast literal pre-search for the ~56 case-sensitive sigils. The `m` flag
// keeps any folded-in `^` (e.g. `oauth-query-param`) as broad as the original.
// No `g`/`y` flags — `.test()` on a `g` regex is stateful (see
// `findSecretInValue` below).
function buildProbe(patterns: readonly SecretPattern[], flags: string): RegExp | null {
  const parts = patterns.map((p) => p.probe ?? p.regex.source);
  return parts.length > 0 ? new RegExp(parts.join("|"), flags) : null;
}

const CASE_SENSITIVE_PROBE = buildProbe(
  PATTERNS.filter((p) => !p.regex.flags.includes("i")),
  "m"
);
const CASE_INSENSITIVE_PROBE = buildProbe(
  PATTERNS.filter((p) => p.regex.flags.includes("i")),
  "im"
);

const PATTERN_PROBES = PATTERNS.map((pattern) => ({
  pattern,
  probe: new RegExp(
    pattern.probe ?? pattern.regex.source,
    pattern.regex.flags.replace(/[gy]/g, "")
  ),
}));

/**
 * Scrubs known secret sigils from free text. Idempotent — calling twice yields
 * the same result, because the `[REDACTED]` token contains no secret sigil.
 *
 * All patterns are linear-time with bounded quantifiers; total work is O(N·K)
 * where K is the number of patterns, and the probe pre-scan reduces the
 * secret-free case to O(N). No pre-truncation is applied, because any
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
  if (!CASE_SENSITIVE_PROBE?.test(value) && !CASE_INSENSITIVE_PROBE?.test(value)) {
    return value;
  }

  let out = value;
  for (const { pattern, probe } of PATTERN_PROBES) {
    if (!probe.test(out)) continue;
    out = out.replace(pattern.regex, pattern.replacement);
  }

  return out;
}

/**
 * Detects whether a string contains a known secret sigil, returning the first
 * matching pattern (or `undefined` when clean). Unlike {@link scrubSecrets},
 * this is a predicate — it reports a match instead of redacting.
 *
 * The shared `PATTERNS` regexes carry the `g` flag, which makes `.test()`
 * stateful (`lastIndex` persists across calls on the same instance and yields
 * non-deterministic false negatives in a loop). Each pattern is cloned once at
 * module load with the `g`/`y` flags stripped so detection stays stateless and
 * the module-level catalogue is never mutated.
 *
 * @param value arbitrary string, e.g. a recipe env value
 * @returns the first matching `SecretPattern`, or `undefined` when none match
 */
const STATELESS_PATTERNS: ReadonlyArray<{ pattern: SecretPattern; stateless: RegExp }> =
  PATTERNS.map((pattern) => ({
    pattern,
    stateless: new RegExp(pattern.regex.source, pattern.regex.flags.replace(/[gy]/g, "")),
  }));

export function findSecretInValue(value: string): SecretPattern | undefined {
  if (value.length === 0) return undefined;
  if (!CASE_SENSITIVE_PROBE?.test(value) && !CASE_INSENSITIVE_PROBE?.test(value)) {
    return undefined;
  }

  for (const { pattern, stateless } of STATELESS_PATTERNS) {
    if (stateless.test(value)) return pattern;
  }

  return undefined;
}
