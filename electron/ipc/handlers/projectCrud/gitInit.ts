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
import { DEFAULT_GITIGNORE_TEMPLATE_ID } from "../../../../shared/config/gitignoreTemplates.js";
import { AppError } from "../../../utils/errorTypes.js";
import { getGitignoreTemplate } from "./gitignoreTemplates.js";

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

    const git = await createHardenedGit(directoryPath);
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
      gitignoreTemplate = DEFAULT_GITIGNORE_TEMPLATE_ID,
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

      const git = await createHardenedGit(directoryPath);

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
        const existingStat = await fs.promises.stat(gitignorePath).catch(() => null);
        const gitignoreIsFile = existingStat?.isFile() ?? false;
        if (existingStat && !gitignoreIsFile) {
          throw new Error(
            `.gitignore at ${gitignorePath} exists but is not a regular file — refusing to proceed`
          );
        }
        if (gitignoreIsFile) {
          completedSteps.push("gitignore");
          let skipMessage = "Existing .gitignore kept — verify it excludes secrets";
          try {
            const existing = await fs.promises.readFile(gitignorePath, "utf-8");
            const missing = computeMissingTemplateEntries(existing, gitignoreContent);
            if (missing.length === 0) {
              skipMessage = "Existing .gitignore kept — covers all template entries";
            } else {
              // Templates are large enough that itemising the diff is noise —
              // report the size and point at the part that actually matters.
              const label = missing.length === 1 ? "entry" : "entries";
              skipMessage = `Existing .gitignore kept — missing ${missing.length} template ${label}; review it for secrets`;
            }
          } catch {
            // Fall through to default message
          }
          emitProgress("gitignore", "success", skipMessage);
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

        const commitMessage = initialCommitMessage.trim() || "Initial commit";
        emitProgress("commit", "start", "Creating initial commit...");
        try {
          await git.commit(commitMessage);
          completedSteps.push("commit");
          emitProgress("commit", "success", `Committed: ${commitMessage}`);
        } catch (commitError) {
          const errorMsg = formatErrorMessage(commitError, "Failed to create initial commit");
          if (errorMsg.includes("user.email") || errorMsg.includes("user.name")) {
            const identityHelp =
              "Set your git identity, then create the initial commit manually:\n" +
              '  git config --global user.name "Your Name"\n' +
              '  git config --global user.email "you@example.com"';
            emitProgress("commit", "error", "Git user identity not configured", identityHelp);
            emitProgress(
              "complete",
              "error",
              "Repository initialized — initial commit skipped",
              identityHelp
            );
            return { outcome: "error" as const, completedSteps };
          }
          throw commitError;
        }
      }

      emitProgress("complete", "success", "Git initialization complete");
      return { outcome: "success" as const, completedSteps };
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

/**
 * Collects the exclusion patterns from a .gitignore, dropping comments, blank
 * lines, and negations. A negation only re-includes something an exclusion took
 * away, so it is meaningless on its own — reporting `!.env.example` as "missing"
 * from a file that never excluded `.env.example` would be noise.
 */
function parseGitignoreLines(content: string): Set<string> {
  const lines = new Set<string>();
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    lines.add(line);
  }
  return lines;
}

export function computeMissingTemplateEntries(
  existingContent: string,
  templateContent: string
): string[] {
  const existing = parseGitignoreLines(existingContent);
  const template = parseGitignoreLines(templateContent);
  const missing: string[] = [];
  for (const entry of template) {
    if (!existing.has(entry)) missing.push(entry);
  }
  return missing;
}
