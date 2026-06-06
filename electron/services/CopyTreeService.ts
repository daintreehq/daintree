import type { CopyResult, CopyOptions as SdkCopyOptions, ProgressEvent } from "copytree";
import * as path from "path";
import * as fs from "fs/promises";
import type { CopyTreeOptions, CopyTreeResult, CopyTreeProgress } from "../types/index.js";
import { logWarn } from "../utils/logger.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";

// Lazy-load copytree so its module graph (ajv, xmlbuilder2, fast-glob, lodash, …)
// stays off the workspace-host readiness path; it resolves on first use.
let _copytreeModule: Promise<typeof import("copytree")> | null = null;

function getCopytree(): Promise<typeof import("copytree")> {
  return (_copytreeModule ??= import("copytree"));
}

export type { CopyTreeOptions, CopyTreeResult, CopyTreeProgress };

export type ProgressCallback = (progress: CopyTreeProgress) => void;

/**
 * CopyTreeService - Generates context trees for AI agents.
 *
 * @pattern Exported Singleton Instance (Pattern A)
 *
 * Why this pattern:
 * - Stateless request-response operations (generate context on demand)
 * - No external dependencies at construction time
 * - Cancellation handled per-operation via AbortController (no global state)
 * - Lightweight instantiation: just initializes an empty Map
 *
 * When to use Pattern A:
 * - Service performs stateless operations without persistent resources
 * - No need for explicit lifecycle management (start/stop/dispose)
 * - Wide usage across handlers benefits from simple import syntax
 */
class CopyTreeService {
  private activeOperations = new Map<string, AbortController>();

  async generate(
    rootPath: string,
    options: CopyTreeOptions = {},
    onProgress?: ProgressCallback,
    traceId?: string
  ): Promise<CopyTreeResult> {
    const opId = traceId || crypto.randomUUID();
    const effectiveTraceId = opId;

    try {
      if (!path.isAbsolute(rootPath)) {
        return {
          content: "",
          fileCount: 0,
          error: "rootPath must be an absolute path",
        };
      }

      try {
        await fs.access(rootPath);
      } catch {
        return {
          content: "",
          fileCount: 0,
          error: `Path does not exist or is not accessible: ${rootPath}`,
        };
      }

      const controller = new AbortController();
      this.activeOperations.set(opId, controller);

      const { copy, ConfigManager } = await getCopytree();
      this.throwIfAborted(controller.signal);

      let config;
      try {
        config = await ConfigManager.create();
      } catch (error) {
        logWarn(
          "Failed to load default config (likely missing configuration files in bundle), proceeding with defaults",
          { error }
        );
      }

      this.throwIfAborted(controller.signal);

      const sdkOptions: SdkCopyOptions = {
        signal: controller.signal,
        display: false,
        clipboard: false,
        format: options.format || "xml",

        filter: options.includePaths || options.filter || undefined,
        exclude: options.exclude || undefined,
        always: options.always,

        modified: options.modified,
        changed: options.changed,

        charLimit: options.charLimit,
        addLineNumbers: options.withLineNumbers,
        maxFileSize: options.maxFileSize,
        maxTotalSize: options.maxTotalSize,
        maxFileCount: options.maxFileCount,
        sort: options.sort,

        onProgress: onProgress
          ? (event: ProgressEvent) => {
              if (controller.signal.aborted) return;

              const progress: CopyTreeProgress = {
                stage: event.stage || "Processing",
                progress: Math.max(0, Math.min(100, event.percent || 0)) / 100,
                message: event.message || `Processing: ${event.stage || "files"}`,
                filesProcessed: event.filesProcessed,
                totalFiles: event.totalFiles,
                currentFile: event.currentFile,
                traceId: effectiveTraceId,
              };
              onProgress(progress);
            }
          : undefined,
        progressThrottleMs: 100,
      };
      if (config) {
        sdkOptions.config = config;
      }

      const result: CopyResult = await copy(rootPath, sdkOptions);

      return {
        content: result.output,
        fileCount: result.stats.totalFiles,
        stats: {
          totalSize: result.stats.totalSize,
          duration: result.stats.duration,
        },
      };
    } catch (error: unknown) {
      return this.handleError(error);
    } finally {
      this.activeOperations.delete(opId);
    }
  }

