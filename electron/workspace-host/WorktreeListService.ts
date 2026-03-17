import { resolve as pathResolve, normalize as pathNormalize } from "path";
import { realpathSync } from "fs";
import type { SimpleGit } from "simple-git";
import type { Worktree } from "../../shared/types/worktree.js";
import { getGitDir } from "../utils/gitUtils.js";

const WORKTREE_LIST_CACHE_TTL_MS = 15_000;

export interface RawWorktreeRecord {
  path: string;
  branch: string;
  bare: boolean;
  isMainWorktree: boolean;
  head?: string;
  isDetached?: boolean;
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

  canonicalizePath(p: string): string {
    try {
      const resolved = pathResolve(p);
      const real = realpathSync(resolved);
      return process.platform === "win32" ? real.toLowerCase() : real;
    } catch {
      const normalized = pathNormalize(pathResolve(p));
      return process.platform === "win32" ? normalized.toLowerCase() : normalized;
    }
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

      let currentWorktree: Partial<{
        path: string;
        branch: string;
        bare: boolean;
        head: string;
        isDetached: boolean;
      }> = {};

      const pushWorktree = () => {
        if (currentWorktree.path) {
          let isMain = false;
          if (this.projectRootPath) {
            const canonicalWorktreePath = this.canonicalizePath(currentWorktree.path);
            const canonicalProjectRoot = this.canonicalizePath(this.projectRootPath);
            isMain = canonicalWorktreePath === canonicalProjectRoot;
          }

          worktrees.push({
            path: currentWorktree.path,
            branch: currentWorktree.branch || "",
            bare: currentWorktree.bare || false,
            isMainWorktree: isMain,
            head: currentWorktree.isDetached ? currentWorktree.head : undefined,
            isDetached: currentWorktree.isDetached,
          });
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

  mapToWorktrees(rawWorktrees: RawWorktreeRecord[]): Worktree[] {
    return rawWorktrees.map((wt) => {
      let name: string;
      if (wt.isMainWorktree) {
        name = wt.path.split(/[/\\]/).pop() || "Main";
      } else if (wt.isDetached) {
        name = wt.path.split(/[/\\]/).pop() || wt.head?.substring(0, 7) || "Detached";
      } else if (wt.branch) {
        name = wt.branch;
      } else {
        name = wt.path.split(/[/\\]/).pop() || "Worktree";
      }

      return {
        id: wt.path,
        path: wt.path,
        name: name,
        branch: wt.branch || undefined,
        head: wt.head,
        isDetached: wt.isDetached,
        isCurrent: false,
        isMainWorktree: wt.isMainWorktree,
        gitDir: getGitDir(wt.path) || undefined,
      };
    });
  }
}
