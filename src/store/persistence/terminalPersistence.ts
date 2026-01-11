import type { TerminalInstance, TerminalSnapshot } from "@/types";
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

const DEFAULT_OPTIONS: Required<Omit<TerminalPersistenceOptions, "getProjectId">> &
  Pick<TerminalPersistenceOptions, "getProjectId"> = {
  debounceMs: 500,
  filter: (t) => t.location !== "trash",
  transform: (t) => {
    const base: TerminalSnapshot = {
      id: t.id,
      kind: t.kind,
      title: t.title,
      worktreeId: t.worktreeId,
      location: t.location === "trash" ? "grid" : t.location,
      cwd: t.cwd,
    };

    if (t.kind === "dev-preview") {
      return {
        ...base,
        type: t.type,
        cwd: t.cwd,
        command: t.devCommand?.trim() || undefined,
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
      return {
        ...base,
        ...(t.browserUrl && { browserUrl: t.browserUrl }),
      };
    }
  },
  getProjectId: undefined,
};

export class TerminalPersistence {
  private readonly client: ProjectClientType;
  private readonly options: Required<Omit<TerminalPersistenceOptions, "getProjectId">> &
    Pick<TerminalPersistenceOptions, "getProjectId">;
  private readonly debouncedSave: ReturnType<typeof debounce<[string, TerminalSnapshot[]]>>;
  private pendingPersist: Promise<void> | null = null;

  constructor(client: ProjectClientType, options: TerminalPersistenceOptions = {}) {
    this.client = client;
    this.options = { ...DEFAULT_OPTIONS, ...options };

    this.debouncedSave = debounce((projectId: string, transformed: TerminalSnapshot[]) => {
      this.pendingPersist = this.client.setTerminals(projectId, transformed).catch((error) => {
        console.error("Failed to persist terminals:", error);
        throw error;
      });
      // Prevent unhandled rejection warning since this runs in background
      this.pendingPersist.catch(() => {});
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
    this.debouncedSave(resolvedProjectId, transformed);
  }

  cancel(): void {
    this.debouncedSave.cancel();
    this.pendingPersist = null;
  }

  async whenIdle(): Promise<void> {
    await this.pendingPersist;
  }

  flush(): void {
    this.debouncedSave.flush();
  }

  setProjectIdGetter(getter: () => string | null | undefined): void {
    this.options.getProjectId = () => getter() ?? null;
  }
}

// Singleton instance - project ID will be passed at call site
export const terminalPersistence = new TerminalPersistence(projectClient);
