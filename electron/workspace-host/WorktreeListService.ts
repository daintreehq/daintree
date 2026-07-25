import { dirname, isAbsolute, resolve as pathResolve } from "path";
import type { SimpleGit } from "simple-git";
import type { Worktree } from "../../shared/types/worktree.js";
import { isPathInside } from "../../shared/utils/path.js";
import { getGitDir } from "../utils/gitUtils.js";

const WORKTREE_LIST_CACHE_TTL_MS = 15_000;

export interface RawWorktreeRecord {
  path: string;
  branch: string;
  bare: boolean;
  isMainWorktree: boolean;
  head?: string;
  isDetached?: boolean;
  isLocked?: boolean;
  lockReason?: string;
  isPrunable?: boolean;
  prunableReason?: string;
}

interface WorktreeListCacheEntry {
  expiresAt: number;
  worktrees: RawWorktreeRecord[];
}

export class WorktreeListService {
  private worktreeListCache = new Map<string, WorktreeListCacheEntry>();
  private inFlightWorktreeList = new Map<string, Promise<RawWorktreeRecord[]>>();
  private git: SimpleGit | null = null;
  private projectRootPath: string | null = null;

  setGit(git: SimpleGit | null, projectRootPath: string | null): void {
    this.git = git;
    this.projectRootPath = projectRootPath;
  }

  getCacheKey(): string | null {
    return this.projectRootPath ? pathResolve(this.projectRootPath) : null;
  }

  private getCachedWorktrees(cacheKey: string): RawWorktreeRecord[] | null {
    const cached = this.worktreeListCache.get(cacheKey);
    if (!cached) {
      return null;
    }

    if (cached.expiresAt <= Date.now()) {
      this.worktreeListCache.delete(cacheKey);
      return null;
    }

    return this.cloneRawWorktrees(cached.worktrees);
  }

  private setCachedWorktrees(cacheKey: string, worktrees: RawWorktreeRecord[]): void {
    this.worktreeListCache.set(cacheKey, {
      expiresAt: Date.now() + WORKTREE_LIST_CACHE_TTL_MS,
      worktrees: this.cloneRawWorktrees(worktrees),
    });
  }

  invalidateCache(cacheKey?: string): void {
    if (cacheKey) {
      this.worktreeListCache.delete(cacheKey);
      this.inFlightWorktreeList.delete(cacheKey);
      return;
    }

    this.worktreeListCache.clear();
    this.inFlightWorktreeList.clear();
  }

  private cloneRawWorktrees(rawWorktrees: RawWorktreeRecord[]): RawWorktreeRecord[] {
    return rawWorktrees.map((worktree) => ({ ...worktree }));
  }

  async list(options?: { forceRefresh?: boolean }): Promise<RawWorktreeRecord[]> {
    if (!this.git) {
      throw new Error("Git not initialized");
    }
    const git = this.git;

    const cacheKey = this.getCacheKey();
    const forceRefresh = options?.forceRefresh === true;
    if (cacheKey && !forceRefresh) {
      const cached = this.getCachedWorktrees(cacheKey);
      if (cached) {
        return cached;
      }

      const inFlight = this.inFlightWorktreeList.get(cacheKey);
      if (inFlight) {
        return inFlight;
      }
    }

    const fetchPromise = (async () => {
      const output = await git.raw(["worktree", "list", "--porcelain"]);
      const worktrees: RawWorktreeRecord[] = [];
      let isFirstEntry = true;

      let currentWorktree: Partial<{
        path: string;
        branch: string;
        bare: boolean;
        head: string;
        isDetached: boolean;
        isLocked: boolean;
        lockReason: string;
        isPrunable: boolean;
        prunableReason: string;
      }> = {};

      const pushWorktree = () => {
        if (currentWorktree.path) {
          worktrees.push({
            path: currentWorktree.path,
            branch: currentWorktree.branch || "",
            bare: currentWorktree.bare || false,
            isMainWorktree: isFirstEntry,
            head: currentWorktree.isDetached ? currentWorktree.head : undefined,
            isDetached: currentWorktree.isDetached,
            isLocked: currentWorktree.isLocked,
            lockReason: currentWorktree.lockReason,
            isPrunable: currentWorktree.isPrunable,
            prunableReason: currentWorktree.prunableReason,
          });
          isFirstEntry = false;
        }
        currentWorktree = {};
      };

      for (const line of output.split("\n")) {
        if (line.startsWith("worktree ")) {
          currentWorktree.path = line.replace("worktree ", "").trim();
        } else if (line.startsWith("HEAD ")) {
          currentWorktree.head = line.replace("HEAD ", "").trim();
        } else if (line.startsWith("branch ")) {
          currentWorktree.branch = line.replace("branch ", "").replace("refs/heads/", "").trim();
        } else if (line.startsWith("bare")) {
          currentWorktree.bare = true;
        } else if (line.trim() === "detached") {
          currentWorktree.isDetached = true;
        } else if (line === "locked") {
          currentWorktree.isLocked = true;
        } else if (line.startsWith("locked ")) {
          currentWorktree.isLocked = true;
          currentWorktree.lockReason = line.slice(7);
        } else if (line === "prunable") {
          currentWorktree.isPrunable = true;
        } else if (line.startsWith("prunable ")) {
          currentWorktree.isPrunable = true;
          currentWorktree.prunableReason = line.slice(9);
        } else if (line.trim() === "") {
          pushWorktree();
        }
      }

      pushWorktree();

      return worktrees;
    })();

    if (cacheKey) {
      this.inFlightWorktreeList.set(cacheKey, fetchPromise);
    }

    try {
      const worktrees = await fetchPromise;

      if (cacheKey && this.inFlightWorktreeList.get(cacheKey) === fetchPromise) {
        this.setCachedWorktrees(cacheKey, worktrees);
      }

      return this.cloneRawWorktrees(worktrees);
    } finally {
      if (cacheKey && this.inFlightWorktreeList.get(cacheKey) === fetchPromise) {
        this.inFlightWorktreeList.delete(cacheKey);
      }
    }
  }

