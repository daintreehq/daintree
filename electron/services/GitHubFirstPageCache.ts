import { readFileSync, existsSync, mkdirSync } from "fs";
import { resilientAtomicWriteFileSync } from "../utils/fs.js";
import { getWritesSuppressed } from "./diskPressureState.js";
import path from "path";
import os from "os";
import type { GitHubIssue, GitHubPR } from "../../shared/types/github.js";

// Get userData path without importing electron (works in both main and utility process)
function getUserDataPath(): string {
  if (process.env.DAINTREE_USER_DATA) {
    const userDataPath = process.env.DAINTREE_USER_DATA;
    if (path.isAbsolute(userDataPath)) {
      return userDataPath;
    }
    console.warn(
      `[GitHubFirstPageCache] DAINTREE_USER_DATA is not absolute: ${userDataPath}, falling back`
    );
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require("electron");
    return app.getPath("userData");
  } catch {
    const appName = "Daintree";
    const homedir = os.homedir();

    if (!homedir || homedir === "" || homedir === "/") {
      throw new Error(
        "[GitHubFirstPageCache] Unable to determine user data path: os.homedir() unavailable"
      );
    }

    switch (process.platform) {
      case "darwin":
        return path.join(homedir, "Library", "Application Support", appName);
      case "win32": {
        const appData = process.env.APPDATA;
        if (appData && path.isAbsolute(appData)) {
          return path.join(appData, appName);
        }
        return path.join(homedir, "AppData", "Roaming", appName);
      }
      default: {
        const xdgConfig = process.env.XDG_CONFIG_HOME;
        if (xdgConfig && path.isAbsolute(xdgConfig)) {
          return path.join(xdgConfig, appName);
        }
        return path.join(homedir, ".config", appName);
      }
    }
  }
}

export interface CachedFirstPagePayload {
  issues: { items: GitHubIssue[]; endCursor: string | null; hasNextPage: boolean };
  prs: { items: GitHubPR[]; endCursor: string | null; hasNextPage: boolean };
  lastUpdated: number;
  projectPath: string;
}

interface CacheFile {
  version: 1;
  projects: Record<string, CachedFirstPagePayload>;
}

// Mirror the stats cache: 10-minute freshness budget for cold-start hydration.
// Anything older is dropped on read so we never resurrect data that's likely
// to mislead the user. The first network poll lands within seconds and
// overwrites this anyway.
const MAX_CACHE_AGE_MS = 10 * 60 * 1000;
const MAX_PROJECTS = 10;

let instance: GitHubFirstPageCache | null = null;

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function normalizePage<T>(
  raw: unknown,
  itemValidator: (item: unknown) => item is T
): { items: T[]; endCursor: string | null; hasNextPage: boolean } | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as {
    items?: unknown;
    endCursor?: unknown;
    hasNextPage?: unknown;
  };
  if (!Array.isArray(candidate.items)) return null;
  if (!isStringOrNull(candidate.endCursor)) return null;
  if (typeof candidate.hasNextPage !== "boolean") return null;
  // Reject the whole page on any bad item rather than silently dropping it —
  // a partially-corrupted file means we cannot trust the rest. The renderer
  // will fall back to the network poll, which is bounded by seconds.
  if (!candidate.items.every(itemValidator)) return null;
  return {
    items: candidate.items as T[],
    endCursor: candidate.endCursor,
    hasNextPage: candidate.hasNextPage,
  };
}

function isUserLike(value: unknown): value is { login: string; avatarUrl: string } {
  if (!value || typeof value !== "object") return false;
  const u = value as { login?: unknown; avatarUrl?: unknown };
  return typeof u.login === "string" && typeof u.avatarUrl === "string";
}

function isIssueLike(item: unknown): item is GitHubIssue {
  if (!item || typeof item !== "object") return false;
  const o = item as {
    number?: unknown;
    title?: unknown;
    url?: unknown;
    author?: unknown;
    assignees?: unknown;
  };
  if (typeof o.number !== "number" || typeof o.title !== "string" || typeof o.url !== "string") {
    return false;
  }
  // GitHubListItem reads author + assignees unconditionally — accepting a
  // malformed page that lacks them would crash the dropdown on render.
  if (!isUserLike(o.author)) return false;
  if (!Array.isArray(o.assignees)) return false;
  return true;
}

function isPRLike(item: unknown): item is GitHubPR {
  if (!item || typeof item !== "object") return false;
  const o = item as {
    number?: unknown;
    title?: unknown;
    url?: unknown;
    author?: unknown;
    isDraft?: unknown;
  };
  if (typeof o.number !== "number" || typeof o.title !== "string" || typeof o.url !== "string") {
    return false;
  }
  if (!isUserLike(o.author)) return false;
  if (typeof o.isDraft !== "boolean") return false;
  return true;
}

