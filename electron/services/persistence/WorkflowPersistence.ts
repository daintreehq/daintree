import { eq } from "drizzle-orm";
import type {
  WorkflowRun,
  NodeState,
  EvaluatedCondition,
} from "../../../shared/types/workflowRun.js";
import type { WorkflowDefinition } from "../../../shared/types/workflow.js";
import { openDb, getSharedDb, type AppDb } from "./db.js";
import * as schema from "./schema.js";

function toRow(run: WorkflowRun, projectId: string): schema.WorkflowRunRow {
  return {
    runId: run.runId,
    projectId,
    workflowId: run.workflowId,
    workflowVersion: run.workflowVersion,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt ?? null,
    definition: JSON.stringify(run.definition),
    nodeStates: JSON.stringify(run.nodeStates),
    taskMapping: JSON.stringify(run.taskMapping),
    scheduledNodes: JSON.stringify(Array.from(run.scheduledNodes)),
    evaluatedConditions: JSON.stringify(run.evaluatedConditions),
  };
}

function fromRow(row: schema.WorkflowRunRow): WorkflowRun {
  return {
    runId: row.runId,
    workflowId: row.workflowId,
    workflowVersion: row.workflowVersion,
    status: row.status as WorkflowRun["status"],
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? undefined,
    definition: JSON.parse(row.definition as string) as WorkflowDefinition,
    nodeStates: JSON.parse(row.nodeStates as string) as Record<string, NodeState>,
    taskMapping: JSON.parse(row.taskMapping as string) as Record<string, string>,
    scheduledNodes: new Set<string>(JSON.parse(row.scheduledNodes as string) as string[]),
    evaluatedConditions: JSON.parse(row.evaluatedConditions as string) as EvaluatedCondition[],
  };
}

export class WorkflowPersistence {
  private _db: AppDb | null = null;
  private _dbProvider: (() => AppDb) | null = null;
  private saveDebounceMs: number;
  private pendingSaves: Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      runs: WorkflowRun[];
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

  async load(projectId: string): Promise<WorkflowRun[]> {
    if (!this.isValidProjectId(projectId)) {
      return [];
    }

    try {
      const rows = this.db
        .select()
        .from(schema.workflowRuns)
        .where(eq(schema.workflowRuns.projectId, projectId))
        .all();
      const runs: WorkflowRun[] = [];
      for (const row of rows) {
        try {
          runs.push(fromRow(row));
        } catch (rowError) {
          console.error(
            `[WorkflowPersistence] Skipping corrupt workflow run row ${row.runId}:`,
            rowError
          );
        }
      }
      console.log(
        `[WorkflowPersistence] Loaded ${runs.length} workflow runs for project ${projectId}`
      );
      return runs;
    } catch (error) {
      console.error(`[WorkflowPersistence] Failed to load workflow runs for ${projectId}:`, error);
      return [];
    }
  }

  async save(projectId: string, runs: WorkflowRun[]): Promise<void> {
    if (!this.isValidProjectId(projectId)) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    let pending = this.pendingSaves.get(projectId);

    if (pending) {
      clearTimeout(pending.timer);
      pending.runs = runs;
    } else {
      pending = {
        timer: null as unknown as ReturnType<typeof setTimeout>,
        runs,
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
        this.saveSync(projectId, entry.runs);
        entry.resolvers.forEach((r) => r());
      } catch (error) {
        entry.rejecters.forEach((r) => r(error));
      }
    }, this.saveDebounceMs);

    return promise;
  }

  private saveSync(projectId: string, runs: WorkflowRun[]): void {
    this.db.transaction((tx) => {
      tx.delete(schema.workflowRuns).where(eq(schema.workflowRuns.projectId, projectId)).run();
      if (runs.length > 0) {
        tx.insert(schema.workflowRuns)
          .values(runs.map((r) => toRow(r, projectId)))
          .run();
      }
    });

    console.log(
      `[WorkflowPersistence] Saved ${runs.length} workflow runs for project ${projectId}`
    );
  }

  async flush(projectId: string): Promise<void> {
    const pending = this.pendingSaves.get(projectId);

    if (pending) {
      clearTimeout(pending.timer);
      this.pendingSaves.delete(projectId);

      try {
        this.saveSync(projectId, pending.runs);
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
        this.db
          .delete(schema.workflowRuns)
          .where(eq(schema.workflowRuns.projectId, projectId))
          .run();
        console.log(`[WorkflowPersistence] Cleared workflow runs for project ${projectId}`);
      } catch (error) {
        console.error(
          `[WorkflowPersistence] Failed to clear workflow runs for ${projectId}:`,
          error
        );
      }
    }

    pending?.resolvers.forEach((resolve) => resolve());
  }
}

export const workflowPersistence = new WorkflowPersistence();
