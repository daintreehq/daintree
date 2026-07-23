import type { TerminalInstance, PanelSnapshot, TabGroup } from "@/types";
import { projectClient } from "@/clients";
import { debounce } from "@/utils/debounce";
import { isRendererPerfCaptureEnabled, markRendererPerformance } from "@/utils/performance";
import { getPanelKindConfig } from "@shared/config/panelKindRegistry";
import { isSmokeTestTerminalId } from "@shared/utils/smokeTestTerminals";
import {
  computeIdArrayDelta,
  deepEqualIgnoringUndefined,
  type IdArrayDelta,
} from "@shared/utils/layoutMerge";
import { logError } from "@/utils/logger";

type ProjectClientType = typeof projectClient;

export interface PanelPersistenceOptions {
  debounceMs?: number;
  filter?: (terminal: TerminalInstance) => boolean;
  transform?: (terminal: TerminalInstance) => PanelSnapshot;
  getProjectId?: () => string | null;
}

// Base fields that panelToSnapshot always writes. Used to isolate kind-specific
// fields when preserving a previous snapshot for an unregistered kind. The
// `satisfies` binding catches key deletions at compile time — removing a key
// from PanelSnapshot without removing it here is a type error. The ratchet
// does NOT catch new keys added to PanelSnapshot; a reviewer must ensure new
// base fields in the `base` object below are listed here.
const BASE_PANEL_FIELDS = [
  "id",
  "kind",
  "title",
  "titleMode",
  "worktreeId",
  "location",
  "extensionState",
  "pluginId",
  "createdAt",
  "lastActiveAt",
] as const satisfies readonly (keyof PanelSnapshot)[];
const BASE_PANEL_FIELD_SET: ReadonlySet<string> = new Set(BASE_PANEL_FIELDS);

export function panelToSnapshot(
  t: TerminalInstance,
  previousSnapshot?: PanelSnapshot
): PanelSnapshot {
  const base: PanelSnapshot = {
    id: t.id,
    kind: t.kind,
    title: t.title,
    ...(t.titleMode !== undefined && { titleMode: t.titleMode }),
    worktreeId: t.worktreeId,
    location: t.location === "trash" || t.location === "background" ? "grid" : t.location,
    ...(t.extensionState !== undefined && { extensionState: t.extensionState }),
    ...(t.pluginId !== undefined && { pluginId: t.pluginId }),
    ...(t.createdAt !== undefined && { createdAt: t.createdAt }),
    ...(t.lastActiveAt !== undefined && { lastActiveAt: t.lastActiveAt }),
  };

  const config = getPanelKindConfig(t.kind ?? "terminal");

  if (!config?.serialize) {
    // Unregistered kind (extension disabled mid-session, plugin not yet loaded,
    // or renamed in code). Preserve previously-persisted kind-specific fields
    // so a save cycle doesn't silently erase extension state.
    if (previousSnapshot && previousSnapshot.id === t.id && previousSnapshot.kind === t.kind) {
      const preserved: Record<string, unknown> = {};
      const prev = previousSnapshot as unknown as Record<string, unknown>;
      for (const key of Object.keys(prev)) {
        if (!BASE_PANEL_FIELD_SET.has(key) && prev[key] !== undefined) {
          preserved[key] = prev[key];
        }
      }
      // Spread order: live base wins over stale preserved fields if any overlap.
      return { ...preserved, ...base };
    }
    return base;
  }

  const fragment = config.serialize(t);
  return { ...base, ...fragment };
}

