export interface RecipeContext {
  issueNumber?: number;
  prNumber?: number;
  worktreePath?: string;
  branchName?: string;
  /**
   * Values for a plugin recipe's `{{plugin.<name>}}` variables (#13797), as
   * `host.runRecipe` supplied them, read by own key only. Set — empty when a
   * run supplies none — only for a plugin's own recipe; absent, `{{plugin.x}}`
   * is ordinary text, as it always was in a user's recipe.
   */
  pluginVariables?: Readonly<Record<string, string>>;
}

/** The values for a plugin recipe run that supplied none: every variable empty. */
export const NO_PLUGIN_VARIABLE_VALUES: Readonly<Record<string, string>> = Object.freeze(
  Object.create(null) as Record<string, string>
);

const PLUGIN_VARIABLE_PREFIX = "plugin.";

function pluginVariableValue(name: string, context: RecipeContext): string | undefined {
  const values = context.pluginVariables;
  const key = name.slice(PLUGIN_VARIABLE_PREFIX.length);
  return values !== undefined && Object.hasOwn(values, key) ? values[key] : undefined;
}

const VARIABLE_DEFINITIONS = [
  { name: "issue_number", description: "Issue number" },
  { name: "pr_number", description: "PR number" },
  { name: "number", description: "Issue or PR number (whichever is set)" },
  { name: "worktree_path", description: "Absolute path to worktree directory" },
  { name: "branch_name", description: "Git branch name" },
] as const;

// One pass with a replacer function, so a value is inserted as typed: a `$&`
// in it is not a replacement pattern, and a `{{...}}` in it is never expanded.
const VARIABLE_PATTERN = /\{\{(\w+|plugin\.\w+)\}\}/gi;

export function replaceRecipeVariables(text: string, context: RecipeContext): string {
  return text.replace(VARIABLE_PATTERN, (match, name: string) => {
    const lowered = name.toLowerCase();
    if (lowered.startsWith(PLUGIN_VARIABLE_PREFIX)) {
      if (context.pluginVariables === undefined) return match;
      return pluginVariableValue(lowered, context) ?? "";
    }
    switch (lowered) {
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
    if (name.startsWith(PLUGIN_VARIABLE_PREFIX)) {
      if (
        context.pluginVariables !== undefined &&
        pluginVariableValue(name, context) === undefined
      ) {
        unresolved.push(name);
      }
      continue;
    }
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

/** `plugin.<name>`, the name half of a plugin variable token. */
const PLUGIN_VARIABLE_NAME = /^plugin\.\w+$/;

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
  const isKnown = (name: string) =>
    knownNames.has(name) ||
    (context?.pluginVariables !== undefined && PLUGIN_VARIABLE_NAME.test(name));
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: "text", text: source.slice(lastIndex, match.index) });
    }
    const token = match[0];
    const name = match[1]!.toLowerCase();
    if (!isKnown(name)) {
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
