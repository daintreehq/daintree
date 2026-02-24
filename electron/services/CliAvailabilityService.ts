import { execFileSync } from "child_process";
import type { CliAvailability } from "../../shared/types/ipc.js";
import { getEffectiveRegistry } from "../../shared/config/agentRegistry.js";

export class CliAvailabilityService {
  private static readonly CHECK_TIMEOUT_MS = 10_000;

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
        const entries = Object.entries(getEffectiveRegistry());

        const checksPromise = Promise.allSettled(
          entries.map(async ([id, config]) => {
            const available = await this.checkCommand(config.command);
            return [id, available] as [string, boolean];
          })
        );

        let timeoutHandle: NodeJS.Timeout;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error("CLI availability check timed out")),
            CliAvailabilityService.CHECK_TIMEOUT_MS
          );
        });

        let availabilityEntries: [string, boolean][];
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
              return [entries[index][0], false] as [string, boolean];
            }
          });
        } catch (error) {
          console.warn("[CliAvailabilityService]", error instanceof Error ? error.message : error);
          availabilityEntries = entries.map(([id]) => [id, false]);
        } finally {
          clearTimeout(timeoutHandle);
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
    this.checkId++;
    this.inFlightCheck = null;
    return this.checkAvailability();
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
