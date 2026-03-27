import type { ProjectSettings } from "../types/index.js";
import type { NotificationSettings } from "../../shared/types/ipc/api.js";
import type { EditorConfig } from "../../shared/types/editor.js";
import type Store from "electron-store";
import type { StoreSchema } from "../store.js";
import fs from "fs/promises";
import { existsSync } from "fs";
import { resilientAtomicWriteFile, resilientRename } from "../utils/fs.js";
import { sanitizeSvg } from "../../shared/utils/svgSanitizer.js";
import { isSensitiveEnvKey } from "../../shared/utils/envVars.js";
import { projectEnvSecureStorage } from "./ProjectEnvSecureStorage.js";
import { getProjectStateDir, settingsFilePath } from "./projectStorePaths.js";
import { parseTerminalSettings, parseNotificationOverrides } from "./projectSettingsParsers.js";

export class ProjectSettingsManager {
  private notificationOverridesCache = new Map<string, Partial<NotificationSettings> | undefined>();

  constructor(
    private projectsConfigDir: string,
    private store: Store<StoreSchema>
  ) {}

  getEffectiveNotificationSettings(currentProjectId: string | null): NotificationSettings {
    const global = this.store.get("notificationSettings");
    if (!currentProjectId) return global;

    const overrides = this.notificationOverridesCache.get(currentProjectId);
    if (!overrides) return global;

    return {
      enabled: global.enabled,
      completedEnabled: overrides.completedEnabled ?? global.completedEnabled,
      waitingEnabled: overrides.waitingEnabled ?? global.waitingEnabled,
      soundEnabled: overrides.soundEnabled ?? global.soundEnabled,
      soundFile: overrides.soundFile ?? global.soundFile,
      waitingEscalationEnabled:
        overrides.waitingEscalationEnabled ?? global.waitingEscalationEnabled,
      waitingEscalationDelayMs:
        overrides.waitingEscalationDelayMs ?? global.waitingEscalationDelayMs,
    };
  }

