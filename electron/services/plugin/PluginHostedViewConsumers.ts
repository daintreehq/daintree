import type { UnsavedPanelsDocumentWatcher } from "./pluginUnsavedPanels.js";

/** Calls `forget` once the reporting document is gone; returns the teardown. */
export type ViewConsumerDocumentWatcher = UnsavedPanelsDocumentWatcher;

/** Bounds on a renderer-supplied report, which main holds in memory. */
const MAX_REPORTED_MOUNTS = 1_000;
const MAX_VIEW_ID_LENGTH = 512;

interface SourceReport {
  viewIds: string[];
  unwatch: () => void;
}

function parseReport(viewIds: unknown): string[] {
  if (!Array.isArray(viewIds)) return [];
  const parsed: string[] = [];
  for (const id of viewIds.slice(0, MAX_REPORTED_MOUNTS)) {
    if (typeof id === "string" && id.length > 0 && id.length <= MAX_VIEW_ID_LENGTH) parsed.push(id);
  }
  return parsed;
}

/**
 * The plugin views each renderer has mounted outside the panel grid (#17068):
 * settings sections, sidebar and toolbar views, Canopy views, project surfaces
 * and file editors. Grid panels are the lifecycle broker's; these have no panel
 * record, so nothing else tells main they are on screen.
 *
 * Each entry is a view id the renderer mounted — a hosted view id or the panel
 * kind a surface draws — once per mount. Ownership is resolved by main from its
 * own registries at read time, never from the report. A report replaces the
 * renderer's last one wholesale, so a lost or repeated report can't leave a
 * count drifting, and a document that goes away takes its report with it.
 */
export class PluginHostedViewConsumers {
  private readonly bySource = new Map<number, SourceReport>();

  /** `onChanged` hears the view ids whose mounts a report or a lost document moved. */
  constructor(private readonly onChanged: (viewIds: readonly string[]) => void) {}

  /** Replace what `sourceId` has mounted. An empty report forgets the source. */
  record(sourceId: number, watchDocument: ViewConsumerDocumentWatcher, viewIds: unknown): void {
    const parsed = parseReport(viewIds);
    const existing = this.bySource.get(sourceId);
    const moved = [...(existing?.viewIds ?? []), ...parsed];
    if (parsed.length === 0) {
      if (!existing) return;
      this.bySource.delete(sourceId);
      existing.unwatch();
    } else if (existing) {
      existing.viewIds = parsed;
    } else {
      const entry: SourceReport = { viewIds: parsed, unwatch: () => {} };
      this.bySource.set(sourceId, entry);
      entry.unwatch = watchDocument(() => {
        if (this.bySource.get(sourceId) !== entry) return;
        this.bySource.delete(sourceId);
        entry.unwatch();
        this.onChanged(entry.viewIds);
      });
    }
    this.onChanged(moved);
  }

  /** Mounts, across every renderer, of views `ownerOf` says belong to `pluginId`. */
  count(pluginId: string, ownerOf: (viewId: string) => string | undefined): number {
    let count = 0;
    for (const { viewIds } of this.bySource.values()) {
      for (const viewId of viewIds) {
        if (ownerOf(viewId) === pluginId) count++;
      }
    }
    return count;
  }

  dispose(): void {
    for (const entry of this.bySource.values()) entry.unwatch();
    this.bySource.clear();
  }
}
