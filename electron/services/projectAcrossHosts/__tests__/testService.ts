import fs from "node:fs";
import path from "node:path";
import { vi, type Mock } from "vitest";
import type { Project } from "../../../../shared/types/project.js";
import type { CreateWorktreeOptions } from "../../../../shared/types/git.js";
import { OperationRegistry } from "../../operations/OperationRegistry.js";
import type { ExecuteCloneOptions } from "../../../ipc/handlers/projectCrud/gitClone.js";
import { ProjectAcrossHostsService } from "../service.js";
import type { ProjectAcrossHostsDeps } from "../types.js";
import { git, testGit } from "./gitFixtures.js";

export interface TestHost {
  service: ProjectAcrossHostsService;
  deps: ProjectAcrossHostsDeps;
  projects: Project[];
  registry: OperationRegistry;
  createWorktree: ReturnType<typeof vi.fn>;
  focusWorktree: ReturnType<typeof vi.fn>;
  clone: ReturnType<typeof vi.fn>;
  registerProject: Mock<ProjectAcrossHostsDeps["registerProject"]>;
  updateProjectDisplay: Mock<ProjectAcrossHostsDeps["updateProjectDisplay"]>;
  addProject(projectPath: string, id?: string, display?: Partial<ProjectDisplay>): Project;
}

type ProjectDisplay = Pick<Project, "name" | "emoji" | "color">;

/** The name, emoji and colour a committed `.daintree/project.json` gives, as `addProject` reads them. */
function readInRepoDisplay(projectPath: string): Partial<ProjectDisplay> {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(projectPath, ".daintree", "project.json"), "utf8")
    );
    return {
      ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
      ...(typeof parsed.emoji === "string" ? { emoji: parsed.emoji } : {}),
      ...(typeof parsed.color === "string" ? { color: parsed.color } : {}),
    };
  } catch {
    return {};
  }
}

let nextId = 1;

/** Plain `git clone` with the requested flags, standing in for the forge-aware clone. */
export async function plainClone(options: ExecuteCloneOptions): Promise<void> {
  const args = ["clone", "-q"];
  if (options.depth === "shallow") args.push("--depth", "1");
  if (options.depth === "partial") args.push("--filter=blob:none");
  git(options.parentPath, [...args, options.url, options.folderName]);
}

/** One host's service over real git and fake stores, as a test's "this host". */
export function createTestHost(root: string, name: string): TestHost {
  const projects: Project[] = [];
  const registry = new OperationRegistry({ progressIntervalMs: 0 });
  const homeDir = path.join(root, `${name}-home`);
  fs.mkdirSync(homeDir, { recursive: true });
  const addProject = (
    projectPath: string,
    id = `${name}-p${nextId++}`,
    display: Partial<ProjectDisplay> = {}
  ): Project => {
    const project: Project = {
      id,
      path: projectPath,
      name: display.name ?? path.basename(projectPath),
      emoji: display.emoji ?? "🌲",
      ...(display.color ? { color: display.color } : {}),
      lastOpened: Date.now(),
    };
    projects.push(project);
    return project;
  };
  const createWorktree = vi.fn(async (projectPath: string, options: CreateWorktreeOptions) => {
    const args = options.useExistingBranch
      ? ["worktree", "add", "-q", options.path, options.newBranch]
      : ["worktree", "add", "-q", "-b", options.newBranch, options.path, options.baseBranch];
    git(projectPath, args);
    return { worktreeId: options.path, branch: options.newBranch };
  });
  const focusWorktree = vi.fn(async () => {});
  const registerProject = vi.fn<ProjectAcrossHostsDeps["registerProject"]>(
    async (projectPath, options) => {
      const known = projects.find((p) => p.path === projectPath);
      if (known) return known;
      const project = addProject(projectPath, undefined, readInRepoDisplay(projectPath));
      options?.onCreated?.();
      return project;
    }
  );
  const updateProjectDisplay = vi.fn<ProjectAcrossHostsDeps["updateProjectDisplay"]>(
    (projectId, updates) => {
      const project = projects.find((p) => p.id === projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      if (updates.name !== undefined) project.name = updates.name;
      if (updates.emoji !== undefined) project.emoji = updates.emoji;
      if ("color" in updates) {
        if (updates.color) project.color = updates.color;
        else delete project.color;
      }
      return { ...project };
    }
  );
  const clone = vi.fn(plainClone);
  const deps: ProjectAcrossHostsDeps = {
    git: testGit,
    listProjects: () => projects,
    getProject: (id) => projects.find((p) => p.id === id) ?? null,
    registerProject,
    updateProjectDisplay,
    readCommittedProjectId: async () => null,
    readInRepoRecipes: async (projectPath) => {
      const dir = path.join(projectPath, ".daintree", "recipes");
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).map((file) => {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
        return { id: parsed.id as string, name: parsed.name as string };
      });
    },
    defaultRecipeId: async () => null,
    createWorktree,
    worktreePathFor: async (projectPath, branch) =>
      path.join(`${projectPath}-worktrees`, branch.replace(/\//g, "-")),
    focusWorktree,
    operations: () => registry,
    clone,
    probeGitLfs: async () => false,
    homeDir: () => homeDir,
    bundleDir: () => path.join(root, `${name}-bundles`),
  };
  const service = new ProjectAcrossHostsService(deps, async (repoPath) =>
    listConfigRemotes(repoPath)
  );
  return {
    service,
    deps,
    projects,
    registry,
    createWorktree,
    focusWorktree,
    clone,
    registerProject,
    updateProjectDisplay,
    addProject,
  };
}

export async function settled(registry: OperationRegistry, opId: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (registry.status(opId).status !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`operation ${opId} never settled`);
}

/** Remotes as configured (`remote -v` would show them after `insteadOf` rewriting). */
export function listConfigRemotes(repoPath: string): Array<{ name: string; url: string }> {
  let out: string;
  try {
    out = git(repoPath, ["config", "--get-regexp", "^remote\\..*\\.url$"]);
  } catch {
    return [];
  }
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [key, url] = line.split(/\s+/);
      return { name: key!.replace(/^remote\./, "").replace(/\.url$/, ""), url: url! };
    });
}
