import type { CanopyCommand, CommandResult } from "../../../shared/types/commands.js";
import { getGitHubToken, getRepoContext, clearGitHubCaches } from "../GitHubService.js";

interface CreateIssueArgs {
  title: string;
  body: string;
  labels?: string;
}

interface CreateIssueResult {
  url: string;
  number: number;
  title: string;
}

export const githubCreateIssueCommand: CanopyCommand<CreateIssueArgs, CreateIssueResult> = {
  id: "github:create-issue",
  label: "/github:create-issue",
  description: "Create a new GitHub issue in the current repository",
  category: "github",
  keywords: ["issue", "create", "new", "bug", "feature", "ticket"],

  args: [
    {
      name: "title",
      type: "string",
      description: "Issue title",
      required: true,
    },
    {
      name: "body",
      type: "string",
      description: "Issue description/body",
      required: true,
    },
    {
      name: "labels",
      type: "string",
      description: "Comma-separated labels (e.g., 'bug,ui')",
      required: false,
    },
  ],

  builder: {
    steps: [
      {
        id: "issue-details",
        title: "Issue Details",
        description: "Enter the details for the new GitHub issue",
        fields: [
          {
            name: "title",
            label: "Title",
            type: "text",
            placeholder: "Brief description of the issue",
            required: true,
            validation: {
              min: 10,
              message: "Title must be at least 10 characters",
            },
            helpText: "A clear, concise title describing the issue",
          },
          {
            name: "body",
            label: "Description",
            type: "textarea",
            placeholder: "Detailed description of the issue...",
            required: true,
            helpText: "Provide context, steps to reproduce, expected behavior, etc.",
          },
          {
            name: "labels",
            label: "Labels",
            type: "text",
            placeholder: "bug, enhancement, documentation",
            required: false,
            helpText: "Comma-separated labels to apply (optional)",
          },
        ],
      },
    ],
  },

  isEnabled: () => {
    return !!getGitHubToken();
  },

  disabledReason: () => {
    if (!getGitHubToken()) {
      return "GitHub token not configured. Set it in Settings > GitHub.";
    }
    return undefined;
  },

  execute: async (context, args): Promise<CommandResult<CreateIssueResult>> => {
    const token = getGitHubToken();
    if (!token) {
      return {
        success: false,
        error: {
          code: "NO_TOKEN",
          message: "GitHub token not configured. Set it in Settings > GitHub.",
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

    const repoContext = await getRepoContext(cwd);
    if (!repoContext) {
      return {
        success: false,
        error: {
          code: "NOT_GIT_REPO",
          message: "Not in a GitHub repository or cannot determine repository from git remote",
        },
      };
    }

    const { owner, repo } = repoContext;
    let { title, body } = args;
    const { labels } = args;

    // Validate and trim title and body to match builder requirements
    title = title.trim();
    body = body.trim();

    if (!title || title.length < 10) {
      return {
        success: false,
        error: {
          code: "INVALID_TITLE",
          message: "Title must be at least 10 characters",
        },
      };
    }

    if (!body) {
      return {
        success: false,
        error: {
          code: "INVALID_BODY",
          message: "Description is required",
        },
      };
    }

    const requestBody: Record<string, unknown> = {
      title,
      body,
    };

    if (labels) {
      const labelArray = labels
        .split(",")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (labelArray.length > 0) {
        requestBody.labels = labelArray;
      }
    }

    try {
      const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage: string;

        if (response.status === 401) {
          errorMessage = "Invalid GitHub token. Please update in Settings.";
        } else if (response.status === 403) {
          // Check for rate limit or SSO in error body
          if (errorText.includes("rate limit") || errorText.includes("API rate limit")) {
            errorMessage = "GitHub rate limit exceeded. Try again in a few minutes.";
          } else if (errorText.includes("SAML") || errorText.includes("SSO")) {
            errorMessage = "SSO authorization required. Re-authorize at github.com.";
          } else {
            errorMessage = "Token lacks required permissions. Required scopes: repo";
          }
        } else if (response.status === 404) {
          errorMessage = "Repository not found or you don't have access";
        } else if (response.status === 422) {
          try {
            const errorData = JSON.parse(errorText) as { message?: string };
            errorMessage = errorData.message ?? "Validation failed";
          } catch {
            errorMessage = "Validation failed";
          }
        } else {
          errorMessage = `GitHub API error: ${response.status} ${response.statusText}`;
        }

        return {
          success: false,
          error: {
            code: "API_ERROR",
            message: errorMessage,
            details: { status: response.status, body: errorText },
          },
        };
      }

      const data = (await response.json()) as {
        html_url?: string;
        number?: number;
        title?: string;
      };

      if (!data.html_url || !data.number || !data.title) {
        return {
          success: false,
          error: {
            code: "INVALID_RESPONSE",
            message: "Invalid response from GitHub API",
          },
        };
      }

      // Clear GitHub caches to ensure the new issue appears in lists
      clearGitHubCaches();

      return {
        success: true,
        message: `Issue #${data.number} created successfully`,
        data: {
          url: data.html_url,
          number: data.number,
          title: data.title,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

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
