import type { Issue } from "@shared/types/forge";
import type { WorktreeSnapshot } from "@shared/types/workspace-host";

export interface RecipeContext {
  issueNumber?: number;
  /**
   * The issues provider's own name for the linked issue (`ENG-42`), set only
   * when a provider served it (#16381). `{{issue_number}}` names the issue by
   * it: `issueNumber` is then the provider's display counter or a hash, and
   * `#42` would read as the code forge's issue.
   */
  issueKey?: string;
  issueTitle?: string;
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

type RecipeIssueFields = Pick<
  WorktreeSnapshot,
  "issueNumber" | "issueTitle" | "issueProviderId" | "issueKey"
>;

/**
 * The issue half of a recipe context. A key counts only with the provider
 * that owns it: without one, `issueNumber` is the code forge's.
 */
export function recipeIssueContext(
  source: RecipeIssueFields
): Pick<RecipeContext, "issueNumber" | "issueKey" | "issueTitle"> {
  return {
    issueNumber: source.issueNumber,
    issueKey: source.issueProviderId ? source.issueKey : undefined,
    issueTitle: source.issueTitle,
  };
}

/** The context for a recipe run in `worktree`, as every launch surface reads it. */
export function recipeContextFromWorktree(
  worktree: RecipeIssueFields & Pick<WorktreeSnapshot, "path" | "branch" | "linked">
): RecipeContext {
  return {
    ...recipeIssueContext(worktree),
    prNumber: worktree.linked?.pr?.ref.number,
    worktreePath: worktree.path,
    branchName: worktree.branch,
  };
}

/** The issue half of a recipe context for a worktree being made for `issue`. */
export function recipeIssueContextFromIssue(
  issue: Pick<Issue, "number" | "title" | "providerId" | "key">
): Pick<RecipeContext, "issueNumber" | "issueKey" | "issueTitle"> {
  return recipeIssueContext({
    issueNumber: issue.number,
    issueTitle: issue.title,
    issueProviderId: issue.providerId,
    issueKey: issue.key,
  });
}

/** The values for a plugin recipe run that supplied none: every variable empty. */
export const NO_PLUGIN_VARIABLE_VALUES: Readonly<Record<string, string>> = Object.freeze({});

const PLUGIN_VARIABLE_PREFIX = "plugin.";

function pluginVariableValue(name: string, context: RecipeContext): string | undefined {
  const values = context.pluginVariables;
  const key = name.slice(PLUGIN_VARIABLE_PREFIX.length);
  return values !== undefined && Object.hasOwn(values, key) ? values[key] : undefined;
}

const VARIABLE_DEFINITIONS = [
  { name: "issue_number", description: "Issue number, or the tracker's key (ENG-42)" },
  { name: "issue_title", description: "Linked issue's title" },
  { name: "pr_number", description: "PR number" },
  { name: "number", description: "Issue or PR number (whichever is set)" },
  { name: "worktree_path", description: "Absolute path to worktree directory" },
  { name: "branch_name", description: "Git branch name" },
] as const;

const KNOWN_VARIABLE_NAMES: ReadonlySet<string> = new Set(VARIABLE_DEFINITIONS.map((d) => d.name));

// One pass with a replacer function, so a value is inserted as typed: a `$&`
// in it is not a replacement pattern, and a `{{...}}` in it is never expanded.
const VARIABLE_PATTERN = /\{\{(\w+|plugin\.\w+)\}\}/gi;

const LINE_BREAKS = /\s*[\r\n\t\u2028\u2029]\s*/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1F\x7F-\x9F]/g;

// Whoever opened the issue wrote its title and the tracker chose its key, so
// either can carry bytes a recipe's author never typed: keep them to one line
// of printable text before they reach a command line or a terminal's input.
function issueText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(LINE_BREAKS, " ").replace(CONTROL_CHARS, "").trim() || undefined;
}

function issueReference(context: RecipeContext): string | undefined {
  const key = issueText(context.issueKey);
  if (key) return key;
  return context.issueNumber != null ? `#${context.issueNumber}` : undefined;
}

/** A built-in variable's value; `undefined` when the context has none. */
function builtInValue(name: string, context: RecipeContext): string | undefined {
  switch (name) {
    case "issue_number":
      return issueReference(context);
    case "issue_title":
      return issueText(context.issueTitle);
    case "pr_number":
      return context.prNumber != null ? `#${context.prNumber}` : undefined;
    case "number":
      return issueReference(context) ?? builtInValue("pr_number", context);
    case "worktree_path":
      return context.worktreePath;
    case "branch_name":
      return context.branchName;
    default:
      return undefined;
  }
}

export function replaceRecipeVariables(text: string, context: RecipeContext): string {
  return text.replace(VARIABLE_PATTERN, (match, name: string) => {
    const lowered = name.toLowerCase();
    if (lowered.startsWith(PLUGIN_VARIABLE_PREFIX)) {
      if (context.pluginVariables === undefined) return match;
      return pluginVariableValue(lowered, context) ?? "";
    }
    if (!KNOWN_VARIABLE_NAMES.has(lowered)) return match;
    return builtInValue(lowered, context) ?? "";
  });
}

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
    if (KNOWN_VARIABLE_NAMES.has(name) && builtInValue(name, context) === undefined) {
      unresolved.push(name);
    }
  }
  return unresolved;
}

export function getAvailableVariables(): { name: string; description: string }[] {
  return [...VARIABLE_DEFINITIONS];
}

const KNOWN_VARIABLE_PATTERN = new RegExp(
  `\\{\\{(${[...KNOWN_VARIABLE_NAMES].join("|")})\\}\\}`,
  "gi"
);

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
  const isKnown = (name: string) =>
    KNOWN_VARIABLE_NAMES.has(name) ||
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
