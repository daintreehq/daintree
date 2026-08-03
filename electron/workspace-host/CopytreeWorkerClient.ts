import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { copyTreeService, type ProgressCallback } from "../services/CopyTreeService.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { logWarn } from "../utils/logger.js";
import type { CopyTreeOptions, CopyTreeResult } from "../types/index.js";
import type { CopyTreeTestConfigResult, FileTreeNode } from "../../shared/types/index.js";
import type { CopytreeWorkerRequest, CopytreeWorkerResponse } from "./copytreeWorkerProtocol.js";
import type { WorkerResourceSnapshot } from "../../shared/types/workerGovernance.js";

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
 * reclaimed. The 5s margin over the main-side timeout exists only so the
 * main-side timeout surfaces first (the in-band result always wins while the
 * worker is healthy); keeping it tight stops the worker grinding on an op the
 * caller has already abandoned — and possibly already retried.
 */
const WORKER_OP_TIMEOUT_MS = 125_000;

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

interface PendingFileTree {
  resolve: (nodes: FileTreeNode[]) => void;
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
  private readonly pendingFileTree = new Map<string, PendingFileTree>();
  // Bumped on every worker (re)creation AND on worker death. Messages from a
  // superseded worker instance are dropped at the listener boundary so a
  // late result can never resurrect a settled operation or hand a stale
  // generation's (potentially multi-MB) content to a new caller.
  private workerGeneration = 0;
  private lastActivityAt: number | null = null;
  private lastCompletedAt: number | null = null;

  constructor(
    private readonly createWorker: () => Worker = () => new Worker(resolveCopytreeWorkerPath())
  ) {}

