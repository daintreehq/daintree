// Processes and tasks for the dev worker's host proxy (#9304, #14331). The
// real process and task live in main; the handles built here address them by
// the id main assigned, and a late answer to a start this worker gave up on is
// released here, by the facet that knows what it names.

import type {
  PluginHostApi,
  PluginProcessHandle,
  PluginDuplexProcessHandle,
  PluginPtyProcessHandle,
  PluginProcessDataChunk,
  PluginProcessMode,
  PluginTaskHandle,
  PluginTaskProgress,
} from "../../../shared/types/plugin.js";
import { PLUGIN_TASK_PROGRESS_COALESCE_MS } from "../../../shared/types/plugin.js";
import {
  inertPluginTaskHandle,
  mergePluginTaskProgress,
  pluginTaskAbortCause,
  pluginTaskAbortReason,
  validatePluginTaskProgress,
  validatePluginTaskResult,
  validatePluginTaskStart,
} from "../../../shared/utils/pluginTasks.js";
import type {
  TaskAbortEvent,
  TaskFinishParams,
  TaskReportParams,
  TaskStartParams,
  TaskStartResult,
} from "../../../shared/types/pluginDevWorker.js";
import type { HostProxyFacetDeps, PluginDevWorkerRpc } from "./pluginDevWorkerRpcClient.js";

export type ProcessHostApi = Pick<PluginHostApi, "tasks" | "process">;

