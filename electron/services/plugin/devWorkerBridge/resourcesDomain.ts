// The filesystem, git, clipboard, system shell, documents, artifacts, spawned
// processes and tasks a dev worker reaches (#14332). Owns the live process and
// task handles, which go with the generation that made them.

import {
  isInertPluginTaskHandle,
  pluginTaskAbortCause,
} from "../../../../shared/utils/pluginTasks.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import { killPluginProcessForHost } from "../pluginInternalApprovers.js";
import type {
  PluginArtifactDownloadRequest,
  PluginArtifactImportSource,
  PluginArtifactListOptions,
  PluginArtifactProgress,
  PluginArtifactUploadRequest,
  PluginDuplexProcessHandle,
  PluginProcessHandle,
  PluginProcessMode,
  PluginProcessSpawnOptions,
  PluginPtyProcessHandle,
  PluginRenderPdfOptions,
  PluginTaskHandle,
} from "../../../../shared/types/plugin.js";
import type {
  ArtifactsIdParams,
  ArtifactsListParams,
  ArtifactsTransferParams,
  ClipboardWriteImageParams,
  ClipboardWriteTextParams,
  DocumentsRenderPdfParams,
  FsAppendFileParams,
  FsPathParams,
  FsReadFilesParams,
  FsWalkParams,
  FsWatchParams,
  FsWriteFileParams,
  GitOpParams,
  PluginHostCallMethod,
  PluginHostNotifyMethod,
  PluginWorkerSubscriptionKind,
  ProcessHandleRefParams,
  ProcessResizeParams,
  ProcessSpawnParams,
  ProcessWriteParams,
  SystemOpenExternalParams,
  SystemPathParams,
  TaskAbortEvent,
  TaskFinishParams,
  TaskReportParams,
  TaskStartParams,
  TaskStartResult,
} from "../../../../shared/types/pluginDevWorker.js";
import { createLogger } from "../../../utils/logger.js";
import type {
  DevWorkerBridgeContext,
  HostCallHandler,
  HostNotifyHandler,
  SubscribeHandler,
  SubscribeMessage,
} from "./bridgeContext.js";

const logger = createLogger("main:PluginDevWorkerBridge");

/**
 * Structural narrowing for an interactive process handle (#11300). The host adds
 * `resize` only for a real PTY, so its presence — not what the worker
 * requested — is what decides whether the resize relay is available.
 *
 * Must be tested BEFORE {@link isWritableHandle}: a PTY handle satisfies both.
 */
function isPtyHandle(handle: PluginProcessHandle): handle is PluginPtyProcessHandle {
  const candidate = handle as Partial<PluginPtyProcessHandle>;
  return typeof candidate.write === "function" && typeof candidate.resize === "function";
}

/**
 * Structural narrowing for any handle whose input the plugin can drive (#11871)
 * — a duplex child's stdin or a PTY. Same principle as {@link isPtyHandle}: the
 * shape the host actually built decides what the relay forwards, so a worker
 * cannot fabricate a `write` onto a pipe-mode process that has no stdin.
 */
function isWritableHandle(handle: PluginProcessHandle): handle is PluginDuplexProcessHandle {
  return typeof (handle as Partial<PluginDuplexProcessHandle>).write === "function";
}

export class ResourcesDomain {
  constructor(private readonly ctx: DevWorkerBridgeContext) {}

  /** Live handles for processes the worker spawned via `host.process.spawn`,
   * keyed by the host-assigned handle id. The worker addresses `kill` /
   * `restart` / `onExit` / `onCrash` by id; all are killed when a generation is
   * retired and on dispose (the next generation re-spawns from its fresh module
   * realm). */
  private readonly processHandles = new Map<string, PluginProcessHandle>();
  /** Live handles for tasks the worker started via `host.tasks.start` (#13819),
   * keyed by task id, each with the detach for the listener that relays the
   * user's Cancel to the worker. Forgotten when a generation is retired: main's
   * registry marks the tasks themselves interrupted. */
  private readonly taskHandles = new Map<
    string,
    { handle: PluginTaskHandle; detach: () => void }
  >();