  async getProjectSettings(projectId: string): Promise<ProjectSettings> {
    const filePath = settingsFilePath(this.projectsConfigDir, projectId);
    if (!filePath || !existsSync(filePath)) {
      this.notificationOverridesCache.delete(projectId);
      return { runCommands: [] };
    }

    try {
      const content = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(content);

      let sanitizedIconSvg: string | undefined;
      if (typeof parsed.projectIconSvg === "string" && parsed.projectIconSvg.trim()) {
        const sanitizeResult = sanitizeSvg(parsed.projectIconSvg);
        if (sanitizeResult.ok) {
          sanitizedIconSvg = sanitizeResult.svg;
          if (sanitizeResult.modified) {
            console.warn(
              `[ProjectSettingsManager] Sanitized potentially unsafe SVG content for project ${projectId}`
            );
          }
        } else {
          console.warn(
            `[ProjectSettingsManager] Invalid SVG in settings for project ${projectId}: ${sanitizeResult.error}`
          );
        }
      }

      let sanitizedCommandOverrides: typeof parsed.commandOverrides = undefined;
      if (Array.isArray(parsed.commandOverrides)) {
        sanitizedCommandOverrides = parsed.commandOverrides
          .filter((override: unknown) => {
            if (!override || typeof override !== "object") return false;
            const o = override as Record<string, unknown>;
            if (typeof o.commandId !== "string") return false;
            if (
              o.defaults !== undefined &&
              (o.defaults === null || typeof o.defaults !== "object" || Array.isArray(o.defaults))
            )
              return false;
            if (o.disabled !== undefined && typeof o.disabled !== "boolean") return false;
            if (o.prompt !== undefined && (typeof o.prompt !== "string" || o.prompt.trim() === ""))
              return false;
            return true;
          })
          .map((override: unknown) => {
            const o = override as Record<string, unknown>;
            return {
              commandId: o.commandId as string,
              defaults: o.defaults as Record<string, unknown> | undefined,
              disabled: o.disabled as boolean | undefined,
              prompt: o.prompt as string | undefined,
            };
          });
      }

      const secureEnvVarKeys = Array.isArray(parsed.secureEnvironmentVariables)
        ? parsed.secureEnvironmentVariables.filter((k: unknown) => typeof k === "string")
        : [];

      const resolvedEnvVars: Record<string, string> = {};
      const insecureKeys: string[] = [];
      const unresolvedKeys: string[] = [];

      if (parsed.environmentVariables && typeof parsed.environmentVariables === "object") {
        for (const [key, value] of Object.entries(parsed.environmentVariables)) {
          if (typeof key === "string" && typeof value === "string") {
            if (isSensitiveEnvKey(key)) {
              insecureKeys.push(key);
              resolvedEnvVars[key] = value;
            } else {
              resolvedEnvVars[key] = value;
            }
          }
        }
      }

      for (const key of secureEnvVarKeys) {
        const secureValue = projectEnvSecureStorage.get(projectId, key);
        if (secureValue !== undefined) {
          resolvedEnvVars[key] = secureValue;
        } else {
          unresolvedKeys.push(key);
        }
      }

      const settings: ProjectSettings = {
        runCommands: Array.isArray(parsed.runCommands) ? parsed.runCommands : [],
        environmentVariables: resolvedEnvVars,
        secureEnvironmentVariables: secureEnvVarKeys,
        insecureEnvironmentVariables: insecureKeys.length > 0 ? insecureKeys : undefined,
        unresolvedSecureEnvironmentVariables:
          unresolvedKeys.length > 0 ? unresolvedKeys : undefined,
        excludedPaths: parsed.excludedPaths,
        projectIconSvg: sanitizedIconSvg,
        defaultWorktreeRecipeId:
          typeof parsed.defaultWorktreeRecipeId === "string"
            ? parsed.defaultWorktreeRecipeId
            : undefined,
        devServerCommand:
          typeof parsed.devServerCommand === "string" ? parsed.devServerCommand : undefined,
        devServerDismissed:
          typeof parsed.devServerDismissed === "boolean" ? parsed.devServerDismissed : undefined,
        devServerAutoDetected:
          typeof parsed.devServerAutoDetected === "boolean"
            ? parsed.devServerAutoDetected
            : undefined,
        devServerLoadTimeout:
          typeof parsed.devServerLoadTimeout === "number" &&
          Number.isFinite(parsed.devServerLoadTimeout) &&
          parsed.devServerLoadTimeout >= 1 &&
          parsed.devServerLoadTimeout <= 120
            ? parsed.devServerLoadTimeout
            : undefined,
        copyTreeSettings:
          parsed.copyTreeSettings && typeof parsed.copyTreeSettings === "object"
            ? parsed.copyTreeSettings
            : undefined,
        commandOverrides:
          sanitizedCommandOverrides && sanitizedCommandOverrides.length > 0
            ? sanitizedCommandOverrides
            : undefined,
        preferredEditor:
          parsed.preferredEditor &&
          typeof parsed.preferredEditor === "object" &&
          typeof (parsed.preferredEditor as Record<string, unknown>).id === "string"
            ? (parsed.preferredEditor as EditorConfig)
            : undefined,
        branchPrefixMode:
          parsed.branchPrefixMode === "none" ||
          parsed.branchPrefixMode === "username" ||
          parsed.branchPrefixMode === "custom"
            ? parsed.branchPrefixMode
            : undefined,
        branchPrefixCustom:
          typeof parsed.branchPrefixCustom === "string" ? parsed.branchPrefixCustom : undefined,
        worktreePathPattern:
          typeof parsed.worktreePathPattern === "string" && parsed.worktreePathPattern.trim()
            ? parsed.worktreePathPattern.trim()
            : undefined,
        terminalSettings: parseTerminalSettings(parsed.terminalSettings),
        notificationOverrides: parseNotificationOverrides(parsed.notificationOverrides),
      };

      this.notificationOverridesCache.set(projectId, settings.notificationOverrides);

      return settings;
    } catch (error) {
      console.error(`[ProjectSettingsManager] Failed to load settings for ${projectId}:`, error);
      this.notificationOverridesCache.delete(projectId);
      try {
        const quarantinePath = `${filePath}.corrupted`;
        await resilientRename(filePath, quarantinePath);
        console.warn(`[ProjectSettingsManager] Corrupted settings file moved to ${quarantinePath}`);
      } catch {
        // Ignore
      }
      return { runCommands: [] };
    }
  }

