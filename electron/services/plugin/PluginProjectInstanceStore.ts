import { store } from "../../store.js";

/**
 * Persists which projects an installed `instanceMode: "project"` package is
 * enabled in. Pure persistence, like {@link PluginInstalledRecordsStore}: the
 * runtime reads it on project open and never infers an enablement from focus.
 *
 * Read and written as whole records under one top-level key, never through
 * dotted electron-store paths, because manifest ids contain dots.
 */
export class PluginProjectInstanceStore {
  private read(): Record<string, string[]> {
    try {
      const raw = store.get("pluginProjectInstances") as unknown;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
      const out: Record<string, string[]> = {};
      for (const [projectId, ids] of Object.entries(raw as Record<string, unknown>)) {
        if (!Array.isArray(ids)) continue;
        const clean = ids.filter((id): id is string => typeof id === "string" && id.length > 0);
        if (clean.length > 0) out[projectId] = clean;
      }
      return out;
    } catch {
      return {};
    }
  }

  private write(next: Record<string, string[]>): void {
    // Propagates: enabling must reach disk before anything executes.
    store.set("pluginProjectInstances", next);
  }

  /** Manifest ids enabled in one project. */
  listForProject(projectId: string): string[] {
    return [...(this.read()[projectId] ?? [])];
  }

  /** Project ids a package is enabled in. */
  listForPackage(manifestId: string): string[] {
    return Object.entries(this.read())
      .filter(([, ids]) => ids.includes(manifestId))
      .map(([projectId]) => projectId);
  }

  isEnabled(projectId: string, manifestId: string): boolean {
    return (this.read()[projectId] ?? []).includes(manifestId);
  }

  setEnabled(projectId: string, manifestId: string, enabled: boolean): void {
    if (!projectId || !manifestId) {
      throw new Error("setEnabled: projectId and manifestId must be non-empty strings");
    }
    const all = this.read();
    const current = all[projectId] ?? [];
    const next = enabled
      ? Array.from(new Set([...current, manifestId]))
      : current.filter((id) => id !== manifestId);
    if (next.length === 0) delete all[projectId];
    else all[projectId] = next;
    this.write(all);
  }

  /** Drop every enablement of a package, e.g. on uninstall. Returns the projects it was in. */
  removePackage(manifestId: string): string[] {
    const all = this.read();
    const affected: string[] = [];
    for (const [projectId, ids] of Object.entries(all)) {
      if (!ids.includes(manifestId)) continue;
      affected.push(projectId);
      const next = ids.filter((id) => id !== manifestId);
      if (next.length === 0) delete all[projectId];
      else all[projectId] = next;
    }
    if (affected.length > 0) this.write(all);
    return affected;
  }

  /** Drop every enablement in a project, e.g. when the project is removed. */
  removeProject(projectId: string): void {
    const all = this.read();
    if (!(projectId in all)) return;
    delete all[projectId];
    this.write(all);
  }
}
