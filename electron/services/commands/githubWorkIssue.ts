/**
 * github:work-issue command - Creates a worktree for a forge issue.
 *
 * Automates the workflow of:
 * 1. Fetching issue details from the active forge provider
 * 2. Generating a branch name from the issue
 * 3. Creating a new worktree
 * 4. Switching to the new worktree
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  DaintreeCommand,
  CommandContext,
  CommandResult,
} from "../../../shared/types/commands.js";
import type { NormalizedIssueState } from "../../../shared/types/forge.js";
import { hasActivatedForgeProvider } from "../forgeProviderRegistry.js";
import { resolveForCwd } from "../../ipc/handlers/forgeResolution.js";
import { auditForgeCall, summarizeForgeArgs } from "../forge/forgeAuditService.js";
import { getWorkspaceClient } from "../WorkspaceClient.js";
import { GitService } from "../GitService.js";
import { generateWorktreePath, validatePathPattern } from "../../../shared/utils/pathPattern.js";
import { resolveWorktreePattern } from "../../utils/worktreePattern.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";

/** Arguments for the github:work-issue command */
export interface GitHubWorkIssueArgs {
  issueNumber: number;
  branchName?: string;
  baseBranch?: string;
}

/** Issue details fetched from the active forge provider */
interface IssueDetails {
  number: number;
  title: string;
  url: string;
  state: NormalizedIssueState;
}

/** Result data returned on success */
export interface GitHubWorkIssueResult {
  worktreeId: string;
  worktreePath: string;
  branchName: string;
  issue: IssueDetails;
  issueUrl: string;
}

const NETWORK_ERROR_CODES = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ECONNRESET",
  "EAI_AGAIN",
]);

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
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
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
  return slug ? `issue-${issueNumber}-${slug}` : `issue-${issueNumber}`;
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

  // Check develop, then trunk, then main, then master
  for (const branchName of ["develop", "trunk", "main", "master"]) {
    const result = checkBranch(branchName);
    if (result.exists) {
      return { branch: result.branch, fromRemote: result.fromRemote };
    }
  }

  // Default to main (will be created from current branch if it doesn't exist)
  return { branch: "main", fromRemote: false };
}

