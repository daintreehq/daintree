import { z } from "zod";
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { app } from "electron";
import type { TaskRecord } from "../../../shared/types/task.js";

const TASKS_FILENAME = "tasks.json";
const SCHEMA_VERSION = "1.0";

const TaskResultSchema = z.object({
  summary: z.string().optional(),
  artifacts: z.array(z.string()).optional(),
  error: z.string().optional(),
});

const TaskStateSchema = z.enum([
  "draft",
  "queued",
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled",
]);

const TaskRoutingHintsSchema = z.object({
  requiredCapabilities: z.array(z.string()).optional(),
  preferredDomains: z.array(z.string()).optional(),
});

const TaskRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  status: TaskStateSchema,
  priority: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  queuedAt: z.number().optional(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  dependencies: z.array(z.string()),
  blockedBy: z.array(z.string()).optional(),
  dependents: z.array(z.string()).optional(),
  worktreeId: z.string().optional(),
  assignedAgentId: z.string().optional(),
  runId: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  result: TaskResultSchema.optional(),
  routingHints: TaskRoutingHintsSchema.optional(),
});

const TaskQueueStateSchema = z.object({
  version: z.literal(SCHEMA_VERSION),
  tasks: z.array(TaskRecordSchema),
  lastUpdated: z.number(),
});

export interface TaskQueueState {
  version: string;
  tasks: TaskRecord[];
  lastUpdated: number;
}

export class TaskPersistence {
  private projectsConfigDir: string;
  private saveDebounceMs: number;
  private pendingSaves: Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      state: TaskQueueState;
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

  private getTasksFilePath(projectId: string): string | null {
    if (!this.isValidProjectId(projectId)) {
      return null;
    }
    const stateDir = path.join(this.projectsConfigDir, projectId);
    const normalized = path.normalize(stateDir);
    if (!normalized.startsWith(this.projectsConfigDir + path.sep)) {
      return null;
    }
    return path.join(normalized, TASKS_FILENAME);
  }

  async load(projectId: string): Promise<TaskRecord[]> {
    const filePath = this.getTasksFilePath(projectId);
    if (!filePath || !existsSync(filePath)) {
      return [];
    }

    try {
      const content = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(content);
      const validated = TaskQueueStateSchema.parse(parsed);

      console.log(
        `[TaskPersistence] Loaded ${validated.tasks.length} tasks for project ${projectId}`
      );
      return validated.tasks as TaskRecord[];
    } catch (error) {
      console.error(`[TaskPersistence] Failed to load tasks for ${projectId}:`, error);

      if (filePath) {
        try {
          const timestamp = Date.now();
          const quarantinePath = `${filePath}.corrupted.${timestamp}`;
          await fs.rename(filePath, quarantinePath);
          console.warn(`[TaskPersistence] Corrupted tasks file moved to ${quarantinePath}`);
        } catch (quarantineError) {
          console.error(
            `[TaskPersistence] Failed to quarantine corrupted file: ${filePath}`,
            quarantineError
          );
        }
      }

      return [];
    }
  }

  async save(projectId: string, tasks: TaskRecord[]): Promise<void> {
    if (!this.getTasksFilePath(projectId)) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    const state: TaskQueueState = {
      version: SCHEMA_VERSION,
      tasks,
      lastUpdated: Date.now(),
    };

    // Get or create pending save entry for this project
    let pending = this.pendingSaves.get(projectId);

    if (pending) {
      // Clear existing timer and update state
      clearTimeout(pending.timer);
      pending.state = state;
    } else {
      // Create new pending save entry
      pending = {
        timer: null as unknown as ReturnType<typeof setTimeout>,
        state,
        resolvers: [],
        rejecters: [],
      };
      this.pendingSaves.set(projectId, pending);
    }

    // Create a promise for this caller
    const promise = new Promise<void>((resolve, reject) => {
      pending!.resolvers.push(resolve);
      pending!.rejecters.push(reject);
    });

    // Set new timer
    pending.timer = setTimeout(async () => {
      const entry = this.pendingSaves.get(projectId);
      if (!entry) return;

      this.pendingSaves.delete(projectId);

      try {
        await this.saveImmediate(projectId, entry.state);
        // Resolve all waiting callers
        entry.resolvers.forEach((r) => r());
      } catch (error) {
        // Reject all waiting callers
        entry.rejecters.forEach((r) => r(error));
      }
    }, this.saveDebounceMs);

    return promise;
  }

  async saveImmediate(projectId: string, state: TaskQueueState): Promise<void> {
    // Check if there's already an in-flight save for this project
    const inFlight = this.inFlightSaves.get(projectId);
    if (inFlight) {
      await inFlight;
    }

    const filePath = this.getTasksFilePath(projectId);
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

    // Track this save as in-flight
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

      console.log(`[TaskPersistence] Saved ${state.tasks.length} tasks for project ${projectId}`);
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
        // Resolve all waiting callers
        pending.resolvers.forEach((r) => r());
      } catch (error) {
        // Reject all waiting callers
        pending.rejecters.forEach((r) => r(error));
        throw error;
      }
    }

    // Also wait for any in-flight save to complete
    const inFlight = this.inFlightSaves.get(projectId);
    if (inFlight) {
      await inFlight;
    }
  }

  async clear(projectId: string): Promise<void> {
    const pending = this.pendingSaves.get(projectId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingSaves.delete(projectId);
      pending.resolvers.forEach((resolve) => resolve());
    }

    const inFlight = this.inFlightSaves.get(projectId);
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        // Best-effort clear: continue to file deletion even if in-flight save failed.
      }
    }

    const filePath = this.getTasksFilePath(projectId);
    if (filePath && existsSync(filePath)) {
      try {
        await fs.unlink(filePath);
        console.log(`[TaskPersistence] Cleared tasks for project ${projectId}`);
      } catch (error) {
        console.error(`[TaskPersistence] Failed to clear tasks for ${projectId}:`, error);
      }
    }
  }
}

export const taskPersistence = new TaskPersistence();
