import type { TerminalInstance, PanelSnapshot, TabGroup } from "@/types";
import { projectClient } from "@/clients";
import { debounce } from "@/utils/debounce";
import { isRendererPerfCaptureEnabled, markRendererPerformance } from "@/utils/performance";
import { getPanelKindConfig } from "@shared/config/panelKindRegistry";
import { isSmokeTestTerminalId } from "@shared/utils/smokeTestTerminals";
import { logError } from "@/utils/logger";

type ProjectClientType = typeof projectClient;

export interface PanelPersistenceOptions {
  debounceMs?: number;
  filter?: (terminal: TerminalInstance) => boolean;
  transform?: (terminal: TerminalInstance) => PanelSnapshot;
  getProjectId?: () => string | null;
}

// Base fields that panelToSnapshot always writes. Used to isolate kind-specific
// fields when preserving a previous snapshot for an unregistered kind. If new
// base fields are added to the `base` object below, they MUST be added here too,
// or unknown-kind snapshots will silently carry stale copies of the new field.
const BASE_PANEL_FIELDS = new Set<string>([
  "id",
  "kind",
  "title",
  "worktreeId",
  "location",
  "extensionState",
  "pluginId",
]);

export function panelToSnapshot(
  t: TerminalInstance,
  previousSnapshot?: PanelSnapshot
): PanelSnapshot {
  const base: PanelSnapshot = {
    id: t.id,
    kind: t.kind,
    title: t.title,
    worktreeId: t.worktreeId,
    location: t.location === "trash" || t.location === "background" ? "grid" : t.location,
    ...(t.extensionState !== undefined && { extensionState: t.extensionState }),
    ...(t.pluginId !== undefined && { pluginId: t.pluginId }),
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
        if (!BASE_PANEL_FIELDS.has(key) && prev[key] !== undefined) {
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
    t.kind !== "assistant" &&
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
  private pendingPersist: Promise<void> | null = null;
  private pendingTabGroupPersist: Promise<void> | null = null;

  constructor(client: ProjectClientType, options: PanelPersistenceOptions = {}) {
    this.client = client;
    this.options = { ...DEFAULT_OPTIONS, ...options };

    this.debouncedSave = debounce((projectId: string, transformed: PanelSnapshot[]) => {
      if (snapshotsEqual(this.persistedTerminalsByProject.get(projectId), transformed)) {
        if (snapshotsEqual(this.queuedTerminalsByProject.get(projectId), transformed)) {
          this.queuedTerminalsByProject.delete(projectId);
        }
        return;
      }

      const collectPerf = shouldCollectPersistencePerf();
      const startedAt = collectPerf
        ? typeof performance !== "undefined"
          ? performance.now()
          : Date.now()
        : 0;
      const payloadBytes = collectPerf ? estimatePayloadBytes(transformed) : null;

      this.pendingPersist = this.client.setTerminals(projectId, transformed).catch((error) => {
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
        if (snapshotsEqual(this.queuedTerminalsByProject.get(projectId), transformed)) {
          this.queuedTerminalsByProject.delete(projectId);
        }
        throw error;
      });
      this.pendingPersist = this.pendingPersist.then(() => {
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
        if (snapshotsEqual(this.queuedTerminalsByProject.get(projectId), transformed)) {
          this.queuedTerminalsByProject.delete(projectId);
        }
      });
      // Prevent unhandled rejection warning since this runs in background
      this.pendingPersist.catch(() => {});
    }, this.options.debounceMs);

    this.debouncedSaveTabGroups = debounce((projectId: string, tabGroups: TabGroup[]) => {
      if (snapshotsEqual(this.persistedTabGroupsByProject.get(projectId), tabGroups)) {
        if (snapshotsEqual(this.queuedTabGroupsByProject.get(projectId), tabGroups)) {
          this.queuedTabGroupsByProject.delete(projectId);
        }
        return;
      }

      const collectPerf = shouldCollectPersistencePerf();
      const startedAt = collectPerf
        ? typeof performance !== "undefined"
          ? performance.now()
          : Date.now()
        : 0;
      const payloadBytes = collectPerf ? estimatePayloadBytes(tabGroups) : null;

      this.pendingTabGroupPersist = this.client
        .setTabGroups(projectId, tabGroups)
        .catch((error) => {
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
          if (snapshotsEqual(this.queuedTabGroupsByProject.get(projectId), tabGroups)) {
            this.queuedTabGroupsByProject.delete(projectId);
          }
          throw error;
        });
      this.pendingTabGroupPersist = this.pendingTabGroupPersist.then(() => {
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
        if (snapshotsEqual(this.queuedTabGroupsByProject.get(projectId), tabGroups)) {
          this.queuedTabGroupsByProject.delete(projectId);
        }
      });
      this.pendingTabGroupPersist.catch(() => {});
    }, this.options.debounceMs);
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
    this.pendingPersist = null;
    this.pendingTabGroupPersist = null;
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
