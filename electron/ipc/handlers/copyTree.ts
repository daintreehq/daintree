import { clipboard } from "electron";
import crypto from "crypto";
import path from "path";
import { pathToFileURL } from "url";
import { z } from "zod";
import { CHANNELS } from "../channels.js";
import { ValidationError } from "../validationError.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  neutralizeControlCharacters,
} from "../../../shared/utils/terminalInputProtocol.js";
import {
  broadcastToRenderer,
  checkRateLimit,
  sendToRenderer,
  sendToRendererContext,
  typedHandle,
  typedHandleWithContext,
} from "../utils.js";
import {
  getOperationRegistry,
  untrackedOperationHandle,
  type OperationHandle,
} from "../../services/operations/index.js";
import type { ClientEndpoint } from "../endpoint.js";
import { getRemoteService } from "../../remote/runtime.js";
import { resolveScopedProjectForIpcContext } from "../projectContext.js";
import { isAssistantTerminalRecord } from "../../services/assistantTerminal.js";
import { getLifecycleLedger } from "../../services/pty/lifecycleLedger.js";
import { isPlainShellName } from "../../services/pty/agentProcessTree.js";
import { isBuiltInAgentId } from "../../../shared/config/agentIds.js";
import type { TerminalInfoPayload } from "../../../shared/types/ipc/terminal.js";
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
import type { CopyTreeRunSource } from "../../../shared/types/ipc/copyTreeHistory.js";

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
import { AppError } from "../../utils/errorTypes.js";
import type {
  CopyTreeCancelPayload,
  CopyTreeTestConfigOptions,
  Project,
  ProjectSettings,
} from "../../types/index.js";
import type { WorktreeSnapshot } from "../../../shared/types/workspace-host.js";
import { projectStore } from "../../services/ProjectStore.js";
import { recordCopyTreeRun } from "../../services/copyTreeHistoryService.js";
import {
  contextInjectionTracker,
  type InjectionStop,
} from "../../services/ContextInjectionTracker.js";
import { events } from "../../services/events.js";
import {
  fitContentToResultBudget,
  readContentPreview,
  releaseContextFilePath,
  reserveContextFilePath,
} from "../../services/copyTreeOutputFile.js";
import { scratchStore } from "../../services/ScratchStore.js";
import {
  cancelAllWorkspaceRootContext,
  generateWorkspaceRootContext,
} from "../../services/workspaceRootCopyTree.js";
import { isFullyQualifiedRoot } from "../../utils/fullyQualifiedRoot.js";

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
export function resolveCopyTreeProjectId(
  ctx: IpcContext,
  deps: HandlerDependencies
): string | null {
  const scopedProject = resolveScopedProjectForIpcContext(ctx, deps);
  if (scopedProject === null) {
    return projectStore.getCurrentProjectId();
  }
  return scopedProject.project?.id ?? null;
}

/**
 * The sender view's project id and its row, resolved together so the worktree
 * lookup and the settings load can never answer for two different projects.
 */
interface CopyTreeSender {
  projectId: string | null;
  /** Null for an unbound view, a scratch (#11484), or an unknown id. */
  project: Project | null;
  /**
   * The folder the sender view's workspace is rooted at — its project's path,
   * or a scratch's own folder. Null when the view resolves to no workspace, and
   * deliberately never the global current project: a root copy bundles whole
   * folders, so it must only ever reach the view's own (#13210).
   */
  workspaceRoot: string | null;
}

/**
 * Both halves of the sender's identity, resolved synchronously.
 *
 * Call this exactly where `resolveCopyTreeProjectId` used to be called — before
 * the handler's first `await`, for the reason documented on that function. The
 * row lookup is synchronous too, so pinning it here costs nothing.
 */
function resolveCopyTreeSender(ctx: IpcContext, deps: HandlerDependencies): CopyTreeSender {
  const scoped = resolveScopedProjectForIpcContext(ctx, deps);
  const projectId =
    scoped === null ? projectStore.getCurrentProjectId() : (scoped.project?.id ?? null);
  const project = projectId ? (projectStore.getProjectById(projectId) ?? null) : null;
  let workspaceRoot: string | null = null;
  if (scoped?.project) {
    workspaceRoot = scoped.project.path;
  } else if (scoped?.workspaceId) {
    workspaceRoot = scratchStore.getScratchById(scoped.workspaceId)?.path ?? null;
  }
  return { projectId, project, workspaceRoot };
}

