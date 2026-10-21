import type { Issue } from "../types/forge.js";
import { validateBranchName } from "./pathPattern.js";

/**
 * The branch name to create for work on an issue: the provider's suggestion
 * when it offers a usable one (#13700), otherwise the caller's own generated
 * name. A tracker that links branches by naming convention (Linear matches its
 * issue id in the branch) only sees the work if the name is its own, so the
 * suggestion is used verbatim — no `feature/` or username prefix added.
 *
 * A suggestion git would reject falls back rather than surfacing as a
 * create-time error the user never typed.
 */
export function issueBranchName(
  issue: Pick<Issue, "branchName"> | null | undefined,
  fallback: string
): string {
  const suggested = issue?.branchName?.trim();
  if (suggested && validateBranchName(suggested).valid) return suggested;
  return fallback;
}
