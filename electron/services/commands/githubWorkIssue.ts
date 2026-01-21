/**
 * github:work-issue command - Creates a worktree for a GitHub issue.
 *
 * Automates the workflow of:
 * 1. Fetching issue details from GitHub
 * 2. Generating a branch name from the issue
 * 3. Creating a new worktree
 * 4. Switching to the new worktree
 */

import type { GraphQlQueryResponseData } from "@octokit/graphql";
import type {
  CanopyCommand,
  CommandContext,
  CommandResult,
} from "../../../shared/types/commands.js";
import { hasGitHubToken, getRepoContext, getIssueUrl } from "../GitHubService.js";
import { GitHubAuth, GET_ISSUE_QUERY } from "../github/index.js";
import { getWorkspaceClient } from "../WorkspaceClient.js";
import { GitService } from "../GitService.js";
import { store } from "../../store.js";
import {
  generateWorktreePath,
  DEFAULT_WORKTREE_PATH_PATTERN,
  validatePathPattern,
} from "../../../shared/utils/pathPattern.js";

/** Arguments for the github:work-issue command */
export interface GitHubWorkIssueArgs {
  issueNumber: number;
  branchName?: string;
  baseBranch?: string;
}

/** Issue details fetched from GitHub */
interface IssueDetails {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED";
}

/** Result data returned on success */
export interface GitHubWorkIssueResult {
  worktreeId: string;
  worktreePath: string;
  branchName: string;
  issue: IssueDetails;
  issueUrl: string;
}

/**
 * Slugify an issue title for use in a branch name.
 *
 * Rules:
 * - Lowercase
 * - Replace spaces and special chars with hyphens
 * - Remove consecutive hyphens
 * - Truncate to 50 chars (not cutting words)
 * - Remove trailing hyphens
 */
function slugifyTitle(title: string): string {
  let slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  // Truncate to 50 chars without cutting words
  if (slug.length > 50) {
    slug = slug.slice(0, 50);
    const lastHyphen = slug.lastIndexOf("-");
    if (lastHyphen > 30) {
      slug = slug.slice(0, lastHyphen);
    }
  }

  return slug.replace(/-$/, "");
}

/**
 * Generate a branch name from an issue number and title.
 * Format: issue-{number}-{slugified-title}
 */
function generateBranchName(issueNumber: number, issueTitle: string): string {
  const slug = slugifyTitle(issueTitle);
  return `issue-${issueNumber}-${slug}`;
}

/**
 * Fetch issue details from GitHub API.
 */
async function fetchIssueDetails(cwd: string, issueNumber: number): Promise<IssueDetails> {
  const client = GitHubAuth.createClient();
  if (!client) {
    throw new Error("GitHub token not configured");
  }

  const context = await getRepoContext(cwd);
  if (!context) {
    throw new Error("Not a GitHub repository");
  }

  const response = (await client(GET_ISSUE_QUERY, {
    owner: context.owner,
    repo: context.repo,
    number: issueNumber,
  })) as GraphQlQueryResponseData;

  const issue = response?.repository?.issue;
  if (!issue) {
    throw new Error(`Issue #${issueNumber} not found`);
  }

  return {
    number: issue.number as number,
    title: issue.title as string,
    url: issue.url as string,
    state: issue.state as "OPEN" | "CLOSED",
  };
}

/**
 * Detect the best base branch to use.
 * Prefers 'develop' if it exists, otherwise uses the default branch (usually 'main').
 * Returns both the branch name and whether it should be fetched from remote.
 */
