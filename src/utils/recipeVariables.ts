export interface RecipeContext {
  issueNumber?: number;
  prNumber?: number;
  worktreePath?: string;
  branchName?: string;
}

const VARIABLE_DEFINITIONS = [
  { name: "issue_number", description: "GitHub issue number" },
  { name: "pr_number", description: "GitHub PR number" },
  { name: "number", description: "GitHub issue or PR number (whichever is set)" },
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
      case "number": {
        const num = context.issueNumber ?? context.prNumber;
        return num != null ? `#${num}` : "";
      }
      case "worktree_path":
        return context.worktreePath ?? "";
      case "branch_name":
        return context.branchName ?? "";
      default:
        return match;
    }
  });
}

const VARIABLE_CONTEXT_MAP: Record<string, keyof RecipeContext> = {
  issue_number: "issueNumber",
  pr_number: "prNumber",
  worktree_path: "worktreePath",
  branch_name: "branchName",
};

export function detectUnresolvedVariables(text: string, context: RecipeContext): string[] {
  const unresolved: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  const pattern = new RegExp(VARIABLE_PATTERN.source, VARIABLE_PATTERN.flags);
  while ((match = pattern.exec(text)) !== null) {
    const name = match[1]!.toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    if (name === "number") {
      if (context.issueNumber == null && context.prNumber == null) {
        unresolved.push(name);
      }
      continue;
    }
    const contextKey = VARIABLE_CONTEXT_MAP[name];
    if (contextKey && context[contextKey] == null) {
      unresolved.push(name);
    }
  }
  return unresolved;
}

export function getAvailableVariables(): { name: string; description: string }[] {
  return [...VARIABLE_DEFINITIONS];
}