/**
 * The requested worktree, looked up in the *sender's* project rather than the
 * window's (#11751).
 *
 * `getAllStatesAsync(windowId)` resolves through `WorkspaceHostPool`'s
 * `windowToProject`, which is repointed to the incoming project the instant a
 * switch starts — so a call from a backgrounded view was answered by whichever
 * project the window happens to show, and its own worktree came back "not
 * found" while `worktree.list` reported that same id as valid. Worse, a sender
 * with no window at all fell into the `windowId === undefined` branch, which
 * unions every live host: worktree ids are normalized absolute paths, so a
 * guessed one could bundle a sibling project's file contents (the containment
 * `fileBrowser.ts` states for its own worktree lookup, #11366).
 *
 * Takes the already-resolved sender instead of `ctx` so it *cannot* re-resolve
 * the project after the await — the eviction race #6015/#11103 fixed for
 * settings applies verbatim here.
 *
 * A sender with no project row resolves nothing. A supplied worktree id
 * demands a project row — the workspace root a scratch or worktree-less project
 * has is not a worktree, and falling back to one would silently widen the
 * bundle to a folder the caller never named. The one way to reach that root is
 * to name no worktree at all, which only `generateAndCopyFile` accepts
 * (#13210).
 */
async function findSenderWorktree(
  sender: CopyTreeSender,
  worktreeId: string,
  worktreeService: NonNullable<HandlerDependencies["worktreeService"]>
): Promise<WorktreeSnapshot | undefined> {
  if (!sender.project) {
    return undefined;
  }
  // Path and id come from the one row: the path selects the host, the id
  // authorizes it (a project's path is mutable, so it is not an identity).
  const states = await worktreeService.getAllStatesForProjectAsync(
    sender.project.path,
    sender.project.id
  );
  return states.find((wt) => wt.id === worktreeId);
}

/**
 * Record a completed run in the project's copy-tree history (#11732).
 *
 * Takes the *validated* payload rather than the merged options: merging folds
 * in live project settings, and a record that froze those in would replay a
 * stale configuration the next time it is re-run.
 *
 * `projectId` must be the value captured synchronously before the handler's
 * first await — re-resolving here would read whatever project the sender's view
 * has since been repointed at.
 *
 * Awaited by its callers so the write and its snapshot push stay ordered behind
 * the per-project queue, and swallowing here rather than only inside the service
 * so that ordering can never cost the caller its result: by this point the
 * bundle has already been delivered, and no bookkeeping failure may turn a
 * completed copy into an error the user sees.
 */
