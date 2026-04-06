import type { SimpleGit, BranchSummary } from "simple-git";
import { resolve, dirname, normalize, sep, isAbsolute } from "path";
import { existsSync } from "fs";
import { readFile, stat } from "fs/promises";
import { logDebug, logError, logWarn } from "../utils/logger.js";
import type { GitStatus, WorktreeChanges } from "../../shared/types/index.js";
import { WorktreeRemovedError, GitError } from "../utils/errorTypes.js";
import type { CrossWorktreeDiffResult, CrossWorktreeFile } from "../../shared/types/ipc/git.js";
import { createHardenedGit } from "../utils/hardenedGit.js";

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface BranchInfo {
  name: string;
  current: boolean;
  commit: string;
  remote?: string;
}

export interface CreateWorktreeOptions {
  baseBranch: string;
  newBranch: string;
  path: string;
  fromRemote?: boolean;
}

export class GitService {
  private git: SimpleGit;
  private rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = rootPath;
    this.git = createHardenedGit(rootPath);
  }

  async listBranches(): Promise<BranchInfo[]> {
    try {
      logDebug("Listing branches", { rootPath: this.rootPath });

      const summary: BranchSummary = await this.git.branch(["-a"]);
      const branches: BranchInfo[] = [];

      for (const [branchName, branchDetail] of Object.entries(summary.branches)) {
        if (branchName.includes("HEAD ->") || branchName.endsWith("/HEAD")) {
          continue;
        }

        const isRemote = branchName.startsWith("remotes/");
        const displayName = isRemote ? branchName.replace("remotes/", "") : branchName;

        branches.push({
          name: displayName,
          current: branchDetail.current,
          commit: branchDetail.commit,
          remote: isRemote ? displayName.split("/")[0] : undefined,
        });
      }

      logDebug("Listed branches", { count: branches.length });
      return branches;
    } catch (error) {
      logError("Failed to list branches", { error: (error as Error).message });
      throw new Error(`Failed to list branches: ${(error as Error).message}`);
    }
  }

  validatePath(path: string): { valid: boolean; error?: string } {
    if (existsSync(path)) {
      return {
        valid: false,
        error: `Path already exists: ${path}`,
      };
    }
    return { valid: true };
  }

  async branchExists(branchName: string): Promise<boolean> {
    try {
      const branches = await this.listBranches();
      return branches.some((b) => b.name === branchName || b.name === `origin/${branchName}`);
    } catch (error) {
      logError("Failed to check branch existence", {
        branchName,
        error: (error as Error).message,
      });
      return false;
    }
  }

  async createWorktree(options: CreateWorktreeOptions): Promise<void> {
    const { baseBranch, newBranch, path, fromRemote = false } = options;

    logDebug("Creating worktree", {
      baseBranch: options.baseBranch,
      newBranch: options.newBranch,
      path: options.path,
      fromRemote: options.fromRemote,
    });

    const pathValidation = this.validatePath(path);
    if (!pathValidation.valid) {
      throw new Error(pathValidation.error);
    }

    const parentDir = dirname(path);
    if (!existsSync(parentDir)) {
      throw new Error(`Parent directory does not exist: ${parentDir}`);
    }

    try {
      if (fromRemote) {
        logDebug("Creating worktree from remote branch", {
          path,
          newBranch,
          remoteBranch: baseBranch,
        });

        await this.git.raw(["worktree", "add", "-b", newBranch, "--track", path, baseBranch]);
      } else {
        logDebug("Creating worktree with new branch", {
          path,
          newBranch,
          baseBranch,
        });

        await this.git.raw(["worktree", "add", "-b", newBranch, path, baseBranch]);
      }

      logDebug("Worktree created successfully", { path, newBranch });
    } catch (error) {
      logError("Failed to create worktree", {
        options,
        error: (error as Error).message,
      });
      throw new Error(`Failed to create worktree: ${(error as Error).message}`);
    }
  }

  async listWorktrees(): Promise<
    Array<{ path: string; branch: string; bare: boolean; isMainWorktree: boolean }>
  > {
    try {
      const output = await this.git.raw(["worktree", "list", "--porcelain"]);
      const worktrees: Array<{
        path: string;
        branch: string;
        bare: boolean;
        isMainWorktree: boolean;
      }> = [];

      let currentWorktree: Partial<{ path: string; branch: string; bare: boolean }> = {};

      const pushWorktree = () => {
        if (currentWorktree.path) {
          worktrees.push({
            path: currentWorktree.path,
            branch: currentWorktree.branch || "",
            bare: currentWorktree.bare || false,
            isMainWorktree: worktrees.length === 0,
          });
        }
        currentWorktree = {};
      };

      for (const line of output.split("\n")) {
        if (line.startsWith("worktree ")) {
          currentWorktree.path = line.replace("worktree ", "").trim();
        } else if (line.startsWith("branch ")) {
          currentWorktree.branch = line.replace("branch ", "").replace("refs/heads/", "").trim();
        } else if (line.startsWith("bare")) {
          currentWorktree.bare = true;
        } else if (line === "") {
          pushWorktree();
        }
      }

      pushWorktree();

      return worktrees;
    } catch (error) {
      logError("Failed to list worktrees", { error: (error as Error).message });
      throw new Error(`Failed to list worktrees: ${(error as Error).message}`);
    }
  }

  async getFileDiff(filePath: string, status: GitStatus): Promise<string> {
    const validStatuses: GitStatus[] = [
      "added",
      "modified",
      "deleted",
      "untracked",
      "ignored",
      "renamed",
      "copied",
    ];
    if (!validStatuses.includes(status)) {
      throw new Error(`Invalid git status: ${status}`);
    }

    if (isAbsolute(filePath)) {
      throw new Error("Absolute paths are not allowed");
    }

    const normalizedPath = normalize(filePath);
    const pathSegments = normalizedPath.split(/[\\/]+/).filter(Boolean);
    if (pathSegments.includes("..") || normalizedPath.startsWith(sep)) {
      throw new Error("Path traversal detected");
    }

    const absolutePath = resolve(this.rootPath, normalizedPath);
    const normalizedRoot = normalize(this.rootPath + sep);
    if (!absolutePath.startsWith(normalizedRoot)) {
      throw new Error("Path is outside worktree root");
    }

    // Git always uses forward slashes in diff output, even on Windows
    const gitPath = normalizedPath.replaceAll("\\", "/");

    try {
      const stats = await stat(absolutePath);
      if (stats.size > 1024 * 1024) {
        return "FILE_TOO_LARGE";
      }
    } catch {
      // ignore
    }

    if (status === "untracked" || status === "added") {
      try {
        const buffer = await readFile(absolutePath);

        if (this.isBinaryBuffer(buffer)) {
          return "BINARY_FILE";
        }

        const content = buffer.toString("utf-8");
        const lines = content.split("\n");

        return `diff --git a/${gitPath} b/${gitPath}
new file mode 100644
--- /dev/null
+++ b/${gitPath}
@@ -0,0 +1,${lines.length} @@
${lines.map((l) => "+" + l).join("\n")}`;
      } catch (error) {
        logError("Failed to read new file for diff", {
          filePath: normalizedPath,
          error: (error as Error).message,
        });
        throw new Error(`Failed to read new file: ${(error as Error).message}`);
      }
    }

    try {
      const diff = await this.git.diff([
        "HEAD",
        "--no-ext-diff",
        "--no-color",
        "--",
        normalizedPath,
      ]);

      if (diff.includes("Binary files")) {
        return "BINARY_FILE";
      }

      if (!diff.trim()) {
        return "NO_CHANGES";
      }

      if (diff.length > 1024 * 1024) {
        return "FILE_TOO_LARGE";
      }

      return diff;
    } catch (error) {
      logError("Failed to generate diff", {
        filePath,
        error: (error as Error).message,
      });
      throw new Error(`Failed to generate diff: ${(error as Error).message}`);
    }
  }

  async compareWorktrees(
    branch1: string,
    branch2: string,
    filePath?: string,
    useMergeBase?: boolean
  ): Promise<CrossWorktreeDiffResult | string> {
    if (branch1 === branch2) {
      return filePath ? "NO_CHANGES" : { branch1, branch2, files: [] };
    }

    const range = useMergeBase ? `${branch1}...${branch2}` : `${branch1}..${branch2}`;

    if (filePath) {
      // Return the unified diff for a specific file
      try {
        const diff = await this.git.raw([
          "diff",
          "--no-ext-diff",
          "--no-color",
          range,
          "--",
          filePath,
        ]);

        if (!diff.trim()) {
          return "NO_CHANGES";
        }

        if (diff.includes("Binary files")) {
          return "BINARY_FILE";
        }

        if (diff.length > 1024 * 1024) {
          return "FILE_TOO_LARGE";
        }

        return diff;
      } catch (error) {
        logError("Failed to get cross-worktree file diff", {
          branch1,
          branch2,
          filePath,
          error: (error as Error).message,
        });
        throw new Error(`Failed to get cross-worktree file diff: ${(error as Error).message}`);
      }
    }

    // Return the list of changed files
    try {
      const output = await this.git.raw(["diff", "--no-ext-diff", "--name-status", range]);
      const files: CrossWorktreeFile[] = [];

      for (const line of output.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const parts = trimmed.split(/\t/);
        if (parts.length < 2) continue;

        const statusRaw = parts[0];
        const status = statusRaw[0] as CrossWorktreeFile["status"];

        if (status === "R" || status === "C") {
          // Renamed/copied: parts[1] = old path, parts[2] = new path
          files.push({
            status,
            path: parts[2] ?? parts[1],
            oldPath: parts[1],
          });
        } else {
          files.push({ status, path: parts[1] });
        }
      }

      logDebug("Compared worktrees", { branch1, branch2, fileCount: files.length });

      return { branch1, branch2, files };
    } catch (error) {
      logError("Failed to compare worktrees", {
        branch1,
        branch2,
        error: (error as Error).message,
      });
      throw new Error(`Failed to compare worktrees: ${(error as Error).message}`);
    }
  }

  private isBinaryBuffer(buffer: Buffer): boolean {
    const checkLength = Math.min(buffer.length, 8192);

    for (let i = 0; i < checkLength; i++) {
      if (buffer[i] === 0) {
        return true;
      }
    }

    let nonPrintable = 0;
    for (let i = 0; i < checkLength; i++) {
      const byte = buffer[i];
      if (!(byte >= 0x20 && byte <= 0x7e) && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
        nonPrintable++;
      }
    }

    return checkLength > 0 && nonPrintable / checkLength > 0.3;
  }

  async getRemoteUrl(repoPath: string): Promise<string | null> {
    return this.handleGitOperation(async () => {
      const git = createHardenedGit(repoPath);
      const remotes = await git.getRemotes(true);
      const origin = remotes.find((r) => r.name === "origin");
      return origin?.refs?.fetch || null;
    }, "getRemoteUrl");
  }

  async listRemotes(repoPath: string): Promise<Array<{ name: string; fetchUrl: string }>> {
    return this.handleGitOperation(async () => {
      const git = createHardenedGit(repoPath);
      const remotes = await git.getRemotes(true);
      return remotes.map((r) => ({ name: r.name, fetchUrl: r.refs?.fetch || "" }));
    }, "listRemotes");
  }

  async getWorktreeChangesWithStats(
    worktreePath: string,
    forceRefresh = true // Default to true to avoid overwriting per-worktree cache TTLs
  ): Promise<WorktreeChanges> {
    const { getWorktreeChangesWithStats: getChanges } = await import("../utils/git.js");
    return getChanges(worktreePath, forceRefresh);
  }

  async getRepositoryRoot(repoPath: string): Promise<string> {
    return this.handleGitOperation(async () => {
      const git = createHardenedGit(repoPath);
      const root = await git.revparse(["--show-toplevel"]);
      return root.trim();
    }, "getRepositoryRoot");
  }

  async removeWorktree(worktreePath: string, force: boolean = false): Promise<void> {
    logDebug("Removing worktree", { worktreePath, force });

    const args = ["worktree", "remove"];
    if (force) {
      args.push("--force");
    }
    args.push(worktreePath);

    return this.handleGitOperation(async () => {
      await this.git.raw(args);
    }, "removeWorktree");
  }

  async findAvailableBranchName(baseName: string): Promise<string> {
    const branches = await this.listBranches();
    // Only check local branches for conflicts (remote branches don't prevent local creation)
    const localBranchNames = new Set(branches.filter((b) => !b.remote).map((b) => b.name));

    if (!localBranchNames.has(baseName)) {
      return baseName;
    }

    // Find highest existing suffix for this base
    // Start at 2 for first conflict (baseName gets -2, not -1)
    let maxSuffix = 1;
    for (const name of localBranchNames) {
      // Check if it's an exact match of the base
      if (name === baseName) {
        maxSuffix = Math.max(maxSuffix, 1);
        continue;
      }

      // Check for suffixed versions: baseName-N (where N is a number)
      const match = name.match(new RegExp(`^${escapeRegex(baseName)}-(\\d+)$`));
      if (match) {
        maxSuffix = Math.max(maxSuffix, parseInt(match[1], 10));
      }
    }

    // Return next available (first conflict gets -2)
    return `${baseName}-${maxSuffix + 1}`;
  }

  findAvailablePath(basePath: string): string {
    if (!existsSync(basePath)) {
      return basePath;
    }

    // Find next available suffix (start at 2 for first conflict)
    let suffix = 2;
    while (existsSync(`${basePath}-${suffix}`)) {
      suffix++;
    }

    return `${basePath}-${suffix}`;
  }

  private async handleGitOperation<T>(operation: () => Promise<T>, context: string): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (
        errorMessage.includes("ENOENT") ||
        errorMessage.includes("no such file or directory") ||
        errorMessage.includes("Unable to read current working directory")
      ) {
        const wtError =
          error instanceof WorktreeRemovedError
            ? error
            : new WorktreeRemovedError(this.rootPath, error instanceof Error ? error : undefined);
        logWarn(`Git operation failed: worktree removed (${context})`, {
          rootPath: this.rootPath,
        });
        throw wtError;
      }

      if (errorMessage.includes("not a git repository")) {
        const cause = error instanceof Error ? error : new Error(String(error));
        const gitError = new GitError(
          `Git operation failed: ${context}`,
          { rootPath: this.rootPath },
          cause
        );
        logWarn(`Git operation failed: not a git repository (${context})`, {
          rootPath: this.rootPath,
        });
        throw gitError;
      }

      const cause = error instanceof Error ? error : new Error(String(error));
      const gitError = new GitError(
        `Git operation failed: ${context}`,
        { rootPath: this.rootPath },
        cause
      );
      logError(`Git operation failed: ${context}`, gitError, { rootPath: this.rootPath });
      throw gitError;
    }
  }
}
