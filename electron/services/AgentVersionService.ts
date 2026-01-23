import { execFile } from "child_process";
import { promisify } from "util";
import * as semver from "semver";
import { getEffectiveAgentConfig, getEffectiveAgentIds } from "../../shared/config/agentRegistry.js";
import type { AgentVersionInfo } from "../../shared/types/ipc/system.js";
import type { AgentId } from "../../shared/types/domain.js";
import { CliAvailabilityService } from "./CliAvailabilityService.js";

const execFileAsync = promisify(execFile);

interface CachedVersionInfo {
  info: AgentVersionInfo;
  timestamp: number;
  generation: number;
}

export class AgentVersionService {
  private cache = new Map<AgentId, CachedVersionInfo>();
  private readonly CACHE_TTL_MS = 12 * 60 * 60 * 1000;
  private readonly TIMEOUT_MS = 5000;
  private readonly MAX_BUFFER = 256 * 1024;
  private inFlightChecks = new Map<AgentId, Promise<AgentVersionInfo>>();
  private generation = 0;

  constructor(private cliAvailabilityService: CliAvailabilityService) {}

  async getVersions(refresh = false): Promise<AgentVersionInfo[]> {
    const agentIds = getEffectiveAgentIds();
    const results = await Promise.all(
      agentIds.map((agentId) => this.getVersion(agentId as AgentId, refresh))
    );
    return results;
  }

  async getVersion(agentId: AgentId, refresh = false): Promise<AgentVersionInfo> {
    const config = getEffectiveAgentConfig(agentId);
    if (!config) {
      return {
        agentId,
        installedVersion: null,
        latestVersion: null,
        updateAvailable: false,
        lastChecked: null,
        error: `Unknown agent: ${agentId}`,
      };
    }

    const inFlight = this.inFlightChecks.get(agentId);
    if (inFlight) {
      return inFlight;
    }

    const cached = this.cache.get(agentId);
    if (!refresh && cached) {
      const age = Date.now() - cached.timestamp;
      if (age < this.CACHE_TTL_MS) {
        return cached.info;
      }
    }

    const currentGeneration = this.generation;
    const checkPromise = this.checkVersion(agentId);
    this.inFlightChecks.set(agentId, checkPromise);

    try {
      const result = await checkPromise;
      if (this.generation === currentGeneration) {
        this.cache.set(agentId, {
          info: result,
          timestamp: Date.now(),
          generation: currentGeneration,
        });
      }
      return result;
    } finally {
      this.inFlightChecks.delete(agentId);
    }
  }

  private async checkVersion(agentId: AgentId): Promise<AgentVersionInfo> {
    const config = getEffectiveAgentConfig(agentId);
    if (!config) {
      return {
        agentId,
        installedVersion: null,
        latestVersion: null,
        updateAvailable: false,
        lastChecked: Date.now(),
        error: `Unknown agent: ${agentId}`,
      };
    }

    const availability = await this.cliAvailabilityService.checkAvailability();
    const isAvailable = availability[agentId];
    if (!isAvailable) {
      return {
        agentId,
        installedVersion: null,
        latestVersion: null,
        updateAvailable: false,
        lastChecked: Date.now(),
      };
    }

    let installedVersion: string | null = null;
    let latestVersion: string | null = null;
    let error: string | undefined;

    try {
      installedVersion = await this.getInstalledVersion(agentId);
    } catch (err: any) {
      error = `Failed to get installed version: ${err.message}`;
    }

    try {
      latestVersion = await this.getLatestVersion(agentId);
    } catch (err: any) {
      if (!error) {
        error = `Failed to get latest version: ${err.message}`;
      }
    }

    const updateAvailable = this.isUpdateAvailable(installedVersion, latestVersion);

    return {
      agentId,
      installedVersion,
      latestVersion,
      updateAvailable,
      lastChecked: Date.now(),
      error,
    };
  }

  private async getInstalledVersion(agentId: AgentId): Promise<string | null> {
    const config = getEffectiveAgentConfig(agentId);
    if (!config || !config.version) {
      return null;
    }

    const versionArgs = config.version.args;
    let stdout = "";

    try {
      const result = await execFileAsync(config.command, versionArgs, {
        timeout: this.TIMEOUT_MS,
        maxBuffer: this.MAX_BUFFER,
        shell: false,
        windowsHide: true,
      });
      stdout = result.stdout || result.stderr || "";
    } catch (error: any) {
      if (error.code === "ENOENT") {
        return null;
      }
      if (error.killed || error.code === "ETIMEDOUT") {
        throw new Error(`Command timed out: ${config.command}`);
      }
      if (error.code === "EACCES") {
        throw new Error(`Permission denied: ${config.command}`);
      }
      stdout = error.stdout?.toString() || error.stderr?.toString() || "";
      if (!stdout) {
        throw new Error(`Command failed: ${error.message}`);
      }
    }

    return this.parseVersion(stdout);
  }