  readonly hostCalls = {
    "fs.readFile": async (params, signal) => {
      return this.ctx.host.fs.readFile((params as FsPathParams).path, { signal });
    },
    "fs.readFileBytes": async (params, signal) => {
      return this.ctx.host.fs.readFileBytes((params as FsPathParams).path, { signal });
    },
    "fs.readFileWithRevision": async (params, signal) => {
      return this.ctx.host.fs.readFileWithRevision((params as FsPathParams).path, { signal });
    },
    "fs.readFiles": async (params, signal) => {
      const p = params as FsReadFilesParams;
      const fsApi = this.ctx.host.fs;
      if (!fsApi.readFiles) throw new Error("fs.readFiles is not available on this host");
      // Forwarded as given so the host validates exactly what the worker
      // sent; the overloads only exist to type a literal `encoding`.
      const readFiles = fsApi.readFiles as (
        paths: readonly string[],
        options: unknown
      ) => Promise<unknown>;
      return readFiles.call(fsApi, p.paths, {
        signal,
        ...(p.encoding !== undefined && { encoding: p.encoding }),
        ...(p.maxBytesPerFile !== undefined && { maxBytesPerFile: p.maxBytesPerFile }),
      });
    },
    "fs.mkdir": async (params) => {
      await this.ctx.host.fs.mkdir((params as FsPathParams).path);
      return undefined;
    },
    "fs.appendFile": async (params) => {
      const p = params as FsAppendFileParams;
      await this.ctx.host.fs.appendFile(p.path, p.contents);
      return undefined;
    },
    "fs.writeFile": async (params) => {
      const p = params as FsWriteFileParams;
      // Forwarded exactly as sent so a malformed options value is refused
      // by the host rather than read as absent.
      return p.options === undefined
        ? this.ctx.host.fs.writeFile(p.path, p.contents)
        : this.ctx.host.fs.writeFile(p.path, p.contents, p.options);
    },
    "fs.readdir": async (params, signal) => {
      const p = params as FsPathParams;
      return this.ctx.host.fs.readdir(p.path, {
        signal,
        ...(p.detail === true && { detail: true }),
      });
    },
    "fs.walk": async (params, signal) => {
      const p = params as FsWalkParams;
      const fsApi = this.ctx.host.fs;
      if (!fsApi.walk) throw new Error("fs.walk is not available on this host");
      // Options forwarded as sent so the host validates exactly what the
      // worker passed; only the bridge's own signal is added.
      const options: unknown = p.options;
      if (options === undefined) return fsApi.walk(p.root, { signal });
      if (options === null || typeof options !== "object") {
        return fsApi.walk(p.root, options as never);
      }
      return fsApi.walk(p.root, { ...options, signal });
    },
    "fs.stat": async (params, signal) => {
      return this.ctx.host.fs.stat((params as FsPathParams).path, { signal });
    },
    "fs.watch": async (params, signal) => {
      const p = params as FsWatchParams;
      const generation = this.ctx.generation();
      // The real watcher lives in main; relay each change as a
      // subscription-event keyed by the worker-supplied subscription id.
      const dispose = await this.ctx.host.fs.watch(
        p.paths,
        (changedPath) => {
          if (this.ctx.isDisposed()) return;
          this.ctx.send({
            type: "subscription-event",
            subscriptionId: p.subscriptionId,
            payload: changedPath,
          });
        },
        {
          signal,
          // Forwarded as given so the host rejects a malformed value.
          ...(p.recursive !== undefined && { recursive: p.recursive }),
          ...(p.debounceMs !== undefined && { debounceMs: p.debounceMs }),
          ...(p.allowMissing !== undefined && { allowMissing: p.allowMissing }),
        }
      );
      // Disposed, reloaded or cancelled while the watch was settling — tear
      // it down rather than leak it: the cleanup pass already ran, or the
      // worker already rejected the call and dropped its callback.
      if (this.ctx.isDisposed() || generation !== this.ctx.generation() || signal.aborted) {
        try {
          dispose();
        } catch {
          // best-effort
        }
        return undefined;
      }
      this.ctx.trackSubscription(p.subscriptionId, dispose);
      return undefined;
    },
    "process.spawn": async (params, signal) => {
      const p = params as ProcessSpawnParams;
      const generation = this.ctx.generation();
      const handle = await this.ctx.host.process.spawn(
        p.command,
        p.options as PluginProcessSpawnOptions
      );
      // Report the mode from the handle the host actually built, not from what
      // the worker asked for, so the proxy can't hand a plugin `write()` on a
      // process that has no writable input. PTY is tested first — it satisfies
      // the writable check too.
      const mode: PluginProcessMode = isPtyHandle(handle)
        ? "pty"
        : isWritableHandle(handle)
          ? "duplex"
          : "pipe";
      // Disposed or reloaded while the spawn was settling — the worker that
      // requested it is gone — or the worker gave up on the call (a cancel
      // or its deadline, #13410) and will never learn this handle's id;
      // kill the orphan rather than leak it. The host's own kill: this call's
      // caller may have lost the project meanwhile, and the orphan is still
      // the host's to clean up.
      if (this.ctx.isDisposed() || generation !== this.ctx.generation() || signal.aborted) {
        try {
          killPluginProcessForHost(handle);
        } catch {
          // best-effort
        }
        return { id: handle.id, mode };
      }
      this.processHandles.set(handle.id, handle);
      return { id: handle.id, mode };
    },
    "tasks.start": async (params, signal) => {
      const p = params as TaskStartParams;
      const generation = this.ctx.generation();
      const handle = await this.ctx.host.tasks.start(p.options);
      // The plugin had unloaded: there is no task to relay or finish.
      if (isInertPluginTaskHandle(handle)) {
        return { id: handle.id, inert: true } satisfies TaskStartResult;
      }
      // Disposed or reloaded while starting, or the worker gave up on the call
      // (a cancel or its deadline) and will never learn this id: nobody can
      // finish the task, so it ends here, quietly.
      if (this.ctx.isDisposed() || generation !== this.ctx.generation() || signal.aborted) {
        void handle.finish({ outcome: "cancelled" }).catch(() => {});
        return { id: handle.id } satisfies TaskStartResult;
      }
      const relayCancel = (): void => {
        if (this.ctx.isDisposed() || generation !== this.ctx.generation()) return;
        // A signal can't cross the port; its cause can, so the worker side
        // still tells a Cancel from an interruption.
        const payload: TaskAbortEvent = { cause: pluginTaskAbortCause(handle.signal.reason) };
        this.ctx.send({
          type: "subscription-event",
          subscriptionId: p.subscriptionId,
          payload,
        });
      };
      // Cancelled before start even answered: the worker registered its
      // subscription before the call, so the event still lands first.
      if (handle.signal.aborted) relayCancel();
      else handle.signal.addEventListener("abort", relayCancel, { once: true });
      this.taskHandles.set(handle.id, {
        handle,
        detach: () => handle.signal.removeEventListener("abort", relayCancel),
      });
      return { id: handle.id } satisfies TaskStartResult;
    },
    "tasks.finish": async (params) => {
      const p = params as TaskFinishParams;
      const entry = this.taskHandles.get(p.taskId);
      // Retired with its generation, or never this worker's: already ended.
      if (!entry) return undefined;
      await entry.handle.finish(p.result);
      if (this.taskHandles.get(p.taskId) === entry) {
        this.taskHandles.delete(p.taskId);
        entry.detach();
      }
      return undefined;
    },
    "process.restart": async (params) => {
      const p = params as ProcessHandleRefParams;
      const handle = this.processHandles.get(p.processId);
      if (!handle) {
        throw new Error(`No live process "${p.processId}" to restart`);
      }
      await handle.restart();
      return undefined;
    },
    "git.status": async (params, signal) => {
      return this.ctx.host.git.status((params as GitOpParams).worktreePath, { signal });
    },
    "git.diff": async (params, signal) => {
      const p = params as GitOpParams;
      return this.ctx.host.git.diff(p.worktreePath, p.filePath, { signal });
    },
    "git.add": async (params, signal) => {
      const p = params as GitOpParams;
      await this.ctx.host.git.add(p.worktreePath, p.paths, { signal });
      return undefined;
    },
    "git.commit": async (params, signal) => {
      const p = params as GitOpParams;
      return this.ctx.host.git.commit(p.worktreePath, { message: p.message ?? "" }, { signal });
    },
    "clipboard.writeText": async (params) => {
      await this.ctx.host.clipboard.writeText((params as ClipboardWriteTextParams).text);
      return undefined;
    },
    "clipboard.writeImage": async (params) => {
      await this.ctx.host.clipboard.writeImage((params as ClipboardWriteImageParams).pngData);
      return undefined;
    },
    "system.openPath": async (params) => {
      await this.ctx.host.system.openPath((params as SystemPathParams).targetPath);
      return undefined;
    },
    "system.showItemInFolder": async (params) => {
      await this.ctx.host.system.showItemInFolder((params as SystemPathParams).targetPath);
      return undefined;
    },
    "system.openExternal": async (params) => {
      await this.ctx.host.system.openExternal((params as SystemOpenExternalParams).url);
      return undefined;
    },
    "documents.renderPdf": async (params) => {
      // Forwarded as sent; the host validates every option.
      return this.ctx.host.documents.renderPdf(
        (params as DocumentsRenderPdfParams).options as PluginRenderPdfOptions
      );
    },
    "artifacts.import": (params, signal, method) => this.transferArtifact(method, params, signal),
    "artifacts.download": (params, signal, method) => this.transferArtifact(method, params, signal),
    "artifacts.upload": (params, signal, method) => this.transferArtifact(method, params, signal),
    "artifacts.stat": async (params) => {
      return this.ctx.host.artifacts.stat((params as ArtifactsIdParams).artifactId as string);
    },
    "artifacts.release": async (params) => {
      return this.ctx.host.artifacts.release((params as ArtifactsIdParams).artifactId as string);
    },
    "artifacts.list": async (params) => {
      return this.ctx.host.artifacts.list(
        (params as ArtifactsListParams).options as PluginArtifactListOptions | undefined
      );
    },
    "clipboard.readText": async () => {
      return this.ctx.host.clipboard.readText();
    },
  } satisfies Partial<Record<PluginHostCallMethod, HostCallHandler>>;