async function recordCompletedCopyTreeRun(
  projectId: string | null,
  validated: {
    worktreeId?: string;
    options?: CopyTreeOptions;
    name?: string;
    source?: CopyTreeRunSource;
  },
  result: CopyTreeResult,
  /** Provenance for a workspace-root run, which names no worktree (#13210). */
  rootPath?: string
): Promise<void> {
  const worktreeId = validated.worktreeId ?? rootPath;
  if (!worktreeId) return;
  try {
    await recordCopyTreeRun(projectId, {
      // Forwarded raw, including blank and untrimmed values: `applyCopyTreeRun`
      // is the authoritative normalization seam (blank-as-absent, trim,
      // truncate), and normalizing twice would let the two drift.
      name: validated.name,
      options: validated.options ?? {},
      source: validated.source ?? "unknown",
      worktreeId,
      stats: {
        fileCount: result.fileCount,
        totalSize: result.stats?.totalSize,
        duration: result.stats?.duration,
      },
    });
  } catch (error) {
    console.warn("[CopyTree] Failed to record run in the project history:", error);
  }
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

const INJECTION_CANCELLED = "Injection cancelled";
const INPUT_LOCKED_STOP = "Injection stopped: the terminal's input was locked";
const AGENT_GONE_STOP = "Injection stopped: the agent it was for is no longer running there";
const TERMINAL_CLOSED = "Terminal closed during injection";
const TERMINAL_GONE = "Terminal no longer exists";
const SHELL_REFUSAL = "Context can only be injected into a running agent, not a shell";
const NOT_ACCEPTING_PASTE =
  "The agent isn't accepting pasted text yet. Try again once its prompt is ready";
const PASTE_READY_WAIT_MS = 10_000;
const PASTE_READY_POLL_MS = 250;

function describeInjectionStop(stop: InjectionStop): string {
  return stop === "input-locked" ? INPUT_LOCKED_STOP : INJECTION_CANCELLED;
}

/**
 * Why delivery must stop. `closePaste` says whether the program that read the
 * opener is still there to be handed its terminator.
 */
interface InjectionHalt {
  error: string;
  closePaste: boolean;
}

/**
 * The terminal and agent an injection was admitted for, held from before
 * generation to the last chunk.
 */
interface InjectionTarget {
  /** Lifecycle-ledger generation of the incarnation that was asked for. */
  readonly generation: number | undefined;
  /** Fold in a fresh host answer: the agent it names must still be the owner. */
  observe(info: TerminalInfoPayload | null): void;
  /** Why the injection can no longer go to this target, or null while it can. */
  lost(): string | null;
  dispose(): void;
}

/**
 * Why the host's view of a terminal doesn't admit the bundle as a bracketed
 * paste, or null when it does. `transient` marks a verdict worth waiting out:
 * an agent still starting, or one that hasn't turned bracketed paste on yet.
 */
export function judgePasteDestination(
  info: TerminalInfoPayload | null,
  platform: NodeJS.Platform = process.platform
): { reason: string; transient: boolean } | null {
  if (!info?.hasPty) return { reason: TERMINAL_GONE, transient: false };
  // The host recognises only built-in agents in the process tree. For one a
  // plugin contributed, the launch plus a foreground process that isn't the
  // shell it runs in is the evidence there is.
  const contributedAgent =
    info.launchAgentId !== undefined && !isBuiltInAgentId(info.launchAgentId);
  // node-pty on Windows answers with the terminal name it was spawned with
  // (`xterm-256color`), not a process, so there is no foreground to go on.
  const foreground = platform === "win32" ? undefined : info.ptyForegroundProcess;
  if (
    info.detectedAgentId === undefined &&
    contributedAgent &&
    (foreground === undefined || isPlainShellName(foreground))
  ) {
    return { reason: SHELL_REFUSAL, transient: true };
  }
  if (info.detectedAgentId === undefined && !contributedAgent) {
    // A launch the host has never seen an agent in is still starting; one it
    // has is a shell again.
    const starting = info.launchAgentId !== undefined && info.everDetectedAgent !== true;
    return { reason: SHELL_REFUSAL, transient: starting };
  }
  if (info.bracketedPasteMode !== true) return { reason: NOT_ACCEPTING_PASTE, transient: true };
  return null;
}

/**
 * Progress goes to the caller on the existing channel and to the operation,
 * whose events reach every client of the project. A remote caller has no
 * window, so it is answered through its endpoint rather than a broadcast that
 * would land in every other client too.
 */
function reportCopyTreeProgress(
  ctx: IpcContext,
  op: OperationHandle,
  progress: CopyTreeProgress
): void {
  const senderWindow = ctx.senderWindow;
  if (senderWindow && !senderWindow.isDestroyed()) {
    sendToRenderer(senderWindow, CHANNELS.COPYTREE_PROGRESS, progress);
  } else if ((ctx.endpoint as ClientEndpoint | undefined)?.kind === "remote-view") {
    sendToRendererContext(ctx, CHANNELS.COPYTREE_PROGRESS, progress);
  } else {
    broadcastToRenderer(CHANNELS.COPYTREE_PROGRESS, progress);
  }
  op.progress({ fraction: progress.progress, stage: progress.stage, message: progress.message });
}

/** The operation-stamped progress event; an unnamed run's events carry no opId, as before. */
function stampProgress(
  progress: CopyTreeProgress,
  traceId: string,
  op: OperationHandle
): CopyTreeProgress {
  return op.tracked ? { ...progress, traceId, opId: op.opId } : { ...progress, traceId };
}

/**
 * Runs a copytree call as an operation when the caller named one. A retry
 * carrying the same opId joins the first run instead of generating (or
 * injecting) twice, and the retained record keeps a summary, never the bundle
 * content. A call with no opId runs exactly as it did before operations.
 *
 * The opId is validated first, through the channel's own schema, so a
 * malformed one is refused before any work rather than read as "no id".
 */
async function runCopyTreeOperation(
  channel: string,
  schema: { shape: { opId: z.ZodType<string | undefined> } },
  ctx: IpcContext,
  payload: unknown,
  work: (op: OperationHandle) => Promise<CopyTreeResult>
): Promise<CopyTreeResult> {
  const rawOpId =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>).opId : undefined;
  const parsed = schema.shape.opId.safeParse(rawOpId);
  if (!parsed.success) {
    throw new AppError({ code: "VALIDATION", message: "Invalid operation id" });
  }
  const opId = parsed.data;
  if (opId === undefined) return work(untrackedOperationHandle());
  return getOperationRegistry().run(
    {
      opId,
      kind: "copytree",
      scope: channel,
      projectId: ctx.projectId,
    },
    work,
    {
      failureOf: (result) => result.error ?? null,
      cancelledBy: (result) => result.error === INJECTION_CANCELLED,
      recordResult: (result) => ({
        fileCount: result.fileCount,
        filePath: result.filePath ?? null,
        outputBytes: result.outputBytes ?? null,
      }),
    }
  );
}

