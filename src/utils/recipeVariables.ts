export interface RecipeContext {
  issueNumber?: number;
  prNumber?: number;
  worktreePath?: string;
  branchName?: string;
}

const VARIABLE_DEFINITIONS = [
  { name: "issue_number", description: "GitHub issue number" },
  { name: "pr_number", description: "GitHub PR number" },
  { name: "worktree_path", description: "Absolute path to worktree directory" },
  { name: "branch_name", description: "Git branch name" },
] as const;

const VARIABLE_PATTERN = /\{\{(\w+)\}\}/gi;

export function replaceRecipeVariables(text: string, context: RecipeContext): string {
  return text.replace(VARIABLE_PATTERN, (match, name: string) => {
    switch (name.toLowerCase()) {
      case "issue_number":
        return context.issueNumber != null ? `#${context.issueNumber}` : "";
      case "pr_number":
        return context.prNumber != null ? `#${context.prNumber}` : "";
      case "worktree_path":
        return context.worktreePath ?? "";
      case "branch_name":
        return context.branchName ?? "";
      default:
        return match;
    }
  });
}

export function getAvailableVariables(): { name: string; description: string }[] {
  return [...VARIABLE_DEFINITIONS];
}