  readonly notifications = {
    "tasks.report": async (params) => {
      // One coalescing window's latest report per task. Fire-and-forget, so a
      // report the host refuses is logged rather than answered.
      const { reports } = params as TaskReportParams;
      if (!Array.isArray(reports)) return;
      for (const report of reports as unknown[]) {
        if (typeof report !== "object" || report === null) continue;
        const { taskId, progress } = report as { taskId?: unknown; progress?: unknown };
        if (typeof taskId !== "string") continue;
        const entry = this.taskHandles.get(taskId);
        if (!entry) continue;
        try {
          entry.handle.report(progress as TaskReportParams["reports"][number]["progress"]);
        } catch (err) {
          logger.warn(
            `[${this.ctx.pluginId}] tasks.report refused: ${formatErrorMessage(err, "invalid progress")}`
          );
        }
      }
      return;
    },
    "process.kill": async (params) => {
      // `PluginProcessHandle.kill()` is sync (no reply) — fire-and-forget. A
      // no-op if the handle already exited or was torn down on reload.
      const { processId } = params as ProcessHandleRefParams;
      this.processHandles.get(processId)?.kill();
      return;
    },
    "process.write": async (params) => {
      const p = params as ProcessWriteParams;
      const handle = this.processHandles.get(p.processId);
      // Silently ignored for a pipe-mode handle: the worker proxy only exposes
      // `write` on a writable handle (duplex or PTY), so reaching here means a
      // plugin fabricated the call. Warn rather than throw — this is a notify.
      if (!handle || !isWritableHandle(handle)) {
        logger.warn(`[${this.ctx.pluginId}] process.write on non-writable "${p.processId}"`);
        return;
      }
      if (typeof p.data !== "string") return;
      handle.write(p.data);
      return;
    },
    "process.resize": async (params) => {
      const p = params as ProcessResizeParams;
      const handle = this.processHandles.get(p.processId);
      // Stays PTY-only: a duplex child has no terminal to resize.
      if (!handle || !isPtyHandle(handle)) {
        logger.warn(`[${this.ctx.pluginId}] process.resize on non-interactive "${p.processId}"`);
        return;
      }
      handle.resize(p.cols, p.rows);
      return;
    },
  } satisfies Partial<Record<PluginHostNotifyMethod, HostNotifyHandler>>;