  /**
   * Directory every Daintree-created worktree is confined to, used to classify
   * `isExternal`. Returns undefined when no boundary can be trusted: no project
   * root, or a repo at the filesystem root (where the parent is the root itself
   * and would accept every path on the system — same rejection as
   * `assertWorktreePathContained`). Undefined means "unknown", so callers leave
   * `isExternal` unset rather than flagging every worktree (#2251).
   */
  private getContainmentBoundary(): string | undefined {
    if (!this.projectRootPath) return undefined;
    const resolvedRoot = pathResolve(this.projectRootPath);
    const parentDir = dirname(resolvedRoot);
    return parentDir === resolvedRoot ? undefined : parentDir;
  }

  /**
   * Base for resolving a relative porcelain path. Git 2.48+'s
   * `worktree.useRelativePaths` emits linked worktrees relative to the
   * repository while the main worktree entry stays absolute, so that entry —
   * not `projectRootPath`, which may itself be a linked worktree — is the
   * correct base. Bare `pathResolve` would resolve against the host process
   * cwd and mint a bogus worktree id.
   */
  private static getRelativePathBase(rawWorktrees: RawWorktreeRecord[]): string | undefined {
    const mainEntry = rawWorktrees.find((wt) => wt.isMainWorktree);
    return mainEntry && isAbsolute(mainEntry.path) ? mainEntry.path : undefined;
  }

  mapToWorktrees(rawWorktrees: RawWorktreeRecord[]): Promise<Worktree[]> {
    const boundary = this.getContainmentBoundary();
    const relativeBase = WorktreeListService.getRelativePathBase(rawWorktrees);

    return Promise.all(
      rawWorktrees.map(async (wt) => {
        const normalizedPath =
          isAbsolute(wt.path) || !relativeBase
            ? pathResolve(wt.path)
            : pathResolve(relativeBase, wt.path);
        let name: string;
        if (wt.isMainWorktree) {
          name = normalizedPath.split(/[/\\]/).pop() || "Main";
        } else if (wt.isDetached) {
          name = normalizedPath.split(/[/\\]/).pop() || wt.head?.substring(0, 7) || "Detached";
        } else if (wt.branch) {
          name = wt.branch;
        } else {
          name = normalizedPath.split(/[/\\]/).pop() || "Worktree";
        }

        return {
          id: normalizedPath,
          path: normalizedPath,
          name: name,
          branch: wt.branch || undefined,
          head: wt.head,
          isDetached: wt.isDetached,
          isCurrent: false,
          isMainWorktree: wt.isMainWorktree,
          isExternal: boundary === undefined ? undefined : !isPathInside(normalizedPath, boundary),
          gitDir: (await getGitDir(normalizedPath)) || undefined,
          isLocked: wt.isLocked,
          lockReason: wt.lockReason,
          isPrunable: wt.isPrunable,
          prunableReason: wt.prunableReason,
        };
      })
    );
  }
}
