import { BRANCH_TYPE_COLOR_CLASSES } from "../theme/index.js";

export interface BranchTypeColors {
  bg: string;
  border: string;
  text: string;
}

export interface BranchType {
  id: string;
  displayName: string;
  /** The sidebar section heading when worktrees are grouped by type. */
  groupName: string;
  prefix: string;
  aliases: readonly string[];
  colors: BranchTypeColors;
}

const COLORS = {
  teal: BRANCH_TYPE_COLOR_CLASSES.feature,
  red: BRANCH_TYPE_COLOR_CLASSES.bugfix,
  gray: BRANCH_TYPE_COLOR_CLASSES.neutral,
  amber: BRANCH_TYPE_COLOR_CLASSES.warm,
} as const;

export const DEFAULT_BRANCH_TYPE: BranchType = {
  id: "other",
  displayName: "Other",
  groupName: "Other",
  prefix: "other",
  aliases: [],
  colors: COLORS.gray,
};

/**
 * Every branch type Daintree recognises, in the order the grouped sidebar
 * lists their sections. Type ids, group order, filter chips and chip counts
 * all derive from this list, so a type added here appears everywhere at once.
 */
export const BRANCH_TYPES = [
  {
    id: "feature",
    displayName: "Feature",
    groupName: "Features",
    prefix: "feature",
    aliases: ["feat", "enhancement", "enhance"],
    colors: COLORS.teal,
  },
  {
    id: "bugfix",
    displayName: "Bugfix",
    groupName: "Bugfixes",
    prefix: "bugfix",
    aliases: ["fix", "bug"],
    colors: COLORS.red,
  },
  {
    id: "hotfix",
    displayName: "Hotfix",
    groupName: "Hotfixes",
    prefix: "hotfix",
    aliases: [],
    colors: COLORS.red,
  },
  {
    id: "security",
    displayName: "Security",
    groupName: "Security",
    prefix: "security",
    aliases: ["sec", "vuln", "cve"],
    colors: COLORS.red,
  },
  {
    id: "design",
    displayName: "Design",
    groupName: "Design",
    prefix: "design",
    aliases: ["ui", "ux", "design-review"],
    colors: COLORS.teal,
  },
  {
    id: "experiment",
    displayName: "Experiment",
    groupName: "Experiments",
    prefix: "experiment",
    aliases: ["exp", "spike", "poc", "prototype", "research", "exploration", "investigate"],
    colors: COLORS.amber,
  },
  {
    id: "refactor",
    displayName: "Refactor",
    groupName: "Refactors",
    prefix: "refactor",
    aliases: ["refact", "cleanup"],
    colors: COLORS.amber,
  },
  {
    id: "chore",
    displayName: "Chore",
    groupName: "Chores",
    prefix: "chore",
    aliases: ["maintenance", "config"],
    colors: COLORS.gray,
  },
  {
    id: "docs",
    displayName: "Docs",
    groupName: "Documentation",
    prefix: "docs",
    aliases: ["doc", "documentation"],
    colors: COLORS.gray,
  },
  {
    id: "test",
    displayName: "Test",
    groupName: "Tests",
    prefix: "test",
    aliases: ["tests", "testing", "qa", "e2e"],
    colors: COLORS.amber,
  },
  {
    id: "release",
    displayName: "Release",
    groupName: "Releases",
    prefix: "release",
    aliases: ["rel"],
    colors: COLORS.amber,
  },
  {
    id: "backport",
    displayName: "Backport",
    groupName: "Backports",
    prefix: "backport",
    aliases: ["cherry-pick"],
    colors: COLORS.amber,
  },
  {
    id: "support",
    displayName: "Support",
    groupName: "Support",
    prefix: "support",
    aliases: [],
    colors: COLORS.gray,
  },
  {
    id: "revert",
    displayName: "Revert",
    groupName: "Reverts",
    prefix: "revert",
    aliases: ["rollback"],
    colors: COLORS.red,
  },
  { id: "ci", displayName: "CI", groupName: "CI", prefix: "ci", aliases: [], colors: COLORS.gray },
  {
    id: "build",
    displayName: "Build",
    groupName: "Build",
    prefix: "build",
    aliases: ["tooling"],
    colors: COLORS.gray,
  },
  {
    id: "infra",
    displayName: "Infra",
    groupName: "Infrastructure",
    prefix: "infra",
    aliases: ["ops", "devops", "deploy"],
    colors: COLORS.gray,
  },
  {
    id: "deps",
    displayName: "Deps",
    groupName: "Dependencies",
    prefix: "deps",
    aliases: [],
    colors: COLORS.gray,
  },
  {
    id: "migration",
    displayName: "Migration",
    groupName: "Migrations",
    prefix: "migration",
    aliases: ["db", "schema"],
    colors: COLORS.amber,
  },
  {
    id: "perf",
    displayName: "Perf",
    groupName: "Performance",
    prefix: "perf",
    aliases: ["performance", "optimize", "optimise"],
    colors: COLORS.teal,
  },
  {
    id: "style",
    displayName: "Style",
    groupName: "Style",
    prefix: "style",
    aliases: ["format", "lint"],
    colors: COLORS.gray,
  },
  {
    id: "i18n",
    displayName: "i18n",
    groupName: "Localization",
    prefix: "i18n",
    aliases: ["l10n", "translation", "localization", "localisation"],
    colors: COLORS.gray,
  },
  {
    id: "a11y",
    displayName: "a11y",
    groupName: "Accessibility",
    prefix: "a11y",
    aliases: ["accessibility"],
    colors: COLORS.gray,
  },
  {
    id: "wip",
    displayName: "WIP",
    groupName: "Work in Progress",
    prefix: "wip",
    aliases: ["draft", "tmp", "temp"],
    colors: COLORS.amber,
  },
  {
    id: "backup",
    displayName: "Backup",
    groupName: "Backups",
    prefix: "backup",
    aliases: [],
    colors: COLORS.gray,
  },
] as const satisfies readonly BranchType[];

