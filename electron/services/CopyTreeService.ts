import type {
  CopyResult,
  CopyOptions as SdkCopyOptions,
  ProgressEvent,
  ConfigManager as SdkConfigManager,
} from "copytree";
import * as path from "path";
import * as fs from "fs/promises";
import type { CopyTreeOptions, CopyTreeResult, CopyTreeProgress } from "../types/index.js";
import type {
  CopyTreeBudgetStats,
  CopyTreeExclusionReason,
  CopyTreeExclusionSummary,
  FileTreeNode,
} from "../../shared/types/ipc/copyTree.js";
import { fileTreeService } from "./FileTreeService.js";
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
const FILE_TREE_FAILED_MESSAGE = "Failed to read the project files";

/**
 * The defaults-only config is immutable and project-independent (`userConfig`
 * is off, so nothing outside the packaged defaults feeds it), and loading one
 * parses every config file and compiles a JSON schema. Cache the promise per
 * isolate: the context listing runs a dry run per directory, and paying that
 * cost on every expansion is pure waste. Failures are evicted so a later call
 * retries rather than inheriting a dead config.
 */
let _configPromise: Promise<SdkConfigManager> | null = null;

export function _resetConfigCacheForTests(): void {
  _configPromise = null;
}

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

  /**
   * List one directory the way the context sees it.
   *
   * The picker used to answer "is this ignored?" with a `git check-ignore`
   * subprocess while the bundle was built by CopyTree's own layered resolution,
   * so the two disagreed: a ticked file could be missing from the output, and
   * exclusions git knows nothing about (the config's excluded-file list, binary
   * classification, the size gate, the budgets) were invisible (#11439). Both
   * answers now come from one dry run of the same `copy()` the real generation
   * runs, with the same merged options.
   *
   * The dry run covers the whole root rather than scoping to `dirPath`. Scoping
   * would be far cheaper — traversal starts at the selection — but `scope`
   * resolves during discovery and the global budgets (`maxFileCount`,
   * `maxTotalSize`, `charLimit`, plus CopyTree's own 100MB/10k defaults) are
   * applied to whatever that traversal found. A scoped run therefore recomputes
   * which files win the budget from one subtree, and would list a file the real
   * run drops — the same class of disagreement this method exists to remove.
   */
  async getFileTree(
    rootPath: string,
    dirPath: string = "",
    options: CopyTreeOptions = {},
    listOptions: { includeExcluded?: boolean } = {},
    traceId?: string
  ): Promise<FileTreeNode[]> {
    // Checked before the operation is registered so the caller's own mistake
    // reaches it verbatim rather than through the error sanitizer, which exists
    // to keep SDK messages and absolute paths away from the renderer.
    if (!path.isAbsolute(rootPath)) {
      throw new Error("rootPath must be an absolute path");
    }

    const opId = traceId || crypto.randomUUID();
    const controller = new AbortController();
    // Registered before the first await so a cancel that lands immediately
    // still finds the operation.
    this.activeOperations.set(opId, controller);

    try {
      // Raw listing first: it owns the containment guards, so a traversal
      // attempt fails before a repository-wide scan is ever started.
      const rawNodes = await fileTreeService.getFileTree(rootPath, dirPath);
      this.throwIfAborted(controller.signal);

      const { copy } = await getCopytree();
      this.throwIfAborted(controller.signal);

      const config = await this.createConfig(controller.signal);
      this.throwIfAborted(controller.signal);

      const result: CopyResult = await copy(rootPath, {
        ...this.buildSdkOptions(options, controller.signal),
        config,
        dryRun: true,
      });
      // A cancel that landed during the walk must not produce a tree. The
      // signal is passed to `copy()`, but the check is repeated here so
      // cancellation holds even when the scan runs to completion anyway.
      this.throwIfAborted(controller.signal);
      this.logScanErrors(result);

      const manifest = result.manifest;
      if (!Array.isArray(manifest)) {
        // Without a manifest there is no verdict to apply, and returning the
        // raw listing would leak exactly what the picker must not show.
        throw new Error("CopyTree dry run returned no manifest");
      }

      return this.applyContextVerdict(rawNodes, manifest, listOptions.includeExcluded === true);
    } catch (error: unknown) {
      throw new Error(this.errorMessageFor(error, FILE_TREE_FAILED_MESSAGE));
    } finally {
      this.activeOperations.delete(opId);
    }
  }

  /**
   * Keep the entries the context would carry, in the raw listing's order.
   *
   * A manifest entry means the file reaches the output in some form — a
   * truncated file, a structure-only lock file and a binary placeholder all
   * still occupy a slot. Anything excluded has no entry at all: CopyTree records
   * only what survived, so absence is the exclusion signal, and it covers every
   * layer uniformly (ignore files, config excludes, binary classification, the
   * size gate, the budgets) including entries the walk never reached.
   *
   * Directories are never in the manifest — CopyTree does not descend into one
   * it has pruned — so a directory is judged by whether anything under it
   * survived. That drops `.git` and `node_modules` with no special-casing, and
   * also drops a directory whose every file is excluded, which would otherwise
   * expand into nothing.
   */
  private applyContextVerdict(
    rawNodes: FileTreeNode[],
    manifest: CopyResult["manifest"],
    includeExcluded: boolean
  ): FileTreeNode[] {
    const includedFiles = new Set<string>();
    const populatedDirs = new Set<string>();

    for (const entry of manifest) {
      if (entry.outcome.startsWith("excluded:")) continue;
      includedFiles.add(entry.path);
      // Record every ancestor so a directory listed at any depth can be
      // answered from this one pass.
      let slash = entry.path.lastIndexOf("/");
      while (slash > 0) {
        const ancestor = entry.path.slice(0, slash);
        if (populatedDirs.has(ancestor)) break;
        populatedDirs.add(ancestor);
        slash = ancestor.lastIndexOf("/");
      }
    }

    const nodes: FileTreeNode[] = [];
    for (const node of rawNodes) {
      const kept = node.isDirectory ? populatedDirs.has(node.path) : includedFiles.has(node.path);
      if (kept) {
        nodes.push(node);
      } else if (includeExcluded) {
        nodes.push({ ...node, excluded: true });
      }
    }
    return nodes;
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
    try {
      // Share the in-flight promise so concurrent operations load the config
      // once, and evict on failure so the next call retries. Awaiting a shared
      // promise means one operation's cancel must not poison it for the others,
      // so the abort check below happens after the await, on this operation's
      // own signal.
      _configPromise ??= (async () => {
        const { ConfigManager } = await getCopytree();
        const config = await ConfigManager.create({ userConfig: false, strict: true });
        // `strict` only throws when a source errors. A config directory that is
        // simply absent resolves successfully and empty, which carries none of
        // the exclusion lists — the case this flag exists to expose.
        if (!config.isDefaultsLoaded) {
          throw new Error("CopyTree default configuration is missing");
        }
        return config;
      })().catch((error: unknown) => {
        _configPromise = null;
        throw error;
      });

      return await _configPromise;
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
