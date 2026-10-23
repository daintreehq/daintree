import { randomUUID } from "node:crypto";
import {
  PLUGIN_TASK_MAX_INTERRUPTED,
  PLUGIN_TASK_MAX_LIVE,
  PLUGIN_TASK_PROGRESS_COALESCE_MS,
  type PluginTaskProgress,
  type PluginTaskSnapshot,
} from "../../../shared/types/plugin.js";

/**
 * One task main holds. The record object is the task's identity: a handle
 * holds the record it was given, and every transition checks that record is
 * still the one in the registry, so a handle left over from an unload or a
 * worker swap never touches anything.
 */
export interface PluginTaskRecord {
  readonly snapshot: PluginTaskSnapshot;
  readonly controller: AbortController;
  /**
   * The plugin's retry action, in its manifest namespace, as notify takes it.
   * Null once interrupted: nothing will ever offer it.
   */
  readonly retry: { actionId: string; args?: Record<string, unknown> } | null;
}

/**
 * What an interrupted record holds in place of its task's controller: already
 * aborted, and never handed to anyone, so a listener the plugin left on the
 * real signal isn't kept alive by a row waiting to be dismissed.
 */
const STOPPED = new AbortController();
STOPPED.abort();

export interface PluginTaskStartInput {
  pluginName: string;
  title: string;
  detail?: string;
  cancellable: boolean;
  fraction: number | null;
  retry: { actionId: string; args?: Record<string, unknown> };
}

/** What {@link PluginTaskRegistry.finish} hands back to the caller that claimed the end. */
export interface PluginTaskClaim {
  title: string;
  retry: { actionId: string; args?: Record<string, unknown> };
  /** The user asked for it to stop, so whatever it ended with shows nothing. */
  cancelRequested: boolean;
}

/**
 * Main's record of plugin tasks (#13819), keyed `pluginId → taskId`. The single
 * owner of every task transition: start, progress, the user's cancel, the
 * plugin's finish, and the interruption an unload or a worker swap forces. Each
 * is idempotent, and the first terminal one wins, so a cancel racing a finish
 * or an unload racing either is settled here and nowhere else.
 *
 * Progress is applied at once but published at most once per window per
 * plugin. The window is fixed from the first report, never re-armed, so a
 * plugin reporting continuously still publishes every window. Every other
 * change publishes immediately and takes the pending window with it, so an
 * older progress snapshot can never land after the change that superseded it.
 *
 * Interrupted tasks stay, without their controller or retry, until the user
 * dismisses them or the plugin piles up more than
 * {@link PLUGIN_TASK_MAX_INTERRUPTED}, so "this stopped when the plugin went"
 * stays visible after the plugin has gone.
 */
export class PluginTaskRegistry {
  private readonly tasks = new Map<string, Map<string, PluginTaskRecord>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(
    private readonly publish: (pluginId: string) => void,
    private readonly coalesceMs: number = PLUGIN_TASK_PROGRESS_COALESCE_MS,
    private readonly now: () => number = Date.now
  ) {}

  /** Unfinished tasks, which are the ones the cap and idle disposal count. */
  liveCount(pluginId: string): number {
    let count = 0;
    for (const record of this.tasks.get(pluginId)?.values() ?? []) {
      if (record.snapshot.state !== "interrupted") count++;
    }
    return count;
  }

  /** Admit a task, or throw when the plugin already holds {@link PLUGIN_TASK_MAX_LIVE}. */
  start(pluginId: string, input: PluginTaskStartInput): PluginTaskRecord {
    if (this.disposed) throw new Error("plugin task registry is disposed");
    if (this.liveCount(pluginId) >= PLUGIN_TASK_MAX_LIVE) {
      throw new Error(
        `already has ${PLUGIN_TASK_MAX_LIVE} unfinished tasks — finish one before starting another`
      );
    }
    const record: PluginTaskRecord = {
      snapshot: {
        id: randomUUID(),
        pluginId,
        pluginName: input.pluginName,
        title: input.title,
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
        fraction: input.fraction,
        cancellable: input.cancellable,
        state: "working",
        startedAt: this.now(),
      },
      controller: new AbortController(),
      retry: input.retry,
    };
    let byId = this.tasks.get(pluginId);
    if (!byId) {
      byId = new Map();
      this.tasks.set(pluginId, byId);
    }
    byId.set(record.snapshot.id, record);
    this.publishNow(pluginId);
    return record;
  }

