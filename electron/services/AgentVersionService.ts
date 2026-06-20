import { spawn, spawnSync, type ChildProcess } from "child_process";
import * as semver from "semver";
import {
  getEffectiveAgentConfig,
  getEffectiveAgentIds,
} from "../../shared/config/agentRegistry.js";
import type { AgentVersionInfo } from "../../shared/types/ipc/system.js";
import type { AgentId } from "../../shared/types/agent.js";
import { CliAvailabilityService } from "./CliAvailabilityService.js";
import { isAgentInstalled } from "../../shared/utils/agentAvailability.js";
import { buildProbeEnv } from "../utils/spawnEnv.js";
import { scrubSecrets } from "../../shared/utils/secretScrubber.js";

interface CachedVersionInfo {
  info: AgentVersionInfo;
  timestamp: number;
  generation: number;
}

export class AgentVersionService {
  private cache = new Map<AgentId, CachedVersionInfo>();
  private readonly CACHE_TTL_MS = 12 * 60 * 60 * 1000;
  private readonly TIMEOUT_MS = 10000;
  // Grace window after `exit` for stdout to flush before we settle without
  // waiting on `close` (which a pipe-inheriting grandchild can stall forever).
  private readonly EXIT_DRAIN_MS = 200;
  private readonly MAX_BUFFER = 256 * 1024;
  private inFlightChecks = new Map<AgentId, Promise<AgentVersionInfo>>();
  private generation = 0;

  constructor(private cliAvailabilityService: CliAvailabilityService) {}

  private toErrorString(error: unknown): string {
    if (error instanceof Error && typeof error.message === "string" && error.message.trim()) {
      return error.message;
    }
    if (typeof error === "string" && error.trim()) {
      return error;
    }
    return "Unknown error";
  }

  private createErrorInfo(agentId: AgentId, error: unknown): AgentVersionInfo {
    return {
      agentId,
      installedVersion: null,
      latestVersion: null,
      updateAvailable: false,
      lastChecked: Date.now(),
      error: this.toErrorString(error),
    };
  }

  async getVersions(refresh = false): Promise<AgentVersionInfo[]> {
    const agentIds = getEffectiveAgentIds();
    const results = await Promise.allSettled(
      agentIds.map((agentId) => this.getVersion(agentId as AgentId, refresh))
    );

    return results.map((result, index) => {
      const agentId = agentIds[index] as AgentId;
      if (result.status === "fulfilled") {
        return result.value;
      }

      return this.createErrorInfo(agentId, result.reason);
    });
  }