async function detectBaseBranch(
  rootPath: string
): Promise<{ branch: string; fromRemote: boolean }> {
  const gitService = new GitService(rootPath);
  const branches = await gitService.listBranches();

  // Helper to check if branch exists and determine if it's local or remote-only
  const checkBranch = (name: string) => {
    const hasLocal = branches.some((b) => b.name === name && !b.remote);
    const hasRemote = branches.some((b) => b.name === `origin/${name}` && b.remote);

    if (hasLocal) {
      return { exists: true, fromRemote: false, branch: name };
    }
    if (hasRemote) {
      return { exists: true, fromRemote: true, branch: `origin/${name}` };
    }
    return { exists: false, fromRemote: false, branch: name };
  };

  // Check develop, then main, then master
  for (const branchName of ["develop", "main", "master"]) {
    const result = checkBranch(branchName);
    if (result.exists) {
      return { branch: result.branch, fromRemote: result.fromRemote };
    }
  }

  // Default to main (will be created from current branch if it doesn't exist)
  return { branch: "main", fromRemote: false };
}

export const githubWorkIssueCommand: CanopyCommand<GitHubWorkIssueArgs, GitHubWorkIssueResult> = {
  id: "github:work-issue",
  label: "/github:work-issue",
  description: "Create a worktree for a GitHub issue",
  category: "github",

  args: [
    {
      name: "issueNumber",
      type: "number",
      description: "GitHub issue number (optional - agent can detect from context)",
      required: false,
    },
    {
      name: "branchName",
      type: "string",
      description: "Custom branch name (auto-generated if not provided)",
      required: false,
    },
    {
      name: "baseBranch",
      type: "string",
      description: "Base branch to branch from (defaults to main or develop)",
      required: false,
    },
  ],

  builder: {
    steps: [
      {
        id: "issue",
        title: "Select Issue",
        description: "Specify the issue to work on - the agent can help if you're unsure",
        fields: [
          {
            name: "issueNumber",
            label: "Issue Number",
            type: "number",
            placeholder: "e.g., 123",
            validation: {
              min: 1,
              message: "Issue number must be a positive integer",
            },
            helpText: "The GitHub issue number. Leave empty to let the agent help you find one.",
          },
          {
            name: "branchName",
            label: "Branch Name",
            type: "text",
            placeholder: "Auto-generated from issue title",
            helpText: "Optional custom branch name. If not provided, will be auto-generated.",
          },
          {
            name: "baseBranch",
            label: "Base Branch",
            type: "text",
            placeholder: "main",
            helpText: "Branch to base off. Defaults to develop (if exists) or main.",
          },
        ],
      },
    ],
  },

  keywords: ["github", "issue", "worktree", "branch", "work"],

  isEnabled: () => hasGitHubToken(),

  disabledReason: () =>
    hasGitHubToken() ? undefined : "GitHub token not configured. Set it in Settings.",

  async execute(
    context: CommandContext,
    args: GitHubWorkIssueArgs
  ): Promise<CommandResult<GitHubWorkIssueResult>> {
    const { issueNumber, branchName: customBranchName, baseBranch: customBaseBranch } = args;

    // Validate issue number
    if (!issueNumber || issueNumber < 1 || !Number.isInteger(issueNumber)) {
      return {
        success: false,
        error: {
          code: "INVALID_ARGS",
          message: "Issue number must be a positive integer",
        },
      };
    }

    // Get working directory from context or use default
    const cwd = context.cwd;
    if (!cwd) {
      return {
        success: false,
        error: {
          code: "NO_CWD",
          message: "No working directory provided in context",
        },
      };
    }

    // Resolve to repository root to ensure correct path generation
    let rootPath: string;
    try {
      const gitService = new GitService(cwd);
      rootPath = await gitService.getRepositoryRoot(cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: {
          code: "NOT_GIT_REPO",
          message: `Not a git repository: ${message}`,
        },
      };
    }

    // Check GitHub token
    if (!hasGitHubToken()) {
      return {
        success: false,
        error: {
          code: "NO_GITHUB_TOKEN",
          message: "GitHub token not configured. Set it in Settings.",
        },
      };
    }

    // Fetch issue details
    let issue: IssueDetails;
    try {
      issue = await fetchIssueDetails(rootPath, issueNumber);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes("not found")) {
        return {
          success: false,
          error: {
            code: "ISSUE_NOT_FOUND",
            message: `Issue #${issueNumber} not found`,
          },
        };
      }

      if (message.includes("Not a GitHub repository")) {
        return {
          success: false,
          error: {
            code: "NOT_GITHUB_REPO",
            message: "Not a GitHub repository",
          },
        };
      }

      return {
        success: false,
        error: {
          code: "GITHUB_ERROR",
          message: `Failed to fetch issue: ${message}`,
        },
      };
    }

    // Generate or validate branch name
    let branchName = customBranchName || generateBranchName(issue.number, issue.title);

    // Validate custom branch name if provided
    if (customBranchName) {
      if (!customBranchName.trim()) {
        return {
          success: false,
          error: {
            code: "INVALID_ARGS",
            message: "Branch name cannot be empty or whitespace",
          },
        };
      }
      branchName = customBranchName.trim();
    }

    // Detect base branch and whether to use remote
    let baseBranch: string;
    let fromRemote: boolean;
    try {
      if (customBaseBranch) {
        baseBranch = customBaseBranch;
        fromRemote = false;
      } else {
        const detected = await detectBaseBranch(rootPath);
        baseBranch = detected.branch;
        fromRemote = detected.fromRemote;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: {
          code: "BASE_BRANCH_ERROR",
          message: `Failed to detect base branch: ${message}`,
        },
      };
    }

    // Get GitService for branch and path validation (using rootPath)
    const gitService = new GitService(rootPath);

    // Find an available branch name (handles conflicts automatically)
    let finalBranchName: string;
    try {
      finalBranchName = await gitService.findAvailableBranchName(branchName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: {
          code: "BRANCH_ERROR",
          message: `Failed to validate branch name: ${message}`,
        },
      };
    }

    // Generate worktree path using configured pattern (from rootPath)
    const configPattern = store.get("worktreeConfig.pathPattern");
    const pattern =
      typeof configPattern === "string" && configPattern.trim()
        ? configPattern
        : DEFAULT_WORKTREE_PATH_PATTERN;

    const validation = validatePathPattern(pattern);
    if (!validation.valid) {
      return {
        success: false,
        error: {
          code: "INVALID_PATTERN",
          message: `Invalid worktree path pattern: ${validation.error}`,
        },
      };
    }

    const initialPath = generateWorktreePath(rootPath, finalBranchName, pattern);
    const worktreePath = gitService.findAvailablePath(initialPath);

    // Get workspace client
    const workspaceClient = getWorkspaceClient();
    if (!workspaceClient.isReady()) {
      return {
        success: false,
        error: {
          code: "WORKSPACE_NOT_READY",
          message: "Workspace service is not ready. Please try again.",
        },
      };
    }

    // Create worktree (using rootPath and detected fromRemote flag)
    let worktreeId: string;
    try {
      worktreeId = await workspaceClient.createWorktree(rootPath, {
        baseBranch,
        newBranch: finalBranchName,
        path: worktreePath,
        fromRemote,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: {
          code: "WORKTREE_CREATE_FAILED",
          message: `Failed to create worktree: ${message}`,
        },
      };
    }

    // Switch to the new worktree
    let switchWarning: string | undefined;
    try {
      await workspaceClient.setActiveWorktree(worktreeId);
    } catch (error) {
      // Non-fatal - worktree was created, just couldn't switch
      const errorMessage = error instanceof Error ? error.message : String(error);
      switchWarning = `Worktree created but failed to switch: ${errorMessage}`;
      console.warn("Failed to switch to new worktree:", errorMessage);
    }

    // Get issue URL (using rootPath)
    const issueUrl = (await getIssueUrl(rootPath, issueNumber)) || issue.url;

    // Build success message with warning if switch failed
    const successMessage = switchWarning
      ? `Created worktree for issue #${issueNumber}: ${issue.title}. Warning: ${switchWarning}`
      : `Created worktree for issue #${issueNumber}: ${issue.title}`;

    return {
      success: true,
      message: successMessage,
      data: {
        worktreeId,
        worktreePath,
        branchName: finalBranchName,
        issue,
        issueUrl,
      },
    };
  },
};