  /** Apply a vetted progress report. A report on a task that has ended is dropped. */
  report(record: PluginTaskRecord, progress: PluginTaskProgress): void {
    if (!this.isLive(record)) return;
    const { snapshot } = record;
    let changed = false;
    if (progress.fraction !== undefined && progress.fraction !== snapshot.fraction) {
      snapshot.fraction = progress.fraction;
      changed = true;
    }
    if (progress.detail !== undefined && progress.detail !== (snapshot.detail ?? "")) {
      if (progress.detail.length === 0) delete snapshot.detail;
      else snapshot.detail = progress.detail;
      changed = true;
    }
    if (changed) this.publishSoon(snapshot.pluginId);
  }

  /**
   * Claim the end of a task for the plugin's own finish. Returns null when the
   * task already ended or was interrupted, so only the first finish counts.
   */
  finish(record: PluginTaskRecord): PluginTaskClaim | null {
    const { snapshot, retry } = record;
    const byId = this.tasks.get(snapshot.pluginId);
    // Live records always carry a retry; only interruption drops it.
    if (!byId || !this.isLive(record) || retry === null) return null;
    byId.delete(snapshot.id);
    if (byId.size === 0) this.tasks.delete(snapshot.pluginId);
    this.publishNow(snapshot.pluginId);
    return {
      title: snapshot.title,
      retry,
      cancelRequested: snapshot.state === "cancelling",
    };
  }

  /**
   * The user's Cancel. Marks the task cancelling, publishes that, then aborts
   * the plugin's signal, so a plugin that finishes from inside its abort
   * listener finds the request already recorded.
   */
  requestCancel(pluginId: string, taskId: string): boolean {
    const record = this.tasks.get(pluginId)?.get(taskId);
    if (!record || record.snapshot.state !== "working" || !record.snapshot.cancellable) {
      return false;
    }
    record.snapshot.state = "cancelling";
    this.publishNow(pluginId);
    record.controller.abort();
    return true;
  }

  /**
   * Mark every unfinished task of a plugin interrupted: its backend is going
   * (unload, a crash, a restart). Each is marked before its signal aborts, so a
   * plugin that finishes as it stops lands on an interrupted task and changes
   * nothing.
   */
  interrupt(pluginId: string): void {
    const byId = this.tasks.get(pluginId);
    if (!byId) return;
    const stopping: AbortController[] = [];
    for (const [taskId, record] of byId) {
      if (record.snapshot.state === "interrupted") continue;
      const snapshot: PluginTaskSnapshot = { ...record.snapshot, state: "interrupted" };
      // A fresh record: the old one stays with the handles that held it, and
      // stops being the registry's, so nothing they do lands here again.
      byId.set(taskId, { snapshot, controller: STOPPED, retry: null });
      stopping.push(record.controller);
    }
    if (stopping.length === 0) return;
    const interrupted = [...byId.values()].filter((r) => r.snapshot.state === "interrupted");
    for (const record of interrupted.slice(0, -PLUGIN_TASK_MAX_INTERRUPTED)) {
      byId.delete(record.snapshot.id);
    }
    this.publishNow(pluginId);
    for (const controller of stopping) controller.abort();
  }

  /** The user's Dismiss. Only an interrupted task can be dismissed. */
  dismiss(pluginId: string, taskId: string): boolean {
    const byId = this.tasks.get(pluginId);
    const record = byId?.get(taskId);
    if (!byId || !record || record.snapshot.state !== "interrupted") return false;
    byId.delete(taskId);
    if (byId.size === 0) this.tasks.delete(pluginId);
    this.publishNow(pluginId);
    return true;
  }

  /** The plugin's complete task list, oldest first. Empty once it has none. */
  snapshot(pluginId: string): PluginTaskSnapshot[] {
    return [...(this.tasks.get(pluginId)?.values() ?? [])].map((record) => ({
      ...record.snapshot,
    }));
  }

  /** Every plugin holding a task, live or interrupted, for a restored view's replay. */
  pluginIds(): string[] {
    return [...this.tasks.keys()];
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const byId of this.tasks.values()) {
      for (const record of byId.values()) record.controller.abort();
    }
    this.tasks.clear();
  }

  private isLive(record: PluginTaskRecord): boolean {
    const { snapshot } = record;
    return (
      this.tasks.get(snapshot.pluginId)?.get(snapshot.id) === record &&
      snapshot.state !== "interrupted"
    );
  }

  private publishSoon(pluginId: string): void {
    if (this.disposed || this.timers.has(pluginId)) return;
    this.timers.set(
      pluginId,
      setTimeout(() => {
        this.timers.delete(pluginId);
        if (!this.disposed) this.publish(pluginId);
      }, this.coalesceMs)
    );
  }

  private publishNow(pluginId: string): void {
    const timer = this.timers.get(pluginId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(pluginId);
    }
    if (!this.disposed) this.publish(pluginId);
  }
}