const DEFAULT_OPTIONS: Required<Omit<PanelPersistenceOptions, "getProjectId">> &
  Pick<PanelPersistenceOptions, "getProjectId"> = {
  debounceMs: 500,
  filter: (t) =>
    t.location !== "trash" &&
    t.location !== "background" &&
    // Dialog panels are ephemeral by location, independent of the flag below —
    // persisting one would resurrect it as a grid panel on restart, since
    // hydration coerces unknown locations to "grid".
    t.location !== "dialog" &&
    t.kind !== "assistant" &&
    t.excludeFromPersistence !== true &&
    !isSmokeTestTerminalId(t.id),
  transform: panelToSnapshot,
  getProjectId: undefined,
};

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return false;

  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    for (let i = 0; i < left.length; i += 1) {
      if (!deepEqual(left[i], right[i])) {
        return false;
      }
    }
    return true;
  }

  if (typeof left === "object") {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }

    for (const key of leftKeys) {
      if (!(key in rightRecord)) {
        return false;
      }
      if (!deepEqual(leftRecord[key], rightRecord[key])) {
        return false;
      }
    }
    return true;
  }

  return false;
}

function snapshotsEqual<T>(left: T[] | undefined, right: T[]): boolean {
  if (left === right) return true;
  if (!left || left.length !== right.length) return false;

  for (let i = 0; i < left.length; i += 1) {
    if (!deepEqual(left[i], right[i])) {
      return false;
    }
  }
  return true;
}

/**
 * Order-sensitive array equality using JSON-round-trip semantics (a missing key
 * equals a key whose value is `undefined`). Used to decide whether a save is a
 * genuine no-op against the last-acknowledged baseline: a baseline read back
 * from disk has its `undefined`-valued keys stripped, so a strict comparison
 * would report a spurious change and re-send an empty delta on every first save
 * after hydration (#11350). Order-sensitive so a pure reorder still persists.
 */
function snapshotsCanonicalEqual<T>(left: T[] | undefined, right: T[]): boolean {
  if (left === right) return true;
  if (!left || left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (!deepEqualIgnoringUndefined(left[i], right[i])) {
      return false;
    }
  }
  return true;
}

function shouldCollectPersistencePerf(): boolean {
  if (typeof window === "undefined") return false;
  return isRendererPerfCaptureEnabled() || Array.isArray(window.__DAINTREE_PERF_MARKS__);
}

const PERF_TEXT_ENCODER = new TextEncoder();

function estimatePayloadBytes(payload: unknown): number | null {
  try {
    return PERF_TEXT_ENCODER.encode(JSON.stringify(payload)).length;
  } catch {
    return null;
  }
}

export class PanelPersistence {
  private readonly client: ProjectClientType;
  private readonly options: Required<Omit<PanelPersistenceOptions, "getProjectId">> &
    Pick<PanelPersistenceOptions, "getProjectId">;
  private readonly debouncedSave: ReturnType<typeof debounce<[string, PanelSnapshot[]]>>;
  private readonly debouncedSaveTabGroups: ReturnType<typeof debounce<[string, TabGroup[]]>>;
  private readonly queuedTerminalsByProject = new Map<string, PanelSnapshot[]>();
  private readonly persistedTerminalsByProject = new Map<string, PanelSnapshot[]>();
  private readonly queuedTabGroupsByProject = new Map<string, TabGroup[]>();
  private readonly persistedTabGroupsByProject = new Map<string, TabGroup[]>();
  // Per-project write tails. Each debounced flush chains its delta computation
  // and send onto the previous write for the same project so the delta is
  // always computed against the baseline the previous write acknowledged. Two
  // overlapping flushes (a send in flight longer than the debounce interval)
  // must not both diff against the same stale baseline, or one would resurrect
  // an entry the other removed (#11350). Tails swallow rejections so a failed
  // write never blocks the next one.
  private readonly terminalWriteTailByProject = new Map<string, Promise<void>>();
  private readonly tabGroupWriteTailByProject = new Map<string, Promise<void>>();
  private pendingPersist: Promise<void> | null = null;
  private pendingTabGroupPersist: Promise<void> | null = null;