export type BranchTypeId = (typeof BRANCH_TYPES)[number]["id"];
export type KnownBranchType = (typeof BRANCH_TYPES)[number];

export const BRANCH_TYPE_IDS: readonly BranchTypeId[] = BRANCH_TYPES.map((type) => type.id);

export type BranchNamespaceKind = "agent" | "bot" | "user";

export interface BranchNamespace {
  id: string;
  kind: BranchNamespaceKind;
  displayName: string;
}

interface KnownBranchNamespace extends BranchNamespace {
  kind: "agent" | "bot";
  /** The type a branch gets when no work type is nested beneath the namespace. */
  fallbackType: BranchTypeId | null;
}

/**
 * First segments that say who made a branch rather than what it is for. Agent
 * namespaces come from the Conventional Branch spec plus Devin; bot namespaces
 * from the dependency and release bots that push branches.
 */
const BRANCH_NAMESPACES: readonly KnownBranchNamespace[] = [
  { id: "claude", kind: "agent", displayName: "Claude", fallbackType: null },
  { id: "codex", kind: "agent", displayName: "Codex", fallbackType: null },
  { id: "copilot", kind: "agent", displayName: "Copilot", fallbackType: null },
  { id: "cursor", kind: "agent", displayName: "Cursor", fallbackType: null },
  { id: "devin", kind: "agent", displayName: "Devin", fallbackType: null },
  { id: "ai", kind: "agent", displayName: "AI", fallbackType: null },
  { id: "dependabot", kind: "bot", displayName: "Dependabot", fallbackType: "deps" },
  { id: "renovate", kind: "bot", displayName: "Renovate", fallbackType: "deps" },
  { id: "greenkeeper", kind: "bot", displayName: "Greenkeeper", fallbackType: "deps" },
  {
    id: "changeset-release",
    kind: "bot",
    displayName: "Changesets",
    fallbackType: "release",
  },
];

// Maps rather than plain objects: branch names are user text, and a plain-object
// table hands back inherited members for `constructor/foo` or `__proto__/x`.
const TYPE_BY_PREFIX = new Map<string, KnownBranchType>();
for (const type of BRANCH_TYPES) {
  for (const prefix of [type.prefix, ...type.aliases]) {
    TYPE_BY_PREFIX.set(prefix.toLowerCase(), type);
  }
}