  async saveProjectSettings(projectId: string, settings: ProjectSettings): Promise<void> {
    const stateDir = getProjectStateDir(this.projectsConfigDir, projectId);
    if (!stateDir) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    const filePath = settingsFilePath(this.projectsConfigDir, projectId);
    if (!filePath) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    const nonSensitiveEnvVars: Record<string, string> = {};
    const secureEnvVarKeys: string[] = [];
    const existingSecureKeys = projectEnvSecureStorage.listKeys(projectId);

    if (settings.environmentVariables) {
      for (const [key, value] of Object.entries(settings.environmentVariables)) {
        if (isSensitiveEnvKey(key)) {
          try {
            projectEnvSecureStorage.set(projectId, key, value);
            secureEnvVarKeys.push(key);
          } catch (error) {
            console.error(
              `[ProjectSettingsManager] Failed to store secure env var ${key} for project ${projectId}:`,
              error
            );
            throw error;
          }
        } else {
          nonSensitiveEnvVars[key] = value;
        }
      }
    }

    const unresolvedKeys = settings.unresolvedSecureEnvironmentVariables || [];
    for (const unresolvedKey of unresolvedKeys) {
      if (!secureEnvVarKeys.includes(unresolvedKey)) {
        secureEnvVarKeys.push(unresolvedKey);
      }
    }

    for (const existingKey of existingSecureKeys) {
      if (!secureEnvVarKeys.includes(existingKey)) {
        projectEnvSecureStorage.delete(projectId, existingKey);
      }
    }

    let sanitizedSettings = {
      ...settings,
      environmentVariables: nonSensitiveEnvVars,
      secureEnvironmentVariables: secureEnvVarKeys.length > 0 ? secureEnvVarKeys : undefined,
      insecureEnvironmentVariables: undefined,
      unresolvedSecureEnvironmentVariables: undefined,
      agentInstructions: undefined,
      devServerDismissed:
        typeof settings.devServerDismissed === "boolean" ? settings.devServerDismissed : undefined,
      devServerAutoDetected:
        typeof settings.devServerAutoDetected === "boolean"
          ? settings.devServerAutoDetected
          : undefined,
      devServerLoadTimeout:
        typeof settings.devServerLoadTimeout === "number" &&
        Number.isFinite(settings.devServerLoadTimeout) &&
        settings.devServerLoadTimeout >= 1 &&
        settings.devServerLoadTimeout <= 120
          ? settings.devServerLoadTimeout
          : undefined,
      terminalSettings: parseTerminalSettings(settings.terminalSettings),
      notificationOverrides: parseNotificationOverrides(settings.notificationOverrides),
    };

    this.notificationOverridesCache.set(projectId, sanitizedSettings.notificationOverrides);

    if (settings.projectIconSvg) {
      const sanitizeResult = sanitizeSvg(settings.projectIconSvg);
      if (sanitizeResult.ok) {
        sanitizedSettings = { ...sanitizedSettings, projectIconSvg: sanitizeResult.svg };
        if (sanitizeResult.modified) {
          console.warn(
            `[ProjectSettingsManager] Sanitized potentially unsafe SVG content before saving for project ${projectId}`
          );
        }
      } else {
        console.warn(
          `[ProjectSettingsManager] Rejecting invalid SVG for project ${projectId}: ${sanitizeResult.error}`
        );
        sanitizedSettings = { ...sanitizedSettings, projectIconSvg: undefined };
      }
    }

    if (settings.commandOverrides !== undefined) {
      if (!Array.isArray(settings.commandOverrides)) {
        console.warn(
          `[ProjectSettingsManager] Coercing non-array commandOverrides to undefined in project ${projectId}`
        );
        sanitizedSettings = {
          ...sanitizedSettings,
          commandOverrides: undefined,
        };
      } else {
        const validOverrides = settings.commandOverrides.filter((override) => {
          if (!override || typeof override !== "object") return false;
          if (typeof override.commandId !== "string") return false;
          if (
            override.defaults !== undefined &&
            (override.defaults === null ||
              typeof override.defaults !== "object" ||
              Array.isArray(override.defaults))
          ) {
            console.warn(
              `[ProjectSettingsManager] Dropping invalid commandOverride for ${override.commandId} in project ${projectId}`
            );
            return false;
          }
          if (override.disabled !== undefined && typeof override.disabled !== "boolean")
            return false;
          if (
            override.prompt !== undefined &&
            (typeof override.prompt !== "string" || override.prompt.trim() === "")
          ) {
            console.warn(
              `[ProjectSettingsManager] Dropping invalid/empty prompt in commandOverride for ${override.commandId} in project ${projectId}`
            );
            return false;
          }
          return true;
        });
        sanitizedSettings = {
          ...sanitizedSettings,
          commandOverrides: validOverrides.length > 0 ? validOverrides : undefined,
        };
      }
    }

    const attemptSave = async (ensureDir: boolean): Promise<void> => {
      if (ensureDir) {
        await fs.mkdir(stateDir, { recursive: true });
      }
      await resilientAtomicWriteFile(filePath, JSON.stringify(sanitizedSettings, null, 2), "utf-8");
    };

    try {
      await attemptSave(false);
    } catch (error) {
      const isEnoent = error instanceof Error && "code" in error && error.code === "ENOENT";
      if (!isEnoent) {
        console.error(`[ProjectSettingsManager] Failed to save settings for ${projectId}:`, error);
        throw error;
      }

      try {
        await attemptSave(true);
      } catch (retryError) {
        console.error(
          `[ProjectSettingsManager] Failed to save settings for ${projectId}:`,
          retryError
        );
        throw retryError;
      }
    }
  }

  deleteAllEnvForProject(projectId: string): void {
    projectEnvSecureStorage.deleteAllForProject(projectId);
  }

  migrateEnvForProject(oldId: string, newId: string): void {
    projectEnvSecureStorage.migrateAllForProject(oldId, newId);
  }
}
