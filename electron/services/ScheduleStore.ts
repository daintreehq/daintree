import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { resilientAtomicWriteFile, resilientRename, resilientUnlink } from "../utils/fs.js";
import { AppError } from "../utils/errorTypes.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { schedulesFilePath } from "./projectStorePaths.js";
import { decodeSchedulesFile, encodeSchedulesFile, type SchedulesFile } from "./schedulesCodec.js";
import { createSchedule, normalizeCadence } from "../../shared/utils/scheduledRuns.js";
import { scheduleIssues, type ScheduleIssue } from "../../shared/utils/scheduleValidation.js";
import {
  SCHEDULE_SWITCHES_OFF,
  type ProjectScheduleSwitches,
  type Schedule,
} from "../../shared/types/scheduledRuns.js";
import type {
  ScheduleCreateInput,
  ScheduleCreateOutcome,
  ScheduleRemoveOutcome,
  ScheduleSetEnabledOutcome,
  ScheduleSetSwitchesOutcome,
  ScheduleSwitchesPatch,
  ScheduleUpdateOutcome,
  ScheduleUpdatePatch,
  SchedulesSnapshot,
} from "../../shared/types/ipc/schedules.js";

/** Called after every committed change, in commit order for each project. */
export type SchedulesListener = (snapshot: SchedulesSnapshot) => void;

export const START_WHEN_CLOSED_PATH = "switches.startWhenClosed";

const EMPTY: SchedulesFile = { switches: SCHEDULE_SWITCHES_OFF, schedules: [] };

