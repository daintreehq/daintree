/**
 * Closing-issue reference parsed from a PR body. GitHub's `closingIssuesReferences`
 * GraphQL field only auto-populates for PRs targeting the repository's default
 * branch, so a body-parse of the `Closes/Fixes/Resolves #N` keywords (including
 * cross-repo `org/repo#N`) is the reliable fallback for PRs targeting other
 * branches (e.g. `develop`). Used to capture the source PR's linked issue at
 * worktree-create time (#8888).
 *
 * Returns the first match only — a PR with multiple closing references is
 * unusual and the worktree card surfaces a single linked issue.
 */
export function extractClosingIssueNumber(bodyText?: string | null): number | undefined {
  if (!bodyText) return undefined;
  // Negative lookbehind so the keyword isn't matched inside a longer token
  // ("hotfixes #1", "discloses #2", "prefix-fix #3" must not match), while
  // still allowing leading punctuation ("(closes #4)", "- Fixes #5").
  const match =
    /(?<![\w-])(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+(?:[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+#|#)(\d+)/i.exec(
      bodyText
    );
  const captured = match?.[1];
  if (!captured) return undefined;
  const parsed = Number.parseInt(captured, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