const NAMESPACE_BY_ID = new Map<string, KnownBranchNamespace>(
  BRANCH_NAMESPACES.map((namespace) => [namespace.id, namespace])
);

const TYPE_BY_ID = new Map<string, KnownBranchType>(BRANCH_TYPES.map((type) => [type.id, type]));

// Longest first, so `design-review-x` matches `design-review` before `design`.
const HYPHEN_PREFIXES = [...TYPE_BY_PREFIX.keys()].sort((a, b) => b.length - a.length);

/** The type a prefix or alias names, case-insensitively, or null. */
export function lookupBranchType(prefix: string): KnownBranchType | null {
  return TYPE_BY_PREFIX.get(prefix.toLowerCase()) ?? null;
}

export function getBranchType(id: string): KnownBranchType | null {
  return TYPE_BY_ID.get(id) ?? null;
}

export interface BranchClassification {
  /** The work type the branch names, or null when it names none. */
  type: KnownBranchType | null;
  /** Who the branch says made it, when its first segment is a namespace. */
  namespace: BranchNamespace | null;
  /**
   * The leading segment a label folds into its glyph, spelled as the branch
   * spells it; empty when the whole name stays in the label.
   */
  prefix: string;
  /** The branch with `prefix` and its slash removed. */
  rest: string;
}

const RELEASE_PLEASE = /^release-please--branches--./;
const GITHUB_REVERT = /^revert-\d+-./;

/**
 * Reads what kind of work a branch holds. The sidebar label, grouping and type
 * filters all classify through this, so a branch reads the same everywhere.
 *
 * Precedence: names generated by GitHub and release-please, then a known type
 * or namespace as the first slash segment, then `<user>/<type>/…`, then a
 * lowercase `<type>-…` with no slash. Anything else names no type.
 */
export function classifyBranch(branch: string): BranchClassification {
  const segments = branch.split("/");
  const slashed = segments.length > 1;
  const prefix = slashed ? segments[0]! : "";
  const rest = slashed ? segments.slice(1).join("/") : branch;
  const result = (
    type: KnownBranchType | null,
    namespace: BranchNamespace | null = null
  ): BranchClassification => ({ type, namespace, prefix, rest });

  if (RELEASE_PLEASE.test(branch)) {
    return {
      type: getBranchType("release"),
      namespace: { id: "release-please", kind: "bot", displayName: "release-please" },
      prefix: "",
      rest: branch,
    };
  }
  if (GITHUB_REVERT.test(branch)) {
    return { type: getBranchType("revert"), namespace: null, prefix: "", rest: branch };
  }

  if (slashed && prefix) {
    const direct = lookupBranchType(prefix);
    if (direct) return result(direct);

    // A namespace or person only lends its type to a third segment: in
    // `codex/fix` the `fix` is the branch's name, not its kind.
    const nested =
      segments.length >= 3 && segments.every((segment) => segment.length > 0)
        ? lookupBranchType(segments[1]!)
        : null;

    const known = NAMESPACE_BY_ID.get(prefix.toLowerCase());
    if (known) {
      const { fallbackType, ...namespace } = known;
      return result(nested ?? (fallbackType ? getBranchType(fallbackType) : null), namespace);
    }
    if (nested) return result(nested, { id: prefix, kind: "user", displayName: prefix });
    return result(null);
  }

  if (!slashed) {
    // Lowercase only: `CI-42-flaky-test` is an issue key, not a CI branch.
    for (const candidate of HYPHEN_PREFIXES) {
      if (branch.length > candidate.length + 1 && branch.startsWith(`${candidate}-`)) {
        return result(TYPE_BY_PREFIX.get(candidate)!);
      }
    }
  }

  return result(null);
}

const STANDARD_BRANCHES = new Set(["main", "master", "develop", "dev"]);

export function isStandardBranch(branch: string): boolean {
  return STANDARD_BRANCHES.has(branch.toLowerCase());
}
