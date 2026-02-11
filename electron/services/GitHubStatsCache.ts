import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import os from "os";

// Get userData path without importing electron (works in both main and utility process)
function getUserDataPath(): string {
  // Priority 1: Environment variable (set by main process for utility processes)
  // Validate that it's an absolute path to prevent project root pollution
  if (process.env.CANOPY_USER_DATA) {
    const userDataPath = process.env.CANOPY_USER_DATA;
    if (path.isAbsolute(userDataPath)) {
      return userDataPath;
    }
    console.warn(
      `[GitHubStatsCache] CANOPY_USER_DATA is not absolute: ${userDataPath}, falling back`
    );
  }

  // Priority 2: Dynamic import electron only in main process
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require("electron");
    return app.getPath("userData");
  } catch {
    // Priority 3: Platform-specific fallback to standard application data directory
    // This handles edge cases where Electron is unavailable but we still want caching
    const appName = "Canopy";
    const homedir = os.homedir();

    // Validate homedir is available (can fail in constrained environments)
    if (!homedir || homedir === "" || homedir === "/") {
      throw new Error(
        "[GitHubStatsCache] Unable to determine user data path: os.homedir() unavailable"
      );
    }

    switch (process.platform) {
      case "darwin":
        return path.join(homedir, "Library", "Application Support", appName);
      case "win32": {
        const appData = process.env.APPDATA;
        // Validate APPDATA if provided
        if (appData && path.isAbsolute(appData)) {
          return path.join(appData, appName);
        }
        return path.join(homedir, "AppData", "Roaming", appName);
      }
      default: {
        // Linux and other Unix-like systems follow XDG Base Directory spec
        const xdgConfig = process.env.XDG_CONFIG_HOME;
        if (xdgConfig && path.isAbsolute(xdgConfig)) {
          return path.join(xdgConfig, appName);
        }
        return path.join(homedir, ".config", appName);
      }
    }
  }
}

interface CachedStats {
  issueCount: number;
  prCount: number;
  lastUpdated: number;
  projectPath: string;
}

interface CacheFile {
  version: 1;
  projects: Record<string, CachedStats>;
}

const MAX_CACHE_AGE_MS = 10 * 60 * 1000; // 10 minutes (reduced from 7 days for better freshness)
const MAX_PROJECTS = 10;

let instance: GitHubStatsCache | null = null;

function normalizeCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

function normalizeCachedStats(entry: unknown): CachedStats | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const candidate = entry as Partial<CachedStats>;

  if (
    typeof candidate.lastUpdated !== "number" ||
    !Number.isFinite(candidate.lastUpdated) ||
    candidate.lastUpdated <= 0
  ) {
    return null;
  }

  if (typeof candidate.projectPath !== "string") {
    return null;
  }

  if (
    typeof candidate.issueCount !== "number" ||
    !Number.isFinite(candidate.issueCount) ||
    candidate.issueCount < 0
  ) {
    return null;
  }

  if (
    typeof candidate.prCount !== "number" ||
    !Number.isFinite(candidate.prCount) ||
    candidate.prCount < 0
  ) {
    return null;
  }

  return {
    issueCount: Math.floor(candidate.issueCount),
    prCount: Math.floor(candidate.prCount),
    lastUpdated: candidate.lastUpdated,
    projectPath: candidate.projectPath,
  };
}

export class GitHubStatsCache {
  private cacheFilePath: string;
  private memoryCache: CacheFile | null = null;

  private constructor(userDataPath: string) {
    this.cacheFilePath = path.join(userDataPath, "github-stats-cache.json");
  }

  static getInstance(): GitHubStatsCache {
    if (!instance) {
      const userDataPath = getUserDataPath();
      instance = new GitHubStatsCache(userDataPath);
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
        console.warn("[GitHubStatsCache] Invalid cache structure, resetting");
        this.memoryCache = { version: 1, projects: {} };
        return this.memoryCache;
      }

      this.memoryCache = data;
      return this.memoryCache;
    } catch (error) {
      console.warn("[GitHubStatsCache] Failed to load cache:", error);
      this.memoryCache = { version: 1, projects: {} };
      return this.memoryCache;
    }
  }

  private save(cache: CacheFile): void {
    try {
      const dir = path.dirname(this.cacheFilePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(this.cacheFilePath, JSON.stringify(cache, null, 2), "utf8");
      this.memoryCache = cache;
    } catch (error) {
      console.error("[GitHubStatsCache] Failed to save cache:", error);
    }
  }

  get(repoKey: string): CachedStats | null {
    const cache = this.load();
    const normalized = normalizeCachedStats((cache.projects as Record<string, unknown>)[repoKey]);
    if (!normalized) {
      return null;
    }

    const age = Date.now() - normalized.lastUpdated;
    if (age > MAX_CACHE_AGE_MS || age < 0) {
      return null;
    }

    return normalized;
  }

  set(repoKey: string, stats: { issueCount: number; prCount: number }, projectPath: string): void {
    const cache = this.load();
    const normalizedProjects: Record<string, CachedStats> = {};

    for (const [key, entry] of Object.entries(cache.projects as Record<string, unknown>)) {
      const normalized = normalizeCachedStats(entry);
      if (normalized) {
        normalizedProjects[key] = normalized;
      }
    }

    normalizedProjects[repoKey] = {
      issueCount: normalizeCount(stats.issueCount),
      prCount: normalizeCount(stats.prCount),
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
