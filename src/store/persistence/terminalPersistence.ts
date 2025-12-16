import type { TerminalInstance, TerminalState } from "@/types";
import { appClient } from "@/clients";
import { debounce } from "@/utils/debounce";

type AppClientType = typeof appClient;

export interface TerminalPersistenceOptions {
  debounceMs?: number;
  filter?: (terminal: TerminalInstance) => boolean;
  transform?: (terminal: TerminalInstance) => TerminalState;
}

const DEFAULT_OPTIONS: Required<TerminalPersistenceOptions> = {
  debounceMs: 500,
  filter: (t) => t.location !== "trash",
  transform: (t) => ({
    id: t.id,
    type: t.type,
    agentId: t.agentId,
    title: t.title,
    cwd: t.cwd,
    worktreeId: t.worktreeId,
    location: t.location,
    command: t.command?.trim() || undefined,
    ...(t.isInputLocked && { isInputLocked: true }),
  }),
};

export class TerminalPersistence {
  private readonly client: AppClientType;
  private readonly options: Required<TerminalPersistenceOptions>;
  private readonly debouncedSave: ReturnType<typeof debounce<[TerminalState[]]>>;
  private pendingPersist: Promise<void> | null = null;

  constructor(client: AppClientType, options: TerminalPersistenceOptions = {}) {
    this.client = client;
    this.options = { ...DEFAULT_OPTIONS, ...options };

    this.debouncedSave = debounce((transformed: TerminalState[]) => {
      this.pendingPersist = this.client.setState({ terminals: transformed }).catch((error) => {
        console.error("Failed to persist terminals:", error);
        throw error;
      });
      // Prevent unhandled rejection warning since this runs in background
      this.pendingPersist.catch(() => {});
    }, this.options.debounceMs);
  }

  save(terminals: TerminalInstance[]): void {
    const filtered = terminals.filter(this.options.filter);
    const transformed = filtered.map(this.options.transform);
    this.debouncedSave(transformed);
  }

  flush(): void {
    this.debouncedSave.flush();
  }

  cancel(): void {
    this.debouncedSave.cancel();
  }

  async whenIdle(): Promise<void> {
    if (this.pendingPersist) {
      await this.pendingPersist;
    }
  }
}

export const terminalPersistence = new TerminalPersistence(appClient);