export const githubWorkIssueCommand: DaintreeCommand<GitHubWorkIssueArgs, GitHubWorkIssueResult> = {
  id: "github:work-issue",
  label: "/github:work-issue",
  description:
    "Start working on a GitHub issue by creating an isolated worktree. " +
    "Fetches issue details, generates a branch name, creates a worktree, and switches to it. " +
    "Perfect for parallel development without stashing changes.",
  category: "github",

  args: [
    {
      name: "issueNumber",
      type: "number",
      description:
        "GitHub issue number to work on. Can be extracted from issue URL or entered directly. (optional - agent can detect from context)",
      required: false,
    },
    {
      name: "branchName",
      type: "string",
      description:
        "Custom branch name. If not provided, auto-generates as 'issue-{number}-{slugified-title}'.",
      required: false,
    },
    {
      name: "baseBranch",
      type: "string",
      description:
        "Base branch to branch from. Auto-detects: prefers 'develop' if exists, otherwise tries 'trunk', 'main', then 'master'. " +
        "For hotfixes, use 'main' explicitly.",
      required: false,
    },
  ],

  builder: {
    steps: [
      {
        id: "issue",
        title: "Work on GitHub Issue",
        description:
          "Create an isolated worktree for the issue. By default, the worktree is created in a sibling " +
          "directory, allowing you to work on multiple issues simultaneously without conflicts.",
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
            label: "Branch Name (Optional)",
            type: "text",
            placeholder: "issue-1234-add-dark-mode",
            helpText:
              "Leave empty to auto-generate from issue title. Format: issue-{number}-{slugified-title}. " +
              "If the branch already exists, a suffix will be added automatically.",
          },
          {
            name: "baseBranch",
            label: "Base Branch (Optional)",
            type: "text",
            placeholder: "develop",
            helpText:
              "Branch to start from. Auto-detects: uses 'develop' if it exists, otherwise tries 'trunk', 'main', then 'master'. " +
              "Override for hotfixes (use 'main') or feature branches (use specific branch).",
          },
        ],
      },
    ],
  },

  keywords: ["github", "issue", "worktree", "branch", "work", "parallel", "isolate"],

  isEnabled: () => hasActivatedForgeProvider(),

  disabledReason: () =>
    hasActivatedForgeProvider()
      ? undefined
      : "No forge provider is active. Enable one (e.g. GitHub) in Settings.",

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
      const message = formatErrorMessage(error, "Not a git repository");
      return {
        success: false,
        error: {
          code: "NOT_GIT_REPO",
          message: `Not a git repository: ${message}`,
        },
      };
    }

    // Resolve the active forge provider for this repo. Routing through the
    // contract (rather than a raw GitHub fetch) lets any registered provider
    // answer, matching the other forge command surfaces.
    let resolved;
    try {
      resolved = await resolveForCwd(rootPath);
    } catch (error) {
      // resolveForCwd throws distinct messages for "no remote", "no provider
      // registered", "provider not activated", etc. — preserve them rather than
      // flattening to NOT_GIT_REPO (the git-root check above already owns that).
      const message = formatErrorMessage(error, "Failed to resolve forge provider");
      return {
        success: false,
        error: {
          code: "FORGE_PROVIDER_ERROR",
          message: `Failed to resolve forge provider: ${message}`,
        },
      };
    }

    // Fetch issue details through the forge contract.
    let issue: IssueDetails;
    try {
      const forgeIssue = await auditForgeCall(
        {
          providerId: resolved.namespaceId,
          methodName: "getIssue",
          repoOwner: resolved.repoRef.owner,
          repoName: resolved.repoRef.repo,
          argsSummary: summarizeForgeArgs("getIssue", issueNumber),
        },
        () => resolved.impl.getIssue(resolved.repoRef, issueNumber),
        (value) => (value === null ? "not-found" : "success")
      );

      if (!forgeIssue) {
        return {
          success: false,
          error: {
            code: "ISSUE_NOT_FOUND",
            message: `Issue #${issueNumber} not found`,
          },
        };
      }

      issue = {
        number: forgeIssue.number,
        title: forgeIssue.title,
        url: forgeIssue.url,
        state: forgeIssue.state,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        return {
          success: false,
          error: {
            code: "GITHUB_ERROR",
            message: "Timed out reaching the forge provider. Try again.",
          },
        };
      }

      const causeCode = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code;
      if (typeof causeCode === "string" && NETWORK_ERROR_CODES.has(causeCode)) {
        return {
          success: false,
          error: {
            code: "GITHUB_ERROR",
            message: "Network error connecting to the forge provider.",
          },
        };
      }

      const message = formatErrorMessage(error, "Failed to fetch issue");
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
        const trimmedBaseBranch = customBaseBranch.trim();
        if (!trimmedBaseBranch) {
          return {
            success: false,
            error: {
              code: "INVALID_ARGS",
              message: "Base branch cannot be empty or whitespace",
            },
          };
        }
        baseBranch = trimmedBaseBranch;
        fromRemote = false;
      } else {
        const detected = await detectBaseBranch(rootPath);
        baseBranch = detected.branch;
        fromRemote = detected.fromRemote;
      }
    } catch (error) {
      const message = formatErrorMessage(error, "Failed to detect base branch");
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
      const message = formatErrorMessage(error, "Failed to validate branch name");
      return {
        success: false,
        error: {
          code: "BRANCH_ERROR",
          message: `Failed to validate branch name: ${message}`,
        },
      };
    }

    // Generate worktree path using configured pattern (project-level → global → default)
    const pattern = await resolveWorktreePattern(rootPath);

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

    // Ensure the parent directory exists for the worktree path
    const parentDir = dirname(worktreePath);
    if (!existsSync(parentDir)) {
      try {
        await mkdir(parentDir, { recursive: true });
      } catch (error) {
        const message = formatErrorMessage(error, "Failed to create worktree directory");
        return {
          success: false,
          error: {
            code: "DIRECTORY_CREATE_FAILED",
            message: `Failed to create worktree directory: ${message}`,
          },
        };
      }
    }

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
      ({ worktreeId } = await workspaceClient.createWorktree(rootPath, {
        baseBranch,
        newBranch: finalBranchName,
        path: worktreePath,
        fromRemote,
      }));
    } catch (error) {
      const message = formatErrorMessage(error, "Failed to create worktree");
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
      const errorMessage = formatErrorMessage(error, "Failed to switch worktree");
      switchWarning = `Worktree created but failed to switch: ${errorMessage}`;
      console.warn("Failed to switch to new worktree:", errorMessage);
    }

    // The forge provider returns a canonical issue URL in its response.
    const issueUrl = issue.url;

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