  constructor(client: ProjectClientType, options: PanelPersistenceOptions = {}) {
    this.client = client;
    this.options = { ...DEFAULT_OPTIONS, ...options };

    this.debouncedSave = debounce((projectId: string, transformed: PanelSnapshot[]) => {
      const collectPerf = shouldCollectPersistencePerf();
      const payloadBytes = collectPerf ? estimatePayloadBytes(transformed) : null;

      const prior = this.terminalWriteTailByProject.get(projectId) ?? Promise.resolve();
      const run = prior
        // A failed prior write must not poison the chain; it left the baseline
        // untouched, so the next write's delta stays correct.
        .catch(() => {})
        .then(async () => {
          // Baseline now reflects the previous committed write for this project.
          const baseline = this.persistedTerminalsByProject.get(projectId) ?? [];
          if (snapshotsCanonicalEqual(baseline, transformed)) {
            this.clearQueuedTerminalsIfMatches(projectId, transformed);
            return;
          }
          const startedAt = collectPerf
            ? typeof performance !== "undefined"
              ? performance.now()
              : Date.now()
            : 0;
          // Describe what changed relative to this renderer's last-acknowledged
          // baseline so Main merges concurrent writes from sibling windows of
          // the same project instead of clobbering them (#11350).
          const { changedIds, removedIds } = computeIdArrayDelta(
            baseline,
            transformed,
            deepEqualIgnoringUndefined
          );
          try {
            await this.client.setTerminals(projectId, transformed, changedIds, removedIds);
            if (collectPerf) {
              const now = typeof performance !== "undefined" ? performance.now() : Date.now();
              markRendererPerformance("persistence_terminals_save", {
                projectId,
                terminalCount: transformed.length,
                payloadBytes,
                durationMs: Number((now - startedAt).toFixed(3)),
                ok: true,
              });
            }
            this.persistedTerminalsByProject.set(projectId, transformed);
            this.clearQueuedTerminalsIfMatches(projectId, transformed);
          } catch (error) {
            logError("Failed to persist terminals", error);
            if (collectPerf) {
              const now = typeof performance !== "undefined" ? performance.now() : Date.now();
              markRendererPerformance("persistence_terminals_save", {
                projectId,
                terminalCount: transformed.length,
                payloadBytes,
                durationMs: Number((now - startedAt).toFixed(3)),
                ok: false,
              });
            }
            this.clearQueuedTerminalsIfMatches(projectId, transformed);
            throw error;
          }
        });

      this.pendingPersist = run;
      this.terminalWriteTailByProject.set(
        projectId,
        run.catch(() => {})
      );
      // Prevent unhandled rejection warning since this runs in background
      run.catch(() => {});
    }, this.options.debounceMs);

    this.debouncedSaveTabGroups = debounce((projectId: string, tabGroups: TabGroup[]) => {
      const collectPerf = shouldCollectPersistencePerf();
      const payloadBytes = collectPerf ? estimatePayloadBytes(tabGroups) : null;

      const prior = this.tabGroupWriteTailByProject.get(projectId) ?? Promise.resolve();
      const run = prior
        .catch(() => {})
        .then(async () => {
          const baseline = this.persistedTabGroupsByProject.get(projectId) ?? [];
          if (snapshotsCanonicalEqual(baseline, tabGroups)) {
            this.clearQueuedTabGroupsIfMatches(projectId, tabGroups);
            return;
          }
          const startedAt = collectPerf
            ? typeof performance !== "undefined"
              ? performance.now()
              : Date.now()
            : 0;
          // Merge concurrent tab-group writes from sibling windows (#11350).
          const { changedIds, removedIds } = computeIdArrayDelta(
            baseline,
            tabGroups,
            deepEqualIgnoringUndefined
          );
          try {
            await this.client.setTabGroups(projectId, tabGroups, changedIds, removedIds);
            if (collectPerf) {
              const now = typeof performance !== "undefined" ? performance.now() : Date.now();
              markRendererPerformance("persistence_tab_groups_save", {
                projectId,
                tabGroupCount: tabGroups.length,
                payloadBytes,
                durationMs: Number((now - startedAt).toFixed(3)),
                ok: true,
              });
            }
            this.persistedTabGroupsByProject.set(projectId, tabGroups);
            this.clearQueuedTabGroupsIfMatches(projectId, tabGroups);
          } catch (error) {
            logError("Failed to persist tab groups", error);
            if (collectPerf) {
              const now = typeof performance !== "undefined" ? performance.now() : Date.now();
              markRendererPerformance("persistence_tab_groups_save", {
                projectId,
                tabGroupCount: tabGroups.length,
                payloadBytes,
                durationMs: Number((now - startedAt).toFixed(3)),
                ok: false,
              });
            }
            this.clearQueuedTabGroupsIfMatches(projectId, tabGroups);
            throw error;
          }
        });

      this.pendingTabGroupPersist = run;
      this.tabGroupWriteTailByProject.set(
        projectId,
        run.catch(() => {})
      );
      run.catch(() => {});
    }, this.options.debounceMs);
  }

