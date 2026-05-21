import type { ProjectSettings } from "../types/index.js";
import type { NotificationSettings } from "../../shared/types/ipc/api.js";
import type Store from "electron-store";
import type { StoreSchema } from "../store.js";
import fs from "fs/promises";
import { existsSync } from "fs";
import { resilientAtomicWriteFile, resilientRename } from "../utils/fs.js";
import { sanitizeSvg } from "../../shared/utils/svgSanitizer.js";
import { isSensitiveEnvKey } from "../../shared/utils/envVars.js";
import { projectEnvSecureStorage } from "./ProjectEnvSecureStorage.js";
import { getProjectStateDir, settingsFilePath, UTF8_BOM } from "./projectStorePaths.js";
import { decode, encodeEnvelope } from "./projectSettingsCodec.js";
import { Cache } from "../utils/cache.js";
import { CHANNELS } from "../ipc/channels.js";

export class ProjectSettingsManager {
  private notificationOverridesCache = new Map<string, Partial<NotificationSettings> | undefined>();
  private readonly settingsCache = new Cache<string, ProjectSettings>({
    maxSize: 20,
    defaultTTL: 30_000,
  });

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
      completedSoundFile: overrides.completedSoundFile ?? global.completedSoundFile,
      waitingSoundFile: overrides.waitingSoundFile ?? global.waitingSoundFile,
      escalationSoundFile: overrides.escalationSoundFile ?? global.escalationSoundFile,
      waitingEscalationEnabled:
        overrides.waitingEscalationEnabled ?? global.waitingEscalationEnabled,
      waitingEscalationDelayMs:
        overrides.waitingEscalationDelayMs ?? global.waitingEscalationDelayMs,
      workingPulseEnabled: overrides.workingPulseEnabled ?? global.workingPulseEnabled,
      workingPulseSoundFile: overrides.workingPulseSoundFile ?? global.workingPulseSoundFile,
      uiFeedbackSoundEnabled: global.uiFeedbackSoundEnabled,
      quietHoursEnabled: global.quietHoursEnabled,
      quietHoursStartMin: global.quietHoursStartMin,
      quietHoursEndMin: global.quietHoursEndMin,
      quietHoursWeekdays: global.quietHoursWeekdays,
    };
  }

  async getProjectSettings(projectId: string): Promise<ProjectSettings> {
    const cached = this.settingsCache.get(projectId);
    if (cached) return cached;

    const filePath = settingsFilePath(this.projectsConfigDir, projectId);
    if (!filePath || !existsSync(filePath)) {
      this.notificationOverridesCache.delete(projectId);
      return { runCommands: [] };
    }

    let parsed: unknown;
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const stripped = content.startsWith(UTF8_BOM) ? content.slice(UTF8_BOM.length) : content;
      parsed = JSON.parse(stripped);
    } catch (error) {
      this.notificationOverridesCache.delete(projectId);
      if (error instanceof SyntaxError) {
        console.error(`[ProjectSettingsManager] Failed to parse settings for ${projectId}:`, error);
        const quarantinedPath = await this.quarantine(filePath, "corrupted");
        void this.broadcastCorruption(quarantinedPath);
      } else {
        const code =
          error && typeof error === "object" && "code" in error
            ? (error as NodeJS.ErrnoException).code
            : undefined;
        if (code !== "ENOENT") {
          console.error(
            `[ProjectSettingsManager] Failed to load settings for ${projectId}:`,
            error
          );
        }
      }
      return { runCommands: [] };
    }

    const decoded = decode(parsed);
    if (!decoded.ok) {
      this.notificationOverridesCache.delete(projectId);
      console.warn(
        `[ProjectSettingsManager] settings.json for ${projectId} was written by a newer app (v${decoded.onDiskVersion} > current); quarantining`
      );
      const quarantinedPath = await this.quarantine(filePath, `future-v${decoded.onDiskVersion}`);
      void this.broadcastCorruption(quarantinedPath, "future-version");
      return { runCommands: [] };
    }

    let settings = decoded.settings;

    // Side-effect post-processing: SVG sanitization happens after pure decode so
    // the codec stays free of I/O and can be exercised from unit tests.
    if (typeof settings.projectIconSvg === "string" && settings.projectIconSvg.trim()) {
      const sanitizeResult = sanitizeSvg(settings.projectIconSvg);
      if (sanitizeResult.ok) {
        if (sanitizeResult.modified) {
          console.warn(
            `[ProjectSettingsManager] Sanitized potentially unsafe SVG content for project ${projectId}`
          );
        }
        settings = { ...settings, projectIconSvg: sanitizeResult.svg };
      } else {
        console.warn(
          `[ProjectSettingsManager] Invalid SVG in settings for project ${projectId}: ${sanitizeResult.error}`
        );
        settings = { ...settings, projectIconSvg: undefined };
      }
    }

    // Secure env resolution: merge plaintext env vars with the decrypted values
    // from secure storage. Sensitive keys present in plaintext are flagged for
    // migration so the renderer can surface a "move to secure storage" prompt.
    const secureEnvVarKeys = settings.secureEnvironmentVariables ?? [];
    const resolvedEnvVars: Record<string, string> = {};
    const insecureKeys: string[] = [];
    const unresolvedKeys: string[] = [];

    if (settings.environmentVariables) {
      for (const [key, value] of Object.entries(settings.environmentVariables)) {
        if (typeof key === "string" && typeof value === "string") {
          resolvedEnvVars[key] = value;
          if (isSensitiveEnvKey(key)) insecureKeys.push(key);
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

    settings = {
      ...settings,
      environmentVariables: resolvedEnvVars,
      secureEnvironmentVariables: secureEnvVarKeys,
      insecureEnvironmentVariables: insecureKeys.length > 0 ? insecureKeys : undefined,
      unresolvedSecureEnvironmentVariables: unresolvedKeys.length > 0 ? unresolvedKeys : undefined,
    };

    this.notificationOverridesCache.set(projectId, settings.notificationOverrides);
    this.settingsCache.set(projectId, settings);

    return settings;
  }

  /**
   * Best-effort quarantine. Returns the destination path on success and
   * `null` if the rename failed — quarantine is a safety net, not a hard
   * dependency for surfacing corruption to the renderer. Suffix collisions
   * (e.g. when an earlier future-version quarantine already exists) get a
   * timestamp tail so we never clobber a previous artifact.
   */
  private async quarantine(filePath: string, suffix: string): Promise<string | null> {
    try {
      const base =
        suffix === "corrupted" ? `${filePath}.corrupted.${Date.now()}` : `${filePath}.${suffix}`;
      const quarantinePath = existsSync(base) ? `${base}.${Date.now()}` : base;
      await resilientRename(filePath, quarantinePath);
      console.warn(`[ProjectSettingsManager] Quarantined settings file to ${quarantinePath}`);
      return quarantinePath;
    } catch {
      return null;
    }
  }

  private async broadcastCorruption(
    quarantinedPath: string | null,
    kind?: "future-version"
  ): Promise<void> {
    try {
      // Lazy import keeps the workspace-host bundle clean of `BrowserWindow`.
      // `ipc/utils` transitively pulls in `webContentsRegistry`, which calls
      // `BrowserWindow.getAllWindows()` — a main-process-only API. The
      // workspace-host UtilityProcess hits this path via `forgeProviderResolver
      // → ProjectStore → ProjectSettingsManager`; from there, settings
      // corruption silently no-ops (the failed import is caught below), and
      // the main process surfaces the toast on its next read.
      const { broadcastToRenderer } = await import("../ipc/utils.js");
      const message = quarantinedPath
        ? `Project settings couldn't be read and have been preserved at ${quarantinedPath}. Defaults are in effect until you reload the project.`
        : "Project settings couldn't be read. Defaults are in effect until you reload the project.";
      broadcastToRenderer(CHANNELS.NOTIFICATION_SHOW_TOAST, {
        type: "error",
        title: kind === "future-version" ? "Settings file too new" : "Project settings corrupted",
        message:
          kind === "future-version"
            ? `${quarantinedPath ? `Settings file written by a newer version of Daintree was quarantined to ${quarantinedPath}. ` : ""}Defaults are in effect until you reload with a newer build.`
            : message,
      });
    } catch (err) {
      console.warn("[ProjectSettingsManager] Failed to broadcast corruption toast:", err);
    }
  }

  async saveProjectSettings(projectId: string, settings: ProjectSettings): Promise<void> {
    this.settingsCache.invalidate(projectId);

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

    // Build the runtime-canonical settings object, then run it through the
    // codec's encoder which strips transient fields and prepends the version
    // envelope. The save-path's SVG sanitization + command-overrides
    // filtering happen here (boundary checks before persistence); shape and
    // version concerns are owned by the codec.
    let runtimeSettings: ProjectSettings = {
      ...settings,
      environmentVariables: nonSensitiveEnvVars,
      secureEnvironmentVariables: secureEnvVarKeys.length > 0 ? secureEnvVarKeys : undefined,
      insecureEnvironmentVariables: undefined,
      unresolvedSecureEnvironmentVariables: undefined,
      devServerDismissed:
        typeof settings.devServerDismissed === "boolean" ? settings.devServerDismissed : undefined,
      devServerAutoDetected:
        typeof settings.devServerAutoDetected === "boolean"
          ? settings.devServerAutoDetected
          : undefined,
      cloudSyncWarningDismissed:
        typeof settings.cloudSyncWarningDismissed === "boolean"
          ? settings.cloudSyncWarningDismissed
          : undefined,
      devServerLoadTimeout:
        typeof settings.devServerLoadTimeout === "number" &&
        Number.isFinite(settings.devServerLoadTimeout) &&
        settings.devServerLoadTimeout >= 1 &&
        settings.devServerLoadTimeout <= 120
          ? settings.devServerLoadTimeout
          : undefined,
      turbopackEnabled:
        typeof settings.turbopackEnabled === "boolean" ? settings.turbopackEnabled : undefined,
    };

    this.notificationOverridesCache.set(projectId, runtimeSettings.notificationOverrides);

    if (settings.projectIconSvg) {
      const sanitizeResult = sanitizeSvg(settings.projectIconSvg);
      if (sanitizeResult.ok) {
        runtimeSettings = { ...runtimeSettings, projectIconSvg: sanitizeResult.svg };
        if (sanitizeResult.modified) {
          console.warn(
            `[ProjectSettingsManager] Sanitized potentially unsafe SVG content before saving for project ${projectId}`
          );
        }
      } else {
        console.warn(
          `[ProjectSettingsManager] Rejecting invalid SVG for project ${projectId}: ${sanitizeResult.error}`
        );
        runtimeSettings = { ...runtimeSettings, projectIconSvg: undefined };
      }
    }

    if (settings.commandOverrides !== undefined) {
      if (!Array.isArray(settings.commandOverrides)) {
        console.warn(
          `[ProjectSettingsManager] Coercing non-array commandOverrides to undefined in project ${projectId}`
        );
        runtimeSettings = { ...runtimeSettings, commandOverrides: undefined };
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
        runtimeSettings = {
          ...runtimeSettings,
          commandOverrides: validOverrides.length > 0 ? validOverrides : undefined,
        };
      }
    }

    const envelope = encodeEnvelope(runtimeSettings);
    const jsonString = JSON.stringify(envelope, null, 2);

    const attemptSave = async (ensureDir: boolean): Promise<void> => {
      if (ensureDir) {
        await fs.mkdir(stateDir, { recursive: true });
      }
      await resilientAtomicWriteFile(filePath, jsonString, "utf-8", { mode: 0o600 });
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

    // Invalidate after durable write succeeds. Dynamic import avoids
    // expanding the static module graph for tests that mock ProjectStore.
    const { commandService } = await import("./CommandService.js");
    commandService.invalidateOverridesCache(projectId);
  }

  async getProjectNotificationOverrides(
    projectIds: string[]
  ): Promise<Record<string, Partial<NotificationSettings>>> {
    const unique = [...new Set(projectIds)];
    const results = await Promise.all(
      unique.map(async (id) => {
        const settings = await this.getProjectSettings(id);
        return { id, overrides: settings.notificationOverrides };
      })
    );
    const record: Record<string, Partial<NotificationSettings>> = {};
    for (const { id, overrides } of results) {
      if (overrides) {
        record[id] = overrides;
      }
    }
    return record;
  }

  deleteAllEnvForProject(projectId: string): void {
    this.settingsCache.invalidate(projectId);
    projectEnvSecureStorage.deleteAllForProject(projectId);
  }

  migrateEnvForProject(oldId: string, newId: string): void {
    this.settingsCache.invalidate(oldId);
    projectEnvSecureStorage.migrateAllForProject(oldId, newId);
  }
}
