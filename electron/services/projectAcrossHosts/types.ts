import type { Project } from "../../../shared/types/project.js";
import type { CreateWorktreeOptions } from "../../../shared/types/git.js";
import type { OperationRegistry } from "../operations/OperationRegistry.js";
import type { ExecuteCloneOptions } from "../../ipc/handlers/projectCrud/gitClone.js";
import type { GitFactory } from "./gitOps.js";

/**
 * What the host-side project work needs from the rest of the process. The
 * defaults wire the real stores and services; tests hand in fakes and real
 * git repositories.
 */
export interface ProjectAcrossHostsDeps {
  git: GitFactory;
  listProjects(): Project[];
  getProject(projectId: string): Project | null;
  /** The normal registration path: the host mints the id. */
  registerProject(projectPath: string): Promise<Project>;
  /** The `id` in a committed `.daintree/project.json`, when there is one. */
  readCommittedProjectId(projectPath: string): Promise<string | null>;
  readInRepoRecipes(projectPath: string): Promise<Array<{ id: string; name: string }>>;
  defaultRecipeId(projectId: string): Promise<string | null>;
  /** `worktree:create` for a project folder, through the workspace host. */
  createWorktree(
    projectPath: string,
    options: CreateWorktreeOptions
  ): Promise<{ worktreeId: string; branch: string }>;
  /** Where a new working tree for `branch` goes, by the project's path pattern. */
  worktreePathFor(projectPath: string, branch: string): Promise<string>;
  /** Make this worktree the one the project's next view opens on. */
  focusWorktree(projectId: string, worktreeId: string): Promise<void>;
  operations(): OperationRegistry;
  clone(options: ExecuteCloneOptions): Promise<void>;
  probeGitLfs(): Promise<boolean>;
  homeDir(): string;
  /** Private scratch space for repository bundles in flight. */
  bundleDir(): string;
  now?(): number;
}
