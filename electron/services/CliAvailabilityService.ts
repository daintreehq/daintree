import { execFileSync } from "child_process";
import type { CliAvailability } from "../../shared/types/ipc.js";
import { getEffectiveRegistry } from "../../shared/config/agentRegistry.js";

export class CliAvailabilityService {
  private availability: CliAvailability | null = null;
  private inFlightCheck: Promise<CliAvailability> | null = null;

  async checkAvailability(): Promise<CliAvailability> {
    if (this.inFlightCheck) {
      return this.inFlightCheck;
    }

    this.inFlightCheck = (async () => {
      try {
        const entries = Object.entries(getEffectiveRegistry());
        const availabilityEntries = await Promise.all(
          entries.map(async ([id, config]) => [id, await this.checkCommand(config.command)])
        );

        const result: CliAvailability = Object.fromEntries(availabilityEntries);

        this.availability = result;

        return result;
      } finally {
        this.inFlightCheck = null;
      }
    })();

    return this.inFlightCheck;
  }

  getAvailability(): CliAvailability | null {
    return this.availability;
  }

  async refresh(): Promise<CliAvailability> {
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
          execFileSync(checkCmd, [command], { stdio: "ignore" });
          resolve(true);
        } catch {
          resolve(false);
        }
      });
    });
  }
}
