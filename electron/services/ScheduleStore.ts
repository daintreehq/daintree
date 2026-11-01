import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { resilientAtomicWriteFile, resilientRename, resilientUnlink } from "../utils/fs.js";
import { AppError } from "../utils/errorTypes.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { schedulesFilePath } from "./projectStorePaths.js";
import { decodeSchedulesFile, encodeSchedulesFile } from "./schedulesCodec.js";
import { createSchedule, normalizeCadence } from "../../shared/utils/scheduledRuns.js";
import { scheduleIssues } from "../../shared/utils/scheduleValidation.js";
import type { Schedule } from "../../shared/types/scheduledRuns.js";
import type {
  ScheduleCreateInput,
  ScheduleCreateOutcome,
  ScheduleRemoveOutcome,
  ScheduleSetEnabledOutcome,
  ScheduleUpdateOutcome,
  ScheduleUpdatePatch,
  SchedulesSnapshot,
} from "../../shared/types/ipc/schedules.js";

/** Called after every committed change, in commit order for each project. */
export type SchedulesListener = (snapshot: SchedulesSnapshot) => void;

/**
 * A project's schedules (#15975), in `schedules.json` in the project's local
 * state directory. It is given that directory's root and project ids, never a
 * repository path, so nothing in a project's `.daintree/` can reach it.
 *
 * Every read and write takes a turn in a per-project queue: a read can
 * quarantine an unreadable file, and two edits must not both build on the same
 * snapshot. Main is the only writer; views and the scheduler hear of each
 * change through {@link subscribe}.
 */
export class ScheduleStore {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<SchedulesListener>();
  private revision = 0;

  constructor(
    private readonly projectsConfigDir: string,
    /** Whether the project is registered; a removed project's schedules can't be written. */
    private readonly projectExists: (projectId: string) => boolean,
    private readonly now: () => number = Date.now
  ) {}

