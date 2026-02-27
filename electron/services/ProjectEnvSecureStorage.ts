import { store } from "../store.js";

/**
 * Per-project environment variable storage backed by electron-store.
 * Values are stored as plain text — the same security model as .env files.
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

  public set(projectId: string, envKey: string, value: string | undefined): void {
    const key = this.makeKey(projectId, envKey);
    const projectEnv = this.getProjectEnvMap();

    if (value === undefined) {
      delete projectEnv[key];
      store.set("projectEnv", projectEnv);
      return;
    }

    projectEnv[key] = value;
    store.set("projectEnv", projectEnv);
  }

  public get(projectId: string, envKey: string): string | undefined {
    const key = this.makeKey(projectId, envKey);
    const projectEnv = this.getProjectEnvMap();
    return projectEnv[key] || undefined;
  }

  public delete(projectId: string, envKey: string): void {
    const key = this.makeKey(projectId, envKey);
    const projectEnv = this.getProjectEnvMap();
    delete projectEnv[key];
    store.set("projectEnv", projectEnv);
  }

  public listKeys(projectId: string): string[] {
    const projectEnv = this.getProjectEnvMap();
    const prefix = `${projectId}:`;
    return Object.keys(projectEnv)
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.substring(prefix.length));
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

  public checkAvailability(): boolean {
    return true;
  }
}

export const projectEnvSecureStorage = new ProjectEnvSecureStorage();