  private clearQueuedTerminalsIfMatches(projectId: string, transformed: PanelSnapshot[]): void {
    if (snapshotsEqual(this.queuedTerminalsByProject.get(projectId), transformed)) {
      this.queuedTerminalsByProject.delete(projectId);
    }
  }

  private clearQueuedTabGroupsIfMatches(projectId: string, tabGroups: TabGroup[]): void {
    if (snapshotsEqual(this.queuedTabGroupsByProject.get(projectId), tabGroups)) {
      this.queuedTabGroupsByProject.delete(projectId);
    }
  }

  save(terminals: TerminalInstance[], projectId?: string): void {
    const resolvedProjectId = projectId ?? this.options.getProjectId?.();
    if (!resolvedProjectId) {
      // No project ID available - skip persistence
      return;
    }

    const filtered = terminals.filter(this.options.filter);
    // When using the default transform (panelToSnapshot), thread the previously-
    // persisted snapshot per panel so unregistered kinds preserve their
    // kind-specific fields across save cycles. Custom transforms own their
    // output entirely and bypass preservation.
    let transformed: PanelSnapshot[];
    if (this.options.transform === panelToSnapshot) {
      const prevById = this.getPreviousSnapshotMap(resolvedProjectId);
      transformed = filtered.map((t) => panelToSnapshot(t, prevById?.get(t.id)));
    } else {
      transformed = filtered.map(this.options.transform);
    }
    if (snapshotsEqual(this.queuedTerminalsByProject.get(resolvedProjectId), transformed)) {
      return;
    }
    if (
      !this.queuedTerminalsByProject.has(resolvedProjectId) &&
      snapshotsEqual(this.persistedTerminalsByProject.get(resolvedProjectId), transformed)
    ) {
      return;
    }

    this.queuedTerminalsByProject.set(resolvedProjectId, transformed);
    this.debouncedSave(resolvedProjectId, transformed);
  }

  saveTabGroups(tabGroups: Map<string, TabGroup>, projectId?: string): void {
    const resolvedProjectId = projectId ?? this.options.getProjectId?.();
    if (!resolvedProjectId) {
      return;
    }

    // Convert Map to array and filter to only explicit groups (panelIds.length > 1)
    // Single-panel groups are virtual and don't need persistence
    const groupArray = Array.from(tabGroups.values()).filter((g) => g.panelIds.length > 1);
    if (snapshotsEqual(this.queuedTabGroupsByProject.get(resolvedProjectId), groupArray)) {
      return;
    }
    if (
      !this.queuedTabGroupsByProject.has(resolvedProjectId) &&
      snapshotsEqual(this.persistedTabGroupsByProject.get(resolvedProjectId), groupArray)
    ) {
      return;
    }

    this.queuedTabGroupsByProject.set(resolvedProjectId, groupArray);
    this.debouncedSaveTabGroups(resolvedProjectId, groupArray);
  }

  cancel(): void {
    this.debouncedSave.cancel();
    this.debouncedSaveTabGroups.cancel();
    this.queuedTerminalsByProject.clear();
    this.queuedTabGroupsByProject.clear();
    this.terminalWriteTailByProject.clear();
    this.tabGroupWriteTailByProject.clear();
    this.pendingPersist = null;
    this.pendingTabGroupPersist = null;
  }

