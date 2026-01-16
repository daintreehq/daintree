import { BRANCH_TYPES, BRANCH_PREFIX_MAP } from "@shared/config/branchPrefixes";
import type { BranchType } from "@shared/config/branchPrefixes";
import type { GitHubIssue } from "@shared/types/github";

export interface ParsedBranchInput {
  prefix: string;
  slug: string;
  fullBranchName: string;
  hasPrefix: boolean;
}

export interface PrefixSuggestion {
  type: BranchType;
  matchScore: number;
}

/**
 * Parses freeform branch input into prefix and slug components.
 * Handles: "feature/my-branch", "feat/my-branch", "my-branch" (no prefix)
 */
export function parseBranchInput(input: string): ParsedBranchInput {
  const trimmed = input.trim();
  const slashIndex = trimmed.indexOf("/");

  if (slashIndex === -1) {
    // No slash - treat as branch without prefix
    return {
      prefix: "",
      slug: trimmed,
      fullBranchName: trimmed,
      hasPrefix: false,
    };
  }

  const potentialPrefix = trimmed.slice(0, slashIndex);
  const slug = trimmed.slice(slashIndex + 1);

  // Empty prefix (leading slash) is invalid - treat as no prefix
  if (!potentialPrefix) {
    return {
      prefix: "",
      slug: trimmed,
      fullBranchName: trimmed,
      hasPrefix: false,
    };
  }

  // Check if the prefix is a known prefix or alias (case-insensitive)
  const isKnownPrefix = !!BRANCH_PREFIX_MAP[potentialPrefix.toLowerCase()];

  if (isKnownPrefix) {
    // Normalize alias to canonical prefix (e.g., "feat" -> "feature")
    const canonicalPrefix = BRANCH_PREFIX_MAP[potentialPrefix.toLowerCase()].prefix;
    return {
      prefix: canonicalPrefix,
      slug,
      fullBranchName: `${canonicalPrefix}/${slug}`,
      hasPrefix: true,
    };
  }

  // Unknown prefix - preserve case for custom prefixes, but validate characters
  return {
    prefix: potentialPrefix,
    slug,
    fullBranchName: `${potentialPrefix}/${slug}`,
    hasPrefix: true,
  };
}

/**
 * Suggests prefixes based on partial input.
 * Returns known prefixes sorted by relevance.
 */
export function suggestPrefixes(query: string): PrefixSuggestion[] {
  const lowerQuery = query.toLowerCase();

  if (!lowerQuery) {
    // No query - return all types with equal score
    return BRANCH_TYPES.map((type) => ({ type, matchScore: 1 }));
  }

  const suggestions: PrefixSuggestion[] = [];

  BRANCH_TYPES.forEach((type) => {
    // Check prefix match
    const prefixMatch = type.prefix.toLowerCase().startsWith(lowerQuery);
    const exactMatch = type.prefix.toLowerCase() === lowerQuery;

    // Check alias match
    const aliasMatch = type.aliases.some((alias) => alias.toLowerCase().startsWith(lowerQuery));
    const exactAliasMatch = type.aliases.some((alias) => alias.toLowerCase() === lowerQuery);

    if (exactMatch || exactAliasMatch) {
      suggestions.push({ type, matchScore: 100 });
    } else if (prefixMatch) {
      suggestions.push({ type, matchScore: 50 });
    } else if (aliasMatch) {
      suggestions.push({ type, matchScore: 40 });
    }
  });

  // Sort by match score (descending), then alphabetically
  return suggestions.sort((a, b) => {
    if (b.matchScore !== a.matchScore) {
      return b.matchScore - a.matchScore;
    }
    return a.type.prefix.localeCompare(b.type.prefix);
  });
}

/**
 * Auto-detects appropriate prefix from GitHub issue context.
 * Uses hybrid approach: labels first, then conservative title keyword matching.
 */
export function detectPrefixFromIssue(issue: GitHubIssue | null): string | null {
  if (!issue) return null;

  // Strategy 1: Label-based detection (most reliable)
  const labels = issue.labels || [];

  for (const label of labels) {
    const name = label.name.toLowerCase();

    // Bug-related labels
    if (/\b(bug|bugfix|hotfix)\b/.test(name)) {
      return "bugfix";
    }

    // Feature/enhancement labels
    if (/\b(feature|enhancement|feat)\b/.test(name)) {
      return "feature";
    }

    // Documentation labels
    if (/\b(docs?|documentation)\b/.test(name)) {
      return "docs";
    }

    // Refactor labels
    if (/\b(refactor|refactoring)\b/.test(name)) {
      return "refactor";
    }

    // Chore labels
    if (/\b(chore|maintenance)\b/.test(name)) {
      return "chore";
    }

    // Test labels
    if (/\b(test|tests|testing)\b/.test(name)) {
      return "test";
    }

    // Performance labels
    if (/\b(perf|performance|optimization)\b/.test(name)) {
      return "perf";
    }
  }

  // Strategy 2: Conservative title keyword detection (fallback)
  const title = issue.title.toLowerCase();

  // Only match at word boundaries to avoid false positives
  if (/\bfix(es|ed|ing)?\b/.test(title) || /\bbug\b/.test(title)) {
    return "bugfix";
  }

  if (/\badd(s|ed|ing)?\b/.test(title) || /\bimplement(s|ed|ing)?\b/.test(title)) {
    return "feature";
  }

  if (/\brefactor(s|ed|ing)?\b/.test(title)) {
    return "refactor";
  }

  if (/\bupdate(s|d|ing)?\b/.test(title) || /\bimprove(s|d|ing)?\b/.test(title)) {
    return "feature";
  }

  // No confident detection - return null
  return null;
}

/**
 * Builds full branch name from prefix and slug.
 */
export function buildBranchName(prefix: string, slug: string): string {
  if (!prefix) return slug;
  return `${prefix}/${slug}`;
}
