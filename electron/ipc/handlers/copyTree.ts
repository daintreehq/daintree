import { clipboard } from "electron";
import crypto from "crypto";
import path from "path";
import { pathToFileURL } from "url";
import { z } from "zod";
import { CHANNELS } from "../channels.js";
import { ValidationError } from "../validationError.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import {
  broadcastToRenderer,
  checkRateLimit,
  sendToRenderer,
  typedHandle,
  typedHandleWithContext,
} from "../utils.js";
import { resolveScopedProjectForIpcContext } from "../projectContext.js";
import type { HandlerDependencies, IpcContext } from "../types.js";
import type {
  CopyTreeGeneratePayload,
  CopyTreeGenerateAndCopyFilePayload,
  CopyTreeInjectPayload,
  CopyTreeGetFileTreePayload,
  CopyTreeResult,
  CopyTreeProgress,
  FileTreeNode,
  CopyTreeOptions,
} from "../../types/index.js";

type CopyTreeFormat = NonNullable<CopyTreeOptions["format"]>;

const FORMAT_TO_EXTENSION: Record<CopyTreeFormat, string> = {
  json: "json",
  markdown: "md",
  tree: "txt",
  ndjson: "ndjson",
  sarif: "sarif",
  xml: "xml",
};

const getExtensionForFormat = (format: CopyTreeFormat | undefined): string => {
  if (!format) return "xml";
  return FORMAT_TO_EXTENSION[format] ?? "xml";
};

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Compute the end index of the next PTY chunk so that a UTF-16 surrogate pair
 * is never split across chunks. Returns an index in `(start, content.length]`
 * — the boundary is guaranteed to advance, so callers can use `i = end`
 * without risking an infinite loop even when `chunkSize` is 1.
 */
export function nextChunkBoundary(content: string, start: number, chunkSize: number): number {
  let end = Math.min(start + chunkSize, content.length);
  if (end < content.length) {
    const lastUnit = content.charCodeAt(end - 1);
    if (lastUnit >= 0xd800 && lastUnit <= 0xdbff && end - 1 > start) {
      end -= 1;
    }
  }
  return end;
}

export function buildRemoteComputeBlock(worktree: {
  resourceStatus?: { provider?: string; lastStatus?: string; endpoint?: string };
  resourceConnectCommand?: string;
}): string {
  if (!worktree.resourceStatus) {
    return "";
  }

  const provider = worktree.resourceStatus.provider ?? "unknown";
  const lastStatus = worktree.resourceStatus.lastStatus;
  const endpoint = worktree.resourceStatus.endpoint;
  const connectCommand = worktree.resourceConnectCommand;

  if (lastStatus === "ready" && endpoint && connectCommand) {
    return `\n\n## Remote Compute\nProvider: ${provider} | Status: ${lastStatus} | Endpoint: ${endpoint}\nRun remote commands: ${connectCommand}\nOr use the wrapper: daintree-remote "<command>"\n`;
  }

  if (lastStatus) {
    return `\n\n## Remote Compute\nProvider: ${provider} | Status: ${lastStatus}\nResource is not yet available for remote execution.\n`;
  }

  return "";
}
import {
  CopyTreeGeneratePayloadSchema,
  CopyTreeGenerateAndCopyFilePayloadSchema,
  CopyTreeInjectPayloadSchema,
  CopyTreeGetFileTreePayloadSchema,
  CopyTreeCancelPayloadSchema,
  CopyTreeTestConfigPayloadSchema,
} from "../../schemas/ipc.js";
import type {
  CopyTreeCancelPayload,
  CopyTreeTestConfigOptions,
  ProjectSettings,
} from "../../types/index.js";
import { projectStore } from "../../services/ProjectStore.js";
import { contextInjectionTracker } from "../../services/ContextInjectionTracker.js";
import {
  fitContentToResultBudget,
  readContentPreview,
  releaseContextFilePath,
  reserveContextFilePath,
} from "../../services/copyTreeOutputFile.js";

