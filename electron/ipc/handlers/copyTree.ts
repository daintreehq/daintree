import { clipboard } from "electron";
import crypto from "crypto";
import path from "path";
import { pathToFileURL } from "url";
import { CHANNELS } from "../channels.js";
import {
  broadcastToRenderer,
  checkRateLimit,
  sendToRenderer,
  typedHandle,
  typedHandleWithContext,
} from "../utils.js";
import type { HandlerDependencies } from "../types.js";
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
  xml: "xml",
};

const getExtensionForFormat = (format: CopyTreeFormat | undefined): string => {
  if (!format) return "xml";
  return FORMAT_TO_EXTENSION[format] ?? "xml";
};

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
} from "../../schemas/ipc.js";
import type { CopyTreeCancelPayload, ProjectSettings } from "../../types/index.js";
import { projectStore } from "../../services/ProjectStore.js";
import { contextInjectionTracker } from "../../services/ContextInjectionTracker.js";

function getStringField(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Merge project-level settings with runtime CopyTree options.
 * Runtime options take precedence over project settings.
 *
 * Merges both:
 * - ProjectSettings.excludedPaths (default exclusions)
 * - ProjectSettings.copyTreeSettings (context generation settings)
 */
export function mergeCopyTreeOptions(
  projectSettings: Pick<ProjectSettings, "excludedPaths" | "copyTreeSettings"> | undefined,
  runtimeOptions: CopyTreeOptions | undefined
): CopyTreeOptions {
  if (!projectSettings) {
    return runtimeOptions || {};
  }

  const merged: CopyTreeOptions = {
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
    return merged;
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

  return merged;
}

/**
 * Get the current project's settings for CopyTree operations.
 * Returns undefined if no project is active.
 */
async function getCurrentProjectSettings(): Promise<
  Pick<ProjectSettings, "excludedPaths" | "copyTreeSettings"> | undefined
> {
  const currentProjectId = projectStore.getCurrentProjectId();
  if (!currentProjectId) {
    return undefined;
  }
  try {
    const settings = await projectStore.getProjectSettings(currentProjectId);
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
      console.error(`[${traceId}] Invalid CopyTree generate payload:`, parseResult.error.format());
      return {
        content: "",
        fileCount: 0,
        error: `Invalid payload: ${parseResult.error.message}`,
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
    const projectSettings = await getCurrentProjectSettings();
    const mergedOptions = mergeCopyTreeOptions(projectSettings, validated.options);

    return deps.worktreeService.generateContext(worktree.path, mergedOptions, onProgress);
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
        parseResult.error.format()
      );
      return {
        content: "",
        fileCount: 0,
        error: `Invalid payload: ${parseResult.error.message}`,
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
    const projectSettings = await getCurrentProjectSettings();
    const mergedOptions = mergeCopyTreeOptions(projectSettings, validated.options);

    const result = await deps.worktreeService.generateContext(
      worktree.path,
      mergedOptions,
      onProgress
    );

    if (result.error) {
      return result;
    }

    try {
      const fs = await import("fs/promises");
      const os = await import("os");
      const path = await import("path");

      const tempDir = path.join(os.tmpdir(), "daintree-context");
      await fs.mkdir(tempDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const projectName =
        path
          .basename(worktree.path)
          .replace(/[^a-zA-Z0-9-_]/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-+|-+$/g, "")
          .toLowerCase()
          .slice(0, 50) || "project";
      const safeBranch =
        (worktree.branch || "head")
          .replace(/[^a-zA-Z0-9-_]/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 100) || "head";
      const extension = getExtensionForFormat(validated.options?.format);
      const filename = `${projectName}-${safeBranch}-${timestamp}.${extension}`;
      const filePath = path.join(tempDir, filename);

      await fs.writeFile(filePath, result.content, "utf-8");

      if (process.platform === "darwin") {
        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
    <string>${filePath}</string>
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

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[${traceId}] Failed to save/copy context file:`, errorMessage);
      return {
        ...result,
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
      console.error(`[${traceId}] Invalid CopyTree inject payload:`, parseResult.error.format());
      return {
        content: "",
        fileCount: 0,
        error: `Invalid payload: ${parseResult.error.message}`,
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
      const projectSettings = await getCurrentProjectSettings();
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
      const contentToInject = result.content + remoteComputeBlock;
      const CHUNK_SIZE = 4096;

      for (let i = 0; i < contentToInject.length; i += CHUNK_SIZE) {
        if (contextInjectionTracker.isCancelled(injectionId)) {
          console.log(`[${traceId}] CopyTree inject cancelled by user`);
          return {
            content: "",
            fileCount: 0,
            error: "Injection cancelled",
          };
        }

        if (!deps.ptyClient!.hasTerminal(validated.terminalId)) {
          return {
            content: "",
            fileCount: 0,
            error: "Terminal closed during injection",
          };
        }

        const chunk = contentToInject.slice(i, i + CHUNK_SIZE);
        deps.ptyClient!.write(validated.terminalId, chunk, traceId);
        if (i + CHUNK_SIZE < contentToInject.length) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      }

      console.log(`[${traceId}] CopyTree inject completed successfully`);
      return result;
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

    const validated = parseResult.success ? parseResult.data : {};

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
    payload: CopyTreeGetFileTreePayload
  ): Promise<FileTreeNode[]> => {
    checkRateLimit(CHANNELS.COPYTREE_GET_FILE_TREE, 5, 10_000);
    const parseResult = CopyTreeGetFileTreePayloadSchema.safeParse(payload);
    if (!parseResult.success) {
      throw new Error(`Invalid file tree request: ${parseResult.error.message}`);
    }

    const validated = parseResult.data;

    if (validated.dirPath) {
      if (path.isAbsolute(validated.dirPath)) {
        throw new Error("dirPath must be a relative path");
      }
      const normalized = path.normalize(validated.dirPath);
      if (normalized.startsWith("..")) {
        throw new Error("dirPath cannot traverse outside worktree root");
      }
    }

    if (!deps.worktreeService) {
      throw new Error("Worktree service not available");
    }

    const monitor = await deps.worktreeService.getMonitorAsync(validated.worktreeId);

    if (!monitor) {
      throw new Error(`Worktree not found: ${validated.worktreeId}`);
    }

    return deps.worktreeService.getFileTree(monitor.path, validated.dirPath);
  };
  handlers.push(typedHandle(CHANNELS.COPYTREE_GET_FILE_TREE, handleCopyTreeGetFileTree));

  const handleCopyTreeTestConfig = async (
    ctx: import("../types.js").IpcContext,
    payload: import("../../types/index.js").CopyTreeTestConfigPayload
  ): Promise<import("../../types/index.js").CopyTreeTestConfigResult> => {
    checkRateLimit(CHANNELS.COPYTREE_TEST_CONFIG, 5, 10_000);
    const traceId = crypto.randomUUID();
    const requestedWorktreeId = getStringField(payload, "worktreeId") ?? "unknown";
    console.log(`[${traceId}] CopyTree test-config started for worktree ${requestedWorktreeId}`);

    const { CopyTreeTestConfigPayloadSchema } = await import("../../schemas/ipc.js");
    const parseResult = CopyTreeTestConfigPayloadSchema.safeParse(payload);
    if (!parseResult.success) {
      console.error(
        `[${traceId}] Invalid CopyTree test-config payload:`,
        parseResult.error.format()
      );
      return {
        includedFiles: 0,
        includedSize: 0,
        excluded: { byTruncation: 0, bySize: 0, byPattern: 0 },
        error: `Invalid payload: ${parseResult.error.message}`,
      };
    }

    const validated = parseResult.data;

    if (!deps.worktreeService) {
      return {
        includedFiles: 0,
        includedSize: 0,
        excluded: { byTruncation: 0, bySize: 0, byPattern: 0 },
        error: "Workspace client not initialized",
      };
    }

    const senderWindowTestConfig = ctx.senderWindow;
    const states = await deps.worktreeService.getAllStatesAsync(senderWindowTestConfig?.id);
    const worktree = states.find((wt) => wt.id === validated.worktreeId);

    if (!worktree) {
      return {
        includedFiles: 0,
        includedSize: 0,
        excluded: { byTruncation: 0, bySize: 0, byPattern: 0 },
        error: `Worktree not found: ${validated.worktreeId}`,
      };
    }

    // Merge project settings with runtime options
    const projectSettings = await getCurrentProjectSettings();
    const mergedOptions = mergeCopyTreeOptions(projectSettings, validated.options);

    return deps.worktreeService.testConfig(worktree.path, mergedOptions);
  };
  handlers.push(typedHandleWithContext(CHANNELS.COPYTREE_TEST_CONFIG, handleCopyTreeTestConfig));

  return () => handlers.forEach((cleanup) => cleanup());
}