function normalizeCachedPayload(entry: unknown): CachedFirstPagePayload | null {
  if (!entry || typeof entry !== "object") return null;
  const candidate = entry as Partial<CachedFirstPagePayload>;
  if (
    typeof candidate.lastUpdated !== "number" ||
    !Number.isFinite(candidate.lastUpdated) ||
    candidate.lastUpdated <= 0
  ) {
    return null;
  }
  if (typeof candidate.projectPath !== "string") return null;

  const issues = normalizePage(candidate.issues, isIssueLike);
  const prs = normalizePage(candidate.prs, isPRLike);
  if (!issues || !prs) return null;

  return {
    issues,
    prs,
    lastUpdated: candidate.lastUpdated,
    projectPath: candidate.projectPath,
  };
}

export class GitHubFirstPageCache {
  private cacheFilePath: string;
  private memoryCache: CacheFile | null = null;

  private constructor(userDataPath: string) {
    this.cacheFilePath = path.join(userDataPath, "github-first-page-cache.json");
  }

  static getInstance(): GitHubFirstPageCache {
    if (!instance) {
      const userDataPath = getUserDataPath();
      instance = new GitHubFirstPageCache(userDataPath);
    }
    return instance;
  }

  static resetInstance(): void {
    instance = null;
  }

  private load(): CacheFile {
    if (this.memoryCache) {
      return this.memoryCache;
    }

    if (!existsSync(this.cacheFilePath)) {
      this.memoryCache = { version: 1, projects: {} };
      return this.memoryCache;
    }

    try {
      const content = readFileSync(this.cacheFilePath, "utf8");
      const data = JSON.parse(content) as CacheFile;

      if (data.version !== 1) {
        this.memoryCache = { version: 1, projects: {} };
        return this.memoryCache;
      }

      if (!data.projects || typeof data.projects !== "object" || Array.isArray(data.projects)) {
        console.warn("[GitHubFirstPageCache] Invalid cache structure, resetting");
        this.memoryCache = { version: 1, projects: {} };
        return this.memoryCache;
      }

      this.memoryCache = data;
      return this.memoryCache;
    } catch (error) {
      console.warn("[GitHubFirstPageCache] Failed to load cache:", error);
      this.memoryCache = { version: 1, projects: {} };
      return this.memoryCache;
    }
  }

  private save(cache: CacheFile): void {
    this.memoryCache = cache;

    if (getWritesSuppressed()) return;

    try {
      const dir = path.dirname(this.cacheFilePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      resilientAtomicWriteFileSync(this.cacheFilePath, JSON.stringify(cache, null, 2), "utf8");
    } catch (error) {
      console.error("[GitHubFirstPageCache] Failed to save cache:", error);
    }
  }

  get(repoKey: string): CachedFirstPagePayload | null {
    const cache = this.load();
    const normalized = normalizeCachedPayload((cache.projects as Record<string, unknown>)[repoKey]);
    if (!normalized) return null;

    const age = Date.now() - normalized.lastUpdated;
    if (age > MAX_CACHE_AGE_MS || age < 0) {
      return null;
    }

    return normalized;
  }

  set(
    repoKey: string,
    payload: {
      issues: { items: GitHubIssue[]; endCursor: string | null; hasNextPage: boolean };
      prs: { items: GitHubPR[]; endCursor: string | null; hasNextPage: boolean };
    },
    projectPath: string
  ): void {
    const cache = this.load();
    const normalizedProjects: Record<string, CachedFirstPagePayload> = {};

    for (const [key, entry] of Object.entries(cache.projects as Record<string, unknown>)) {
      const normalized = normalizeCachedPayload(entry);
      if (normalized) {
        normalizedProjects[key] = normalized;
      }
    }

    normalizedProjects[repoKey] = {
      issues: payload.issues,
      prs: payload.prs,
      lastUpdated: Date.now(),
      projectPath: typeof projectPath === "string" ? projectPath : "",
    };

    const entries = Object.entries(normalizedProjects);
    if (entries.length > MAX_PROJECTS) {
      const sorted = entries.sort(([, a], [, b]) => b.lastUpdated - a.lastUpdated);
      cache.projects = Object.fromEntries(sorted.slice(0, MAX_PROJECTS));
    } else {
      cache.projects = normalizedProjects;
    }

    this.save(cache);
  }

  clear(): void {
    this.memoryCache = { version: 1, projects: {} };
    this.save(this.memoryCache);
  }
}