  /** Hears every committed change. Returns its unsubscribe. */
  subscribe(listener: SchedulesListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  list(projectId: string): Promise<SchedulesSnapshot> {
    return this.enqueue(projectId, async () =>
      this.snapshot(projectId, await this.read(projectId))
    );
  }

  async get(projectId: string, scheduleId: string): Promise<Schedule | null> {
    const { schedules } = await this.list(projectId);
    return schedules.find((schedule) => schedule.id === scheduleId) ?? null;
  }

  create(projectId: string, input: ScheduleCreateInput): Promise<ScheduleCreateOutcome> {
    return this.enqueue(projectId, async () => {
      this.requireProject(projectId);
      const schedule = createSchedule({ ...input, id: randomUUID(), projectId }, this.now());
      const issues = scheduleIssues(schedule);
      if (issues.length > 0) return { status: "invalid", issues };
      const schedules = [...(await this.read(projectId)), schedule];
      const snapshot = await this.commit(projectId, schedules);
      return { status: "saved", schedule, snapshot };
    });
  }

  /**
   * Apply an edit made from the version stamped `expectedUpdatedAt`. A schedule
   * changed since, by any view or by main, wins: the edit is refused as a
   * conflict and nothing is saved.
   */
  update(
    projectId: string,
    scheduleId: string,
    expectedUpdatedAt: number,
    patch: ScheduleUpdatePatch
  ): Promise<ScheduleUpdateOutcome> {
    return this.enqueue(projectId, async () => {
      this.requireProject(projectId);
      const current = await this.read(projectId);
      const index = current.findIndex((schedule) => schedule.id === scheduleId);
      const existing = current[index];
      if (!existing) return { status: "not-found", snapshot: this.snapshot(projectId, current) };
      if (existing.updatedAt !== expectedUpdatedAt) {
        return {
          status: "conflict",
          schedule: existing,
          snapshot: this.snapshot(projectId, current),
        };
      }
      const schedule: Schedule = {
        ...existing,
        ...(patch.name !== undefined && { name: patch.name.trim() }),
        ...(patch.cadence !== undefined && { cadence: normalizeCadence(patch.cadence) }),
        ...(patch.launch !== undefined && { launch: { ...patch.launch } }),
        ...(patch.policies !== undefined && { policies: { ...patch.policies } }),
        updatedAt: this.nextUpdatedAt(existing),
      };
      const issues = scheduleIssues(schedule);
      if (issues.length > 0) return { status: "invalid", issues };
      const snapshot = await this.commit(projectId, replaceAt(current, index, schedule));
      return { status: "saved", schedule, snapshot };
    });
  }

  setEnabled(
    projectId: string,
    scheduleId: string,
    enabled: boolean
  ): Promise<ScheduleSetEnabledOutcome> {
    return this.enqueue(projectId, async () => {
      this.requireProject(projectId);
      const current = await this.read(projectId);
      const index = current.findIndex((schedule) => schedule.id === scheduleId);
      const existing = current[index];
      if (!existing) return { status: "not-found", snapshot: this.snapshot(projectId, current) };
      if (existing.enabled === enabled) {
        return { status: "saved", schedule: existing, snapshot: this.snapshot(projectId, current) };
      }
      const schedule: Schedule = { ...existing, enabled, updatedAt: this.nextUpdatedAt(existing) };
      const snapshot = await this.commit(projectId, replaceAt(current, index, schedule));
      return { status: "saved", schedule, snapshot };
    });
  }

  remove(projectId: string, scheduleId: string): Promise<ScheduleRemoveOutcome> {
    return this.enqueue(projectId, async () => {
      this.requireProject(projectId);
      const current = await this.read(projectId);
      const schedules = current.filter((schedule) => schedule.id !== scheduleId);
      if (schedules.length === current.length) {
        return { status: "removed", snapshot: this.snapshot(projectId, current) };
      }
      return { status: "removed", snapshot: await this.commit(projectId, schedules) };
    });
  }

  /**
   * Deletes a removed project's schedules and tells every listener they're
   * gone. Called once the project's row is deleted: an edit that started
   * before then finishes first, and every turn after it refuses, so nothing
   * writes the file again.
   */
  removeProject(projectId: string): Promise<void> {
    return this.enqueue(projectId, async () => {
      const filePath = schedulesFilePath(this.projectsConfigDir, projectId);
      if (!filePath) return;
      try {
        await resilientUnlink(filePath);
      } catch (error) {
        if (!isEnoent(error)) throw error;
      }
      this.revision += 1;
      this.notify(this.snapshot(projectId, []));
    });
  }

  // Strictly after the stored stamp, so an edit in the same millisecond, or
  // after the clock went back, still reads as a change to `update`'s check.
  private nextUpdatedAt(existing: Schedule): number {
    return Math.max(this.now(), existing.updatedAt + 1);
  }

  private requireProject(projectId: string): void {
    if (this.projectExists(projectId)) return;
    throw new AppError({
      code: "NOT_FOUND",
      message: `schedules: project ${projectId} is not registered`,
    });
  }

  private snapshot(projectId: string, schedules: Schedule[]): SchedulesSnapshot {
    return { projectId, schedules, revision: this.revision };
  }

  private async commit(projectId: string, schedules: Schedule[]): Promise<SchedulesSnapshot> {
    await this.write(projectId, schedules);
    this.revision += 1;
    const snapshot = this.snapshot(projectId, schedules);
    this.notify(snapshot);
    return snapshot;
  }

  private notify(snapshot: SchedulesSnapshot): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error(
          `[ScheduleStore] A listener failed for project ${snapshot.projectId}: ${formatErrorMessage(error, "unknown error")}`
        );
      }
    }
  }

  /**
   * Unqueued: only ever called inside a turn. A missing file is no schedules.
   * An unreadable one is moved aside and read as none, but if it can't be
   * moved this throws: reporting none would let the next write replace bytes
   * that were never preserved.
   */
  private async read(projectId: string): Promise<Schedule[]> {
    const filePath = schedulesFilePath(this.projectsConfigDir, projectId);
    if (!filePath) return [];

    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch (error) {
      if (isEnoent(error)) return [];
      throw error;
    }

    const decoded = decodeSchedulesFile(raw, projectId);
    if (decoded.ok) return decoded.schedules;

    const quarantinePath =
      decoded.reason === "future-version"
        ? `${filePath}.future-v${decoded.onDiskVersion}`
        : `${filePath}.corrupted.${this.now()}`;
    const target = existsSync(quarantinePath)
      ? `${quarantinePath}.${randomUUID()}`
      : quarantinePath;
    try {
      await resilientRename(filePath, target);
    } catch (error) {
      throw new AppError({
        code: "PERSIST_FAILED",
        message: `schedules: the file for project ${projectId} is unreadable and couldn't be moved aside (${formatErrorMessage(error, "rename failed")}); leaving it untouched`,
      });
    }
    console.warn(
      `[ScheduleStore] Schedules for project ${projectId} were unreadable (${decoded.reason}); moved to ${path.basename(target)}`
    );
    return [];
  }

  private async write(projectId: string, schedules: Schedule[]): Promise<void> {
    const filePath = schedulesFilePath(this.projectsConfigDir, projectId);
    if (!filePath) {
      throw new AppError({
        code: "VALIDATION",
        message: `schedules: ${projectId} is not a project id`,
      });
    }
    const content = encodeSchedulesFile(schedules);
    try {
      await resilientAtomicWriteFile(filePath, content, "utf-8");
    } catch (error) {
      if (!isEnoent(error)) throw error;
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await resilientAtomicWriteFile(filePath, content, "utf-8");
    }
  }

  // One turn at a time per project. A failed turn rejects only its own caller;
  // the next starts regardless, and the map drops the tail once it settles.
  private enqueue<T>(projectId: string, turn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(turn);
    this.queues.set(projectId, next);
    const cleanup = () => {
      if (this.queues.get(projectId) === next) this.queues.delete(projectId);
    };
    next.then(cleanup, cleanup);
    return next;
  }
}

function replaceAt(schedules: Schedule[], index: number, schedule: Schedule): Schedule[] {
  return schedules.map((existing, at) => (at === index ? schedule : existing));
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
