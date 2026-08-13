import crypto from "crypto";
import os from "os";
import { getEffectiveAgentConfig } from "../../shared/config/agentRegistry.js";
import type { AgentId } from "../../shared/types/agent.js";
import type {
  StartAgentUpdatePayload,
  StartAgentUpdateResult,
} from "../../shared/types/ipc/system.js";
import type { PtyClient } from "./PtyClient.js";
import { AgentVersionService } from "./AgentVersionService.js";
import { CliAvailabilityService } from "./CliAvailabilityService.js";
import { refreshWindowsPathForSpawn } from "../setup/windowsPath.js";

export class AgentUpdateHandler {
  constructor(
    private ptyClient: PtyClient,
    private versionService: AgentVersionService,
    private cliAvailabilityService: CliAvailabilityService
  ) {}

  async startUpdate(payload: StartAgentUpdatePayload): Promise<StartAgentUpdateResult> {
    const { agentId, method } = payload;
    const normalizedMethod = typeof method === "string" ? method.trim() : method;
    const config = getEffectiveAgentConfig(agentId);

    if (!config) {
      throw new Error(`Unknown agent: ${agentId}`);
    }

    if (!config.update) {
      throw new Error(`Agent ${agentId} does not have update configuration`);
    }

    if (method !== undefined && normalizedMethod === "") {
      throw new Error("Invalid update method");
    }

    if (normalizedMethod) {
      const availableMethods = this.getAvailableUpdateMethods(agentId);
      if (!availableMethods.includes(normalizedMethod)) {
        throw new Error(
          `No update command available for ${agentId} with method: ${normalizedMethod}`
        );
      }
    }

    const updateCommand = this.getUpdateCommand(agentId, normalizedMethod);
    if (!updateCommand) {
      throw new Error(
        `No update command available for ${agentId} with method: ${normalizedMethod || "default"}`
      );
    }

    const terminalId = crypto.randomUUID();
    const cols = 120;
    const rows = 30;

    // An update command is the case that most needs a current PATH: the user
    // often installs the runtime (Node, a package manager) and immediately asks
    // Daintree to update a CLI through it. `PtyClient` stamps whatever main
    // holds onto the spawn, so refreshing here is what makes it the fresh one
    // (#11773). Windows-only and throttled; failure just uses the current PATH.
    await refreshWindowsPathForSpawn().catch((err) => {
      console.warn(
        "[AgentUpdateHandler] Windows PATH refresh failed; using the current PATH:",
        err
      );
    });

    this.ptyClient.spawn(terminalId, {
      cwd: os.homedir(),
      cols,
      rows,
      kind: "terminal",
      title: `Update ${config.name}`,
    });

    let submitTimer: NodeJS.Timeout | null = null;
    let terminalExited = false;

    const exitHandler = () => {
      finalize();
    };
    const finalize = () => {
      if (terminalExited) {
        return;
      }
      terminalExited = true;
      if (submitTimer) {
        clearTimeout(submitTimer);
        submitTimer = null;
      }

      this.ptyClient.off(`exit:${terminalId}`, exitHandler);
      this.versionService.clearCache(agentId);
      this.cliAvailabilityService.refresh();
    };

    this.ptyClient.on(`exit:${terminalId}`, exitHandler);

    const submitDelay = 500;
    submitTimer = setTimeout(() => {
      if (terminalExited) {
        return;
      }
      try {
        this.ptyClient.submit(terminalId, updateCommand);
      } catch (error) {
        console.error(
          `[AgentUpdateHandler] Failed to submit update command for ${agentId}:`,
          error
        );
        finalize();
      } finally {
        submitTimer = null;
      }
    }, submitDelay);

    return {
      terminalId,
      command: updateCommand,
    };
  }

  private getUpdateCommand(agentId: AgentId, method?: string): string | null {
    const config = getEffectiveAgentConfig(agentId);
    if (!config || !config.update) {
      return null;
    }

    const updates = config.update as Record<string, string | undefined>;

    if (method) {
      return updates[method] ?? null;
    }

    const priority = ["npm", "brew", "curl", "powershell", "pip", "pipx", "pypi", "cargo", "go"];
    for (const key of priority) {
      const value = updates[key];
      if (typeof value === "string" && value) return value;
    }

    return null;
  }

  getAvailableUpdateMethods(agentId: AgentId): string[] {
    const config = getEffectiveAgentConfig(agentId);
    if (!config || !config.update) {
      return [];
    }

    const updates = config.update as Record<string, string | undefined>;
    const methods = new Set<string>();
    for (const [key, value] of Object.entries(updates)) {
      if (typeof value === "string" && value) methods.add(key);
    }
    return [...methods];
  }
}
