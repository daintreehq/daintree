import path from "path";
import { CHANNELS } from "../../channels.js";
import { getWindowForWebContents } from "../../../window/webContentsRegistry.js";
import {
  broadcastToRenderer,
  sendToRenderer,
  typedHandle,
  typedHandleWithContext,
} from "../../utils.js";
import { createHardenedGit } from "../../../utils/hardenedGit.js";
import type {
  GitInitOptions,
  GitInitResult,
  GitInitProgressEvent,
} from "../../../../shared/types/ipc/gitInit.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import { AppError } from "../../../utils/errorTypes.js";

export function registerGitInitHandlers(): () => void {
  const handlers: Array<() => void> = [];

  const handleProjectInitGit = async (directoryPath: string): Promise<void> => {
    if (typeof directoryPath !== "string" || !directoryPath) {
      throw new Error("Invalid directory path");
    }
    if (!path.isAbsolute(directoryPath)) {
      throw new Error("Project path must be absolute");
    }

    const fs = await import("fs");
    const stats = await fs.promises.stat(directoryPath);
    if (!stats.isDirectory()) {
      throw new Error("Path is not a directory");
    }

    const git = createHardenedGit(directoryPath);
    await git.init();
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_INIT_GIT, handleProjectInitGit));

  const handleProjectInitGitGuided = async (
    ctx: import("../../types.js").IpcContext,
    options: GitInitOptions
  ): Promise<GitInitResult> => {
    if (!options || typeof options !== "object") {
      throw new Error("Invalid options object");
    }

    const senderWindow = getWindowForWebContents(ctx.event.sender);

    const {
      directoryPath,
      createInitialCommit = true,
      initialCommitMessage = "Initial commit",
      createGitignore = true,
      gitignoreTemplate = "node",
    } = options;

    if (typeof directoryPath !== "string" || !directoryPath) {
      throw new Error("Invalid directory path");
    }
    if (!path.isAbsolute(directoryPath)) {
      throw new Error("Project path must be absolute");
    }

    const completedSteps: GitInitProgressEvent["step"][] = [];

    const emitProgress = (
      step: GitInitProgressEvent["step"],
      status: GitInitProgressEvent["status"],
      message: string,
      error?: string
    ) => {
      const progressEvent: GitInitProgressEvent = {
        step,
        status,
        message,
        error,
        timestamp: Date.now(),
      };
      if (senderWindow && !senderWindow.isDestroyed()) {
        sendToRenderer(senderWindow, CHANNELS.PROJECT_INIT_GIT_PROGRESS, progressEvent);
      } else {
        broadcastToRenderer(CHANNELS.PROJECT_INIT_GIT_PROGRESS, progressEvent);
      }
    };

    try {
      const fs = await import("fs");
      const stats = await fs.promises.stat(directoryPath);
      if (!stats.isDirectory()) {
        throw new Error("Path is not a directory");
      }

      const git = createHardenedGit(directoryPath);

      emitProgress("init", "start", "Initializing Git repository...");
      await git.init();
      completedSteps.push("init");
      emitProgress("init", "success", "Git repository initialized");

      if (createGitignore && gitignoreTemplate !== "none") {
        emitProgress("gitignore", "start", "Creating .gitignore file...");
        const gitignoreContent = getGitignoreTemplate(gitignoreTemplate);
        if (!gitignoreContent) {
          emitProgress(
            "gitignore",
            "error",
            "Invalid gitignore template",
            `Unknown template: ${gitignoreTemplate}`
          );
          throw new Error(`Invalid gitignore template: ${gitignoreTemplate}`);
        }
        const gitignorePath = path.join(directoryPath, ".gitignore");
        const gitignoreExists = await fs.promises
          .access(gitignorePath)
          .then(() => true)
          .catch(() => false);
        if (gitignoreExists) {
          completedSteps.push("gitignore");
          emitProgress("gitignore", "success", "Skipping .gitignore (already exists)");
        } else {
          await fs.promises.writeFile(gitignorePath, gitignoreContent, "utf-8");
          completedSteps.push("gitignore");
          emitProgress("gitignore", "success", ".gitignore file created");
        }
      }

      if (createInitialCommit) {
        emitProgress("add", "start", "Staging files for initial commit...");
        await git.add(".");
        completedSteps.push("add");
        emitProgress("add", "success", "Files staged");

        emitProgress("commit", "start", "Creating initial commit...");
        try {
          await git.commit(initialCommitMessage);
          completedSteps.push("commit");
          emitProgress("commit", "success", `Committed: ${initialCommitMessage}`);
        } catch (commitError) {
          const errorMsg = formatErrorMessage(commitError, "Failed to create initial commit");
          if (errorMsg.includes("user.email") || errorMsg.includes("user.name")) {
            emitProgress(
              "commit",
              "error",
              "Git user identity not configured",
              "Please configure git user.name and user.email before creating commits"
            );
            emitProgress("complete", "success", "Git initialization complete (no initial commit)");
            return { completedSteps };
          }
          throw commitError;
        }
      }

      emitProgress("complete", "success", "Git initialization complete");
      return { completedSteps };
    } catch (error) {
      const errorMessage = formatErrorMessage(error, "Git initialization failed");
      emitProgress("error", "error", "Git initialization failed", errorMessage);
      throw new AppError({
        code: "INTERNAL",
        message: errorMessage,
        context: { directoryPath, completedSteps },
        cause: error instanceof Error ? error : undefined,
      });
    }
  };
  handlers.push(
    typedHandleWithContext(CHANNELS.PROJECT_INIT_GIT_GUIDED, handleProjectInitGitGuided)
  );

  return () => handlers.forEach((cleanup) => cleanup());
}

function getGitignoreTemplate(template: string): string | null {
  switch (template) {
    case "node":
      return `# Node.js
node_modules/
npm-debug.log*
yarn-debug.log*
yarn-error.log*
.npm
.yarn
.pnp.*

# Environment
.env
.env.local
.env.*.local

# Build outputs
dist/
build/
out/
.next/
.nuxt/

# OS
.DS_Store
Thumbs.db

# IDE
.vscode/
.idea/
*.swp
*.swo
*~
`;
    case "python":
      return `# Python
__pycache__/
*.py[cod]
*$py.class
*.so
.Python
env/
venv/
ENV/
.venv

# Distribution
build/
dist/
*.egg-info/

# Testing
.pytest_cache/
.coverage
htmlcov/

# OS
.DS_Store
Thumbs.db

# IDE
.vscode/
.idea/
*.swp
`;
    case "minimal":
      return `# OS
.DS_Store
Thumbs.db

# IDE
.vscode/
.idea/
*.swp
`;
    default:
      return null;
  }
}
