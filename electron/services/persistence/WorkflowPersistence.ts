import { z } from "zod";
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { app } from "electron";
import type { WorkflowRun } from "../../../shared/types/workflowRun.js";
import {
  WorkflowDefinitionSchema,
  WorkflowConditionSchema,
} from "../../../shared/types/workflow.js";

const WORKFLOW_RUNS_FILENAME = "workflow-runs.json";
const SCHEMA_VERSION = "1.0";

const TaskResultSchema = z.object({
  summary: z.string().optional(),
  artifacts: z.array(z.string()).optional(),
  error: z.string().optional(),
});

const NodeStateSchema = z.object({
  status: z.enum(["draft", "queued", "running", "blocked", "completed", "failed", "cancelled"]),
  taskId: z.string().optional(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  result: TaskResultSchema.optional(),
});

const EvaluatedConditionSchema = z.object({
  nodeId: z.string(),
  condition: WorkflowConditionSchema,
  result: z.boolean(),
  timestamp: z.number(),
});

const WorkflowRunSchema = z.object({
  runId: z.string().min(1),
  workflowId: z.string().min(1),
  workflowVersion: z.string(),
  status: z.enum(["running", "completed", "failed", "cancelled"]),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  definition: WorkflowDefinitionSchema,
  nodeStates: z.record(z.string(), NodeStateSchema),
  taskMapping: z.record(z.string(), z.string()),
  scheduledNodes: z.array(z.string()),
  evaluatedConditions: z.array(EvaluatedConditionSchema),
});

const WorkflowRunsStateSchema = z.object({
  version: z.literal(SCHEMA_VERSION),
  runs: z.array(WorkflowRunSchema),
  lastUpdated: z.number(),
});

export interface WorkflowRunsState {
  version: string;
  runs: SerializedWorkflowRun[];
  lastUpdated: number;
}

interface SerializedWorkflowRun extends Omit<WorkflowRun, "scheduledNodes"> {
  scheduledNodes: string[];
}

export class WorkflowPersistence {
  private projectsConfigDir: string;
  private saveDebounceMs: number;
  private pendingSaves: Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      state: WorkflowRunsState;
      resolvers: Array<() => void>;
      rejecters: Array<(error: unknown) => void>;
    }
  > = new Map();
  private inFlightSaves: Map<string, Promise<void>> = new Map();

  constructor(debounceMs: number = 1000) {
    this.projectsConfigDir = path.join(app.getPath("userData"), "projects");
    this.saveDebounceMs = debounceMs;
  }

  private isValidProjectId(projectId: string): boolean {
    return /^[0-9a-f]{64}$/.test(projectId);
  }

  private getWorkflowRunsFilePath(projectId: string): string | null {
    if (!this.isValidProjectId(projectId)) {
      return null;
    }
    const stateDir = path.join(this.projectsConfigDir, projectId);
    const normalized = path.normalize(stateDir);
    if (!normalized.startsWith(this.projectsConfigDir + path.sep)) {
      return null;
    }
    return path.join(normalized, WORKFLOW_RUNS_FILENAME);
  }

  async load(projectId: string): Promise<WorkflowRun[]> {
    const filePath = this.getWorkflowRunsFilePath(projectId);
    if (!filePath || !existsSync(filePath)) {
      return [];
    }

    try {
      const content = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(content);
      const validated = WorkflowRunsStateSchema.parse(parsed);

      const runs = validated.runs.map(
        (serialized): WorkflowRun => ({
          ...serialized,
          scheduledNodes: new Set(serialized.scheduledNodes),
        })
      );

      console.log(
        `[WorkflowPersistence] Loaded ${runs.length} workflow runs for project ${projectId}`
      );
      return runs;
    } catch (error) {
      console.error(`[WorkflowPersistence] Failed to load workflow runs for ${projectId}:`, error);

      if (filePath) {
        try {
          const timestamp = Date.now();
          const quarantinePath = `${filePath}.corrupted.${timestamp}`;
          await fs.rename(filePath, quarantinePath);
          console.warn(
            `[WorkflowPersistence] Corrupted workflow runs file moved to ${quarantinePath}`
          );
        } catch (quarantineError) {
          console.error(
            `[WorkflowPersistence] Failed to quarantine corrupted file: ${filePath}`,
            quarantineError
          );
        }
      }

      return [];
    }
  }

  async save(projectId: string, runs: WorkflowRun[]): Promise<void> {
    const serializedRuns: SerializedWorkflowRun[] = runs.map((run) => ({
      ...run,
      scheduledNodes: Array.from(run.scheduledNodes),
    }));

    const state: WorkflowRunsState = {
      version: SCHEMA_VERSION,
      runs: serializedRuns,
      lastUpdated: Date.now(),
    };

    let pending = this.pendingSaves.get(projectId);

    if (pending) {
      clearTimeout(pending.timer);
      pending.state = state;
    } else {
      pending = {
        timer: null as unknown as ReturnType<typeof setTimeout>,
        state,
        resolvers: [],
        rejecters: [],
      };
      this.pendingSaves.set(projectId, pending);
    }

    const promise = new Promise<void>((resolve, reject) => {
      pending!.resolvers.push(resolve);
      pending!.rejecters.push(reject);
    });

    pending.timer = setTimeout(async () => {
      const entry = this.pendingSaves.get(projectId);
      if (!entry) return;

      this.pendingSaves.delete(projectId);

      try {
        await this.saveImmediate(projectId, entry.state);
        entry.resolvers.forEach((r) => r());
      } catch (error) {
        entry.rejecters.forEach((r) => r(error));
      }
    }, this.saveDebounceMs);

    return promise;
  }

  async saveImmediate(projectId: string, state: WorkflowRunsState): Promise<void> {
    const inFlight = this.inFlightSaves.get(projectId);
    if (inFlight) {
      await inFlight;
    }

    const filePath = this.getWorkflowRunsFilePath(projectId);
    if (!filePath) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    const stateDir = path.dirname(filePath);
    const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tempFilePath = `${filePath}.${uniqueSuffix}.tmp`;

    const attemptSave = async (ensureDir: boolean): Promise<void> => {
      if (ensureDir) {
        await fs.mkdir(stateDir, { recursive: true });
      }
      await fs.writeFile(tempFilePath, JSON.stringify(state, null, 2), "utf-8");
      await fs.rename(tempFilePath, filePath);
    };

    const savePromise = (async () => {
      try {
        await attemptSave(false);
      } catch (error) {
        const isEnoent = error instanceof Error && "code" in error && error.code === "ENOENT";
        if (!isEnoent) {
          this.cleanupTempFile(tempFilePath);
          throw error;
        }

        try {
          await attemptSave(true);
        } catch (retryError) {
          this.cleanupTempFile(tempFilePath);
          throw retryError;
        }
      }

      console.log(
        `[WorkflowPersistence] Saved ${state.runs.length} workflow runs for project ${projectId}`
      );
    })();

    this.inFlightSaves.set(projectId, savePromise);

    try {
      await savePromise;
    } finally {
      this.inFlightSaves.delete(projectId);
    }
  }

  private cleanupTempFile(tempFilePath: string): void {
    fs.unlink(tempFilePath).catch(() => {
      // Ignore cleanup errors
    });
  }

  async flush(projectId: string): Promise<void> {
    const pending = this.pendingSaves.get(projectId);

    if (pending) {
      clearTimeout(pending.timer);
      this.pendingSaves.delete(projectId);

      try {
        await this.saveImmediate(projectId, pending.state);
        pending.resolvers.forEach((r) => r());
      } catch (error) {
        pending.rejecters.forEach((r) => r(error));
        throw error;
      }
    }

    const inFlight = this.inFlightSaves.get(projectId);
    if (inFlight) {
      await inFlight;
    }
  }

  async clear(projectId: string): Promise<void> {
    const filePath = this.getWorkflowRunsFilePath(projectId);
    if (filePath && existsSync(filePath)) {
      try {
        await fs.unlink(filePath);
        console.log(`[WorkflowPersistence] Cleared workflow runs for project ${projectId}`);
      } catch (error) {
        console.error(
          `[WorkflowPersistence] Failed to clear workflow runs for ${projectId}:`,
          error
        );
      }
    }
  }
}

export const workflowPersistence = new WorkflowPersistence();