/**
 * A project's schedules (#15975) and its switches for them (#16166), in
 * `schedules.json` in the project's local state directory. It is given that directory's root and project ids, never a
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
    private readonly now: () => number = Date.now,
    /**
     * Deletes what a removed schedule leaves behind, its run history (#15976).
     * Runs in the schedule's turn once its removal is committed; a failure is
     * logged and never undoes the removal.
     */
    private readonly forgetSchedule: (
      projectId: string,
      scheduleId: string
    ) => Promise<void> | void = () => {},
    /**
     * What this machine refuses in a schedule the schema accepts: the option
     * to start Daintree when it isn't running, for a cadence its OS job can't
     * hold (#15990). Asked only of a write, never of a read, so a stored
     * schedule never stops loading because the machine changed.
     */
    private readonly writeIssues: (schedule: Schedule) => ScheduleIssue[] = () => [],
    /**
     * Why this machine can never start Daintree for schedules (no OS job on
     * the platform, a Microsoft Store build), or null. Asked only when the
     * project's switch for it is turned on.
     */
    private readonly startWhenClosedIssue: () => string | null = () => null
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
      const issues = this.issuesFor(schedule);
      if (issues.length > 0) return { status: "invalid", issues };
      const current = await this.read(projectId);
      const snapshot = await this.commit(projectId, {
        ...current,
        schedules: [...current.schedules, schedule],
      });
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
      const index = current.schedules.findIndex((schedule) => schedule.id === scheduleId);
      const existing = current.schedules[index];
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
      const issues = this.issuesFor(schedule);
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
      const index = current.schedules.findIndex((schedule) => schedule.id === scheduleId);
      const existing = current.schedules[index];
      if (!existing) return { status: "not-found", snapshot: this.snapshot(projectId, current) };
      if (existing.enabled === enabled) {
        return { status: "saved", schedule: existing, snapshot: this.snapshot(projectId, current) };
      }
      const schedule: Schedule = { ...existing, enabled, updatedAt: this.nextUpdatedAt(existing) };
      const snapshot = await this.commit(projectId, replaceAt(current, index, schedule));
      return { status: "saved", schedule, snapshot };
    });
  }

  /**
   * Turns the project's schedules on or off, or Daintree starting for them
   * (#16166). An intent, so it takes no version; one already as asked
   * changes nothing. Turning schedules on stamps `schedulesOnSince`, so
   * what came due while they were off is never caught up, even after a
   * restart. Neither switch touches a schedule, its history or open runs.
   */
  setSwitches(
    projectId: string,
    patch: ScheduleSwitchesPatch
  ): Promise<ScheduleSetSwitchesOutcome> {
    return this.enqueue(projectId, async () => {
      this.requireProject(projectId);
      const current = await this.read(projectId);
      const before = current.switches;
      const schedulesOn = patch.schedulesOn ?? before.schedulesOn;
      const startWhenClosed = patch.startWhenClosed ?? before.startWhenClosed;
      if (schedulesOn === before.schedulesOn && startWhenClosed === before.startWhenClosed) {
        return { status: "saved", snapshot: this.snapshot(projectId, current) };
      }
      if (startWhenClosed && !before.startWhenClosed) {
        const message = this.startWhenClosedIssue();
        if (message !== null) {
          return {
            status: "invalid",
            issues: [{ path: START_WHEN_CLOSED_PATH, cronField: null, message }],
          };
        }
      }
      const switches: ProjectScheduleSwitches = {
        schedulesOn,
        startWhenClosed,
        schedulesOnSince: schedulesOn && !before.schedulesOn ? this.now() : before.schedulesOnSince,
      };
      const snapshot = await this.commit(projectId, { ...current, switches });
      return { status: "saved", snapshot };
    });
  }

  remove(projectId: string, scheduleId: string): Promise<ScheduleRemoveOutcome> {
    return this.enqueue(projectId, async () => {
      this.requireProject(projectId);
      const current = await this.read(projectId);
      const schedules = current.schedules.filter((schedule) => schedule.id !== scheduleId);
      if (schedules.length === current.schedules.length) {
        return { status: "removed", snapshot: this.snapshot(projectId, current) };
      }
      const snapshot = await this.commit(projectId, { ...current, schedules });
      try {
        await this.forgetSchedule(projectId, scheduleId);
      } catch (error) {
        console.error(
          `[ScheduleStore] Couldn't delete the run history of schedule ${scheduleId}: ${formatErrorMessage(error, "unknown error")}`
        );
      }
      return { status: "removed", snapshot };
    });
  }

  /**
   * Deletes a removed project's schedules, by default just its file, and tells
   * every listener they're gone. Called once the project's row is deleted: an
   * edit that started before then finishes first, and every turn after refuses.
   * `removeFiles` runs inside the turn, so a caller removing the project's
   * whole state directory does it before an edit for the same project, added
   * again at once, can write there.
   */
  removeProject(
    projectId: string,
    removeFiles: () => Promise<void> = () => this.unlinkFile(projectId)
  ): Promise<void> {
    return this.enqueue(projectId, async () => {
      try {
        await removeFiles();
      } finally {
        this.revision += 1;
        this.notify(this.snapshot(projectId, EMPTY));
      }
    });
  }

  private async unlinkFile(projectId: string): Promise<void> {
    const filePath = schedulesFilePath(this.projectsConfigDir, projectId);
    if (!filePath) return;
    try {
      await resilientUnlink(filePath);
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }

  private issuesFor(schedule: Schedule): ScheduleIssue[] {
    const issues = scheduleIssues(schedule);
    return issues.length > 0 ? issues : this.writeIssues(schedule);
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

  private snapshot(projectId: string, file: SchedulesFile): SchedulesSnapshot {
    return {
      projectId,
      switches: file.switches,
      schedules: file.schedules,
      revision: this.revision,
    };
  }

  private async commit(projectId: string, file: SchedulesFile): Promise<SchedulesSnapshot> {
    await this.write(projectId, file);
    this.revision += 1;
    const snapshot = this.snapshot(projectId, file);
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
   * Unqueued: only ever called inside a turn. A missing file is no schedules,
   * with both switches off. An unreadable one is moved aside and read the
   * same, but if it can't be moved this throws: reporting none would let the
   * next write replace bytes that were never preserved.
   */
  private async read(projectId: string): Promise<SchedulesFile> {
    const filePath = schedulesFilePath(this.projectsConfigDir, projectId);
    if (!filePath) return EMPTY;

    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch (error) {
      if (isEnoent(error)) return EMPTY;
      throw error;
    }

    const decoded = decodeSchedulesFile(raw, projectId);
    if (decoded.ok) return { switches: decoded.switches, schedules: decoded.schedules };

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
    return EMPTY;
  }

  private async write(projectId: string, file: SchedulesFile): Promise<void> {
    const filePath = schedulesFilePath(this.projectsConfigDir, projectId);
    if (!filePath) {
      throw new AppError({
        code: "VALIDATION",
        message: `schedules: ${projectId} is not a project id`,
      });
    }
    const content = encodeSchedulesFile(file);
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

function replaceAt(file: SchedulesFile, index: number, schedule: Schedule): SchedulesFile {
  return {
    ...file,
    schedules: file.schedules.map((existing, at) => (at === index ? schedule : existing)),
  };
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