  private async getLatestVersion(agentId: AgentId): Promise<string | null> {
    const config = getEffectiveAgentConfig(agentId);
    if (!config || !config.version) {
      return null;
    }

    if (config.version.githubRepo) {
      try {
        const githubVersion = await this.getLatestGitHubVersion(config.version.githubRepo);
        if (githubVersion) {
          return githubVersion;
        }
        console.warn(`[AgentVersionService] GitHub API returned null for ${agentId}, falling back to npm`);
      } catch (error: any) {
        console.warn(`[AgentVersionService] GitHub API failed for ${agentId}, falling back to npm:`, error.message);
      }
    }

    if (config.version.npmPackage) {
      return this.getLatestNpmVersion(config.version.npmPackage);
    }

    return null;
  }

  private async getLatestNpmVersion(packageName: string): Promise<string | null> {
    try {
      const url = `https://registry.npmjs.org/${packageName}?fields=dist-tags`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`npm registry returned ${response.status}`);
        }

        const data = await response.json();
        return data["dist-tags"]?.latest || null;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error: any) {
      throw new Error(`Failed to fetch npm version: ${error.message}`);
    }
  }

  private async getLatestGitHubVersion(repo: string): Promise<string | null> {
    try {
      const url = `https://api.github.com/repos/${repo}/releases/latest`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "Canopy-Electron",
          },
        });

        if (response.status === 404) {
          throw new Error(`No releases found for ${repo}`);
        }

        if (response.status === 403) {
          const rateLimitRemaining = response.headers.get("X-RateLimit-Remaining");
          if (rateLimitRemaining === "0") {
            const resetTime = response.headers.get("X-RateLimit-Reset");
            throw new Error(
              `GitHub API rate limit exceeded. Resets at ${new Date(Number(resetTime) * 1000).toLocaleTimeString()}`
            );
          }
          throw new Error(`GitHub API access forbidden (status 403)`);
        }

        if (!response.ok) {
          throw new Error(`GitHub API returned ${response.status}`);
        }

        const data = await response.json();
        const tagName = data.tag_name;
        const parsed = this.parseVersion(tagName);
        if (!parsed) {
          throw new Error(`Could not parse version from tag: ${tagName}`);
        }
        return parsed;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error: any) {
      throw new Error(`Failed to fetch GitHub version for ${repo}: ${error.message}`);
    }
  }

  private parseVersion(versionString: string): string | null {
    if (!versionString || typeof versionString !== "string") {
      return null;
    }

    const cleanedDirect = semver.clean(versionString);
    if (cleanedDirect && semver.valid(cleanedDirect)) {
      return cleanedDirect;
    }

    const versionPatterns = [
      /v?(\d+\.\d+\.\d+(?:-[a-z0-9.]+(?:\+[a-z0-9.]+)?)?)/i,
      /version[:\s]+v?(\d+\.\d+\.\d+(?:-[a-z0-9.]+)?)/i,
      /(\d+\.\d+\.\d+(?:-[a-z0-9.]+)?)/,
    ];

    for (const pattern of versionPatterns) {
      const match = versionString.match(pattern);
      if (match && match[1]) {
        const cleaned = semver.clean(match[1]);
        if (cleaned && semver.valid(cleaned)) {
          return cleaned;
        }
      }
    }

    const coerced = semver.coerce(versionString);
    if (coerced) {
      return coerced.version;
    }

    return null;
  }

  private isUpdateAvailable(
    installedVersion: string | null,
    latestVersion: string | null
  ): boolean {
    if (!installedVersion || !latestVersion) {
      return false;
    }

    try {
      return semver.gt(latestVersion, installedVersion);
    } catch {
      return false;
    }
  }

  clearCache(agentId?: AgentId): void {
    this.generation++;
    if (agentId) {
      this.cache.delete(agentId);
      this.inFlightChecks.delete(agentId);
    } else {
      this.cache.clear();
      this.inFlightChecks.clear();
    }
  }
}
