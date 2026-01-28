import * as electron from "electron";
import { store } from "../store.js";

class ProjectEnvSecureStorage {
  private _hasWarnedUnavailable = false;

  private get isAvailable(): boolean {
    if (!electron.safeStorage) {
      return false;
    }
    const available = electron.safeStorage.isEncryptionAvailable();
    if (!available && !this._hasWarnedUnavailable) {
      console.warn(
        "[ProjectEnvSecureStorage] OS encryption not available. Cannot store sensitive env vars."
      );
      this._hasWarnedUnavailable = true;
    }
    return available;
  }

  private isHexEncoded(value: string): boolean {
    return /^[0-9a-f]+$/i.test(value) && value.length % 2 === 0;
  }

  private makeKey(projectId: string, envKey: string): string {
    return `${projectId}:${envKey}`;
  }

  public set(projectId: string, envKey: string, value: string | undefined): void {
    const key = this.makeKey(projectId, envKey);
    const projectEnv = store.get("projectEnv") || {};

    if (value === undefined) {
      delete projectEnv[key];
      store.set("projectEnv", projectEnv);
      return;
    }

    if (!this.isAvailable) {
      throw new Error(
        "Cannot store sensitive environment variable: encryption is not available on this system"
      );
    }

    try {
      const encrypted = electron.safeStorage.encryptString(value);
      projectEnv[key] = encrypted.toString("hex");
      store.set("projectEnv", projectEnv);
    } catch (error) {
      console.error(
        `[ProjectEnvSecureStorage] Failed to encrypt ${key}:`,
        error
      );
      throw new Error("Failed to encrypt environment variable");
    }
  }

  public get(projectId: string, envKey: string): string | undefined {
    const key = this.makeKey(projectId, envKey);
    const projectEnv = store.get("projectEnv") || {};
    const storedValue = projectEnv[key];

    if (!storedValue) return undefined;

    if (!this.isHexEncoded(storedValue)) {
      console.warn(
        `[ProjectEnvSecureStorage] Found non-hex value for ${key}, returning undefined`
      );
      return undefined;
    }

    if (!this.isAvailable) {
      console.warn(
        `[ProjectEnvSecureStorage] Encryption unavailable, cannot decrypt ${key}`
      );
      return undefined;
    }

    try {
      const buffer = Buffer.from(storedValue, "hex");
      return electron.safeStorage.decryptString(buffer);
    } catch (error) {
      console.error(
        `[ProjectEnvSecureStorage] Failed to decrypt ${key}:`,
        error
      );
      // Don't delete immediately - the error might be transient (locked keychain)
      // Return undefined so the value is not exposed
      return undefined;
    }
  }

  public delete(projectId: string, envKey: string): void {
    const key = this.makeKey(projectId, envKey);
    const projectEnv = store.get("projectEnv") || {};
    delete projectEnv[key];
    store.set("projectEnv", projectEnv);
  }

  public listKeys(projectId: string): string[] {
    const projectEnv = store.get("projectEnv") || {};
    const prefix = `${projectId}:`;
    return Object.keys(projectEnv)
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.substring(prefix.length));
  }

  public deleteAllForProject(projectId: string): void {
    const projectEnv = store.get("projectEnv") || {};
    const prefix = `${projectId}:`;
    const newProjectEnv: Record<string, string> = {};

    for (const [key, value] of Object.entries(projectEnv)) {
      if (!key.startsWith(prefix)) {
        newProjectEnv[key] = value;
      }
    }

    store.set("projectEnv", newProjectEnv);
  }

  public checkAvailability(): boolean {
    return this.isAvailable;
  }
}

export const projectEnvSecureStorage = new ProjectEnvSecureStorage();