  /**
   * Compute the terminal delta a caller outside the debounced save path (e.g.
   * the synchronous project-switch outgoing-state capture) should send so Main
   * merges it against the shared on-disk state instead of full-replacing and
   * clobbering a sibling window's changes (#11350). Diffs against this
   * renderer's last-acknowledged baseline using JSON-round-trip equality.
   */
  computeTerminalDelta(projectId: string, snapshots: PanelSnapshot[]): IdArrayDelta {
    return computeIdArrayDelta(
      this.persistedTerminalsByProject.get(projectId) ?? [],
      snapshots,
      deepEqualIgnoringUndefined
    );
  }

  /** Tab-group counterpart to {@link computeTerminalDelta} (#11350). */
  computeTabGroupDelta(projectId: string, groups: TabGroup[]): IdArrayDelta {
    return computeIdArrayDelta(
      this.persistedTabGroupsByProject.get(projectId) ?? [],
      groups,
      deepEqualIgnoringUndefined
    );
  }

  async whenIdle(): Promise<void> {
    await Promise.all([this.pendingPersist, this.pendingTabGroupPersist]);
  }

  flush(): void {
    this.debouncedSave.flush();
    this.debouncedSaveTabGroups.flush();
  }

  setProjectIdGetter(getter: () => string | null | undefined): void {
    this.options.getProjectId = () => getter() ?? null;
  }

  /**
   * Seed the previously-persisted snapshot cache for a project from hydration.
   * Without this, the first save after app launch has no "previous" snapshot
   * to preserve kind-specific fields from, and an unregistered kind's state
   * would be dropped on the very first save. Only primes if not already
   * present to avoid clobbering a post-hydration save that may have already
   * run through `save()`.
   */
  primeProject(projectId: string, snapshots: PanelSnapshot[]): void {
    if (this.persistedTerminalsByProject.has(projectId)) return;
    this.persistedTerminalsByProject.set(projectId, snapshots);
  }

  /**
   * Seed the tab-group baseline for a project from hydration, mirroring
   * {@link primeProject}. Without this, the first tab-group save has no baseline
   * to diff against, so a group the user deletes before that save cannot emit a
   * `removedIds` tombstone and Main would resurrect it from a sibling's on-disk
   * copy (#11350). Only primes if not already present so a post-hydration save
   * isn't clobbered.
   */
  primeTabGroups(projectId: string, groups: TabGroup[]): void {
    if (this.persistedTabGroupsByProject.has(projectId)) return;
    this.persistedTabGroupsByProject.set(projectId, groups);
  }

  /**
   * Drop the cached previous-snapshot entry for a project so the next
   * `primeProject` reseeds it. Used when a project is removed and in tests that
   * need a clean cache (the cache is otherwise process-lived).
   */
  clearProjectSnapshotCache(projectId: string): void {
    this.persistedTerminalsByProject.delete(projectId);
  }

  /**
   * Returns a map of panel id → most-recent snapshot for the given project,
   * or `undefined` if no snapshots are tracked. Used by callers outside the
   * debounced save path (e.g., the synchronous outgoing-state capture on
   * project switch) so they can thread `previousSnapshot` into
   * `panelToSnapshot` and preserve unregistered-kind fragments. Prefers
   * queued (in-flight) state over persisted (on-disk) state.
   */
  getPreviousSnapshotMap(projectId: string): Map<string, PanelSnapshot> | undefined {
    const snapshots =
      this.queuedTerminalsByProject.get(projectId) ??
      this.persistedTerminalsByProject.get(projectId);
    if (!snapshots) return undefined;
    return new Map(snapshots.map((s) => [s.id, s]));
  }
}

// Singleton instance - project ID will be passed at call site
export const panelPersistence = new PanelPersistence(projectClient);