/**
 * Put a file on this machine's clipboard as a file (not its text), the way a
 * file manager's Copy does. A remote window's copy-as-file lands here too,
 * with the bundle already downloaded from its host.
 */
export function copyFileToClipboard(filePath: string): void {
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
    target: { path: string; branch?: string; isWorkspaceRoot?: boolean },
    options: CopyTreeOptions,
    onProgress: (progress: CopyTreeProgress) => void
  ): Promise<CopyTreeResult> => {
    let filePath: string;
    try {
      filePath = await reserveContextFilePath({
        worktreePath: target.path,
        branch: target.branch,
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
      // A workspace root has no workspace host to route to — a scratch never
      // gets one — so it runs on main's own CopyTree worker (#13210).
      const result = target.isWorkspaceRoot
        ? await generateWorkspaceRootContext(target.path, options, onProgress, filePath)
        : await deps.worktreeService!.generateContext(target.path, options, onProgress, filePath);
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
    ctx: IpcContext,
    payload: CopyTreeGeneratePayload,
    op: OperationHandle
  ): Promise<CopyTreeResult> => {
    checkRateLimit(CHANNELS.COPYTREE_GENERATE, 5, 10_000);
    const traceId = crypto.randomUUID();
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
    const sender = resolveCopyTreeSender(ctx, deps);

    const worktree = await findSenderWorktree(sender, validated.worktreeId, deps.worktreeService);

    if (!worktree) {
      return {
        content: "",
        fileCount: 0,
        error: `Worktree not found: ${validated.worktreeId}`,
      };
    }

    const onProgress = (progress: CopyTreeProgress) => {
      reportCopyTreeProgress(ctx, op, stampProgress(progress, traceId, op));
    };

    // Merge project settings with runtime options
    const projectSettings = await loadCopyTreeProjectSettings(sender.projectId);
    const mergedOptions = mergeCopyTreeOptions(projectSettings, validated.options);

    const result = await generateToFile(worktree, mergedOptions, onProgress);
    if (result.error) {
      return result;
    }

    await recordCompletedCopyTreeRun(sender.projectId, validated, result);

    // A remote Shell downloads the bundle it just asked for (copy-as-file). The
    // host serves that one file to that one endpoint, and only because it was
    // generated for it here; the rest of the shared context folder stays shut.
    // Only a link call has no event, so a local call never materialises its
    // lazily-built endpoint just to be told it is local.
    const endpoint = ctx.event ? undefined : (ctx.endpoint as ClientEndpoint | undefined);
    if (endpoint?.kind === "remote-view" && result.filePath) {
      getRemoteService("hostFileService")?.recordBundle(endpoint, result.filePath);
    }

    if (!result.filePath || !validated.includeContent) {
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
  handlers.push(
    typedHandleWithContext(CHANNELS.COPYTREE_GENERATE, (ctx, payload) =>
      runCopyTreeOperation(
        CHANNELS.COPYTREE_GENERATE,
        CopyTreeGeneratePayloadSchema,
        ctx,
        payload,
        (op) => handleCopyTreeGenerate(ctx, payload, op)
      )
    )
  );

  const handleCopyTreeGenerateAndCopyFile = async (
    ctx: IpcContext,
    payload: CopyTreeGenerateAndCopyFilePayload,
    op: OperationHandle
  ): Promise<CopyTreeResult> => {
    checkRateLimit(CHANNELS.COPYTREE_GENERATE_AND_COPY_FILE, 5, 10_000);
    const traceId = crypto.randomUUID();
    const requestedWorktreeId = getStringField(payload, "worktreeId") ?? "(workspace root)";
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

    // Capture the sender's project before awaiting: the view can be evicted
    // while the workspace call is in flight, taking its binding with it.
    const sender = resolveCopyTreeSender(ctx, deps);

    // No worktree named means the view's own workspace root — the only thing a
    // scratch or a non-git project has to copy (#13210). A named one must
    // resolve: it never falls back to that wider folder.
    let target: { path: string; branch?: string; isWorkspaceRoot?: boolean };
    if (validated.worktreeId === undefined) {
      if (!sender.workspaceRoot || !isFullyQualifiedRoot(sender.workspaceRoot)) {
        return { content: "", fileCount: 0, error: "No workspace open to copy" };
      }
      target = { path: sender.workspaceRoot, isWorkspaceRoot: true };
    } else {
      if (!deps.worktreeService) {
        return {
          content: "",
          fileCount: 0,
          error: "Workspace client not initialized",
        };
      }
      const worktree = await findSenderWorktree(sender, validated.worktreeId, deps.worktreeService);
      if (!worktree) {
        return {
          content: "",
          fileCount: 0,
          error: `Worktree not found: ${validated.worktreeId}`,
        };
      }
      target = worktree;
    }

    const onProgress = (progress: CopyTreeProgress) => {
      reportCopyTreeProgress(ctx, op, stampProgress(progress, traceId, op));
    };

    // Merge project settings with runtime options
    const projectSettings = await loadCopyTreeProjectSettings(sender.projectId);
    const mergedOptions = mergeCopyTreeOptions(projectSettings, validated.options);

    // Written by the workspace host straight to disk. This handler used to pull
    // the whole bundle across two process boundaries only to write it out here
    // (#11528); the file it needs is now already on disk when the call returns.
    const result = await generateToFile(target, mergedOptions, onProgress);

    if (result.error || !result.filePath) {
      return result;
    }

    // Recorded on generation, not on the clipboard write below. The bundle now
    // exists and its path rides back even when the clipboard step throws, so a
    // run the user would most want to retry is exactly the one that must not be
    // missing from the history.
    await recordCompletedCopyTreeRun(
      sender.projectId,
      validated,
      result,
      target.isWorkspaceRoot ? target.path : undefined
    );

    const filePath = result.filePath;

    try {
      copyFileToClipboard(filePath);

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
    typedHandleWithContext(CHANNELS.COPYTREE_GENERATE_AND_COPY_FILE, (ctx, payload) =>
      runCopyTreeOperation(
        CHANNELS.COPYTREE_GENERATE_AND_COPY_FILE,
        CopyTreeGenerateAndCopyFilePayloadSchema,
        ctx,
        payload,
        (op) => handleCopyTreeGenerateAndCopyFile(ctx, payload, op)
      )
    )
  );

  /**
   * Pin the incarnation and the agent an injection is for, before generation
   * spends seconds on it. A terminal with no agent detected yet (a workflow
   * injects right after launching one) takes the first agent seen as its
   * owner. From then on an exit, a respawn, or a different agent or session in
   * the same pane means the bundle no longer has its reader.
   *
   * The host's agent events keep the pin current between snapshots, so a chunk
   * boundary needs no round trip. An agent a plugin contributed has no
   * detected identity, so only the incarnation is pinned for it.
   */
  const pinInjectionTarget = async (terminalId: string): Promise<InjectionTarget> => {
    const ledger = getLifecycleLedger();
    const generation = ledger.currentGeneration(terminalId);
    const info = await deps.ptyClient!.getTerminalInfo(terminalId);
    let owner: { agentId: string; incarnation: number | undefined } | undefined;
    let lost: string | null = null;

    const adoptOrCompare = (agentId: string, incarnation: number | undefined): void => {
      if (!owner) {
        owner = { agentId, incarnation };
        return;
      }
      // Absent means unobserved, never zero, so only two observed counts compare.
      const relaunched =
        owner.incarnation !== undefined &&
        incarnation !== undefined &&
        owner.incarnation !== incarnation;
      if (owner.agentId !== agentId || relaunched) lost = AGENT_GONE_STOP;
    };

    // An answer that straddled a respawn describes the predecessor. No answer
    // at all is a spawn the host hasn't made yet (or a failed read), so the
    // pin waits for the first agent seen.
    if (ledger.currentGeneration(terminalId) !== generation) lost = TERMINAL_CLOSED;
    else if (info && !info.hasPty) lost = TERMINAL_GONE;
    else if (info?.detectedAgentId) adoptOrCompare(info.detectedAgentId, info.agentIncarnation);

    // Subscribed in the continuation of the snapshot, so every event seen here
    // happened after the state that answer describes.
    const offDetected = events.on("agent:detected", (event) => {
      if (lost || event.terminalId !== terminalId || !event.agentType) return;
      adoptOrCompare(event.agentType, event.agentIncarnation);
    });
    // An agent leaving before one was pinned was there when the injection was
    // asked for, unseen by a failed read: whatever starts next isn't it.
    const offExited = events.on("agent:exited", (event) => {
      if (lost || event.terminalId !== terminalId || !event.agentType) return;
      lost = AGENT_GONE_STOP;
    });

    return {
      generation,
      observe(next) {
        if (lost) return;
        if (ledger.currentGeneration(terminalId) !== generation) {
          lost = TERMINAL_CLOSED;
          return;
        }
        if (next?.detectedAgentId) {
          adoptOrCompare(next.detectedAgentId, next.agentIncarnation);
        } else if (owner && next?.hasPty) {
          lost = AGENT_GONE_STOP;
        }
      },
      lost: () => lost,
      dispose() {
        offDetected();
        offExited();
      },
    };
  };

  /**
   * Poll the host until the terminal can take the paste, for as long as the
   * verdict could still change: a workflow injects right after launching its
   * agent, before the CLI has drawn a prompt. Every answer is held against the
   * pinned target, so a respawn or a new agent can't inherit the paste.
   */
  const awaitPasteDestination = async (
    terminalId: string,
    target: InjectionTarget,
    halted: () => InjectionHalt | null
  ): Promise<{ error: string } | null> => {
    const deadline = Date.now() + PASTE_READY_WAIT_MS;
    for (;;) {
      const before = halted();
      if (before) return before;
      const info = await deps.ptyClient!.getTerminalInfo(terminalId);
      target.observe(info);
      const after = halted();
      if (after) return after;
      const verdict = judgePasteDestination(info);
      if (!verdict) return null;
      if (!verdict.transient) return { error: verdict.reason };
      if (Date.now() >= deadline) return { error: verdict.reason };
      await new Promise((resolve) => setTimeout(resolve, PASTE_READY_POLL_MS));
    }
  };

  /**
   * Stream `sources` into the terminal as ONE bracketed paste: the wrapper
   * opens once, each surrogate-safe chunk is neutralised on its way out, and
   * the wrapper closes after the last source. `formatWithBracketedPaste` does
   * the same in one string; this payload is too large to hold twice or to
   * write without a cancellation point.
   *
   * Once delivery stops — cancelled, locked, terminal gone, a write that
   * throws, the agent gone — no further body byte is written. The terminator
   * is the one exception, so a program still reading is never left inside an
   * open paste; one that left has no paste to close.
   */
  const writeBracketedPaste = async (
    terminalId: string,
    generation: number | undefined,
    sources: string[],
    halted: () => InjectionHalt | null,
    traceId: string
  ): Promise<string | null> => {
    const ptyClient = deps.ptyClient!;
    const ledger = getLifecycleLedger();
    const CHUNK_SIZE = 4096;
    if (sources.every((source) => source.length === 0)) return null;
    let opened = false;

    // `hasTerminal` alone stays true across a same-id respawn, whose successor
    // never saw the opener and would read the rest of the bundle as typing.
    const isAdmittedTerminalAlive = (): boolean =>
      ptyClient.hasTerminal(terminalId) &&
      ledger.currentGeneration(terminalId) === generation &&
      ledger.getEntry(terminalId)?.closedAt === undefined;

    const stop = (error: string, closePaste = true): string => {
      if (closePaste && opened && isAdmittedTerminalAlive()) {
        try {
          ptyClient.write(terminalId, BRACKETED_PASTE_END, traceId);
        } catch {
          // The write that failed first is the error worth reporting.
        }
      }
      return error;
    };

    // Admission resolved a continuation ago; a respawn can land in between.
    const beforeOpen = halted();
    if (beforeOpen) return beforeOpen.error;
    if (!isAdmittedTerminalAlive()) return TERMINAL_CLOSED;
    try {
      ptyClient.write(terminalId, BRACKETED_PASTE_START, traceId);
      opened = true;
      for (const source of sources) {
        for (let i = 0; i < source.length;) {
          const halt = halted();
          if (halt) {
            console.log(`[${traceId}] CopyTree inject stopped: ${halt.error}`);
            return stop(halt.error, halt.closePaste);
          }
          if (!isAdmittedTerminalAlive()) {
            return stop(TERMINAL_CLOSED);
          }
          const end = nextChunkBoundary(source, i, CHUNK_SIZE);
          // Neutralising maps each code unit to one code unit, so a chunk cut
          // on a surrogate boundary stays cut on one.
          const chunk = neutralizeControlCharacters(source.slice(i, end), {
            insideBracketedPaste: true,
          });
          ptyClient.write(terminalId, chunk, traceId);
          i = end;
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
    } catch (error) {
      return stop(
        `Failed to write context to the terminal: ${formatErrorMessage(error, "unknown error")}`
      );
    }

    const afterLast = halted();
    if (afterLast) return stop(afterLast.error, afterLast.closePaste);
    if (!isAdmittedTerminalAlive()) return TERMINAL_CLOSED;
    try {
      ptyClient.write(terminalId, BRACKETED_PASTE_END, traceId);
    } catch (error) {
      return `Failed to write context to the terminal: ${formatErrorMessage(error, "unknown error")}`;
    }
    return null;
  };

  const handleCopyTreeInject = async (
    ctx: IpcContext,
    payload: CopyTreeInjectPayload,
    op: OperationHandle
  ): Promise<CopyTreeResult> => {
    checkRateLimit(CHANNELS.COPYTREE_INJECT, 5, 10_000);
    const traceId = crypto.randomUUID();
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
    const sender = resolveCopyTreeSender(ctx, deps);

    contextInjectionTracker.beginInjection(validated.terminalId, injectionId);
    op.onCancel(() => contextInjectionTracker.markCancelled(injectionId));
    let target: InjectionTarget | undefined;

    // A lock or cancel arrives as a stop on the tracker, and the target's own
    // loss comes from the host; either ends the run at its next checkpoint.
    // Only a target still there is handed the terminator, whichever stop won.
    const halted = (): InjectionHalt | null => {
      const lost = target?.lost() ?? null;
      const stop = contextInjectionTracker.getStop(injectionId);
      if (stop) return { error: describeInjectionStop(stop), closePaste: lost === null };
      return lost ? { error: lost, closePaste: false } : null;
    };

    try {
      const worktree = await findSenderWorktree(sender, validated.worktreeId, deps.worktreeService);

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

      // `terminal.inject`, `worktree.inject` and `copyTree.injectToTerminal` take
      // any panel id and are open to plugin dispatch with no capability, so
      // without this a plugin could type a codebase dump into the Daintree
      // Assistant (#13494).
      if (
        isAssistantTerminalRecord({
          id: validated.terminalId,
          isAssistantTerminal: deps.ptyClient!.isAssistantTerminal(validated.terminalId),
        })
      ) {
        return {
          content: "",
          fileCount: 0,
          error: "Context can't be injected into the Daintree Assistant",
        };
      }

      const onProgress = (progress: CopyTreeProgress) => {
        reportCopyTreeProgress(ctx, op, stampProgress(progress, traceId, op));
      };

      target = await pinInjectionTarget(validated.terminalId);

      // Merge project settings with runtime options
      const projectSettings = await loadCopyTreeProjectSettings(sender.projectId);
      const mergedOptions = mergeCopyTreeOptions(projectSettings, validated.options || {});

      // A run stopped while it was being set up has nothing to generate for.
      const beforeGeneration = halted();
      if (beforeGeneration) {
        return { content: "", fileCount: 0, error: beforeGeneration.error };
      }

      const result = await deps.worktreeService.generateContext(
        worktree.path,
        mergedOptions,
        onProgress
      );

      if (result.error) {
        return result;
      }

      // Admitted only now, against what the host has parsed since generation
      // started: the bundle is written as one bracketed paste, which a shell's
      // line editor would still leave as a multi-megabyte draft, and a program
      // with bracketed paste off reads every newline in it as Enter.
      const refusal = await awaitPasteDestination(validated.terminalId, target, halted);
      if (refusal) {
        return { content: "", fileCount: 0, error: refusal.error };
      }

      const injectError = await writeBracketedPaste(
        validated.terminalId,
        target.generation,
        [result.content, buildRemoteComputeBlock(worktree)],
        halted,
        traceId
      );
      if (injectError) {
        return { content: "", fileCount: 0, error: injectError };
      }

      console.log(`[${traceId}] CopyTree inject completed successfully`);

      // Injection is the same intent as a copy with a different delivery, so it
      // earns a history entry too — and dedupes against the clipboard run that
      // used the same options.
      await recordCompletedCopyTreeRun(sender.projectId, validated, result);

      // The renderer reads only fileCount/stats; drop the (possibly multi-MB)
      // content so the contextBridge doesn't clone a second copy into the heap.
      return {
        content: "",
        fileCount: result.fileCount,
        stats: result.stats,
        outputFormatVersion: result.outputFormatVersion,
      };
    } finally {
      target?.dispose();
      contextInjectionTracker.finishInjection(validated.terminalId, injectionId);
    }
  };
  handlers.push(
    typedHandleWithContext(CHANNELS.COPYTREE_INJECT, (ctx, payload) =>
      runCopyTreeOperation(
        CHANNELS.COPYTREE_INJECT,
        CopyTreeInjectPayloadSchema,
        ctx,
        payload,
        (op) => handleCopyTreeInject(ctx, payload, op)
      )
    )
  );

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
      const wasActive = contextInjectionTracker.markCancelled(
        validated.injectionId,
        validated.reason
      );
      if (wasActive) {
        console.log(`[cancel] Marked injection ${validated.injectionId} for cancellation`);
      } else {
        console.log(
          `[cancel] Holding cancel for injection ${validated.injectionId} not yet active`
        );
      }
    } else {
      const count = contextInjectionTracker.markAllCancelled();
      if (deps.worktreeService) {
        deps.worktreeService.cancelAllContext();
      }
      cancelAllWorkspaceRootContext();
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
    const sender = resolveCopyTreeSender(ctx, deps);

    const worktree = await findSenderWorktree(sender, validated.worktreeId, deps.worktreeService);

    if (!worktree) {
      throw new Error(`Worktree not found: ${validated.worktreeId}`);
    }

    // The same merge generation uses. Without it the listing would answer for
    // CopyTree's defaults while the bundle is built with the project's
    // exclusions and budgets — the disagreement this channel exists to end
    // (#11439).
    const projectSettings = await loadCopyTreeProjectSettings(sender.projectId);
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
    const sender = resolveCopyTreeSender(ctx, deps);

    const worktree = await findSenderWorktree(sender, validated.worktreeId, deps.worktreeService);

    if (!worktree) {
      return {
        includedFiles: 0,
        includedSize: 0,
        error: `Worktree not found: ${validated.worktreeId}`,
      };
    }

    // Merge project settings with runtime options
    const projectSettings = await loadCopyTreeProjectSettings(sender.projectId);
    const mergedOptions = mergeCopyTreeOptions(projectSettings, validated.options);

    return deps.worktreeService.testConfig(worktree.path, mergedOptions);
  };
  handlers.push(typedHandleWithContext(CHANNELS.COPYTREE_TEST_CONFIG, handleCopyTreeTestConfig));

  return () => handlers.forEach((cleanup) => cleanup());
}
