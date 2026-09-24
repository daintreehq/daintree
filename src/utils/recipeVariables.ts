export interface RecipeContext {
  issueNumber?: number;
  prNumber?: number;
  worktreePath?: string;
  branchName?: string;
}

const VARIABLE_DEFINITIONS = [
  { name: "issue_number", description: "Issue number" },
  { name: "pr_number", description: "PR number" },
  { name: "number", description: "Issue or PR number (whichever is set)" },
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

const KNOWN_VARIABLE_NAMES = VARIABLE_DEFINITIONS.map((d) => d.name);
const KNOWN_VARIABLE_PATTERN = new RegExp(`\\{\\{(${KNOWN_VARIABLE_NAMES.join("|")})\\}\\}`, "gi");

export function hasRecipeVariables(text: string): boolean {
  KNOWN_VARIABLE_PATTERN.lastIndex = 0;
  return KNOWN_VARIABLE_PATTERN.test(text);
}

export function splitByRecipeVariables(text: string): Array<{ text: string; isVar: boolean }> {
  const parts: Array<{ text: string; isVar: boolean }> = [];
  const pattern = new RegExp(KNOWN_VARIABLE_PATTERN.source, KNOWN_VARIABLE_PATTERN.flags);
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ text: text.slice(lastIndex, match.index), isVar: false });
    }
    parts.push({ text: match[0], isVar: true });
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push({ text: text.slice(lastIndex), isVar: false });
  }
  return parts;
}

export type RecipePromptSegment =
  | { kind: "text"; text: string }
  /** A known variable whose value is only known at launch. */
  | { kind: "variable"; text: string; name: string }
  /** A known variable substituted from the context. */
  | { kind: "value"; text: string; name: string }
  /** A known variable with no value in the context: launch sends an empty string here. */
  | { kind: "missing"; text: string; name: string }
  /** `{{word}}` that isn't a recipe variable: launch sends it as typed. */
  | { kind: "unknown"; text: string; name: string };

/**
 * Splits a prompt the way launch will read it — trimmed first, then
 * substituted — so a preview can show where every value lands. Pass `null`
 * when the values are only known at launch.
 */
export function segmentRecipePrompt(
  text: string,
  context: RecipeContext | null
): RecipePromptSegment[] {
  const source = text.trim();
  const segments: RecipePromptSegment[] = [];
  // Wider than launch's own pattern on purpose: `{{ issue_number }}` or
  // `{{issue-number}}` is sent as typed, so it has to show up as unknown.
  const pattern = /\{\{([^{}\n]+?)\}\}/g;
  const knownNames = new Set<string>(KNOWN_VARIABLE_NAMES);
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: "text", text: source.slice(lastIndex, match.index) });
    }
    const token = match[0];
    const name = match[1]!.toLowerCase();
    if (!knownNames.has(name)) {
      segments.push({ kind: "unknown", text: token, name: match[1]! });
    } else if (context === null) {
      segments.push({ kind: "variable", text: token, name });
    } else {
      const value = replaceRecipeVariables(token, context);
      segments.push(
        value === "" ? { kind: "missing", text: token, name } : { kind: "value", text: value, name }
      );
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < source.length) {
    segments.push({ kind: "text", text: source.slice(lastIndex) });
  }
  return segments;
}
