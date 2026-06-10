import type { DaintreeCommand, CommandResult } from "../../../shared/types/commands.js";
import type { CreateIssueInput } from "../../../shared/types/forge.js";
import { getGitHubToken, clearGitHubCaches } from "../GitHubService.js";
import { hasActivatedForgeProvider } from "../forgeProviderRegistry.js";
import { resolveForCwd } from "../../ipc/handlers/forgeResolution.js";
import { auditForgeCall, summarizeForgeArgs } from "../forge/forgeAuditService.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";

const NETWORK_ERROR_CODES = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ECONNRESET",
  "EAI_AGAIN",
]);

interface CreateIssueArgs {
  title?: string;
  body?: string;
  labels?: string;
}

interface CreateIssueResult {
  url: string;
  number: number;
  title: string;
}

export const githubCreateIssueCommand: DaintreeCommand<CreateIssueArgs, CreateIssueResult> = {
  id: "github:create-issue",
  label: "/github:create-issue",
  description:
    "Create a GitHub issue in the current repository. " +
    "Use structured sections, file links, and task lists to make issues self-contained for autonomous work.",
  category: "github",
  keywords: ["issue", "create", "new", "bug", "feature", "ticket", "task", "request"],

  args: [
    {
      name: "title",
      type: "string",
      description:
        "Concise title describing what needs to be done (e.g., 'Add dark mode toggle to settings') (optional - agent can generate)",
      required: false,
    },
    {
      name: "body",
      type: "string",
      description:
        "Issue explanation or structured body. The agent will interpret natural language input. (optional)",
      required: false,
    },
    {
      name: "labels",
      type: "string",
      description: "Comma-separated labels (e.g., 'enhancement,ui' or 'bug,critical')",
      required: false,
    },
  ],

  builder: {
    steps: [
      {
        id: "issue-details",
        title: "Create GitHub Issue",
        description:
          "Create a well-structured issue that provides enough context for developers or AI agents to implement autonomously",
        fields: [
          {
            name: "title",
            label: "Issue Title",
            type: "text",
            placeholder: "Optional - agent can generate from your explanation",
            helpText: "Leave empty to let the agent generate a title from your explanation",
          },
          {
            name: "body",
            label: "Explanation",
            type: "textarea",
            placeholder: "Explain what you want to create an issue about...",
            helpText:
              "Describe the issue in natural language. The agent will interpret and format appropriately.",
          },
          {
            name: "labels",
            label: "Labels",
            type: "text",
            placeholder: "enhancement, ui",
            helpText:
              "Common labels: bug, enhancement, documentation, refactor, testing, ui, api, performance",
          },
        ],
      },
    ],
  },

  isEnabled: () => {
    // Mirrors githubWorkIssue: a stored token alone isn't enough — the forge
    // provider must be activated (GitHub plugin enabled), or execute() dies
    // in resolveForCwd with a misleading not-a-git-repo classification.
    return !!getGitHubToken() && hasActivatedForgeProvider();
  },

  disabledReason: () => {
    if (!getGitHubToken()) {
      return "GitHub token not configured. Set it in Settings.";
    }
    if (!hasActivatedForgeProvider()) {
      return "GitHub plugin is disabled. Enable it in Settings to create issues.";
    }
    return undefined;
  },

  execute: async (context, args): Promise<CommandResult<CreateIssueResult>> => {
    if (!getGitHubToken()) {
      return {
        success: false,
        error: {
          code: "NO_TOKEN",
          message: "GitHub token not configured. Set it in Settings.",
        },
      };
    }

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

    const { labels } = args;

    // Trim values if provided
    const title = args.title?.trim() || "";
    const body = args.body?.trim() || "";

    // If no title and no body provided, return message for agent interpretation.
    // The agent in the terminal will handle generating appropriate content.
    if (!title && !body) {
      return {
        success: false,
        error: {
          code: "NO_INPUT",
          message: "Please provide a title or explanation for the issue",
        },
      };
    }

    // Use body as title if title is missing (agent-style behavior)
    const issueTitle = title || body.split("\n")[0].replace(/\r$/, "").slice(0, 100);
    const issueBody = body || title;

    const input: CreateIssueInput = {
      title: issueTitle,
      body: issueBody,
    };

    if (labels) {
      const labelArray = labels
        .split(",")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (labelArray.length > 0) {
        input.labels = labelArray;
      }
    }

    // Resolve the active forge provider for this repo. Routing through the
    // contract (rather than a raw GitHub fetch) lets any registered provider
    // answer, matching the other forge command surfaces.
    let resolved;
    try {
      resolved = await resolveForCwd(cwd);
    } catch (error) {
      const message = formatErrorMessage(error, "Failed to determine repository context");
      return {
        success: false,
        error: {
          code: "NOT_GIT_REPO",
          message: `Failed to determine repository context: ${message}`,
        },
      };
    }

    try {
      const issue = await auditForgeCall(
        {
          providerId: resolved.namespaceId,
          methodName: "createIssue",
          repoOwner: resolved.repoRef.owner,
          repoName: resolved.repoRef.repo,
          argsSummary: summarizeForgeArgs("createIssue", input),
        },
        () => resolved.impl.createIssue(resolved.repoRef, input)
      );

      // Clear forge/GitHub caches so the new issue appears in subsequent lists.
      clearGitHubCaches();

      return {
        success: true,
        message: `Issue #${issue.number} created successfully`,
        data: {
          url: issue.url,
          number: issue.number,
          title: issue.title,
        },
      };
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        return {
          success: false,
          error: {
            code: "TIMEOUT_ERROR",
            message: "Timed out reaching GitHub. Try again.",
          },
        };
      }

      const causeCode = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code;
      if (typeof causeCode === "string" && NETWORK_ERROR_CODES.has(causeCode)) {
        return {
          success: false,
          error: {
            code: "NETWORK_ERROR",
            message: "Cannot reach GitHub. Check your internet connection.",
          },
        };
      }

      const message = formatErrorMessage(error, "Failed to create GitHub issue");

      if (
        message.includes("ENOTFOUND") ||
        message.includes("ETIMEDOUT") ||
        message.includes("ECONNREFUSED") ||
        message.includes("ECONNRESET") ||
        message.includes("EAI_AGAIN") ||
        message.includes("network") ||
        message.includes("fetch failed")
      ) {
        return {
          success: false,
          error: {
            code: "NETWORK_ERROR",
            message: "Cannot reach GitHub. Check your internet connection.",
          },
        };
      }

      return {
        success: false,
        error: {
          code: "EXECUTION_ERROR",
          message,
        },
      };
    }
  },
};