  readonly subscriptions = {
    "process-exit": (msg, push) => this.subscribeProcess(msg, push),
    "process-crash": (msg, push) => this.subscribeProcess(msg, push),
    "process-data": (msg, push) => this.subscribeProcess(msg, push),
  } satisfies Partial<Record<PluginWorkerSubscriptionKind, SubscribeHandler>>;

  /** Kill every process the worker spawned (the worker is going away — a fresh
   * generation re-spawns from its own module realm). */
  disposeProcessHandles(): void {
    for (const handle of this.processHandles.values()) {
      try {
        killPluginProcessForHost(handle);
      } catch {
        // best-effort
      }
    }
    this.processHandles.clear();
  }

  /** Stop relaying cancels for the worker's tasks and forget their handles. */
  disposeTaskHandles(): void {
    for (const { detach } of this.taskHandles.values()) detach();
    this.taskHandles.clear();
  }

  private async transferArtifact(
    method: string,
    params: unknown,
    signal: AbortSignal
  ): Promise<unknown> {
    // Forwarded as sent; the host validates. The worker's signal arrives
    // as this call's own, and its progress callback as a subscription.
    const p = params as ArtifactsTransferParams;
    const generation = this.ctx.generation();
    const subscriptionId = p.progressSubscriptionId;
    const onProgress =
      typeof subscriptionId === "string"
        ? (progress: PluginArtifactProgress) => {
            if (this.ctx.isDisposed() || generation !== this.ctx.generation()) return;
            this.ctx.send({
              type: "subscription-event",
              subscriptionId,
              payload: progress,
            });
          }
        : undefined;
    const options = {
      ...(typeof p.options === "object" && p.options !== null ? p.options : {}),
      signal,
      onProgress,
    };
    if (method === "artifacts.upload") {
      return this.ctx.host.artifacts.upload(
        p.artifactId as string,
        p.target as PluginArtifactUploadRequest,
        options
      );
    }
    return method === "artifacts.import"
      ? this.ctx.host.artifacts.import(p.target as PluginArtifactImportSource, options)
      : this.ctx.host.artifacts.download(p.target as PluginArtifactDownloadRequest, options);
  }

  private async subscribeProcess(
    msg: SubscribeMessage,
    push: (payload: unknown) => void
  ): Promise<(() => void) | undefined> {
    const { kind } = msg;
    if (!msg.processId) {
      logger.warn(`[${this.ctx.pluginId}] ${kind} subscribe missing processId`);
      return undefined;
    }
    const handle = this.processHandles.get(msg.processId);
    if (!handle) {
      // The handle was killed (reload/dispose) between spawn and subscribe.
      logger.warn(
        `[${this.ctx.pluginId}] ${kind} subscribe for unknown process "${msg.processId}"`
      );
      return undefined;
    }
    return kind === "process-exit"
      ? handle.onExit((info) => push(info))
      : kind === "process-crash"
        ? handle.onCrash((info) => push(info))
        : handle.onData((chunk) => push(chunk));
  }
}
