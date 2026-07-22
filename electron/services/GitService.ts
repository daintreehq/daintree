// eager-import-allow: performs sync fs existence checks while resolving git paths
import type { SimpleGit, BranchSummary } from "simple-git";
import { resolve, dirname, normalize, sep, isAbsolute } from "path";
import { existsSync, realpathSync } from "fs";
import { readFile, stat } from "fs/promises";
import { logDebug, logError, logWarn } from "../utils/logger.js";
import type { GitStatus, WorktreeChanges } from "../../shared/types/index.js";
import type { BranchInfo, CreateWorktreeOptions } from "../../shared/types/git.js";
import { WorktreeRemovedError, GitError, toGitOperationError } from "../utils/errorTypes.js";
import type { CrossWorktreeDiffResult, CrossWorktreeFile } from "../../shared/types/ipc/git.js";
import { createHardenedGit } from "../utils/hardenedGit.js";
import { validateBranchName } from "../../shared/utils/pathPattern.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { parseNumstat } from "../utils/git.js";
import type { DiffStat } from "../utils/git.js";

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type HeadFileReadResult =
  | { ok: true; content: Buffer }
  | { ok: false; reason: "NOT_FOUND" | "TOO_LARGE" };

// Git error text for a path/revision that cannot resolve to a blob at HEAD:
// missing path, untracked path, empty repo (unborn HEAD), or a non-blob object.
const MISSING_AT_HEAD_RE =
  /does not exist in|exists on disk, but not in|invalid object name|not a valid object name|bad revision|bad file/i;