  async testConfig(
    rootPath: string,
    options: CopyTreeOptions = {},
    traceId?: string
  ): Promise<import("../../shared/types/index.js").CopyTreeTestConfigResult> {
    const opId = traceId || crypto.randomUUID();

    try {
      if (!path.isAbsolute(rootPath)) {
        return {
          includedFiles: 0,
          includedSize: 0,
          excluded: { byTruncation: 0, bySize: 0, byPattern: 0 },
          error: "rootPath must be an absolute path",
        };
      }

      try {
        await fs.access(rootPath);
      } catch {
        return {
          includedFiles: 0,
          includedSize: 0,
          excluded: { byTruncation: 0, bySize: 0, byPattern: 0 },
          error: `Path does not exist or is not accessible: ${rootPath}`,
        };
      }

      const controller = new AbortController();
      this.activeOperations.set(opId, controller);

      const { copy, ConfigManager } = await getCopytree();
      this.throwIfAborted(controller.signal);

      let config;
      try {
        config = await ConfigManager.create();
      } catch (error) {
        logWarn(
          "Failed to load default config (likely missing configuration files in bundle), proceeding with defaults",
          { error }
        );
      }

      this.throwIfAborted(controller.signal);

      const sdkOptions: SdkCopyOptions = {
        signal: controller.signal,
        display: false,
        clipboard: false,
        format: options.format || "xml",
        dryRun: true,

        filter: options.includePaths || options.filter || undefined,
        exclude: options.exclude || undefined,
        always: options.always,

        modified: options.modified,
        changed: options.changed,

        charLimit: options.charLimit,
        addLineNumbers: options.withLineNumbers,
        maxFileSize: options.maxFileSize,
        maxTotalSize: options.maxTotalSize,
        maxFileCount: options.maxFileCount,
        sort: options.sort,
      };
      if (config) {
        sdkOptions.config = config;
      }

      const result: CopyResult = await copy(rootPath, sdkOptions);

      return {
        includedFiles: result.stats.totalFiles,
        includedSize: result.stats.totalSize,
        excluded: {
          byTruncation: 0,
          bySize: 0,
          byPattern: 0,
        },
        files: undefined,
      };
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        return {
          includedFiles: 0,
          includedSize: 0,
          excluded: { byTruncation: 0, bySize: 0, byPattern: 0 },
          error: "Context generation cancelled",
        };
      }
      return {
        includedFiles: 0,
        includedSize: 0,
        excluded: { byTruncation: 0, bySize: 0, byPattern: 0 },
        error: formatErrorMessage(error, "Failed to generate context"),
      };
    } finally {
      this.activeOperations.delete(opId);
    }
  }

  cancelAll(): void {
    for (const controller of this.activeOperations.values()) {
      controller.abort();
    }
    this.activeOperations.clear();
  }

  cancel(opId: string): boolean {
    const controller = this.activeOperations.get(opId);
    if (controller) {
      controller.abort();
      this.activeOperations.delete(opId);
      return true;
    }
    return false;
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw Object.assign(new Error("Context generation cancelled"), { name: "AbortError" });
    }
  }

  private handleError(error: unknown): CopyTreeResult {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        content: "",
        fileCount: 0,
        error: "Context generation cancelled",
      };
    }

    if (error instanceof Error) {
      const errorName = error.name;
      const errorCode = (error as Error & { code?: string }).code;

      if (errorName === "ValidationError") {
        return {
          content: "",
          fileCount: 0,
          error: `Validation Error: ${error.message}`,
        };
      }

      if (errorName === "CopyTreeError" || errorCode) {
        return {
          content: "",
          fileCount: 0,
          error: `CopyTree Error${errorCode ? ` [${errorCode}]` : ""}: ${error.message}`,
        };
      }

      return {
        content: "",
        fileCount: 0,
        error: `CopyTree Error: ${error.message}`,
      };
    }

    return {
      content: "",
      fileCount: 0,
      error: `CopyTree Error: ${String(error)}`,
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

export const copyTreeService = new CopyTreeService();
