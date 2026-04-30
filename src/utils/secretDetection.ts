/**
 * Heuristic detector for common literal secrets pasted into env var editors.
 *
 * Anchored, pure-regex patterns only — no back-references, no unbounded
 * alternation. The safe-form guard short-circuits any value of the shape
 * `${ENV_VAR}` so shell-style references never trigger the warning even if
 * the referenced name happens to look like a token.
 *
 * Detection is advisory: callers render a UI warning but must still accept
 * the value. Nothing about the value is logged, transmitted, or stored.
 */

// Matches a shell-style env var reference like `${ANTHROPIC_API_KEY}` or
// `${home}`. Allows lowercase to avoid false positives on legitimate
// lowercase variable names (e.g. POSIX `$path`).
const SAFE_FORM_RE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

const NAMED_PATTERNS: readonly RegExp[] = [
  // Anthropic API keys (legacy and api03-prefixed).
  /^sk-ant-[A-Za-z0-9_-]{20,}$/,
  // OpenAI keys (user `sk-` and project `sk-proj-`).
  /^sk-(?:proj-)?[A-Za-z0-9_-]{20,}$/,
  // GitHub classic tokens: ghp_, gho_, ghu_, ghs_, ghr_.
  /^gh[pousr]_[A-Za-z0-9]{30,}$/,
  // GitHub fine-grained personal access tokens.
  /^github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}$/,
  // AWS access key IDs.
  /^AKIA[0-9A-Z]{16}$/,
  // Generic `ak-` / `sk-` / `pk-` bearer-style keys.
  /^(ak|sk|pk)-[A-Za-z0-9_-]{24,}$/,
];

// Fallback high-entropy heuristic for opaque tokens that don't match a named
// vendor pattern. 40 chars is the issue spec's threshold — above UUIDs (36)
// while still catching HuggingFace `hf_`, Slack bot tokens, and similar
// 40–47 char secrets that vendor patterns don't cover.
const LONG_OPAQUE_RE = /^[A-Za-z0-9+/=_-]{40,}$/;

export function looksLikeSecret(value: string): boolean {
  if (!value) return false;
  if (SAFE_FORM_RE.test(value)) return false;
  for (const re of NAMED_PATTERNS) {
    if (re.test(value)) return true;
  }
  return LONG_OPAQUE_RE.test(value);
}
