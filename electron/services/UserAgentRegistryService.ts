import { store } from "../store.js";
import type { UserAgentRegistry, UserAgentConfig } from "../../shared/types/index.js";
import { UserAgentConfigSchema } from "../../shared/types/index.js";
import { setUserRegistry, isBuiltInAgent } from "../../shared/config/agentRegistry.js";

export class UserAgentRegistryService {
  private registry: UserAgentRegistry = {};

  constructor() {
    this.loadRegistry();
    this.syncToSharedRegistry();
  }

  private loadRegistry(): void {
    try {
      const stored = store.get("userAgentRegistry", {});
      const validation = UserAgentRegistrySchema.safeParse(stored);

      if (!validation.success) {
        console.error("[UserAgentRegistryService] Invalid stored registry:", validation.error);
        this.registry = {};
        return;
      }

      const sanitized: UserAgentRegistry = {};
      for (const [id, config] of Object.entries(validation.data)) {
        if (isBuiltInAgent(id)) {
          console.warn(`[UserAgentRegistryService] Skipping built-in agent ID in user registry: ${id}`);
          continue;
        }
        sanitized[id] = config;
      }

      this.registry = sanitized;
    } catch (error) {
      console.error("[UserAgentRegistryService] Failed to load registry:", error);
      this.registry = {};
    }
  }

  private saveRegistry(): { success: boolean; error?: string } {
    try {
      store.set("userAgentRegistry", this.registry);
      this.syncToSharedRegistry();
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("[UserAgentRegistryService] Failed to save registry:", error);
      return { success: false, error: `Failed to save: ${message}` };
    }
  }

  private syncToSharedRegistry(): void {
    setUserRegistry(this.registry);
  }

  getRegistry(): UserAgentRegistry {
    return { ...this.registry };
  }

  getAgent(id: string): UserAgentConfig | undefined {
    return this.registry[id];
  }

  addAgent(config: UserAgentConfig): { success: boolean; error?: string } {
    const validation = UserAgentConfigSchema.safeParse(config);
    if (!validation.success) {
      return {
        success: false,
        error: `Invalid agent config: ${validation.error.message}`,
      };
    }

    if (!/^[a-zA-Z0-9._-]+$/.test(config.command)) {
      return {
        success: false,
        error: `Command "${config.command}" contains invalid characters. Only alphanumeric, dots, dashes, and underscores are allowed.`,
      };
    }

    if (isBuiltInAgent(config.id)) {
      return {
        success: false,
        error: `Agent ID "${config.id}" is reserved for built-in agents. Please choose a different ID.`,
      };
    }

    this.registry[config.id] = config;
    return this.saveRegistry();
  }

  updateAgent(id: string, config: UserAgentConfig): { success: boolean; error?: string } {
    if (!this.registry[id]) {
      return {
        success: false,
        error: `Agent "${id}" not found in user registry`,
      };
    }

    if (config.id !== id) {
      return {
        success: false,
        error: "Cannot change agent ID",
      };
    }

    const validation = UserAgentConfigSchema.safeParse(config);
    if (!validation.success) {
      return {
        success: false,
        error: `Invalid agent config: ${validation.error.message}`,
      };
    }

    if (!/^[a-zA-Z0-9._-]+$/.test(config.command)) {
      return {
        success: false,
        error: `Command "${config.command}" contains invalid characters. Only alphanumeric, dots, dashes, and underscores are allowed.`,
      };
    }

    this.registry[id] = config;
    return this.saveRegistry();
  }

  removeAgent(id: string): { success: boolean; error?: string } {
    if (isBuiltInAgent(id)) {
      return {
        success: false,
        error: `Cannot remove built-in agent "${id}"`,
      };
    }

    if (!this.registry[id]) {
      return {
        success: false,
        error: `Agent "${id}" not found in user registry`,
      };
    }

    delete this.registry[id];
    return this.saveRegistry();
  }
}
