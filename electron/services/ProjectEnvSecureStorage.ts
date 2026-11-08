// eager-import-allow: reads the secure-storage key map via store.get synchronously at module scope
import { store } from "../store.js";

/**
 * Per-project environment variable storage backed by electron-store.
 * Values are stored as plain text — the same security model as .env files.
 *
 * Every `store.set` rewrites all of config.json on Main's thread, so a
 * project's variables are read and written together, never a key at a time.
 */
class ProjectEnvSecureStorage {
  private makeKey(projectId: string, envKey: string): string {
    return `${projectId}:${envKey}`;
  }

  private getProjectEnvMap(): Record<string, string> {
    const raw = store.get("projectEnv");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return {};
    }

    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string") {
        normalized[key] = value;
      }
    }
    return normalized;
  }

  /**
   * The stored values of `envKeys`, from one read of the map. A key with no
   * stored value is absent. A Map, because the names come from settings.json
   * and a name like "constructor" would resolve to a member of a plain object.
   */
  public getForProject(projectId: string, envKeys: readonly string[]): Map<string, string> {
    const values = new Map<string, string>();
    if (envKeys.length === 0) return values;

    const projectEnv = this.getProjectEnvMap();
    for (const envKey of envKeys) {
      const value = projectEnv[this.makeKey(projectId, envKey)];
      if (value !== undefined) values.set(envKey, value);
    }
    return values;
  }

  /**
   * Stores `values` as the project's variables and removes its other keys,
   * except `retainedKeys`, whose stored values stay as they are. Writes the map
   * at most once, and not at all when nothing differs. Entries the read
   * normalised away don't count as a difference, since nothing ever reads them.
   */
  public replaceForProject(
    projectId: string,
    values: ReadonlyMap<string, string>,
    retainedKeys: ReadonlySet<string>
  ): void {
    const projectEnv = this.getProjectEnvMap();
    const prefix = `${projectId}:`;
    let changed = false;

    for (const [envKey, value] of values) {
      const key = this.makeKey(projectId, envKey);
      if (projectEnv[key] !== value) {
        projectEnv[key] = value;
        changed = true;
      }
    }

    for (const key of Object.keys(projectEnv)) {
      if (!key.startsWith(prefix)) continue;
      const envKey = key.substring(prefix.length);
      if (!values.has(envKey) && !retainedKeys.has(envKey)) {
        delete projectEnv[key];
        changed = true;
      }
    }

    if (changed) store.set("projectEnv", projectEnv);
  }

  public deleteAllForProject(projectId: string): void {
    const projectEnv = this.getProjectEnvMap();
    const prefix = `${projectId}:`;
    const newProjectEnv: Record<string, string> = {};

    for (const [key, value] of Object.entries(projectEnv)) {
      if (!key.startsWith(prefix)) {
        newProjectEnv[key] = value;
      }
    }

    store.set("projectEnv", newProjectEnv);
  }

  public migrateAllForProject(oldProjectId: string, newProjectId: string): void {
    const projectEnv = this.getProjectEnvMap();
    const oldPrefix = `${oldProjectId}:`;
    const newPrefix = `${newProjectId}:`;
    const updated: Record<string, string> = {};

    for (const [key, value] of Object.entries(projectEnv)) {
      if (key.startsWith(oldPrefix)) {
        updated[`${newPrefix}${key.slice(oldPrefix.length)}`] = value;
      } else {
        updated[key] = value;
      }
    }

    store.set("projectEnv", updated);
  }

  public checkAvailability(): boolean {
    return true;
  }
}

export const projectEnvSecureStorage = new ProjectEnvSecureStorage();
