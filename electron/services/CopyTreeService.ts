import { copy, ConfigManager } from "copytree";
import type { CopyResult, CopyOptions as SdkCopyOptions, ProgressEvent } from "copytree";
import * as path from "path";
import * as fs from "fs/promises";
import type { CopyTreeOptions, CopyTreeResult, CopyTreeProgress } from "../types/index.js";
import { logWarn } from "../utils/logger.js";

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

      let config;
      try {
        config = await ConfigManager.create();
      } catch (error) {
        logWarn(
          "Failed to load default config (likely missing configuration files in bundle), proceeding with defaults",
          { error }
        );
      }

      const sdkOptions: SdkCopyOptions = {
        config: config,
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
              const controller = this.activeOperations.get(opId);
              if (!controller || controller.signal.aborted) return;

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
    options: CopyTreeOptions = {}
  ): Promise<import("../../shared/types/index.js").CopyTreeTestConfigResult> {
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

      let config;
      try {
        config = await ConfigManager.create();
      } catch (error) {
        logWarn(
          "Failed to load default config (likely missing configuration files in bundle), proceeding with defaults",
          { error }
        );
      }

      const sdkOptions: SdkCopyOptions = {
        config: config,
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
      return {
        includedFiles: 0,
        includedSize: 0,
        excluded: { byTruncation: 0, bySize: 0, byPattern: 0 },
        error: error instanceof Error ? error.message : "Unknown error",
      };
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
