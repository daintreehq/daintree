import { execFileSync } from "child_process";
import { access, constants } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { CliAvailability, AgentAvailabilityState } from "../../shared/types/ipc.js";
import {
  getEffectiveRegistry,
  type AgentConfig,
  type AgentAuthCheck,
} from "../../shared/config/agentRegistry.js";
import { refreshPath } from "../setup/environment.js";

export class CliAvailabilityService {
  private static readonly CHECK_TIMEOUT_MS = 10_000;
  private static readonly AUTH_CHECK_TIMEOUT_MS = 3_000;

  private availability: CliAvailability | null = null;
  private inFlightCheck: Promise<CliAvailability> | null = null;
  private checkId = 0;

  async checkAvailability(): Promise<CliAvailability> {
    if (this.inFlightCheck) {
      return this.inFlightCheck;
    }

    const currentCheckId = this.checkId;

    this.inFlightCheck = (async () => {
      try {
        if (this.availability === null) {
          await refreshPath();
        }

        const entries = Object.entries(getEffectiveRegistry());

        const checksPromise = Promise.allSettled(
          entries.map(async ([id, config]) => {
            const state = await this.checkAgent(config);
            return [id, state] as [string, AgentAvailabilityState];
          })
        );

        let timeoutHandle: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error("CLI availability check timed out")),
            CliAvailabilityService.CHECK_TIMEOUT_MS
          );
        });

        let availabilityEntries: [string, AgentAvailabilityState][];
        try {
          const results = await Promise.race([checksPromise, timeoutPromise]);
          availabilityEntries = results.map((result, index) => {
            if (result.status === "fulfilled") {
              return result.value;
            } else {
              console.warn(
                `[CliAvailabilityService] Check failed for ${entries[index][0]}:`,
                result.reason
              );
              return [entries[index][0], "missing"] as [string, AgentAvailabilityState];
            }
          });
        } catch (error) {
          console.warn("[CliAvailabilityService]", error instanceof Error ? error.message : error);
          availabilityEntries = entries.map(
            ([id]) => [id, "missing"] as [string, AgentAvailabilityState]
          );
        } finally {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
        }

        const result: CliAvailability = Object.fromEntries(availabilityEntries);

        if (this.checkId === currentCheckId) {
          this.availability = result;
        }

        return result;
      } finally {
        if (this.checkId === currentCheckId) {
          this.inFlightCheck = null;
        }
      }
    })();

    return this.inFlightCheck;
  }

  getAvailability(): CliAvailability | null {
    return this.availability;
  }

  async refresh(): Promise<CliAvailability> {
    await refreshPath();
    this.checkId++;
    this.inFlightCheck = null;
    return this.checkAvailability();
  }

  private async checkAgent(config: AgentConfig): Promise<AgentAvailabilityState> {
    const binaryFound = await this.checkCommand(config.command);
    if (!binaryFound) return "missing";

    if (!config.authCheck) return "ready";

    return this.checkAuth(config.name, config.authCheck);
  }

  private async checkAuth(
    agentName: string,
    authCheck: AgentAuthCheck
  ): Promise<AgentAvailabilityState> {
    const timeoutPromise = new Promise<AgentAvailabilityState>((resolve) => {
      setTimeout(
        () => resolve(authCheck.fallback ?? "installed"),
        CliAvailabilityService.AUTH_CHECK_TIMEOUT_MS
      );
    });

    const checkPromise = (async (): Promise<AgentAvailabilityState> => {
      const checkedPaths: string[] = [];

      // Check environment variable first (positive signal only)
      if (authCheck.envVar && process.env[authCheck.envVar]) {
        return "ready";
      }

      const home = homedir();

      // Check platform-specific config paths
      const platform = process.platform as "darwin" | "linux" | "win32";
      const platformPaths = authCheck.configPaths?.[platform];
      if (platformPaths) {
        for (const relPath of platformPaths) {
          const fullPath = join(home, relPath);
          checkedPaths.push(fullPath);
          try {
            await access(fullPath, constants.R_OK);
            return "ready";
          } catch {
            // File not found, continue
          }
        }
      }

      // Check platform-independent config paths
      if (authCheck.configPathsAll) {
        for (const relPath of authCheck.configPathsAll) {
          const fullPath = join(home, relPath);
          checkedPaths.push(fullPath);
          try {
            await access(fullPath, constants.R_OK);
            return "ready";
          } catch {
            // File not found, continue
          }
        }
      }

      const fallbackState = authCheck.fallback ?? "installed";
      console.log(
        `[CliAvailabilityService] ${agentName}: binary found, auth check fell through (checked: ${
          checkedPaths.join(", ") || "none"
        }) -> "${fallbackState}"`
      );
      return fallbackState;
    })();

    return Promise.race([checkPromise, timeoutPromise]);
  }

  private async checkCommand(command: string): Promise<boolean> {
    if (typeof command !== "string" || !command.trim()) {
      return false;
    }

    // Prevent shell injection (alphanumeric, ., -, _)
    if (!/^[a-zA-Z0-9._-]+$/.test(command)) {
      console.warn(
        `[CliAvailabilityService] Command "${command}" contains invalid characters, rejecting`
      );
      return false;
    }

    return new Promise((resolve) => {
      setImmediate(() => {
        try {
          const checkCmd = process.platform === "win32" ? "where" : "which";
          execFileSync(checkCmd, [command], { stdio: "ignore", timeout: 5000 });
          resolve(true);
        } catch {
          resolve(false);
        }
      });
    });
  }
}
