// eager-import-allow: reads the user-agent registry via store.get synchronously during init
import { store } from "../store.js";
import type { UserAgentRegistry, UserAgentConfig } from "../../shared/types/index.js";
import { UserAgentConfigSchema, SAFE_AGENT_ID_PATTERN } from "../../shared/types/index.js";
import { setUserRegistry, isBuiltInAgent } from "../../shared/config/agentRegistry.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";

const RESERVED_REGISTRY_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function hasOwnKey(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function cloneConfig(config: UserAgentConfig): UserAgentConfig {
  return structuredClone(config);
}

/**
 * Read + sanitize the persisted user-agent registry from the store. Shared by
 * the service's own load path and the batched `app:boot` hydrate payload so
 * both surfaces apply identical validation to the raw store bytes.
 */
export function loadSanitizedUserAgentRegistry(): UserAgentRegistry {
  try {
    const stored = store.get("userAgentRegistry", {});
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
      console.warn("[UserAgentRegistryService] Stored registry is not an object, resetting");
      return {};
    }

    const sanitized: UserAgentRegistry = {};
    for (const [id, config] of Object.entries(stored)) {
      if (RESERVED_REGISTRY_KEYS.has(id)) {
        console.warn(`[UserAgentRegistryService] Skipping reserved registry key: ${id}`);
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

      const entryValidation = UserAgentConfigSchema.safeParse(config);
      if (!entryValidation.success) {
        console.warn(
          `[UserAgentRegistryService] Skipping invalid registry entry "${id}":`,
          entryValidation.error.message
        );
        continue;
      }

      const validated = entryValidation.data;
      if (validated.id !== id) {
        console.warn(
          `[UserAgentRegistryService] Skipping registry entry with mismatched id: key=${id}, config.id=${validated.id}`
        );
        continue;
      }

      sanitized[id] = cloneConfig(validated);
    }

    return sanitized;
  } catch (error) {
    console.error("[UserAgentRegistryService] Failed to load registry:", error);
    return {};
  }
}

export class UserAgentRegistryService {
  private registry: UserAgentRegistry = {};

  constructor() {
    this.loadRegistry();
    this.syncToSharedRegistry();
  }

  private loadRegistry(): void {
    this.registry = loadSanitizedUserAgentRegistry();
  }

  private saveRegistry(nextRegistry: UserAgentRegistry): { success: boolean; error?: string } {
    try {
      store.set("userAgentRegistry", nextRegistry);
      const sharedClone: UserAgentRegistry = {};
      for (const [id, config] of Object.entries(nextRegistry)) {
        sharedClone[id] = cloneConfig(config);
      }
      setUserRegistry(sharedClone);
      return { success: true };
    } catch (error) {
      const message = formatErrorMessage(error, "Failed to save user agent registry");
      console.error("[UserAgentRegistryService] Failed to save registry:", error);
      return { success: false, error: `Failed to save: ${message}` };
    }
  }

  private syncToSharedRegistry(): void {
    setUserRegistry(this.getRegistry());
  }

  reload(): void {
    this.loadRegistry();
    this.syncToSharedRegistry();
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

    if (!SAFE_AGENT_ID_PATTERN.test(config.command)) {
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

    const nextRegistry = { ...this.registry, [config.id]: cloneConfig(config) };
    const result = this.saveRegistry(nextRegistry);
    if (result.success) {
      this.registry = nextRegistry;
    }
    return result;
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

    if (!SAFE_AGENT_ID_PATTERN.test(config.command)) {
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

    const nextRegistry = { ...this.registry, [id]: cloneConfig(config) };
    const result = this.saveRegistry(nextRegistry);
    if (result.success) {
      this.registry = nextRegistry;
    }
    return result;
  }

  removeAgent(id: string): { success: boolean; error?: string } {
    if (!hasOwnKey(this.registry, id)) {
      return {
        success: false,
        error: `Agent "${id}" not found in user registry`,
      };
    }

    if (isBuiltInAgent(id)) {
      return {
        success: false,
        error: `Cannot remove built-in agent "${id}"`,
      };
    }

    const nextRegistry = { ...this.registry };
    delete nextRegistry[id];
    const result = this.saveRegistry(nextRegistry);
    if (result.success) {
      this.registry = nextRegistry;
    }
    return result;
  }
}
