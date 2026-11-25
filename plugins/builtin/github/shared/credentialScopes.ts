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

export type GitHubFineGrainedAccess = "read" | "write";

/**
 * Repository permissions Daintree pre-fills on GitHub's fine-grained token
 * page, keyed by GitHub's URL parameter names. Each is read unless a Code forge
 * action writes with it: merging and auto-merge need `contents` write.
 * Metadata read is left out because GitHub grants it to every fine-grained
 * token. A fine-grained token sends no scope header, so nothing here is
 * checked when the token is saved.
 */
export const GITHUB_FINE_GRAINED_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
  statuses: "read",
  // Names the workflow behind each check run; the rest of the CI rollup reads without it.
  actions: "read",
  deployments: "read",
} as const satisfies Record<string, GitHubFineGrainedAccess>;
