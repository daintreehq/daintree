import type { TerminalInstance, TerminalSnapshot, TabGroup } from "@/types";
import { projectClient } from "@/clients";
import { debounce } from "@/utils/debounce";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";

type ProjectClientType = typeof projectClient;

export interface TerminalPersistenceOptions {
  debounceMs?: number;
  filter?: (terminal: TerminalInstance) => boolean;
  transform?: (terminal: TerminalInstance) => TerminalSnapshot;
  getProjectId?: () => string | null;
}

export function terminalToSnapshot(t: TerminalInstance): TerminalSnapshot {
  // Note: tabGroupId and orderInGroup are NOT saved on terminals anymore
  // Tab groups are stored separately in ProjectState.tabGroups
  const base: TerminalSnapshot = {
    id: t.id,
    kind: t.kind,
    title: t.title,
    worktreeId: t.worktreeId,
    location: t.location === "trash" ? "grid" : t.location,
  };

  if (t.kind === "dev-preview") {
    return {
      ...base,
      type: t.type,
      cwd: t.cwd,
      command: t.devCommand?.trim() || undefined,
      ...(t.browserUrl && { browserUrl: t.browserUrl }),
      ...(t.browserHistory && { browserHistory: t.browserHistory }),
      ...(t.browserZoom != null && { browserZoom: t.browserZoom }),
      ...(t.devPreviewConsoleOpen !== undefined && {
        devPreviewConsoleOpen: t.devPreviewConsoleOpen,
      }),
    };
  }

  if (panelKindHasPty(t.kind ?? "terminal")) {
    return {
      ...base,
      type: t.type,
      agentId: t.agentId,
      cwd: t.cwd,
      command: t.command?.trim() || undefined,
    };
  } else if (t.kind === "notes") {
    return {
      ...base,
      notePath: t.notePath,
      noteId: t.noteId,
      scope: t.scope,
      createdAt: t.createdAt,
    };
  } else {
    // Non-PTY panels: browser, assistant, etc.
    return {
      ...base,
      ...(t.browserUrl && { browserUrl: t.browserUrl }),
      ...(t.browserHistory && { browserHistory: t.browserHistory }),
      ...(t.browserZoom != null && { browserZoom: t.browserZoom }),
    };
  }
}

const DEFAULT_OPTIONS: Required<Omit<TerminalPersistenceOptions, "getProjectId">> &
  Pick<TerminalPersistenceOptions, "getProjectId"> = {
  debounceMs: 500,
  filter: (t) => t.location !== "trash" && t.kind !== "assistant",
  transform: terminalToSnapshot,
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

export class TerminalPersistence {
  private readonly client: ProjectClientType;
  private readonly options: Required<Omit<TerminalPersistenceOptions, "getProjectId">> &
    Pick<TerminalPersistenceOptions, "getProjectId">;
  private readonly debouncedSave: ReturnType<typeof debounce<[string, TerminalSnapshot[]]>>;
  private readonly debouncedSaveTabGroups: ReturnType<typeof debounce<[string, TabGroup[]]>>;
  private readonly queuedTerminalsByProject = new Map<string, TerminalSnapshot[]>();
  private readonly persistedTerminalsByProject = new Map<string, TerminalSnapshot[]>();
  private readonly queuedTabGroupsByProject = new Map<string, TabGroup[]>();
  private readonly persistedTabGroupsByProject = new Map<string, TabGroup[]>();
  private pendingPersist: Promise<void> | null = null;
  private pendingTabGroupPersist: Promise<void> | null = null;

  constructor(client: ProjectClientType, options: TerminalPersistenceOptions = {}) {
    this.client = client;
    this.options = { ...DEFAULT_OPTIONS, ...options };

    this.debouncedSave = debounce((projectId: string, transformed: TerminalSnapshot[]) => {
      if (snapshotsEqual(this.persistedTerminalsByProject.get(projectId), transformed)) {
        if (snapshotsEqual(this.queuedTerminalsByProject.get(projectId), transformed)) {
          this.queuedTerminalsByProject.delete(projectId);
        }
        return;
      }

      this.pendingPersist = this.client.setTerminals(projectId, transformed).catch((error) => {
        console.error("Failed to persist terminals:", error);
        if (snapshotsEqual(this.queuedTerminalsByProject.get(projectId), transformed)) {
          this.queuedTerminalsByProject.delete(projectId);
        }
        throw error;
      });
      this.pendingPersist = this.pendingPersist.then(() => {
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

      this.pendingTabGroupPersist = this.client
        .setTabGroups(projectId, tabGroups)
        .catch((error) => {
          console.error("Failed to persist tab groups:", error);
          if (snapshotsEqual(this.queuedTabGroupsByProject.get(projectId), tabGroups)) {
            this.queuedTabGroupsByProject.delete(projectId);
          }
          throw error;
        });
      this.pendingTabGroupPersist = this.pendingTabGroupPersist.then(() => {
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
    const transformed = filtered.map(this.options.transform);
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
}

// Singleton instance - project ID will be passed at call site
export const terminalPersistence = new TerminalPersistence(projectClient);
