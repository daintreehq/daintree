import type { PluginHostApi } from "../../../../shared/types/plugin.js";
import type { SessionAgentId } from "./sessionRecords.js";

export interface ConversionRecord {
  readonly id: string;
  readonly projectId: string;
  readonly worktreeId: string | null;
  readonly cwd: string;
  readonly sourceAgent: SessionAgentId;
  readonly targetAgent: SessionAgentId;
  readonly sourceSessionId: string;
  readonly sourcePath: string;
  /** The session file's size when it was read; later appends are not in the index. */
  readonly sourceBytes: number;
  readonly fragments: number;
  /** Lines that weren't JSON or ran past the size a record is read at. */
  readonly skippedLines: number;
  readonly createdAt: number;
  /**
   * The terminals continuing agents were launched in for this session. Only
   * their agents can search it, unless its project shares converted
   * sessions. A launch adds its terminal before it starts and takes it back
   * if it doesn't, without touching another launch's.
   */
  readonly terminalIds: readonly string[];
}

const CONVERSIONS_KEY = "conversions";
const SHARED_PROJECTS_KEY = "sharedProjects";

/**
 * What has been converted, and which projects share their converted sessions
 * with every agent in them. Kept in the plugin's user-scope storage: the
 * plugin is one instance serving every project, so each record carries its
 * project rather than living in a per-project file. Writes are serialised so
 * two conversions finishing together don't drop each other's record.
 */
export class Catalog {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: PluginHostApi["storage"]) {}

  async list(): Promise<ConversionRecord[]> {
    const stored = await this.storage.get<Record<string, ConversionRecord>>(CONVERSIONS_KEY);
    if (!stored || typeof stored !== "object") return [];
    return Object.values(stored)
      .filter(isRecord)
      .map((record) => ({
        ...record,
        terminalIds: Array.isArray(record.terminalIds)
          ? record.terminalIds.filter((id): id is string => typeof id === "string")
          : [],
      }));
  }

  async get(id: string): Promise<ConversionRecord | null> {
    return (await this.list()).find((record) => record.id === id) ?? null;
  }

  put(record: ConversionRecord): Promise<void> {
    return this.mutate((all) => {
      all[record.id] = record;
    });
  }

  /** Lets one more terminal's agent search the session. */
  grant(id: string, terminalId: string): Promise<void> {
    return this.mutate((all) => {
      const current = all[id];
      if (!current || current.terminalIds.includes(terminalId)) return;
      all[id] = { ...current, terminalIds: [...current.terminalIds, terminalId] };
    });
  }

  /** Takes back one terminal's grant, leaving every other one. */
  revoke(id: string, terminalId: string, replacement?: string): Promise<void> {
    return this.mutate((all) => {
      const current = all[id];
      if (!current) return;
      const kept = current.terminalIds.filter((candidate) => candidate !== terminalId);
      if (replacement && !kept.includes(replacement)) kept.push(replacement);
      all[id] = { ...current, terminalIds: kept };
    });
  }

  remove(ids: readonly string[]): Promise<void> {
    return this.mutate((all) => {
      for (const id of ids) delete all[id];
    });
  }

  async sharedProjects(): Promise<ReadonlySet<string>> {
    const stored = await this.storage.get<unknown>(SHARED_PROJECTS_KEY);
    return new Set(
      Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : []
    );
  }

  setShared(projectId: string, shared: boolean): Promise<void> {
    return this.serialise(async () => {
      const current = new Set(await this.sharedProjects());
      if (shared) current.add(projectId);
      else current.delete(projectId);
      await this.storage.set(SHARED_PROJECTS_KEY, [...current].sort());
    });
  }

  private mutate(change: (all: Record<string, ConversionRecord>) => void): Promise<void> {
    return this.serialise(async () => {
      const all: Record<string, ConversionRecord> = {};
      for (const record of await this.list()) all[record.id] = record;
      change(all);
      await this.storage.set(CONVERSIONS_KEY, all);
    });
  }

  private serialise<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

function isRecord(value: unknown): value is ConversionRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ConversionRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.projectId === "string" &&
    (record.sourceAgent === "codex" || record.sourceAgent === "claude") &&
    (record.targetAgent === "codex" || record.targetAgent === "claude") &&
    typeof record.createdAt === "number"
  );
}