function getStringField(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Drop `null`-valued keys so downstream CopyTree code only ever sees
 * `T | undefined`. `null` marks a field the caller explicitly cleared
 * (test-config dry runs) — it has done its job once the merge is over.
 */
function stripClearedFields(options: CopyTreeTestConfigOptions): CopyTreeOptions {
  const result = { ...options };
  for (const key of Object.keys(result) as Array<keyof CopyTreeTestConfigOptions>) {
    if (result[key] === null) {
      delete result[key];
    }
  }
  return result as CopyTreeOptions;
}

/**
 * Merge project-level settings with runtime CopyTree options.
 * Runtime options take precedence over project settings.
 *
 * A `null` runtime value means "explicitly cleared": the field is excluded
 * from the project-settings back-fill (the `=== undefined` guards skip it)
 * and stripped from the result. An absent/`undefined` field still falls back
 * to project settings.
 *
 * Merges both:
 * - ProjectSettings.excludedPaths (default exclusions)
 * - ProjectSettings.copyTreeSettings (context generation settings)
 */
export function mergeCopyTreeOptions(
  projectSettings: Pick<ProjectSettings, "excludedPaths" | "copyTreeSettings"> | undefined,
  runtimeOptions: CopyTreeOptions | CopyTreeTestConfigOptions | undefined
): CopyTreeOptions {
  if (!projectSettings) {
    return stripClearedFields(runtimeOptions || {});
  }

  const merged: CopyTreeTestConfigOptions = {
    ...runtimeOptions,
  };

  const copyTreeSettings = projectSettings.copyTreeSettings;

  // Only apply project settings if runtime options don't explicitly set them
  // Priority: runtime > copyTreeSettings > excludedPaths

  // Handle exclude patterns: only use project settings if runtime didn't provide exclude
  if (merged.exclude === undefined) {
    const excludePatterns: string[] = [];

    // Add excludedPaths (lowest priority)
    if (projectSettings.excludedPaths && projectSettings.excludedPaths.length > 0) {
      excludePatterns.push(...projectSettings.excludedPaths);
    }

    // Add copyTreeSettings.alwaysExclude (medium priority)
    if (copyTreeSettings?.alwaysExclude && copyTreeSettings.alwaysExclude.length > 0) {
      excludePatterns.push(...copyTreeSettings.alwaysExclude);
    }

    if (excludePatterns.length > 0) {
      merged.exclude = excludePatterns;
    }
  }

  if (!copyTreeSettings) {
    return stripClearedFields(merged);
  }

  if (copyTreeSettings.maxContextSize !== undefined && merged.maxTotalSize === undefined) {
    merged.maxTotalSize = copyTreeSettings.maxContextSize;
  }

  if (copyTreeSettings.maxFileSize !== undefined && merged.maxFileSize === undefined) {
    merged.maxFileSize = copyTreeSettings.maxFileSize;
  }

  if (copyTreeSettings.charLimit !== undefined && merged.charLimit === undefined) {
    merged.charLimit = copyTreeSettings.charLimit;
  }

  if (copyTreeSettings.strategy && merged.sort === undefined) {
    merged.sort = copyTreeSettings.strategy === "modified" ? "modified" : undefined;
  }

  // Only apply project alwaysInclude if runtime didn't set it
  if (merged.always === undefined && copyTreeSettings.alwaysInclude) {
    merged.always = copyTreeSettings.alwaysInclude;
  }

  return stripClearedFields(merged);
}

/**
 * Resolve which project's CopyTree settings apply to this request: the one bound
 * to the IPC sender's view. Reading the global current project here made a
 * generate in window A inherit window B's exclusions whenever B was focused most
 * recently (#11103).
 *
 * A view that resolves to no project yields `null` — it must never inherit the
 * global pointer (#6015). The global is consulted only when project-scoped
 * resolution is unavailable altogether.
 *
 * Call this SYNCHRONOUSLY, before the handler's first `await`. The sender's view
 * can be evicted while a later await is in flight, and a binding that vanishes
 * mid-request would silently drop the project's exclusions from the context.
 */
function resolveCopyTreeProjectId(ctx: IpcContext, deps: HandlerDependencies): string | null {
  const scopedProject = resolveScopedProjectForIpcContext(ctx, deps);
  if (scopedProject === null) {
    return projectStore.getCurrentProjectId();
  }
  return scopedProject.project?.id ?? null;
}

/** Load the CopyTree-relevant settings for a project resolved by `resolveCopyTreeProjectId`. */
async function loadCopyTreeProjectSettings(
  projectId: string | null
): Promise<Pick<ProjectSettings, "excludedPaths" | "copyTreeSettings"> | undefined> {
  if (!projectId) {
    return undefined;
  }
  try {
    const settings = await projectStore.getProjectSettings(projectId);
    return {
      excludedPaths: settings.excludedPaths,
      copyTreeSettings: settings.copyTreeSettings,
    };
  } catch (error) {
    console.warn("[CopyTree] Failed to get project settings:", error);
    return undefined;
  }
}

export function registerCopyTreeHandlers(deps: HandlerDependencies): () => void {
  // copyTree progress is broadcast to all windows
  const handlers: Array<() => void> = [];

  /**
   * Generate a bundle straight into a freshly reserved temp file.
   *
   * Both file-backed callers come through here. The write happens in the
   * workspace host, not in this process: that is the whole point of #11528 —
   * the bundle used to be built as one multi-MB string and then cloned across
   * the host → main → renderer boundaries before anything trimmed it.
   */
  const generateToFile = async (
    worktree: { path: string; branch?: string },
    options: CopyTreeOptions,
    onProgress: (progress: CopyTreeProgress) => void
  ): Promise<CopyTreeResult> => {
    let filePath: string;
    try {
      filePath = await reserveContextFilePath({
        worktreePath: worktree.path,
        branch: worktree.branch,
        // The merged options, not the caller's: project settings decide the
        // format too, and the extension has to match what actually gets written.
        extension: getExtensionForFormat(options.format),
      });
    } catch (error) {
      // A raw fs rejection carries absolute paths, and this result is published
      // to MCP callers verbatim — so only the static message crosses.
      console.error("[CopyTree] Failed to reserve a context file:", error);
      return { content: "", fileCount: 0, error: "Can't write the context file" };
    }

    try {
      const result = await deps.worktreeService!.generateContext(
        worktree.path,
        options,
        onProgress,
        filePath
      );
      if (result.error) return result;
      // A successful generation names the file we reserved and reports its
      // size. Anything else is a result that outlived its operation: publishing
      // its path would hand this caller another run's bundle, and the missing
      // size would break the shape the tool advertises.
      if (result.filePath !== filePath || typeof result.outputBytes !== "number") {
        return { content: "", fileCount: 0, error: "Failed to generate context" };
      }
      return result;
    } finally {
      releaseContextFilePath(filePath);
    }
  };

  const handleCopyTreeGenerate = async (
    ctx: import("../types.js").IpcContext,
    payload: CopyTreeGeneratePayload
  ): Promise<CopyTreeResult> => {
    checkRateLimit(CHANNELS.COPYTREE_GENERATE, 5, 10_000);
    const traceId = crypto.randomUUID();
    const senderWindow = ctx.senderWindow;
    const requestedWorktreeId = getStringField(payload, "worktreeId") ?? "unknown";
    console.log(`[${traceId}] CopyTree generate started for worktree ${requestedWorktreeId}`);

    const parseResult = CopyTreeGeneratePayloadSchema.safeParse(payload);
    if (!parseResult.success) {
      console.error(
        `[${traceId}] Invalid CopyTree generate payload:`,
        z.prettifyError(parseResult.error)
      );
      return {
        content: "",
        fileCount: 0,
        error: "Invalid payload",
      };
    }

    const validated = parseResult.data;

    if (!deps.worktreeService) {
      return {
        content: "",
        fileCount: 0,
        error: "Workspace client not initialized",
      };
    }

    // Capture the sender's project before awaiting: the view can be evicted
    // while the workspace call is in flight, taking its binding with it.
    const settingsProjectId = resolveCopyTreeProjectId(ctx, deps);

    const states = await deps.worktreeService.getAllStatesAsync(senderWindow?.id);
    const worktree = states.find((wt) => wt.id === validated.worktreeId);

    if (!worktree) {
      return {
        content: "",
        fileCount: 0,
        error: `Worktree not found: ${validated.worktreeId}`,
      };
    }

    const onProgress = (progress: CopyTreeProgress) => {
      const progressPayload = { ...progress, traceId };
      if (senderWindow && !senderWindow.isDestroyed()) {
        sendToRenderer(senderWindow, CHANNELS.COPYTREE_PROGRESS, progressPayload);
      } else {
        broadcastToRenderer(CHANNELS.COPYTREE_PROGRESS, progressPayload);
      }
    };

    // Merge project settings with runtime options
    const projectSettings = await loadCopyTreeProjectSettings(settingsProjectId);
    const mergedOptions = mergeCopyTreeOptions(projectSettings, validated.options);

    const result = await generateToFile(worktree, mergedOptions, onProgress);
    if (result.error || !result.filePath || !validated.includeContent) {
      return result;
    }

    // The opt-in reads a head back out of the file rather than asking for the
    // string: the bundle stays on disk, and only what the caller can actually
    // receive is loaded.
    try {
      const preview = await readContentPreview(result.filePath);
      return fitContentToResultBudget(
        preview.content,
        (content, contentTruncated) => ({ ...result, content, contentTruncated }),
        preview.truncated
      ).result;
    } catch (error) {
      // The bundle itself is fine and its path is already usable, so a failed
      // read-back downgrades to the default shape instead of failing the run.
      console.warn(`[${traceId}] Failed to read back context preview:`, error);
      return result;
    }
  };
  handlers.push(typedHandleWithContext(CHANNELS.COPYTREE_GENERATE, handleCopyTreeGenerate));

  const handleCopyTreeGenerateAndCopyFile = async (
    ctx: import("../types.js").IpcContext,
    payload: CopyTreeGenerateAndCopyFilePayload
  ): Promise<CopyTreeResult> => {
    checkRateLimit(CHANNELS.COPYTREE_GENERATE_AND_COPY_FILE, 5, 10_000);
    const traceId = crypto.randomUUID();
    const senderWindow = ctx.senderWindow;
    const requestedWorktreeId = getStringField(payload, "worktreeId") ?? "unknown";
    console.log(
      `[${traceId}] CopyTree generate-and-copy-file started for worktree ${requestedWorktreeId}`
    );

    const parseResult = CopyTreeGenerateAndCopyFilePayloadSchema.safeParse(payload);
    if (!parseResult.success) {
      console.error(
        `[${traceId}] Invalid CopyTree generate-and-copy-file payload:`,
        z.prettifyError(parseResult.error)
      );
      return {
        content: "",
        fileCount: 0,
        error: "Invalid payload",
      };
    }

    const validated = parseResult.data;

    if (!deps.worktreeService) {
      return {
        content: "",
        fileCount: 0,
        error: "Workspace client not initialized",
      };
    }

    // Capture the sender's project before awaiting: the view can be evicted
    // while the workspace call is in flight, taking its binding with it.
    const settingsProjectId = resolveCopyTreeProjectId(ctx, deps);

    const states = await deps.worktreeService.getAllStatesAsync(senderWindow?.id);
    const worktree = states.find((wt) => wt.id === validated.worktreeId);

    if (!worktree) {
      return {
        content: "",
        fileCount: 0,
        error: `Worktree not found: ${validated.worktreeId}`,
      };
    }

    const onProgress = (progress: CopyTreeProgress) => {
      const progressPayload = { ...progress, traceId };
      if (senderWindow && !senderWindow.isDestroyed()) {
        sendToRenderer(senderWindow, CHANNELS.COPYTREE_PROGRESS, progressPayload);
      } else {
        broadcastToRenderer(CHANNELS.COPYTREE_PROGRESS, progressPayload);
      }
    };

    // Merge project settings with runtime options
    const projectSettings = await loadCopyTreeProjectSettings(settingsProjectId);
    const mergedOptions = mergeCopyTreeOptions(projectSettings, validated.options);

    // Written by the workspace host straight to disk. This handler used to pull
    // the whole bundle across two process boundaries only to write it out here
    // (#11528); the file it needs is now already on disk when the call returns.
    const result = await generateToFile(worktree, mergedOptions, onProgress);

    if (result.error || !result.filePath) {
      return result;
    }

    const filePath = result.filePath;

    try {
      if (process.platform === "darwin") {
        // Electron's `clipboard.writeBuffer` maps to Chromium's
        // `WritePortableAndPlatformRepresentations`, which calls
        // `[NSPasteboard clearContents]` on each invocation, so sequential
        // `writeBuffer` calls cannot install multiple custom UTIs in one
        // pasteboard session. Keep the legacy `NSFilenamesPboardType` plist
        // (Finder reads it natively) with the path XML-escaped so a
        // hostile `TMPDIR` cannot break out of the <string> element.
        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
    <string>${escapeXml(filePath)}</string>
</array>
</plist>`;
        clipboard.writeBuffer("NSFilenamesPboardType", Buffer.from(plist, "utf8"));
      } else if (process.platform === "win32") {
        clipboard.writeText(filePath);
      } else {
        clipboard.writeBuffer(
          "text/uri-list",
          Buffer.from(pathToFileURL(filePath).href + "\r\n", "utf8")
        );
      }

      console.log(`[${traceId}] Copied context file to clipboard: ${filePath}`);

      return {
        content: "",
        fileCount: result.fileCount,
        filePath,
        outputBytes: result.outputBytes,
        stats: result.stats,
        outputFormatVersion: result.outputFormatVersion,
      };
    } catch (error) {
      const errorMessage = formatErrorMessage(error, "Failed to copy context file");
      console.error(`[${traceId}] Failed to save/copy context file:`, errorMessage);
      // The bundle exists either way, so its path still rides back — only the
      // clipboard step failed, and the caller can still reach the file.
      return {
        content: "",
        fileCount: result.fileCount,
        filePath,
        outputBytes: result.outputBytes,
        stats: result.stats,
        outputFormatVersion: result.outputFormatVersion,
        error: `Failed to copy file to clipboard: ${errorMessage}`,
      };
    }
  };
  handlers.push(
    typedHandleWithContext(
      CHANNELS.COPYTREE_GENERATE_AND_COPY_FILE,
      handleCopyTreeGenerateAndCopyFile
    )
  );

  const handleCopyTreeInject = async (
    ctx: import("../types.js").IpcContext,
    payload: CopyTreeInjectPayload
  ): Promise<CopyTreeResult> => {
    checkRateLimit(CHANNELS.COPYTREE_INJECT, 5, 10_000);
    const traceId = crypto.randomUUID();
    const senderWindow = ctx.senderWindow;
    const requestedTerminalId = getStringField(payload, "terminalId") ?? "unknown";
    const requestedWorktreeId = getStringField(payload, "worktreeId") ?? "unknown";
    console.log(
      `[${traceId}] CopyTree inject started for terminal ${requestedTerminalId}, worktree ${requestedWorktreeId}`
    );

    const parseResult = CopyTreeInjectPayloadSchema.safeParse(payload);
    if (!parseResult.success) {
      console.error(
        `[${traceId}] Invalid CopyTree inject payload:`,
        z.prettifyError(parseResult.error)
      );
      return {
        content: "",
        fileCount: 0,
        error: "Invalid payload",
      };
    }

    const validated = parseResult.data;
    const injectionId = validated.injectionId || traceId;

    if (contextInjectionTracker.isTerminalInjecting(validated.terminalId)) {
      return {
        content: "",
        fileCount: 0,
        error: "Context injection already in progress for this terminal",
      };
    }

    if (!deps.worktreeService) {
      return {
        content: "",
        fileCount: 0,
        error: "Workspace client not initialized",
      };
    }

    // Capture the sender's project before awaiting: the view can be evicted
    // while the workspace call is in flight, taking its binding with it.
    const settingsProjectId = resolveCopyTreeProjectId(ctx, deps);

    contextInjectionTracker.beginInjection(validated.terminalId, injectionId);

    try {
      const states = await deps.worktreeService.getAllStatesAsync(senderWindow?.id);
      const worktree = states.find((wt) => wt.id === validated.worktreeId);

      if (!worktree) {
        return {
          content: "",
          fileCount: 0,
          error: `Worktree not found: ${validated.worktreeId}`,
        };
      }

      if (!deps.ptyClient!.hasTerminal(validated.terminalId)) {
        return {
          content: "",
          fileCount: 0,
          error: "Terminal no longer exists",
        };
      }

      const onProgress = (progress: CopyTreeProgress) => {
        const progressPayload = { ...progress, traceId };
        if (senderWindow && !senderWindow.isDestroyed()) {
          sendToRenderer(senderWindow, CHANNELS.COPYTREE_PROGRESS, progressPayload);
        } else {
          broadcastToRenderer(CHANNELS.COPYTREE_PROGRESS, progressPayload);
        }
      };

      // Merge project settings with runtime options
      const projectSettings = await loadCopyTreeProjectSettings(settingsProjectId);
      const mergedOptions = mergeCopyTreeOptions(projectSettings, validated.options || {});

      const result = await deps.worktreeService.generateContext(
        worktree.path,
        mergedOptions,
        onProgress
      );

      if (result.error) {
        return result;
      }

      const remoteComputeBlock = buildRemoteComputeBlock(worktree);
      const CHUNK_SIZE = 4096;

      // Write directly over each source string rather than concatenating into a
      // single (possibly multi-MB) buffer that would stay pinned alongside
      // result.content across the whole setImmediate-yielding loop. The
      // remoteComputeBlock — usually empty — is written as trailing chunks.
      const writeChunked = async (source: string): Promise<string | null> => {
        for (let i = 0; i < source.length;) {
          if (contextInjectionTracker.isCancelled(injectionId)) {
            console.log(`[${traceId}] CopyTree inject cancelled by user`);
            return "Injection cancelled";
          }

          if (!deps.ptyClient!.hasTerminal(validated.terminalId)) {
            return "Terminal closed during injection";
          }

          const end = nextChunkBoundary(source, i, CHUNK_SIZE);
          const chunk = source.slice(i, end);
          deps.ptyClient!.write(validated.terminalId, chunk, traceId);
          i = end;
          if (i < source.length) {
            await new Promise((resolve) => setImmediate(resolve));
          }
        }
        return null;
      };

      let injectError = await writeChunked(result.content);
      if (!injectError && remoteComputeBlock) {
        await new Promise((resolve) => setImmediate(resolve));
        injectError = await writeChunked(remoteComputeBlock);
      }
      if (injectError) {
        return { content: "", fileCount: 0, error: injectError };
      }

      console.log(`[${traceId}] CopyTree inject completed successfully`);
      // The renderer reads only fileCount/stats; drop the (possibly multi-MB)
      // content so the contextBridge doesn't clone a second copy into the heap.
      return {
        content: "",
        fileCount: result.fileCount,
        stats: result.stats,
        outputFormatVersion: result.outputFormatVersion,
      };
    } finally {
      contextInjectionTracker.finishInjection(validated.terminalId, injectionId);
    }
  };
  handlers.push(typedHandleWithContext(CHANNELS.COPYTREE_INJECT, handleCopyTreeInject));

  const handleCopyTreeAvailable = async (): Promise<boolean> => {
    return !!deps.worktreeService && deps.worktreeService.isReady();
  };
  handlers.push(typedHandle(CHANNELS.COPYTREE_AVAILABLE, handleCopyTreeAvailable));

  const handleCopyTreeCancel = async (payload?: CopyTreeCancelPayload): Promise<void> => {
    const parseResult = CopyTreeCancelPayloadSchema.safeParse(payload ?? {});
    if (!parseResult.success) {
      console.warn("Invalid cancel payload, ignoring");
      return;
    }

    const validated = parseResult.data;

    if (validated.injectionId) {
      const wasActive = contextInjectionTracker.markCancelled(validated.injectionId);
      if (wasActive) {
        console.log(`[cancel] Marked injection ${validated.injectionId} for cancellation`);
      } else {
        console.log(
          `[cancel] Ignoring cancel for unknown/completed injection ${validated.injectionId}`
        );
      }
    } else {
      const count = contextInjectionTracker.markAllCancelled();
      if (deps.worktreeService) {
        deps.worktreeService.cancelAllContext();
      }
      console.log(`[cancel] Marked all ${count} active injections for cancellation`);
    }
  };
  handlers.push(typedHandle(CHANNELS.COPYTREE_CANCEL, handleCopyTreeCancel));

  const handleCopyTreeGetFileTree = async (
    ctx: import("../types.js").IpcContext,
    payload: CopyTreeGetFileTreePayload
  ): Promise<FileTreeNode[]> => {
    checkRateLimit(CHANNELS.COPYTREE_GET_FILE_TREE, 5, 10_000);
    const parseResult = CopyTreeGetFileTreePayloadSchema.safeParse(payload);
    if (!parseResult.success) {
      console.error("Invalid CopyTree file tree request:", z.prettifyError(parseResult.error));
      throw new ValidationError(CHANNELS.COPYTREE_GET_FILE_TREE);
    }

    const validated = parseResult.data;

    if (validated.dirPath) {
      if (path.isAbsolute(validated.dirPath)) {
        throw new Error("dirPath must be a relative path");
      }
      // Segment-aware: a bare `startsWith("..")` also rejects legitimate names
      // like `..cache`. This is the cheap pre-check — `FileTreeService` still
      // owns the authoritative containment guard, including realpath escapes.
      const normalized = path.normalize(validated.dirPath);
      const segments = normalized.split(/[\\/]/);
      if (segments.includes("..")) {
        throw new Error("dirPath cannot traverse outside worktree root");
      }
    }

    if (!deps.worktreeService) {
      throw new Error("Worktree service not available");
    }

    // Capture the sender's project before awaiting: the view can be evicted
    // while the workspace call is in flight, taking its binding with it.
    const settingsProjectId = resolveCopyTreeProjectId(ctx, deps);

    const states = await deps.worktreeService.getAllStatesAsync(ctx.senderWindow?.id);
    const worktree = states.find((wt) => wt.id === validated.worktreeId);

    if (!worktree) {
      throw new Error(`Worktree not found: ${validated.worktreeId}`);
    }

    // The same merge generation uses. Without it the listing would answer for
    // CopyTree's defaults while the bundle is built with the project's
    // exclusions and budgets — the disagreement this channel exists to end
    // (#11439).
    const projectSettings = await loadCopyTreeProjectSettings(settingsProjectId);
    const mergedOptions = mergeCopyTreeOptions(projectSettings, undefined);

    return deps.worktreeService.getContextFileTree(
      worktree.path,
      validated.dirPath,
      mergedOptions,
      validated.includeExcluded
    );
  };
  handlers.push(typedHandleWithContext(CHANNELS.COPYTREE_GET_FILE_TREE, handleCopyTreeGetFileTree));

  const handleCopyTreeTestConfig = async (
    ctx: import("../types.js").IpcContext,
    payload: import("../../types/index.js").CopyTreeTestConfigPayload
  ): Promise<import("../../types/index.js").CopyTreeTestConfigResult> => {
    checkRateLimit(CHANNELS.COPYTREE_TEST_CONFIG, 5, 10_000);
    const traceId = crypto.randomUUID();
    const requestedWorktreeId = getStringField(payload, "worktreeId") ?? "unknown";
    console.log(`[${traceId}] CopyTree test-config started for worktree ${requestedWorktreeId}`);

    const parseResult = CopyTreeTestConfigPayloadSchema.safeParse(payload);
    if (!parseResult.success) {
      console.error(
        `[${traceId}] Invalid CopyTree test-config payload:`,
        z.prettifyError(parseResult.error)
      );
      return {
        includedFiles: 0,
        includedSize: 0,
        error: "Invalid payload",
      };
    }

    const validated = parseResult.data;

    if (!deps.worktreeService) {
      return {
        includedFiles: 0,
        includedSize: 0,
        error: "Workspace client not initialized",
      };
    }

    // Capture the sender's project before awaiting: the view can be evicted
    // while the workspace call is in flight, taking its binding with it.
    const settingsProjectId = resolveCopyTreeProjectId(ctx, deps);

    const senderWindowTestConfig = ctx.senderWindow;
    const states = await deps.worktreeService.getAllStatesAsync(senderWindowTestConfig?.id);
    const worktree = states.find((wt) => wt.id === validated.worktreeId);

    if (!worktree) {
      return {
        includedFiles: 0,
        includedSize: 0,
        error: `Worktree not found: ${validated.worktreeId}`,
      };
    }

    // Merge project settings with runtime options
    const projectSettings = await loadCopyTreeProjectSettings(settingsProjectId);
    const mergedOptions = mergeCopyTreeOptions(projectSettings, validated.options);

    return deps.worktreeService.testConfig(worktree.path, mergedOptions);
  };
  handlers.push(typedHandleWithContext(CHANNELS.COPYTREE_TEST_CONFIG, handleCopyTreeTestConfig));

  return () => handlers.forEach((cleanup) => cleanup());
}
