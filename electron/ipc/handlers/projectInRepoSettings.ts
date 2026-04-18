import path from "path";
import fs from "fs/promises";
import { CHANNELS } from "../channels.js";
import { projectStore } from "../../services/ProjectStore.js";
import type { HandlerDependencies } from "../types.js";
import type { Project } from "../../types/index.js";
import { typedHandle } from "../utils.js";

async function resolveClaudeMdPath(projectId: string): Promise<string> {
  if (typeof projectId !== "string" || !projectId) {
    throw new Error("Invalid project ID");
  }
  const project = projectStore.getAllProjects().find((p) => p.id === projectId);
  if (!project) {
    throw new Error("Project not found");
  }
  const claudeMdPath = path.join(project.path, "CLAUDE.md");
  try {
    const stat = await fs.lstat(claudeMdPath);
    if (stat.isSymbolicLink()) {
      throw new Error("CLAUDE.md is a symlink; operation not allowed");
    }
  } catch (error: unknown) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      const parentReal = await fs.realpath(project.path);
      const expectedParent = path.normalize(parentReal);
      if (
        !path.normalize(claudeMdPath).startsWith(expectedParent + path.sep) &&
        path.normalize(claudeMdPath) !== expectedParent
      ) {
        throw new Error("Resolved path is outside project root");
      }
      return claudeMdPath;
    }
    throw error;
  }
  const resolvedPath = path.normalize(await fs.realpath(project.path));
  if (!path.normalize(claudeMdPath).startsWith(resolvedPath + path.sep)) {
    throw new Error("Resolved path is outside project root");
  }
  return claudeMdPath;
}

export function registerProjectInRepoSettingsHandlers(_deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleProjectReadClaudeMd = async (projectId: string): Promise<string | null> => {
    const claudeMdPath = await resolveClaudeMdPath(projectId);
    try {
      return await fs.readFile(claudeMdPath, "utf-8");
    } catch (error: unknown) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    }
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_READ_CLAUDE_MD, handleProjectReadClaudeMd));

  const handleProjectWriteClaudeMd = async (payload: {
    projectId: string;
    content: string;
  }): Promise<void> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    const { projectId, content } = payload;
    if (typeof content !== "string") {
      throw new Error("Invalid content");
    }
    if (content.length > 1_000_000) {
      throw new Error("Content exceeds 1 MB limit");
    }
    const claudeMdPath = await resolveClaudeMdPath(projectId);
    await fs.writeFile(claudeMdPath, content, "utf-8");
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_WRITE_CLAUDE_MD, handleProjectWriteClaudeMd));

  const handleProjectEnableInRepoSettings = async (projectId: string): Promise<Project> => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    const project = projectStore.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    const settings = await projectStore.getProjectSettings(projectId);
    await projectStore.writeInRepoProjectIdentity(project.path, {
      name: project.name,
      emoji: project.emoji,
      color: project.color,
    });
    await projectStore.writeInRepoSettings(project.path, settings);

    // Sync existing project recipes to .daintree/recipes/
    const recipes = await projectStore.getRecipes(projectId);
    for (const recipe of recipes) {
      await projectStore.writeInRepoRecipe(project.path, recipe);
    }

    return projectStore.updateProject(projectId, {
      inRepoSettings: true,
      daintreeConfigPresent: true,
    });
  };
  handlers.push(
    typedHandle(CHANNELS.PROJECT_ENABLE_IN_REPO_SETTINGS, handleProjectEnableInRepoSettings)
  );

  const handleProjectDisableInRepoSettings = async (projectId: string): Promise<Project> => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    const project = projectStore.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    return projectStore.updateProject(projectId, { inRepoSettings: false });
  };
  handlers.push(
    typedHandle(CHANNELS.PROJECT_DISABLE_IN_REPO_SETTINGS, handleProjectDisableInRepoSettings)
  );

  const CONTEXT_FILE_CANDIDATES: readonly string[] = [
    "CLAUDE.md",
    "AGENTS.md",
    ".mcp.json",
    ".cursorrules",
    ".windsurfrules",
    ".claude/settings.json",
  ];

  const handleProjectDetectContextFiles = async (projectId: string): Promise<string[]> => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    const project = projectStore.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const checks = await Promise.all(
      CONTEXT_FILE_CANDIDATES.map(async (relative) => {
        const absolute = path.join(project.path, relative);
        try {
          // lstat (not stat) — reject symlinks to avoid advertising files that
          // point outside the project tree. All candidates are expected to be
          // regular files; directories named like a candidate are ignored.
          const info = await fs.lstat(absolute);
          if (!info.isFile()) return null;
          return relative;
        } catch {
          return null;
        }
      })
    );

    return checks.filter((name): name is string => name !== null);
  };
  handlers.push(
    typedHandle(CHANNELS.PROJECT_DETECT_CONTEXT_FILES, handleProjectDetectContextFiles)
  );

  return () => handlers.forEach((cleanup) => cleanup());
}