  async generate(
    rootPath: string,
    options: CopyTreeOptions = {},
    onProgress?: ProgressCallback,
    operationId?: string,
    outputPath?: string
  ): Promise<CopyTreeResult> {
    const id = operationId || crypto.randomUUID();
    this.lastActivityAt = Date.now();
    const worker = this.getWorker();
    if (!worker) {
      return copyTreeService.generate(rootPath, options, onProgress, id, outputPath);
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
        outputPath,
      } satisfies CopytreeWorkerRequest);
    } catch (error) {
      this.takePendingGenerate(id);
      logWarn("copytree worker postMessage failed; running in-process", {
        error: formatErrorMessage(error, "postMessage failed"),
      });
      return copyTreeService.generate(rootPath, options, onProgress, id, outputPath);
    }
    return pending;
  }

  async testConfig(
    rootPath: string,
    options: CopyTreeOptions = {},
    operationId?: string
  ): Promise<CopyTreeTestConfigResult> {
    const id = operationId || crypto.randomUUID();
    this.lastActivityAt = Date.now();
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

  async getFileTree(
    rootPath: string,
    dirPath: string | undefined,
    options: CopyTreeOptions = {},
    includeExcluded?: boolean,
    operationId?: string
  ): Promise<FileTreeNode[]> {
    const id = operationId || crypto.randomUUID();
    this.lastActivityAt = Date.now();
    const worker = this.getWorker();
    if (!worker) {
      return copyTreeService.getFileTree(rootPath, dirPath, options, { includeExcluded }, id);
    }
    const pending = new Promise<FileTreeNode[]>((resolve, reject) => {
      this.pendingFileTree.set(id, { resolve, reject, timer: this.armOperationTimeout(id) });
    });
    try {
      worker.postMessage({
        type: "get-file-tree",
        id,
        rootPath,
        dirPath,
        options,
        includeExcluded,
      } satisfies CopytreeWorkerRequest);
    } catch (error) {
      this.takePendingFileTree(id);
      logWarn("copytree worker postMessage failed; running in-process", {
        error: formatErrorMessage(error, "postMessage failed"),
      });
      return copyTreeService.getFileTree(rootPath, dirPath, options, { includeExcluded }, id);
    }
    return pending;
  }

  /**
   * Cancel an operation wherever it runs. Both sides treat an unknown id as a
   * no-op, so forwarding to both is safe and covers the fallback path.
   */
  cancel(operationId: string): void {
    copyTreeService.cancel(operationId);
    if (
      this.pendingGenerate.has(operationId) ||
      this.pendingTestConfig.has(operationId) ||
      this.pendingFileTree.has(operationId)
    ) {
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
      // Generation fence: bind this worker instance's listeners to the
      // generation current at spawn. A message or exit surfacing after the
      // client moved on (worker replaced or already failed) is dropped —
      // stale results and their payloads are unreachable the moment the
      // generation advances.
      const generation = ++this.workerGeneration;
      worker.on("message", (message: CopytreeWorkerResponse) => {
        if (generation !== this.workerGeneration) return;
        this.handleMessage(message);
      });
      worker.on("error", (error) => {
        if (generation !== this.workerGeneration) return;
        this.handleWorkerDown(error);
      });
      worker.on("exit", (code) => {
        if (generation !== this.workerGeneration) return;
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
    const pending =
      this.takePendingGenerate(id) ??
      this.takePendingTestConfig(id) ??
      this.takePendingFileTree(id);
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

  private takePendingFileTree(id: string): PendingFileTree | undefined {
    const pending = this.pendingFileTree.get(id);
    if (pending) {
      this.pendingFileTree.delete(id);
      clearTimeout(pending.timer);
    }
    return pending;
  }

  private handleWorkerDown(error: unknown): void {
    // Persistent-worker policy: no respawn. A crashing worker would otherwise
    // enter the Electron spawn/terminate crash path, so all future requests
    // take the in-thread fallback instead. Advancing the generation makes any
    // message still in flight from the dead worker unroutable.
    this.workerGeneration++;
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
    for (const pending of this.pendingFileTree.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
    this.pendingFileTree.clear();
    logWarn("copytree worker down; falling back to in-process generation", {
      error: failure.message,
    });
  }

  private handleMessage(message: CopytreeWorkerResponse): void {
    switch (message.type) {
      case "progress":
        this.pendingGenerate.get(message.id)?.onProgress?.(message.progress);
        break;
      // Result payloads (potentially multi-MB XML) are released the moment
      // they transfer: takePending* deletes the map entry before resolve, so
      // the client retains no reference once the caller has the result.
      case "generate-result":
        this.lastCompletedAt = Date.now();
        this.takePendingGenerate(message.id)?.resolve(message.result);
        break;
      case "generate-error":
        this.takePendingGenerate(message.id)?.reject(new Error(message.error));
        break;
      case "test-config-result":
        this.lastCompletedAt = Date.now();
        this.takePendingTestConfig(message.id)?.resolve(message.result);
        break;
      case "test-config-error":
        this.takePendingTestConfig(message.id)?.reject(new Error(message.error));
        break;
      case "get-file-tree-result":
        this.lastCompletedAt = Date.now();
        this.takePendingFileTree(message.id)?.resolve(message.nodes);
        break;
      case "get-file-tree-error":
        this.takePendingFileTree(message.id)?.reject(new Error(message.error));
        break;
    }
  }

  /**
   * Governance snapshot. The copytree worker holds no caches — result buffers
   * live only in the pending maps until transfer — so nothing is
   * trim-eligible, and the persistent-worker policy (no terminate, no respawn)
   * rules out dispose/restart.
   */
  getGovernanceSnapshot(): WorkerResourceSnapshot {
    return {
      kind: "copytree-worker",
      id: "copytree-worker",
      pid: null,
      threadId: this.worker?.threadId ?? null,
      alive: this.worker !== null,
      activeSessionCount: 0,
      queueDepth:
        this.pendingGenerate.size + this.pendingTestConfig.size + this.pendingFileTree.size,
      lastActivityAt: this.lastActivityAt,
      memory: null,
      eligibility: { trim: false, dispose: false, restart: false },
      state: this.workerFailed ? "fallback-pinned" : this.worker ? "running" : "not-spawned",
      detail: {
        lastCompletedAt: this.lastCompletedAt,
        workerGeneration: this.workerGeneration,
      },
    };
  }
}

export const copytreeWorkerClient = new CopytreeWorkerClient();