export class PluginDevWorkerProcessFacet {
  readonly api: ProcessHostApi;
  private readonly rpc: PluginDevWorkerRpc;
  private readonly pluginId: string;
  /** Task progress waiting for the next `tasks.report`, the latest per task id (#13819). */
  private readonly pendingTaskReports = new Map<string, PluginTaskProgress>();
  private taskReportTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: HostProxyFacetDeps) {
    this.rpc = deps.rpc;
    this.pluginId = deps.pluginId;
    this.api = this.buildApi();
  }

  dispose(): void {
    if (this.taskReportTimer !== null) clearTimeout(this.taskReportTimer);
    this.taskReportTimer = null;
    this.pendingTaskReports.clear();
  }

  /**
   * A `tasks.start` this worker gave up on (#13819) whose answer arrived
   * anyway: it names a task nobody here can finish, so it is ended quietly
   * rather than left running against the plugin's cap.
   */
  private finishAbandonedTaskStart(late: unknown): void {
    const taskId = typeof late === "object" && late !== null ? Reflect.get(late, "id") : undefined;
    const inert = typeof late === "object" && late !== null && Reflect.get(late, "inert") === true;
    if (typeof taskId !== "string" || inert) return;
    const params: TaskFinishParams = { taskId, result: { outcome: "cancelled" } };
    this.rpc.call<void>("tasks.finish", params).catch(() => {
      // best-effort — the bridge forgets its handles at teardown regardless
    });
  }

  /**
   * A `process.spawn` this worker gave up on (#13410) whose answer arrived
   * anyway: main spawned it, and nothing else will ever learn the process id,
   * so it is killed now.
   */
  private killAbandonedSpawn(late: unknown): void {
    const id = (late as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string") return;
    try {
      this.rpc.notify("process.kill", { processId: id });
    } catch {
      // best-effort — the bridge kills it at teardown regardless
    }
  }

  /**
   * A worker-side task handle for a task main started (#13819). Progress is
   * held per task and sent in one `tasks.report` per window, so a plugin
   * reporting on every item crosses the port at most once per window.
   */
  private buildTaskHandle(
    taskId: string,
    controller: AbortController,
    subscriptionId: string
  ): PluginTaskHandle {
    let finished = false;
    return {
      id: taskId,
      signal: controller.signal,
      report: (progress) => {
        const vetted = validatePluginTaskProgress(progress);
        if (!vetted.ok) throw new Error(`Plugin "${this.pluginId}" task.report: ${vetted.error}`);
        if (finished || this.rpc.disposed) return;
        this.pendingTaskReports.set(
          taskId,
          mergePluginTaskProgress(this.pendingTaskReports.get(taskId), vetted.value)
        );
        // A fixed window from the first report, never re-armed, so continuous
        // reporting still sends one batch per window.
        this.taskReportTimer ??= setTimeout(
          () => this.flushTaskReports(),
          PLUGIN_TASK_PROGRESS_COALESCE_MS
        );
      },
      finish: (result) => {
        const vetted = validatePluginTaskResult(result);
        if (!vetted.ok) {
          return Promise.reject(
            new Error(`Plugin "${this.pluginId}" task.finish: ${vetted.error}`)
          );
        }
        if (finished) return Promise.resolve();
        finished = true;
        // Progress still waiting would only redraw a task that is ending.
        this.pendingTaskReports.delete(taskId);
        this.rpc.deleteSubscription(subscriptionId);
        const params: TaskFinishParams = { taskId, result: vetted.value };
        return this.rpc.callWithGrace<void>("tasks.finish", params, undefined);
      },
    };
  }

  private flushTaskReports(): void {
    this.taskReportTimer = null;
    if (this.rpc.disposed || this.pendingTaskReports.size === 0) return;
    const params: TaskReportParams = {
      reports: [...this.pendingTaskReports].map(([taskId, progress]) => ({ taskId, progress })),
    };
    this.pendingTaskReports.clear();
    this.rpc.notify("tasks.report", params);
  }

  /**
   * Build a worker-side {@link PluginProcessHandle} proxy for a process the host
   * spawned on our behalf, addressing it by the host-assigned `id`. `interactive`
   * comes from the host's reported mode, so `write`/`resize` exist only when
   * there is a real PTY behind them.
   */
  private buildProcessHandle(id: string, mode: PluginProcessMode): PluginProcessHandle {
    const subscribeLifecycle = (
      kind: "process-exit" | "process-crash",
      callback: (info: { exitCode: number | null; signal: string | null }) => void
    ): (() => void) =>
      this.rpc.openSubscription(
        { type: "subscribe", subscriptionId: this.rpc.nextSubscriptionId(), kind, processId: id },
        (payload) => callback(payload as { exitCode: number | null; signal: string | null })
      );
    const base: PluginProcessHandle = {
      id,
      kill: () => {
        // Sync in the public contract — fire-and-forget over the port.
        this.rpc.notify("process.kill", { processId: id });
      },
      restart: () => this.rpc.call<void>("process.restart", { processId: id }),
      onExit: (callback) => subscribeLifecycle("process-exit", callback),
      onCrash: (callback) => subscribeLifecycle("process-crash", callback),
      onData: (callback) =>
        this.rpc.openSubscription(
          {
            type: "subscribe",
            subscriptionId: this.rpc.nextSubscriptionId(),
            kind: "process-data",
            processId: id,
          },
          (payload) => callback(payload as PluginProcessDataChunk)
        ),
    };
    if (mode === "pipe") return base;
    // Void in the public contract, like `kill` — fire-and-forget over the port.
    const writableHandle: PluginDuplexProcessHandle = {
      ...base,
      write: (data) => this.rpc.notify("process.write", { processId: id, data }),
    };
    if (mode === "duplex") return writableHandle;
    const ptyHandle: PluginPtyProcessHandle = {
      ...writableHandle,
      resize: (cols, rows) => this.rpc.notify("process.resize", { processId: id, cols, rows }),
    };
    return ptyHandle;
  }

  private buildApi(): ProcessHostApi {
    return {
      tasks: {
        // The real task lives in main's registry; `start` relays over the port
        // and returns a handle addressing it by id (#13819). The user's Cancel
        // comes back as a subscription event that aborts this side's signal,
        // since a signal can't cross the port.
        start: (options) => {
          if (this.rpc.disposed) return Promise.resolve(inertPluginTaskHandle());
          const vetted = validatePluginTaskStart(options);
          if (!vetted.ok) {
            return Promise.reject(
              new Error(`Plugin "${this.pluginId}" tasks.start: ${vetted.error}`)
            );
          }
          const subscriptionId = this.rpc.nextSubscriptionId();
          const controller = new AbortController();
          // Registered before the call so a cancel can't race ahead of the
          // handle; dropped again if the start doesn't produce one.
          this.rpc.addSubscription(subscriptionId, (payload) =>
            controller.abort(
              pluginTaskAbortReason(pluginTaskAbortCause(payload as TaskAbortEvent | null))
            )
          );
          const params: TaskStartParams = { subscriptionId, options: vetted.value };
          return this.rpc
            .callWithGrace<TaskStartResult>(
              "tasks.start",
              params,
              { id: "", inert: true },
              undefined,
              { onLateResult: (late) => this.finishAbandonedTaskStart(late) }
            )
            .then(
              (result) => {
                if (result.inert) {
                  this.rpc.deleteSubscription(subscriptionId);
                  return inertPluginTaskHandle();
                }
                return this.buildTaskHandle(result.id, controller, subscriptionId);
              },
              (err: unknown) => {
                this.rpc.deleteSubscription(subscriptionId);
                throw err;
              }
            );
        },
      },
      process: {
        // The real `PluginProcessHandle` lives in main (PluginProcessManager);
        // `spawn` relays over the port and returns a proxy handle whose id
        // addresses `kill` / `restart` and the exit/crash subscriptions. `kill`
        // is sync (a fire-and-forget notify); `restart` awaits the host. Late
        // exit/crash events ride the existing subscription-event channel.
        // One implementation behind an overloaded signature: the public `spawn`
        // narrows its return on the `mode` literal, which a single arrow
        // function can't express — the cast is the standard overload-impl seam.
        spawn: (async (command: string, options?: unknown) => {
          const { id, mode } = await this.rpc.call<{ id: string; mode?: PluginProcessMode }>(
            "process.spawn",
            { command, options },
            undefined,
            { onLateResult: (late) => this.killAbandonedSpawn(late) }
          );
          // A host that somehow omits the mode is treated as pipe — the least
          // capable shape, so a missing field can never manufacture a `write`.
          return this.buildProcessHandle(id, mode ?? "pipe");
        }) as PluginHostApi["process"]["spawn"],
      },
    };
  }
}