  async getVersion(agentId: AgentId, refresh = false): Promise<AgentVersionInfo> {
    let config;
    try {
      config = getEffectiveAgentConfig(agentId);
    } catch (error) {
      return this.createErrorInfo(agentId, error);
    }
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

    if (!refresh) {
      const inFlight = this.inFlightChecks.get(agentId);
      if (inFlight) {
        return inFlight;
      }

      const cached = this.cache.get(agentId);
      if (cached) {
        const age = Date.now() - cached.timestamp;
        if (age < this.CACHE_TTL_MS) {
          return cached.info;
        }
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
    } catch (error) {
      return this.createErrorInfo(agentId, error);
    } finally {
      // Promise-identity guard: a `refresh=true` call bypasses the in-flight
      // check and overwrites this entry, so an older probe settling later must
      // only evict its OWN promise. Deleting unconditionally would drop a newer
      // refresh probe's entry and let a concurrent caller miss dedup.
      if (this.inFlightChecks.get(agentId) === checkPromise) {
        this.inFlightChecks.delete(agentId);
      }
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
    if (!isAgentInstalled(availability[agentId])) {
      return {
        agentId,
        installedVersion: null,
        latestVersion: null,
        updateAvailable: false,
        lastChecked: Date.now(),
      };
    }

    const [installedResult, latestResult] = await Promise.allSettled([
      this.getInstalledVersion(agentId),
      this.getLatestVersion(agentId),
    ]);

    let installedVersion: string | null = null;
    let latestVersion: string | null = null;
    const errors: string[] = [];

    if (installedResult.status === "fulfilled") {
      installedVersion = installedResult.value;
    } else {
      errors.push(`Failed to get installed version: ${this.toErrorString(installedResult.reason)}`);
    }

    if (latestResult.status === "fulfilled") {
      latestVersion = latestResult.value;
    } else {
      errors.push(`Failed to get latest version: ${this.toErrorString(latestResult.reason)}`);
    }

    const error = errors.length > 0 ? errors.join("; ") : undefined;

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

    let output: string;
    try {
      output = await this.runVersionProbe(config.command, config.version.args);
    } catch (error: any) {
      if (error.code === "ENOENT") {
        return null;
      }
      // The thrown message is what flows into AgentVersionInfo.error (via
      // toErrorString → .message), so it is scrubbed/sanitized; the original is
      // preserved only as `cause` for local debugging, never surfaced to the UI.
      if (error.code === "EACCES") {
        throw new Error(`Permission denied: ${config.command}`, { cause: error });
      }
      throw new Error(`Command failed: ${scrubSecrets(error.message ?? "")}`, { cause: error });
    }

    return this.parseVersion(output);
  }

  /**
   * Spawn `<command> --version` and capture its output without ever waiting
   * indefinitely on `close`.
   *
   * The previous `execFile` resolved on `close` (all stdio EOF), which could
   * hang forever: some agent CLIs spawn a background/daemon grandchild that
   * inherits the stdout fd, so the foreground prints its version and exits but
   * the pipe never EOFs. `execFile`'s own `timeout` was ineffective there — it
   * signals the already-exited foreground PID, never the grandchild holding the
   * fd — and a never-settling version probe stranded the assistant launch FSM
   * on "Checking version…" (its phase reset lives in a `finally` that an
   * unsettled await never reaches).
   *
   * Settle order: prefer `close` (full output, the normal fast path, and the
   * only path where every fd-holder has already exited — so it never needs to
   * reap); on `exit` arm a short grace timer (`EXIT_DRAIN_MS`) so a grandchild
   * holding the pipe can't keep us pending past the process actually
   * terminating, while still letting any stdout delivered between `exit` and
   * `close` land. `exit` does NOT guarantee stdout is flushed, so we never
   * finish on it directly. Every settle that bypasses `close` — the exit-grace
   * timer and the hard wall-clock deadline — reaps the whole process group
   * (`detached` SIGKILL on POSIX, `taskkill /T` on Windows) so a foreground that
   * exited (or genuinely hangs) leaves no grandchild still holding the pipe,
   * then resolves with whatever was captured (usually the version line, else an
   * empty string → `parseVersion` → null → "indeterminate" → the launch proceeds
   * rather than blocking on an outdated-CLI gate).
   */
  private runVersionProbe(command: string, args: string[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      // `detached` puts the child in its own process group (POSIX) so the
      // deadline can SIGKILL the entire tree, including a grandchild that
      // inherited the stdout pipe. Windows has no process groups here, so fall
      // back to killing just the child.
      const useGroup = process.platform !== "win32";
      let child: ChildProcess;
      try {
        child = spawn(command, args, {
          shell: false,
          windowsHide: true,
          env: buildProbeEnv(),
          detached: useGroup,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        reject(error);
        return;
      }

      // Detached + unref'd so an in-flight probe can't pin main-process teardown
      // during `app.quit()`. unref only drops the event-loop ref-count; the
      // ChildProcess object stays referenced here and its events still deliver.
      child.unref();

      let stdout = "";
      let stderr = "";
      let settled = false;
      // Set when `exit` fires before `close`. `exit` does NOT guarantee all
      // stdout has been delivered (Node only guarantees that by `close`), so we
      // don't finish on `exit` directly — we give the pipes a short grace to
      // flush. If `close` arrives in that window we finish with the full output;
      // if it never comes (a grandchild is holding the pipe open), the grace
      // timer reaps the group and finishes with whatever the foreground printed.
      let exitGraceTimer: ReturnType<typeof setTimeout> | null = null;

      const killTree = (): void => {
        const pid = child.pid;
        if (typeof pid !== "number") return;
        if (!useGroup) {
          // Windows has no process groups here: `child.kill()` TerminateProcess-es
          // only the foreground, orphaning the inherited-pipe grandchild. Use
          // `taskkill /T` to reap the whole tree (repo pattern: ProcessTreeKiller,
          // PtyClient). `timeout`/`stdio: ignore` keep it from blocking the probe.
          try {
            spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
              windowsHide: true,
              stdio: "ignore",
              timeout: 3000,
            });
          } catch (error) {
            // taskkill itself failed to launch — the tree may still be alive.
            console.warn(`[AgentVersionService] taskkill pid=${pid}:`, this.toErrorString(error));
          }
          return;
        }
        try {
          // Negative pid → signal the whole process group (the grandchild
          // holding the pipe lives here unless it properly daemonized via
          // setsid, in which case it has escaped the hang anyway).
          process.kill(-pid, "SIGKILL");
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          // ESRCH: the group is already gone — nothing to reap, silent. EPERM/
          // EINVAL mean the tree may still be alive and the operator needs to
          // know, so surface them rather than swallowing every failure.
          if (code !== "ESRCH") {
            console.warn(
              `[AgentVersionService] SIGKILL group pid=${pid}: ${this.toErrorString(error)}`
            );
          }
        }
      };

      // `finish` is a hoisted declaration so the timer callback below can
      // reference it while `timer` stays a `const` it can clear in turn.
      const timer = setTimeout(() => {
        if (settled) return;
        // A genuinely hung foreground (or a grandchild keeping us alive) — reap
        // the tree and resolve with whatever the CLI managed to print first.
        killTree();
        finish(stdout || stderr);
      }, this.TIMEOUT_MS);
      // Don't let the deadline timer pin event-loop teardown (the optional call
      // guards Vitest fake-timer objects that lack `unref`).
      timer.unref?.();

      function cleanup(): void {
        clearTimeout(timer);
        if (exitGraceTimer) clearTimeout(exitGraceTimer);
        child.stdout?.removeAllListeners();
        child.stderr?.removeAllListeners();
        child.stdout?.destroy();
        child.stderr?.destroy();
      }

      function finish(value: string): void {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      }

      // A rare pipe error (EBADF/EIO on a dead/closed fd) on a piped stream
      // becomes an uncaughtException if unhandled (lesson from #5648). The
      // `settled` guard already covers teardown, so these can be no-ops.
      child.stdout?.on("error", () => {});
      child.stderr?.on("error", () => {});

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length >= this.MAX_BUFFER) return;
        stdout += chunk.toString();
        if (stdout.length >= this.MAX_BUFFER) {
          // Enough to parse a version line — stop reading and reap so a chatty
          // CLI can't stream past the cap and keep us alive.
          killTree();
          finish(stdout || stderr);
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length >= this.MAX_BUFFER) return;
        stderr += chunk.toString();
      });

      // `close` fires after the process exited AND all stdio reached EOF, so it
      // carries the complete output — the preferred settle in the common case.
      child.on("close", () => {
        finish(stdout || stderr);
      });

      // `exit` fires when the process terminates but BEFORE stdio is guaranteed
      // flushed/closed. The crux of the hang fix is that we never wait on `close`
      // alone: arm a short grace timer so a daemon grandchild holding the pipe
      // can't keep us pending. `close` (if it comes) clears this via `cleanup`.
      child.on("exit", () => {
        if (settled || exitGraceTimer) return;
        exitGraceTimer = setTimeout(() => {
          // `close` never came within the grace window, so a grandchild is still
          // holding the pipe open — reap the whole group before settling, else
          // the detached process the probe exists to kill leaks. (The `close`
          // path stays kill-free: it fires only once every fd-holder has exited.)
          killTree();
          finish(stdout || stderr);
        }, this.EXIT_DRAIN_MS);
        exitGraceTimer.unref?.();
      });

      child.on("error", (error: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });
    });
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
        console.warn(
          `[AgentVersionService] GitHub API returned null for ${agentId}, falling back to npm`
        );
      } catch (error: any) {
        console.warn(
          `[AgentVersionService] GitHub API failed for ${agentId}, falling back to npm:`,
          error.message
        );
      }
    }

    if (config.version.npmPackage) {
      return this.getLatestNpmVersion(config.version.npmPackage);
    }

    if (config.version.pypiPackage) {
      return this.getLatestPypiVersion(config.version.pypiPackage);
    }

    return null;
  }

  private async getLatestPypiVersion(packageName: string): Promise<string | null> {
    try {
      const url = `https://pypi.org/pypi/${packageName}/json`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "User-Agent": "Daintree-Electron",
          },
        });

        if (response.status === 404) {
          throw new Error(`PyPI package not found: ${packageName}`);
        }

        if (!response.ok) {
          throw new Error(`PyPI returned ${response.status}`);
        }

        const data = (await response.json()) as { info?: { version?: string } };
        const version = data.info?.version;
        if (typeof version !== "string" || !version) return null;
        return this.parseVersion(version);
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      throw new Error(`Failed to fetch PyPI version: ${this.toErrorString(error)}`, {
        cause: error,
      });
    }
  }

  private async getLatestNpmVersion(packageName: string): Promise<string | null> {
    try {
      const url = `https://registry.npmjs.org/${packageName}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            Accept: "application/vnd.npm.install-v1+json",
            "User-Agent": "Daintree-Electron",
          },
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
      throw new Error(`Failed to fetch npm version: ${this.toErrorString(error)}`);
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
            "User-Agent": "Daintree-Electron",
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
      throw new Error(`Failed to fetch GitHub version for ${repo}: ${this.toErrorString(error)}`);
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
      /v?(\d+\.\d+\.\d+(?:-[a-z0-9.-]+(?:\+[a-z0-9.-]+)?)?)/i,
      /version[:\s]+v?(\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?)/i,
      /(\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?)/,
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

    const coerced = semver.coerce(versionString, { includePrerelease: true });
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

    if (!semver.prerelease(installedVersion) && semver.prerelease(latestVersion)) {
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