export class GitService {
  private git: Promise<SimpleGit> | null = null;
  private rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = rootPath;
  }

  // Lazy so constructing a GitService that is never used cannot leave an
  // unhandled rejection behind (createHardenedGit is async since #10395).
  private getGit(): Promise<SimpleGit> {
    this.git ??= createHardenedGit(this.rootPath);
    return this.git;
  }

  async listBranches(): Promise<BranchInfo[]> {
    try {
      logDebug("Listing branches", { rootPath: this.rootPath });

      const summary: BranchSummary = await (await this.getGit()).branch(["-a"]);
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
      throw toGitOperationError(error, { cwd: this.rootPath, op: "list-branches" });
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

    const newBranchValidation = validateBranchName(newBranch);
    if (!newBranchValidation.valid) {
      throw new Error(
        `Invalid branch name '${newBranch}': ${newBranchValidation.error ?? "invalid"}`
      );
    }
    const baseBranchValidation = validateBranchName(baseBranch);
    if (!baseBranchValidation.valid) {
      throw new Error(
        `Invalid base branch '${baseBranch}': ${baseBranchValidation.error ?? "invalid"}`
      );
    }

    const pathValidation = this.validatePath(path);
    if (!pathValidation.valid) {
      throw new Error(pathValidation.error);
    }

    const parentDir = dirname(path);
    if (!existsSync(parentDir)) {
      throw new Error(`Parent directory does not exist: ${parentDir}`);
    }

    try {
      const git = await this.getGit();
      if (fromRemote) {
        logDebug("Creating worktree from remote branch", {
          path,
          newBranch,
          remoteBranch: baseBranch,
        });

        // `--end-of-options` after the subcommand flags so any leading-dash
        // ref or path that slipped past validation is treated as positional.
        await git.raw([
          "worktree",
          "add",
          "-b",
          newBranch,
          "--track",
          "--end-of-options",
          path,
          baseBranch,
        ]);
      } else {
        logDebug("Creating worktree with new branch", {
          path,
          newBranch,
          baseBranch,
        });

        await git.raw(["worktree", "add", "-b", newBranch, "--end-of-options", path, baseBranch]);
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
      const output = await (await this.getGit()).raw(["worktree", "list", "--porcelain"]);
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
      // `--no-textconv` blocks user-defined diff drivers that would otherwise
      // execute arbitrary binaries via `.gitattributes` textconv mappings.
      const diff = await (
        await this.getGit()
      ).diff(["HEAD", "--no-ext-diff", "--no-textconv", "--no-color", "--", normalizedPath]);

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

  /**
   * Read a file's blob content at HEAD. Size-checks via `cat-file -s` before
   * reading so an oversized blob is never loaded, and reads the content with
   * `binaryCatFile` (Buffer-safe — `raw()` is utf8-lossy for binary blobs).
   */
  async readFileAtHead(filePath: string, maxBytes: number): Promise<HeadFileReadResult> {
    if (isAbsolute(filePath)) {
      throw new Error("Absolute paths are not allowed");
    }
    if (filePath.includes("\0")) {
      throw new Error("Path contains null bytes");
    }

    const normalizedPath = normalize(filePath);
    const pathSegments = normalizedPath.split(/[\\/]+/).filter(Boolean);
    if (pathSegments.includes("..") || normalizedPath.startsWith(sep)) {
      throw new Error("Path traversal detected");
    }

    // Git object specs always use forward slashes, even on Windows. The
    // `HEAD:` prefix also guarantees the spec never starts with a dash.
    const objectSpec = `HEAD:${normalizedPath.replaceAll("\\", "/")}`;
    const git = await this.getGit();

    let sizeRaw: string;
    try {
      sizeRaw = await git.raw(["cat-file", "-s", "--end-of-options", objectSpec]);
    } catch (error) {
      if (MISSING_AT_HEAD_RE.test((error as Error).message ?? "")) {
        return { ok: false, reason: "NOT_FOUND" };
      }
      throw toGitOperationError(error, { cwd: this.rootPath, op: "read-file-at-head" });
    }

    const size = Number.parseInt(sizeRaw.trim(), 10);
    if (Number.isFinite(size) && size > maxBytes) {
      return { ok: false, reason: "TOO_LARGE" };
    }

    let content: Buffer;
    try {
      content = (await git.binaryCatFile(["blob", objectSpec])) as Buffer;
    } catch (error) {
      if (MISSING_AT_HEAD_RE.test((error as Error).message ?? "")) {
        return { ok: false, reason: "NOT_FOUND" };
      }
      throw toGitOperationError(error, { cwd: this.rootPath, op: "read-file-at-head" });
    }

    if (content.byteLength > maxBytes) {
      return { ok: false, reason: "TOO_LARGE" };
    }
    return { ok: true, content };
  }

  async compareWorktrees(
    branch1: string,
    branch2: string,
    filePath?: string,
    useMergeBase?: boolean,
    ignoreWhitespace?: boolean
  ): Promise<CrossWorktreeDiffResult | string> {
    // Validate before the equality fast-path so an invalid argv-shaped name
    // is rejected unconditionally — not silently accepted when both inputs
    // happen to match.
    const branch1Validation = validateBranchName(branch1);
    if (!branch1Validation.valid) {
      throw new Error(`Invalid branch name '${branch1}': ${branch1Validation.error ?? "invalid"}`);
    }
    const branch2Validation = validateBranchName(branch2);
    if (!branch2Validation.valid) {
      throw new Error(`Invalid branch name '${branch2}': ${branch2Validation.error ?? "invalid"}`);
    }

    if (branch1 === branch2) {
      return filePath ? "NO_CHANGES" : { branch1, branch2, files: [] };
    }

    // Expand to fully qualified `refs/heads/` so a leading-dash branch name
    // can never appear at the start of the range token. `--end-of-options`
    // alone is insufficient — git's revision parser sees `branch1..branch2`
    // as a single argument and re-parses dashes inside it as flags.
    // Worktree branches surface as short names (`refs/heads/` is stripped in
    // `listWorktrees`), so this prefix is always correct.
    const ref1 = `refs/heads/${branch1}`;
    const ref2 = `refs/heads/${branch2}`;
    const range = useMergeBase ? `${ref1}...${ref2}` : `${ref1}..${ref2}`;

    if (filePath) {
      // Return the unified diff for a specific file
      try {
        const diff = await (
          await this.getGit()
        ).raw([
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          ...(ignoreWhitespace ? ["--ignore-all-space"] : []),
          "--end-of-options",
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

    // Return the list of changed files with per-file churn (--numstat)
    try {
      const git = await this.getGit();
      const [nameStatusOutput, numstatOutput, toplevel] = await Promise.all([
        git.raw([
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--name-status",
          ...(ignoreWhitespace ? ["--ignore-all-space"] : []),
          "--end-of-options",
          range,
        ]),
        git
          .raw([
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--numstat",
            ...(ignoreWhitespace ? ["--ignore-all-space"] : []),
            "--end-of-options",
            range,
          ])
          .catch((error) => {
            logWarn(
              "Failed to read numstat for cross-worktree comparison; continuing without churn",
              {
                branch1,
                branch2,
                message: (error as Error).message,
              }
            );
            return "";
          }),
        git.revparse(["--show-toplevel"]),
      ]);

      const gitRoot = realpathSync(toplevel.trim()).replace(/\\/g, "/");
      const rootPrefix = gitRoot.endsWith("/") ? gitRoot : `${gitRoot}/`;

      // Build relative-path-keyed numstat map from the numstat output
      let numstatByRelPath = new Map<string, DiffStat>();
      if (numstatOutput) {
        const numstatByAbsPath = parseNumstat(numstatOutput, gitRoot);
        numstatByRelPath = new Map<string, DiffStat>();
        for (const [absPath, stats] of numstatByAbsPath) {
          const normalized = absPath.replace(/\\/g, "/");
          const relative = normalized.startsWith(rootPrefix)
            ? normalized.slice(rootPrefix.length)
            : normalized;
          numstatByRelPath.set(relative, stats);
        }
      }

      const files: CrossWorktreeFile[] = [];

      for (const line of nameStatusOutput.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const parts = trimmed.split(/\t/);
        if (parts.length < 2) continue;

        const statusRaw = parts[0];
        const status = statusRaw[0] as CrossWorktreeFile["status"];

        if (status === "R" || status === "C") {
          const newPath = parts[2] ?? parts[1];
          const oldPath = parts[1];
          const insStats = numstatByRelPath.get(newPath);
          const delStats = numstatByRelPath.get(oldPath);
          files.push({
            status,
            path: newPath,
            oldPath,
            insertions: insStats?.insertions ?? null,
            deletions: delStats?.deletions ?? null,
          });
        } else {
          const stats = numstatByRelPath.get(parts[1]);
          files.push({
            status,
            path: parts[1],
            insertions: stats?.insertions ?? null,
            deletions: stats?.deletions ?? null,
          });
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
    if (checkLength === 0) return false;

    const sample = buffer.subarray(0, checkLength);

    if (sample.indexOf(0) !== -1) return true;

    let nonPrintable = 0;
    for (let i = 0; i < checkLength; i++) {
      const byte = sample[i];
      if (!(byte >= 0x20 && byte <= 0x7e) && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
        nonPrintable++;
      }
    }

    return nonPrintable / checkLength > 0.3;
  }

  async getRemoteUrl(repoPath: string): Promise<string | null> {
    return this.handleGitOperation(async () => {
      const git = await createHardenedGit(repoPath);
      const remotes = await git.getRemotes(true);
      const origin = remotes.find((r) => r.name === "origin");
      return origin?.refs?.fetch || null;
    }, "getRemoteUrl");
  }

  async listRemotes(repoPath: string): Promise<Array<{ name: string; fetchUrl: string }>> {
    return this.handleGitOperation(async () => {
      const git = await createHardenedGit(repoPath);
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
      const git = await createHardenedGit(repoPath);
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
    // `--end-of-options` so a leading-dash worktree path is treated as
    // positional rather than parsed as a flag.
    args.push("--end-of-options", worktreePath);

    return this.handleGitOperation(async () => {
      await (await this.getGit()).raw(args);
    }, "removeWorktree");
  }

  /**
   * Re-links this repository with its linked worktrees after the main worktree
   * has moved on disk (#11282).
   *
   * A move breaks a pointer *pair*: each linked worktree's `.git` file still
   * names the old main location, and `.git/worktrees/<id>/gitdir` still names
   * the old linked location. Run from the main worktree's new path, `git
   * worktree repair` fixes the linked worktrees git can still find on its own,
   * which covers the common case where only the main folder moved. When the
   * linked worktrees moved too, git has no anchor to infer them from and their
   * new paths must be passed explicitly.
   *
   * Note this does not repair nested submodule gitlinks — those need
   * `git submodule absorbgitdirs` and are not handled here.
   */
  async repairWorktrees(worktreePaths: string[] = []): Promise<void> {
    logDebug("Repairing worktrees", { rootPath: this.rootPath, worktreePaths });

    const args = ["worktree", "repair"];
    if (worktreePaths.length > 0) {
      args.push("--end-of-options", ...worktreePaths);
    }

    return this.handleGitOperation(async () => {
      await (await this.getGit()).raw(args);
    }, "repairWorktrees");
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
      const errorMessage = formatErrorMessage(error, `Git operation failed: ${context}`);

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
