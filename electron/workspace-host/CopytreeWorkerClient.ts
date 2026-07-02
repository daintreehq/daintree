import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { copyTreeService, type ProgressCallback } from "../services/CopyTreeService.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { logWarn } from "../utils/logger.js";
import type { CopyTreeOptions, CopyTreeResult } from "../types/index.js";
import type { CopyTreeTestConfigResult } from "../../shared/types/index.js";
import type { CopytreeWorkerRequest, CopytreeWorkerResponse } from "./copytreeWorkerProtocol.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolves the compiled copytree worker on disk. esbuild may emit this module
 * into a shared chunk under `dist-electron/electron/chunks/`, so `__dirname`
 * can point at that chunks dir — step up to the electron root, then down to
 * the worker's own output path. Mirrors `resolveVadWorkerPath()` in
 * `OpenAITranscriptionProvider.ts`.
 */
function resolveCopytreeWorkerPath(): string {
  const electronDir = path.basename(__dirname) === "chunks" ? path.dirname(__dirname) : __dirname;
  return path.join(electronDir, "workspace-host", "copytreeWorker.js");
}

/**
 * Client-side backstop for a wedged worker. The main process's
 * `sendWithResponse` gives up at 120s, so past this point the request is
 * already lost main-side — reject, drop the pending entry (it would
 * otherwise leak forever), and ask the worker to abort the op so its CPU is
 * reclaimed. Deliberately above the main-side timeout so the in-band result
 * always wins while the worker is healthy.
 */
const WORKER_OP_TIMEOUT_MS = 180_000;

interface PendingGenerate {
  resolve: (result: CopyTreeResult) => void;
  reject: (error: Error) => void;
  onProgress?: ProgressCallback;
  timer: NodeJS.Timeout;
}

