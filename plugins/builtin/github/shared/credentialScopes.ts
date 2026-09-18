/**
 * Classic OAuth scopes Daintree asks a GitHub token for. The Settings pane
 * lists them and pre-fills them on the "create token" link; a credential
 * import compares a token's live scopes against them.
 */
export const GITHUB_REQUIRED_SCOPES = ["repo", "read:org"] as const;

export type GitHubRequiredScope = (typeof GITHUB_REQUIRED_SCOPES)[number];

// GitHub's org scopes nest: `admin:org` grants `write:org`, which grants
// `read:org`. A plain array difference would report a false gap for a token
// that holds the broader scope.
const SATISFIED_BY: Record<GitHubRequiredScope, readonly string[]> = {
  repo: ["repo"],
  "read:org": ["read:org", "write:org", "admin:org"],
};

/**
 * Required scopes the token lacks, given the scopes GitHub reported for it.
 *
 * An empty list means the scopes are unknown, not absent — fine-grained PATs
 * and GitHub App tokens send no `x-oauth-scopes` header — so it yields no
 * missing scopes rather than all of them.
 */
export function findMissingGitHubScopes(scopes: readonly string[]): GitHubRequiredScope[] {
  const held = new Set(scopes.map((scope) => scope.trim()).filter(Boolean));
  if (held.size === 0) return [];
  return GITHUB_REQUIRED_SCOPES.filter(
    (required) => !SATISFIED_BY[required].some((scope) => held.has(scope))
  );
}
