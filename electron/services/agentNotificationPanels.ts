import type { PanelSnapshot, ProjectState } from "../../shared/types/project.js";

/** What an agent alert needs to know about the panel it is about. */
export type PanelRecord = Pick<PanelSnapshot, "location" | "worktreeId" | "title" | "titleMode">;

type SavedPanels = Pick<ProjectState, "terminals"> | null;

/**
 * Where each panel is, as its project last saved it (#15636).
 *
 * Live renderers write their panels per project (`project:set-terminals`); the
 * global `appState.terminals` is a legacy snapshot nothing updates during a
 * session. Every save lands here synchronously, so an alert deciding on a
 * panel's dock, worktree or title never waits on disk. A workspace no save has
 * reached since this process started is read once, the first time one of its
 * agents is seen.
 *
 * As fresh as the renderer's debounced layout save, never fresher.
 */
export class PanelRecordIndex {
  private records = new Map<string, { workspaceId: string; panel: PanelRecord }>();
  private idsByWorkspace = new Map<string, Set<string>>();
  /** Bumped by every save, so a read that started before one can't land on top of it. */
  private generations = new Map<string, number>();
  private loading = new Set<string>();
  /** Bumped by `clear`, so a read still in flight can't refill a disposed index. */
  private epoch = 0;

  get(panelId: string | undefined): PanelRecord | undefined {
    return panelId === undefined ? undefined : this.records.get(panelId)?.panel;
  }

  /** The workspace whose save last listed the panel. */
  workspaceOf(panelId: string | undefined): string | undefined {
    return panelId === undefined ? undefined : this.records.get(panelId)?.workspaceId;
  }

  noteSaved(workspaceId: string, state: SavedPanels): void {
    this.generations.set(workspaceId, (this.generations.get(workspaceId) ?? 0) + 1);
    this.replace(workspaceId, state);
  }

  /**
   * Read a workspace no save has reached yet. A failed read, or one that found
   * nothing, is tried again on the next sighting: the store answers `null` for
   * a file it could not read as well as for one that isn't there.
   */
  load(workspaceId: string, read: (workspaceId: string) => Promise<SavedPanels>): void {
    if (this.idsByWorkspace.has(workspaceId) || this.loading.has(workspaceId)) return;
    const generation = this.generations.get(workspaceId) ?? 0;
    const epoch = this.epoch;
    this.loading.add(workspaceId);
    void Promise.resolve()
      .then(() => read(workspaceId))
      .then(
        (state) => {
          if (epoch !== this.epoch) return;
          this.loading.delete(workspaceId);
          if (state === null) return;
          if ((this.generations.get(workspaceId) ?? 0) !== generation) return;
          this.replace(workspaceId, state);
        },
        () => {
          if (epoch === this.epoch) this.loading.delete(workspaceId);
        }
      );
  }

  clear(): void {
    this.epoch++;
    this.records.clear();
    this.idsByWorkspace.clear();
    this.generations.clear();
    this.loading.clear();
  }

  private replace(workspaceId: string, state: SavedPanels): void {
    const next = new Set<string>();
    for (const panel of state?.terminals ?? []) {
      if (!panel || typeof panel.id !== "string") continue;
      next.add(panel.id);
      this.records.set(panel.id, {
        workspaceId,
        panel: {
          location: panel.location,
          worktreeId: panel.worktreeId,
          title: panel.title,
          titleMode: panel.titleMode,
        },
      });
    }
    for (const id of this.idsByWorkspace.get(workspaceId) ?? []) {
      // A panel another workspace has saved since belongs to that one now.
      if (!next.has(id) && this.records.get(id)?.workspaceId === workspaceId) {
        this.records.delete(id);
      }
    }
    this.idsByWorkspace.set(workspaceId, next);
  }
}
