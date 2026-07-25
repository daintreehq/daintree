import type { CopyResult, CopyOptions as SdkCopyOptions, ProgressEvent } from "copytree";
import * as path from "path";
import * as fs from "fs/promises";
import type { CopyTreeOptions, CopyTreeResult, CopyTreeProgress } from "../types/index.js";
import type {
  CopyTreeBudgetStats,
  CopyTreeExclusionReason,
  CopyTreeExclusionSummary,
} from "../../shared/types/ipc/copyTree.js";
import { logWarn } from "../utils/logger.js";

/**
 * Renderer-visible text for the SDK's stable error codes. SDK messages can
 * carry absolute paths and raw option values, so nothing from the error itself
 * reaches the renderer — only these static strings.
 */
const ERROR_CODE_MESSAGES: Record<string, string> = {
  ERR_PATH_NOT_FOUND: "Project path is unavailable",
  ERR_NOT_A_DIRECTORY: "Project path isn't a directory",
  ERR_SCOPE_OUTSIDE_ROOT: "Selected paths must stay inside the project",
  ERR_SYMLINK_OUTSIDE_ROOT: "Selected paths must stay inside the project",
  ERR_INVALID_OPTION: "Context settings are invalid",
  ERR_INVALID_FORMAT: "Context settings are invalid",
  ERR_CONFIG_INVALID: "Context configuration couldn't be loaded",
  ERR_NO_FILES_MATCHED: "No files matched the current context settings",
  ERR_SECRETS_DETECTED: "Context generation stopped because secrets were detected",
  ERR_ABORTED: "Context generation cancelled",
  ENOENT: "Project path is unavailable",
  EACCES: "Can't read the project files",
};

