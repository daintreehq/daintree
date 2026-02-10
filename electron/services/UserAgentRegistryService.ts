import { store } from "../store.js";
import type { UserAgentRegistry, UserAgentConfig } from "../../shared/types/index.js";
import { UserAgentConfigSchema, UserAgentRegistrySchema } from "../../shared/types/index.js";
import { setUserRegistry, isBuiltInAgent } from "../../shared/config/agentRegistry.js";

const RESERVED_REGISTRY_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SAFE_AGENT_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

function hasOwnKey(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function cloneConfig(config: UserAgentConfig): UserAgentConfig {
  return structuredClone(config);
}

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
        if (RESERVED_REGISTRY_KEYS.has(id)) {
          console.warn(`[UserAgentRegistryService] Skipping reserved registry key: ${id}`);
          continue;
        }
        if (config.id !== id) {
          console.warn(
            `[UserAgentRegistryService] Skipping registry entry with mismatched id: key=${id}, config.id=${config.id}`
          );
          continue;
        }
        if (!SAFE_AGENT_ID_PATTERN.test(id)) {
          console.warn(`[UserAgentRegistryService] Skipping registry entry with invalid id: ${id}`);
          continue;
        }
        if (isBuiltInAgent(id)) {
          console.warn(
            `[UserAgentRegistryService] Skipping built-in agent ID in user registry: ${id}`
          );
          continue;
        }
        sanitized[id] = cloneConfig(config);
      }

      this.registry = sanitized;
    } catch (error) {
      console.error("[UserAgentRegistryService] Failed to load registry:", error);
      this.registry = {};
    }
  }

  private saveRegistry(): { success: boolean; error?: string } {
    try {
      store.set("userAgentRegistry", this.getRegistry());
      this.syncToSharedRegistry();
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("[UserAgentRegistryService] Failed to save registry:", error);
      return { success: false, error: `Failed to save: ${message}` };
    }
  }

  private syncToSharedRegistry(): void {
    setUserRegistry(this.getRegistry());
  }

  getRegistry(): UserAgentRegistry {
    const cloned: UserAgentRegistry = {};
    for (const [id, config] of Object.entries(this.registry)) {
      cloned[id] = cloneConfig(config);
    }
    return cloned;
  }

  getAgent(id: string): UserAgentConfig | undefined {
    if (!hasOwnKey(this.registry, id)) {
      return undefined;
    }
    return cloneConfig(this.registry[id]);
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
    if (!SAFE_AGENT_ID_PATTERN.test(config.id)) {
      return {
        success: false,
        error: `Agent ID "${config.id}" contains invalid characters. Only alphanumeric, dots, dashes, and underscores are allowed.`,
      };
    }

    if (isBuiltInAgent(config.id)) {
      return {
        success: false,
        error: `Agent ID "${config.id}" is reserved for built-in agents. Please choose a different ID.`,
      };
    }

    this.registry[config.id] = cloneConfig(config);
    return this.saveRegistry();
  }

  updateAgent(id: string, config: UserAgentConfig): { success: boolean; error?: string } {
    if (!hasOwnKey(this.registry, id)) {
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
    if (!SAFE_AGENT_ID_PATTERN.test(config.id)) {
      return {
        success: false,
        error: `Agent ID "${config.id}" contains invalid characters. Only alphanumeric, dots, dashes, and underscores are allowed.`,
      };
    }

    this.registry[id] = cloneConfig(config);
    return this.saveRegistry();
  }

  removeAgent(id: string): { success: boolean; error?: string } {
    if (isBuiltInAgent(id)) {
      return {
        success: false,
        error: `Cannot remove built-in agent "${id}"`,
      };
    }

    if (!hasOwnKey(this.registry, id)) {
      return {
        success: false,
        error: `Agent "${id}" not found in user registry`,
      };
    }

    delete this.registry[id];
    return this.saveRegistry();
  }
}
