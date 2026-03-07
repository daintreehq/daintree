import { eq } from "drizzle-orm";
import type { TaskRecord, TaskResult, TaskRoutingHints } from "../../../shared/types/task.js";
import { openDb, getSharedDb, type AppDb } from "./db.js";
import * as schema from "./schema.js";

function toRow(task: TaskRecord, projectId: string): schema.TaskRow {
  return {
    id: task.id,
    projectId,
    title: task.title,
    description: task.description ?? null,
    status: task.status,
    priority: task.priority,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    queuedAt: task.queuedAt ?? null,
    startedAt: task.startedAt ?? null,
    completedAt: task.completedAt ?? null,
    dependencies: JSON.stringify(task.dependencies ?? []),
    worktreeId: task.worktreeId ?? null,
    assignedAgentId: task.assignedAgentId ?? null,
    runId: task.runId ?? null,
    metadata: task.metadata != null ? JSON.stringify(task.metadata) : null,
    result: task.result != null ? JSON.stringify(task.result) : null,
    routingHints: task.routingHints != null ? JSON.stringify(task.routingHints) : null,
  };
}

function fromRow(row: schema.TaskRow): TaskRecord {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? undefined,
    status: row.status as TaskRecord["status"],
    priority: row.priority ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    queuedAt: row.queuedAt ?? undefined,
    startedAt: row.startedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
    dependencies: row.dependencies ? (JSON.parse(row.dependencies) as string[]) : [],
    worktreeId: row.worktreeId ?? undefined,
    assignedAgentId: row.assignedAgentId ?? undefined,
    runId: row.runId ?? undefined,
    metadata:
      row.metadata != null ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
    result: row.result != null ? (JSON.parse(row.result) as TaskResult) : undefined,
    routingHints:
      row.routingHints != null ? (JSON.parse(row.routingHints) as TaskRoutingHints) : undefined,
  };
}

export class TaskPersistence {
  private _db: AppDb | null = null;
  private _dbProvider: (() => AppDb) | null = null;
  private saveDebounceMs: number;
  private pendingSaves: Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      tasks: TaskRecord[];
      resolvers: Array<() => void>;
      rejecters: Array<(error: unknown) => void>;
    }
  > = new Map();

  constructor(dbOrPath?: AppDb | string, debounceMs: number = 1000) {
    this.saveDebounceMs = debounceMs;
    if (dbOrPath && typeof dbOrPath === "object") {
      this._db = dbOrPath;
    } else if (typeof dbOrPath === "string") {
      this._dbProvider = () => openDb(dbOrPath).db;
    } else {
      this._dbProvider = () => getSharedDb();
    }
  }

  private get db(): AppDb {
    if (!this._db) {
      this._db = this._dbProvider!();
    }
    return this._db;
  }

  private isValidProjectId(projectId: string): boolean {
    return /^[0-9a-f]{64}$/.test(projectId);
  }

  async load(projectId: string): Promise<TaskRecord[]> {
    if (!this.isValidProjectId(projectId)) {
      return [];
    }

    try {
      const rows = this.db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.projectId, projectId))
        .all();
      const tasks: TaskRecord[] = [];
      for (const row of rows) {
        try {
          tasks.push(fromRow(row));
        } catch (rowError) {
          console.error(`[TaskPersistence] Skipping corrupt task row ${row.id}:`, rowError);
        }
      }
      console.log(`[TaskPersistence] Loaded ${tasks.length} tasks for project ${projectId}`);
      return tasks;
    } catch (error) {
      console.error(`[TaskPersistence] Failed to load tasks for ${projectId}:`, error);
      return [];
    }
  }

  async save(projectId: string, tasks: TaskRecord[]): Promise<void> {
    if (!this.isValidProjectId(projectId)) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    let pending = this.pendingSaves.get(projectId);

    if (pending) {
      clearTimeout(pending.timer);
      pending.tasks = tasks;
    } else {
      pending = {
        timer: null as unknown as ReturnType<typeof setTimeout>,
        tasks,
        resolvers: [],
        rejecters: [],
      };
      this.pendingSaves.set(projectId, pending);
    }

    const promise = new Promise<void>((resolve, reject) => {
      pending!.resolvers.push(resolve);
      pending!.rejecters.push(reject);
    });

    pending.timer = setTimeout(() => {
      const entry = this.pendingSaves.get(projectId);
      if (!entry) return;

      this.pendingSaves.delete(projectId);

      try {
        this.saveSync(projectId, entry.tasks);
        entry.resolvers.forEach((r) => r());
      } catch (error) {
        entry.rejecters.forEach((r) => r(error));
      }
    }, this.saveDebounceMs);

    return promise;
  }

  private saveSync(projectId: string, tasks: TaskRecord[]): void {
    this.db.transaction((tx) => {
      tx.delete(schema.tasks).where(eq(schema.tasks.projectId, projectId)).run();
      if (tasks.length > 0) {
        tx.insert(schema.tasks)
          .values(tasks.map((t) => toRow(t, projectId)))
          .run();
      }
    });

    console.log(`[TaskPersistence] Saved ${tasks.length} tasks for project ${projectId}`);
  }

  async flush(projectId: string): Promise<void> {
    const pending = this.pendingSaves.get(projectId);

    if (pending) {
      clearTimeout(pending.timer);
      this.pendingSaves.delete(projectId);

      try {
        this.saveSync(projectId, pending.tasks);
        pending.resolvers.forEach((r) => r());
      } catch (error) {
        pending.rejecters.forEach((r) => r(error));
        throw error;
      }
    }
  }

  async clear(projectId: string): Promise<void> {
    const pending = this.pendingSaves.get(projectId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingSaves.delete(projectId);
    }

    if (this.isValidProjectId(projectId)) {
      try {
        this.db.delete(schema.tasks).where(eq(schema.tasks.projectId, projectId)).run();
        console.log(`[TaskPersistence] Cleared tasks for project ${projectId}`);
      } catch (error) {
        console.error(`[TaskPersistence] Failed to clear tasks for ${projectId}:`, error);
      }
    }

    pending?.resolvers.forEach((resolve) => resolve());
  }
}

export const taskPersistence = new TaskPersistence();