const CANCELLED_MESSAGE = "Context generation cancelled";
const CONFIG_FAILED_MESSAGE = "Context configuration couldn't be loaded";
const GENERATE_FAILED_MESSAGE = "Failed to generate context";
const TEST_CONFIG_FAILED_MESSAGE = "Failed to test context settings";

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
          error: ERROR_CODE_MESSAGES.ENOENT,
        };
      }

      const controller = new AbortController();
      this.activeOperations.set(opId, controller);

      const { copy } = await getCopytree();
      this.throwIfAborted(controller.signal);

      const config = await this.createConfig(controller.signal);
      this.throwIfAborted(controller.signal);

      const sdkOptions: SdkCopyOptions = {
        ...this.buildSdkOptions(options, controller.signal),
        config,
        onProgress: onProgress
          ? (event: ProgressEvent) => {
              if (controller.signal.aborted) return;

              onProgress({
                stage: event.stage || "unknown",
                progress: Math.max(0, Math.min(100, event.percent || 0)) / 100,
                message: event.message || "Processing files",
                traceId: effectiveTraceId,
              });
            }
          : undefined,
        progressThrottleMs: 100,
      };

      const result: CopyResult = await copy(rootPath, sdkOptions);
      this.logScanErrors(result);

      return {
        content: result.output,
        fileCount: result.stats.totalFiles,
        outputFormatVersion: result.outputFormatVersion,
        stats: {
          totalSize: result.stats.totalSize,
          duration: result.stats.duration,
          ...this.mapBudgetStats(result),
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
          error: "rootPath must be an absolute path",
        };
      }

      try {
        await fs.access(rootPath);
      } catch {
        return {
          includedFiles: 0,
          includedSize: 0,
          error: ERROR_CODE_MESSAGES.ENOENT,
        };
      }

      const controller = new AbortController();
      this.activeOperations.set(opId, controller);

      const { copy } = await getCopytree();
      this.throwIfAborted(controller.signal);

      const config = await this.createConfig(controller.signal);
      this.throwIfAborted(controller.signal);

      const sdkOptions: SdkCopyOptions = {
        ...this.buildSdkOptions(options, controller.signal),
        config,
        dryRun: true,
      };

      const result: CopyResult = await copy(rootPath, sdkOptions);
      this.logScanErrors(result);

      // The 0.16 manifest reports every file's outcome, not just the kept ones.
      // Everything that isn't `excluded:*` reaches the output in some form —
      // truncated content, a structure-only lock file and a binary placeholder
      // all still occupy a slot — so only the excluded entries are dropped.
      const included = (result.manifest ?? [])
        .filter((entry) => !entry.outcome.startsWith("excluded:"))
        .map((entry) => ({ path: entry.path, size: entry.size }));

      return {
        includedFiles: included.length,
        includedSize: included.reduce((total, entry) => total + entry.size, 0),
        files: included,
        ...this.mapBudgetStats(result),
      };
    } catch (error: unknown) {
      return {
        includedFiles: 0,
        includedSize: 0,
        error: this.errorMessageFor(error, TEST_CONFIG_FAILED_MESSAGE),
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
      throw Object.assign(new Error(CANCELLED_MESSAGE), { name: "AbortError" });
    }
  }

  /**
   * Load configuration from the packaged defaults only.
   *
   * `userConfig` would let `~/.copytree/config/copytree.js` — arbitrary code on
   * a machine we don't control — run inside the host process, and would make a
   * project's context depend on a file outside it. Failure is fatal rather than
   * degraded: since 0.16 the config carries the exclusions, so running without
   * it would sweep `node_modules`, media and build output into the context.
   */
  private async createConfig(signal: AbortSignal) {
    const { ConfigManager } = await getCopytree();
    try {
      const config = await ConfigManager.create({ userConfig: false, strict: true });
      // `strict` only throws when a source errors. A config directory that is
      // simply absent resolves successfully and empty, which carries none of
      // the exclusion lists — the case this flag exists to expose.
      if (!config.isDefaultsLoaded) {
        throw new Error("CopyTree default configuration is missing");
      }
      return config;
    } catch (error) {
      // A cancel that lands while config is loading is a cancel, not a failure.
      this.throwIfAborted(signal);
      logWarn("Failed to load CopyTree configuration; refusing to run without exclusions", {
        error,
      });
      throw Object.assign(new Error(CONFIG_FAILED_MESSAGE), { code: "ERR_CONFIG_INVALID" });
    }
  }

  private buildSdkOptions(options: CopyTreeOptions, signal: AbortSignal): SdkCopyOptions {
    return {
      signal,
      display: false,
      clipboard: false,
      quiet: true,
      format: options.format || "xml",

      filter: options.includePaths || options.filter || undefined,
      exclude: options.exclude || undefined,
      always: options.always,
      respectGitignore: true,

      modified: options.modified,
      changed: options.changed,

      charLimit: options.charLimit,
      addLineNumbers: options.withLineNumbers,
      // The user-facing "max file size" is a per-file gate that `always`
      // patterns are meant to override, which is `sizeGate` — not the SDK's
      // `maxFileSize` memory ceiling, which nothing lifts. Left unset (or set to
      // a non-positive value) the gate is disabled rather than falling back to
      // the SDK's 256KB default, so existing projects keep the files they had
      // before this upgrade.
      sizeGate:
        options.maxFileSize !== undefined && options.maxFileSize > 0 ? options.maxFileSize : false,
      maxTotalSize: options.maxTotalSize,
      maxFileCount: options.maxFileCount,
      sort: options.sort,
      // Budgets keep the head of the sorted list, so "recently modified first"
      // only holds descending.
      sortOrder: options.sort === "modified" ? "desc" : undefined,

      // Redaction runs by default from 0.16 and still misfires on ordinary
      // source, which would silently corrupt the context handed to an agent.
      secretsGuard: false,
    };
  }

  private mapBudgetStats(result: CopyResult): CopyTreeBudgetStats {
    const stats = result.stats;
    return {
      estimatedOutputChars: stats.estimatedOutputChars,
      estimatedTokens: stats.estimatedTokens,
      noFilesMatched: stats.noFilesMatched,
      excluded: this.mapExclusions(stats.excluded),
      truncated: stats.truncated,
      truncatedCount: stats.truncatedCount,
      truncatedBy: stats.truncatedBy,
      budgetExceeded: stats.budgetExceeded,
    };
  }

  private mapExclusions(excluded: CopyResult["stats"]["excluded"]): CopyTreeExclusionSummary {
    const byReason: Partial<Record<CopyTreeExclusionReason, number>> = excluded?.byReason ?? {};
    return { total: excluded?.total ?? 0, byReason };
  }

  /**
   * Unreadable files are already accounted for as exclusions, so a scan error
   * is a logged detail rather than a reason to fail the whole run.
   */
  private logScanErrors(result: CopyResult): void {
    const scanErrors = result.stats.scanErrors;
    if (scanErrors && scanErrors.length > 0) {
      logWarn("CopyTree reported scan errors", { count: scanErrors.length });
    }
  }

  private errorMessageFor(error: unknown, fallback: string): string {
    if (error instanceof Error) {
      if (error.name === "AbortError") return CANCELLED_MESSAGE;

      // Own-property check only: an error carrying `code: "constructor"` would
      // otherwise resolve to an inherited function and fail structured clone on
      // its way to the renderer.
      const code = (error as Error & { code?: string }).code;
      if (typeof code === "string" && Object.hasOwn(ERROR_CODE_MESSAGES, code)) {
        return ERROR_CODE_MESSAGES[code];
      }
      if (error.name === "ValidationError") return "Context settings are invalid";
    }

    logWarn("CopyTree operation failed", { error });
    return fallback;
  }

  private handleError(error: unknown): CopyTreeResult {
    return {
      content: "",
      fileCount: 0,
      error: this.errorMessageFor(error, GENERATE_FAILED_MESSAGE),
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

export const copyTreeService = new CopyTreeService();