interface PendingTestConfig {
  resolve: (result: CopyTreeTestConfigResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Runs copytree operations on a persistent worker thread so the CPU-heavy
 * walk/format work stays off the workspace-host event loop.
 *
 * - The worker is spawned lazily on the first request and never terminated in
 *   normal operation (Electron 37+ crashes on repeated worker
 *   spawn/terminate cycles inside a utilityProcess — `!flush_tasks_`).
 * - `DAINTREE_DISABLE_COPYTREE_WORKER=1` or a spawn failure falls back to the
 *   in-thread CopyTreeService path; an unexpected worker exit fails in-flight
 *   operations and pins the fallback for the rest of the host's life.
 * - Result/error shapes match the in-thread path: copytree-level failures
 *   arrive as error-shaped results, only transport/infra failures reject.
 */
export class CopytreeWorkerClient {
  private worker: Worker | null = null;
  private workerFailed = false;
  private readonly pendingGenerate = new Map<string, PendingGenerate>();
  private readonly pendingTestConfig = new Map<string, PendingTestConfig>();

  constructor(
    private readonly createWorker: () => Worker = () => new Worker(resolveCopytreeWorkerPath())
  ) {}

  async generate(
    rootPath: string,
    options: CopyTreeOptions = {},
    onProgress?: ProgressCallback,
    operationId?: string
  ): Promise<CopyTreeResult> {
    const id = operationId || crypto.randomUUID();
    const worker = this.getWorker();
    if (!worker) {
      return copyTreeService.generate(rootPath, options, onProgress, id);
    }
    const pending = new Promise<CopyTreeResult>((resolve, reject) => {
      this.pendingGenerate.set(id, {
        resolve,
        reject,
        onProgress,
        timer: this.armOperationTimeout(id),
      });
    });
    try {
      worker.postMessage({
        type: "generate",
        id,
        rootPath,
        options,
      } satisfies CopytreeWorkerRequest);
    } catch (error) {
      this.takePendingGenerate(id);
      logWarn("copytree worker postMessage failed; running in-process", {
        error: formatErrorMessage(error, "postMessage failed"),
      });
      return copyTreeService.generate(rootPath, options, onProgress, id);
    }
    return pending;
  }

  async testConfig(
    rootPath: string,
    options: CopyTreeOptions = {},
    operationId?: string
  ): Promise<CopyTreeTestConfigResult> {
    const id = operationId || crypto.randomUUID();
    const worker = this.getWorker();
    if (!worker) {
      return copyTreeService.testConfig(rootPath, options, id);
    }
    const pending = new Promise<CopyTreeTestConfigResult>((resolve, reject) => {
      this.pendingTestConfig.set(id, { resolve, reject, timer: this.armOperationTimeout(id) });
    });
    try {
      worker.postMessage({
        type: "test-config",
        id,
        rootPath,
        options,
      } satisfies CopytreeWorkerRequest);
    } catch (error) {
      this.takePendingTestConfig(id);
      logWarn("copytree worker postMessage failed; running in-process", {
        error: formatErrorMessage(error, "postMessage failed"),
      });
      return copyTreeService.testConfig(rootPath, options, id);
    }
    return pending;
  }

  /**
   * Cancel an operation wherever it runs. Both sides treat an unknown id as a
   * no-op, so forwarding to both is safe and covers the fallback path.
   */
  cancel(operationId: string): void {
    copyTreeService.cancel(operationId);
    if (this.pendingGenerate.has(operationId) || this.pendingTestConfig.has(operationId)) {
      this.postCancel(operationId);
    }
  }

  private workerDisabled(): boolean {
    return process.env.DAINTREE_DISABLE_COPYTREE_WORKER === "1";
  }

  private getWorker(): Worker | null {
    if (this.workerDisabled() || this.workerFailed) return null;
    if (this.worker) return this.worker;
    try {
      const worker = this.createWorker();
      worker.on("message", (message: CopytreeWorkerResponse) => this.handleMessage(message));
      worker.on("error", (error) => this.handleWorkerDown(error));
      worker.on("exit", (code) => {
        this.handleWorkerDown(new Error(`copytree worker exited with code ${code}`));
      });
      // The worker must never keep the host alive on its own; the host's
      // lifetime is owned by the parent port.
      worker.unref();
      this.worker = worker;
      return worker;
    } catch (error) {
      this.workerFailed = true;
      logWarn("copytree worker spawn failed; falling back to in-process generation", {
        error: formatErrorMessage(error, "spawn failed"),
      });
      return null;
    }
  }

  private armOperationTimeout(id: string): NodeJS.Timeout {
    const timer = setTimeout(() => this.timeOutOperation(id), WORKER_OP_TIMEOUT_MS);
    timer.unref?.();
    return timer;
  }

  private timeOutOperation(id: string): void {
    const pending = this.takePendingGenerate(id) ?? this.takePendingTestConfig(id);
    if (!pending) return;
    // Best-effort abort so the worker reclaims the CPU; an already-finished
    // (or unknown) id is a no-op on the worker side.
    this.postCancel(id);
    pending.reject(new Error(`copytree worker did not respond within ${WORKER_OP_TIMEOUT_MS}ms`));
  }

  private postCancel(id: string): void {
    try {
      this.worker?.postMessage({ type: "cancel", id } satisfies CopytreeWorkerRequest);
    } catch {
      // Worker already torn down — nothing left to cancel.
    }
  }

  private takePendingGenerate(id: string): PendingGenerate | undefined {
    const pending = this.pendingGenerate.get(id);
    if (pending) {
      this.pendingGenerate.delete(id);
      clearTimeout(pending.timer);
    }
    return pending;
  }

  private takePendingTestConfig(id: string): PendingTestConfig | undefined {
    const pending = this.pendingTestConfig.get(id);
    if (pending) {
      this.pendingTestConfig.delete(id);
      clearTimeout(pending.timer);
    }
    return pending;
  }

  private handleWorkerDown(error: unknown): void {
    // Persistent-worker policy: no respawn. A crashing worker would otherwise
    // enter the Electron spawn/terminate crash path, so all future requests
    // take the in-thread fallback instead.
    this.workerFailed = true;
    this.worker = null;
    const failure = new Error(formatErrorMessage(error, "copytree worker failed"));
    for (const pending of this.pendingGenerate.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
    this.pendingGenerate.clear();
    for (const pending of this.pendingTestConfig.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
    this.pendingTestConfig.clear();
    logWarn("copytree worker down; falling back to in-process generation", {
      error: failure.message,
    });
  }

  private handleMessage(message: CopytreeWorkerResponse): void {
    switch (message.type) {
      case "progress":
        this.pendingGenerate.get(message.id)?.onProgress?.(message.progress);
        break;
      case "generate-result":
        this.takePendingGenerate(message.id)?.resolve(message.result);
        break;
      case "generate-error":
        this.takePendingGenerate(message.id)?.reject(new Error(message.error));
        break;
      case "test-config-result":
        this.takePendingTestConfig(message.id)?.resolve(message.result);
        break;
      case "test-config-error":
        this.takePendingTestConfig(message.id)?.reject(new Error(message.error));
        break;
    }
  }
}

export const copytreeWorkerClient = new CopytreeWorkerClient();
