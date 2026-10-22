import type { ForgeIssueProviderImpl, Issue } from "../../../../shared/types/forge.js";
import { localAuthStubs } from "../../../../shared/utils/forgeProviderHelpers.js";

/**
 * A tracker-shaped issues-only provider (#13700): no PR, CI or remote parsing,
 * a repository reference built from the project, and issues carrying a stable
 * id, a display key and a suggested branch. Typed without casts on purpose —
 * if `ForgeIssueProviderImpl` ever starts requiring a code-role member, this
 * stops compiling.
 */
export function makeIssuesOnlyProvider(
  issues: Issue[] = [makeTrackerIssue(42, "Fix login")]
): ForgeIssueProviderImpl & {
  resolveIssueRepo: NonNullable<ForgeIssueProviderImpl["resolveIssueRepo"]>;
} {
  const find = (n: number) => issues.find((issue) => issue.number === n) ?? null;
  const unsupported = async (): Promise<never> => {
    throw new Error("Not supported");
  };
  return {
    ...localAuthStubs,
    resolveIssueRepo: async (projectPath) => ({
      host: "tracker.invalid",
      owner: "ENG",
      repo: "ENG",
      rawData: { teamKey: "ENG", projectPath },
    }),
    listIssues: async () => ({
      items: issues,
      nextCursor: null,
      hasMore: false,
      totalCount: issues.length,
    }),
    getIssue: async (_repo, n) => find(n),
    // Stable id or full key, as a provider that claims branch keys must accept.
    getIssueById: async (_repo, id) =>
      issues.find((issue) => issue.id === id || issue.key === id) ?? null,
    getIssueBranchKeys: async () => ["ENG"],
    buildIssueUrl: (_repo, n) => `https://tracker.invalid/issue/ENG-${n}`,
    buildIssuesUrl: () => "https://tracker.invalid/team/ENG",
    createIssue: unsupported,
    assignIssue: async () => [],
    unassignIssue: async () => [],
    closeIssue: unsupported,
    reopenIssue: unsupported,
    editIssue: unsupported,
    addIssueComment: unsupported,
    addIssueLabel: async () => [],
    removeIssueLabel: async () => [],
  };
}

export function makeTrackerIssue(number: number, title: string): Issue {
  return {
    number,
    title,
    body: "",
    state: "open",
    rawState: "started",
    url: `https://tracker.invalid/issue/ENG-${number}`,
    assignees: [],
    labels: [],
    createdAt: 0,
    updatedAt: 0,
    id: `uuid-${number}`,
    key: `ENG-${number}`,
    branchName: `eng-${number}-${title.toLowerCase().replace(/\s+/g, "-")}`,
    rawData: null,
  };
}
