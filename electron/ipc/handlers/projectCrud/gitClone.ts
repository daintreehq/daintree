import path from "path";
import { spawnSync } from "child_process";
import { CHANNELS } from "../../channels.js";
import { defineIpcNamespace, op } from "../../define.js";
import { getWindowForWebContents } from "../../../window/webContentsRegistry.js";
import { broadcastToRenderer, sendToRenderer, sendToRendererContext } from "../../utils.js";
import type { IpcContext } from "../../types.js";
import type { ClientEndpoint } from "../../endpoint.js";
import {
  getOperationRegistry,
  normalizeOperationId,
  untrackedOperationHandle,
  type OperationHandle,
} from "../../../services/operations/index.js";
import { createAuthenticatedGit } from "../../../utils/hardenedGit.js";
import {
  getActiveProvider,
  getForgeProviderImpl,
} from "../../../services/forgeProviderRegistry.js";
import { makeForgeProviderId } from "../../../../shared/utils/forgeProviderIds.js";
import { scrubSecrets } from "../../../../shared/utils/secretScrubber.js";
import type { CloneAuthProbe, CloneCapability } from "../../../../shared/types/forge.js";
import type {
  CloneCancelPayload,
  CloneRepoOptions,
  CloneRepoResult,
  CloneRepoProgressEvent,
} from "../../../../shared/types/ipc/gitClone.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import { validateFolderName } from "../../../../shared/utils/folderName.js";
import { classifyGitError } from "../../../../shared/utils/gitOperationErrors.js";
import { isSupportedCloneUrl } from "../../../../shared/utils/gitRemoteUrl.js";
import { AppError, GitOperationError } from "../../../utils/errorTypes.js";

/**
 * Resolve the clone capability of the forge provider matching the URL's
 * hostname. `undefined` when no provider matches or the impl doesn't implement
 * `clone`. Activates the matching plugin first (like `forgeRpcServer`) so a
 * clone issued before the provider's lazy `activate()` ran still gets the
 * authenticated path instead of silently falling back to an anonymous clone.
 */
async function resolveCloneCapability(url: string): Promise<CloneCapability | undefined> {
  const provider = getActiveProvider(url);
  if (!provider) return undefined;
  const namespacedId = makeForgeProviderId(provider.pluginId, provider.contribution.id);
  try {
    const { pluginService } = await import("../../../services/PluginService.js");
    await pluginService.activatePluginForForgeProvider(namespacedId);
  } catch {
    // Activation failure → fall through to whatever impl is (or isn't) bound.
  }
  return getForgeProviderImpl(namespacedId)?.clone;
}

/** Minimal shape of simple-git's internal PluginStore (`_plugins`). */
interface PluginStoreLike {
  append?(
    type: "spawn.after",
    action: (data: unknown, context: { spawned?: { pid?: number } }) => unknown
  ): () => void;
}

/**
 * Kill the git clone process tree on Windows. The orphaned child processes
 * (git-remote-https, index-pack) keep `.git/` files locked, so `fs.rm` of the
 * partial clone fails until they're gone. `taskkill /T /F` tears the whole
 * tree down atomically; it exits non-zero (and may throw) if the process
 * already exited — non-fatal, so swallow it. Mirrors ProcessTreeKiller.ts.
 */
function killCloneProcessTree(pid: number | undefined): void {
  if (process.platform !== "win32" || pid == null) return;
  try {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 3000,
    });
  } catch {
    // Process already exited — nothing to kill.
  }
}

/**
 * The same remote spelled with or without a trailing slash or `.git` is one
 * clone, so two clients naming it differently still join one operation.
 */
function normalizeCloneRemote(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
}

export type CloneDepth = "full" | "shallow" | "partial";

export interface ExecuteCloneOptions {
  url: string;
  /** Existing directory the clone is created in. */
  parentPath: string;
  folderName: string;
  /** `parentPath/folderName`; must not exist. */
  targetPath: string;
  /** `shallow` is `--depth 1`; `partial` is `--filter=blob:none`. */
  depth?: CloneDepth;
  /** Initialise and update submodules once the clone is in place. */
  recurseSubmodules?: boolean;
  signal: AbortSignal;
  onProgress: (stage: string, progress: number, message: string) => void;
}

function cloneArgs(depth: CloneDepth | undefined): string[] {
  if (depth === "shallow") return ["--depth", "1"];
  if (depth === "partial") return ["--filter=blob:none"];
  return [];
}

/**
 * Clone `url` into `targetPath` as this machine: the matching forge
 * provider's authenticated path when it has one, else plain git with the
 * user's own credentials. A failed or cancelled clone removes what it left
 * behind and throws `CANCELLED` or a classified {@link GitOperationError}
 * whose message is git's own text, scrubbed of credentials.
 */
export async function executeClone(options: ExecuteCloneOptions): Promise<void> {
  const { url, parentPath, folderName: trimmedFolder, targetPath, depth, signal } = options;
  const shallowClone = depth === "shallow";
  const emitProgress = options.onProgress;
  const fs = await import("fs");

  // Resolve the URL's forge provider and probe its clone auth — an
  // authenticated probe picks the provider's clone path below. Probe
  // failures mean "no authenticated path", never a clone failure.
  const cloneCapability = await resolveCloneCapability(url);
  let authProbe: CloneAuthProbe = { authenticated: false };
  if (cloneCapability) {
    try {
      authProbe = await cloneCapability.probeAuth(signal);
    } catch {
      // Fall back to plain git.
    }
  }

  // PID of the spawned `git clone` child process, captured via simple-git's
  // internal `spawn.after` plugin hook. Needed on Windows because aborting
  // the AbortController only kills the immediate process — git's children
  // (git-remote-https, index-pack) are orphaned and hold `.git/` file locks,
  // making the partial-clone cleanup below fail. Internal API (simple-git
  // 3.36): if `_plugins` ever disappears, `cloneChildPid` stays undefined
  // and the taskkill branch is simply skipped — degrades to prior behavior.
  let cloneChildPid: number | undefined;

  try {
    if (signal.aborted) {
      throw new AppError({ code: "CANCELLED", message: "Clone cancelled" });
    }

    // No "starting" event here on purpose: emitting one would populate the
    // renderer's progress list immediately and defeat the Doherty gate that
    // suppresses the connecting placeholder for sub-400ms clones. The
    // renderer owns that phase via `isCloning` + `useDohertyGate`.

    // A provider's own clone command takes no filter, so a partial clone
    // goes through git with the provider's authenticated URL instead.
    if (authProbe.authenticated && cloneCapability?.cloneRepository && depth !== "partial") {
      // Provider-owned clone (e.g. `gh repo clone`). Failures surface
      // directly — no plain-git retry, matching the historical gh path.
      await cloneCapability.cloneRepository(url, targetPath, {
        shallow: Boolean(shallowClone),
        signal: signal,
        onProgress: emitProgress,
      });
    } else {
      let cloneUrl = url;
      if (authProbe.authenticated && cloneCapability?.getAuthenticatedCloneUrl) {
        // May embed credentials — never log it; error context below already
        // omits the URL for the same reason.
        cloneUrl = (await cloneCapability.getAuthenticatedCloneUrl(url).catch(() => null)) ?? url;
      }
      const git = await createAuthenticatedGit(parentPath, {
        signal: signal,
        progress({ stage, progress }) {
          // Sentence-case the display label (git emits lowercase, e.g.
          // "receiving objects"); the lowercase `stage` stays the dedup key.
          const label = stage.charAt(0).toUpperCase() + stage.slice(1);
          emitProgress(stage, progress, `${label}: ${progress}%`);
        },
        extraConfig: [
          // CVE-2025-48385 / GHSA-m98c-vgpc-9655 (CVSS 8.6): a malicious
          // server can abuse Git's bundle-URI transport to write fetched
          // bundle content to arbitrary filesystem paths. Disabling it
          // client-side is defense-in-depth for users on git versions before
          // the 2.43.7 / 2.44.4 / 2.45.4 fixes (the server can't override
          // this).
          "transfer.bundleURI=false",
        ],
      });

      const pluginStore = (git as unknown as { _plugins?: PluginStoreLike })._plugins;
      pluginStore?.append?.("spawn.after", (data, context) => {
        cloneChildPid = context?.spawned?.pid;
        return data;
      });

      await git.clone(cloneUrl, trimmedFolder, cloneArgs(depth));
    }

    if (options.recurseSubmodules) {
      emitProgress("submodules", 0, "Updating submodules");
      const submoduleGit = await createAuthenticatedGit(targetPath, { signal });
      await submoduleGit.raw(["submodule", "update", "--init", "--recursive"]);
    }

    emitProgress("complete", 100, "Clone complete");
  } catch (error) {
    const wasCancelled =
      signal.aborted ||
      (error instanceof Error &&
        (error.name === "AbortError" ||
          (error instanceof AppError && error.code === "CANCELLED") ||
          /abort/i.test(error.message)));

    // Clean up partial clone. On Windows the spawned process tree must be
    // terminated before fs.rm or the orphaned children (git-remote-https,
    // index-pack) keep `.git/` files locked. A provider's `cloneRepository`
    // owns its own process-tree teardown on abort; the simple-git path needs
    // `killCloneProcessTree(cloneChildPid)` here because simple-git owns the
    // child and only the captured pid is reachable from this scope.
    killCloneProcessTree(cloneChildPid);

    const partialExists = await fs.promises
      .access(targetPath)
      .then(() => true)
      .catch(() => false);
    if (partialExists) {
      await fs.promises.rm(targetPath, { recursive: true, force: true }).catch((rmErr) => {
        // Don't escalate — the original clone error is what the user sees.
        // But surface this in logs so partial-cleanup failures (e.g. Windows
        // antivirus locks) are diagnosable instead of silently swallowed.
        console.warn("[gitClone] Failed to clean up partial clone at", targetPath, rmErr);
        // Tier 3 inline banner in the dialog: the leftover directory needs
        // manual removal, so the user has to know where it is.
        emitProgress(
          "cleanup-failed",
          0,
          `Couldn't remove the partial clone at ${targetPath}. Close any Git processes using it and delete the folder manually.`
        );
      });
    }

    if (wasCancelled) {
      emitProgress("cancelled", 0, "Clone cancelled");
      throw new AppError({
        code: "CANCELLED",
        message: "Clone cancelled",
        context: { targetPath },
      });
    }

    // Scrub before surfacing: a simple-git failure can echo the clone
    // command or remote, and an authenticated clone URL embeds credentials
    // (https://x-access-token:TOKEN@host/...). `scrubSecrets` redacts URL
    // basic-auth and known token shapes so neither the progress event nor
    // the thrown error leaks the secret.
    const errorMessage = scrubSecrets(formatErrorMessage(error, "Failed to clone repository"));
    emitProgress("error", 0, `Clone failed: ${errorMessage}`);
    const reason = classifyGitError(error);
    // `url` deliberately omitted from context — it can carry embedded
    // credentials (e.g. https://x-access-token:TOKEN@github.com/...) and
    // the renderer already has the input URL in local state.
    throw new GitOperationError(reason, errorMessage, {
      op: "clone",
      cause: error instanceof Error ? error : undefined,
      context: { targetPath },
    });
  }
}

export function registerGitCloneHandlers(): () => void {
  // Track every in-flight clone so cancel aborts each one independently.
  // Electron's ipcMain.handle permits concurrent invocations from multiple
  // senders; sharing a single controller would let a later clone overwrite an
  // earlier one's cancel target. Keyed to the clone's operation id so a cancel
  // can name one clone.
  const activeControllers = new Map<AbortController, string>();

  const handleProjectCloneRepo = async (
    ctx: IpcContext,
    options: CloneRepoOptions
  ): Promise<CloneRepoResult> => {
    if (!options || typeof options !== "object") {
      throw new Error("Invalid options object");
    }

    const { url, parentPath, folderName } = options;

    if (typeof url !== "string" || !url.trim()) {
      throw new Error("Repository URL is required");
    }
    if (!isSupportedCloneUrl(url)) {
      throw new Error("Only HTTP(S) and SSH (git@ or ssh://) URLs are supported");
    }
    if (typeof parentPath !== "string" || !parentPath.trim()) {
      throw new Error("Parent path is required");
    }
    if (!path.isAbsolute(parentPath)) {
      throw new Error("Parent path must be absolute");
    }
    if (typeof folderName !== "string") {
      throw new Error("Folder name is required");
    }

    const folderNameError = validateFolderName(folderName);
    if (folderNameError) {
      throw new Error(folderNameError);
    }
    const trimmedFolder = folderName.trim();

    const targetPath = path.join(parentPath, trimmedFolder);
    const normalizedParent = path.resolve(parentPath);
    const normalizedTarget = path.resolve(targetPath);
    if (!normalizedTarget.startsWith(normalizedParent + path.sep)) {
      throw new Error("Folder name resolves outside of the parent directory");
    }

    const opId = normalizeOperationId(options.opId);
    if (options.opId !== undefined && opId === null) {
      throw new AppError({ code: "VALIDATION", message: "Invalid operation id" });
    }
    // Only a caller that names its operation (a remote view) is recorded,
    // published and joinable. An unnamed clone runs exactly as it always has,
    // and one into a busy destination still fails on the existing folder.
    if (opId === null) {
      return cloneRepository(ctx, options, trimmedFolder, targetPath, untrackedOperationHandle());
    }
    const remote = normalizeCloneRemote(url);
    const input = {
      opId,
      kind: "git-clone" as const,
      projectId: ctx.projectId,
      dedupKey: `git-clone:${remote}\0${normalizedTarget}`,
      // Every option that shapes the result: a joiner asking for a full clone
      // must not be handed a shallow one.
      fingerprint: JSON.stringify({
        remote,
        target: normalizedTarget,
        shallowClone: Boolean(options.shallowClone),
      }),
    };
    return getOperationRegistry().run(input, (op) =>
      cloneRepository(ctx, options, trimmedFolder, targetPath, op)
    );
  };

  const cloneRepository = async (
    ctx: IpcContext,
    options: CloneRepoOptions,
    trimmedFolder: string,
    targetPath: string,
    op: OperationHandle
  ): Promise<CloneRepoResult> => {
    const senderWindow = ctx.event && getWindowForWebContents(ctx.event.sender);

    // Registered before the first await, so a Stop pressed while the checks
    // below are still running cancels this clone instead of missing it.
    const localController = new AbortController();
    activeControllers.set(localController, op.opId);
    op.onCancel(() => localController.abort());
    try {
      return await runClone(
        ctx,
        options,
        trimmedFolder,
        targetPath,
        op,
        senderWindow,
        localController
      );
    } finally {
      activeControllers.delete(localController);
    }
  };

  const runClone = async (
    ctx: IpcContext,
    options: CloneRepoOptions,
    trimmedFolder: string,
    targetPath: string,
    op: OperationHandle,
    senderWindow: ReturnType<typeof getWindowForWebContents> | null,
    localController: AbortController
  ): Promise<CloneRepoResult> => {
    const { url, parentPath, shallowClone } = options;
    const fs = await import("fs");

    try {
      const parentStat = await fs.promises.stat(parentPath);
      if (!parentStat.isDirectory()) {
        throw new Error("Parent path is not a directory");
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new Error("Parent directory does not exist", { cause: err });
      }
      throw err;
    }

    const targetExists = await fs.promises
      .access(targetPath)
      .then(() => true)
      .catch(() => false);
    if (targetExists) {
      throw new Error(`Folder "${trimmedFolder}" already exists in this location`);
    }

    const emitProgress = (stage: string, progress: number, message: string) => {
      const progressEvent: CloneRepoProgressEvent = {
        ...(op.tracked ? { opId: op.opId } : {}),
        stage,
        progress,
        message,
        timestamp: Date.now(),
      };
      if (senderWindow && !senderWindow.isDestroyed()) {
        sendToRenderer(senderWindow, CHANNELS.PROJECT_CLONE_PROGRESS, progressEvent);
      } else if ((ctx.endpoint as ClientEndpoint | undefined)?.kind === "remote-view") {
        // A remote caller has no window, and a global broadcast would put its
        // clone's progress in every other client's dialog.
        sendToRendererContext(ctx, CHANNELS.PROJECT_CLONE_PROGRESS, progressEvent);
      } else {
        broadcastToRenderer(CHANNELS.PROJECT_CLONE_PROGRESS, progressEvent);
      }
      op.progress({ fraction: progress / 100, stage, message });
    };

    // Stopped during the checks above: nothing was created, so there is no
    // partial clone to clean up — and the folder check just proved the target
    // isn't ours to remove.
    if (localController.signal.aborted) {
      emitProgress("cancelled", 0, "Clone cancelled");
      throw new AppError({
        code: "CANCELLED",
        message: "Clone cancelled",
        context: { targetPath },
      });
    }

    await executeClone({
      url,
      parentPath,
      folderName: trimmedFolder,
      targetPath,
      depth: shallowClone ? "shallow" : "full",
      signal: localController.signal,
      onProgress: emitProgress,
    });
    return { clonedPath: targetPath };
  };

  const handleProjectCloneCancel = async (
    ctx: IpcContext,
    payload?: CloneCancelPayload
  ): Promise<void> => {
    const rawOpId = payload?.opId;
    const requested = normalizeOperationId(rawOpId);
    // A malformed id is refused, never read as "no id": that would widen a
    // cancel meant for one clone into a cancel of every clone.
    if (rawOpId !== undefined && requested === null) {
      throw new AppError({ code: "VALIDATION", message: "Invalid operation id" });
    }
    const registry = getOperationRegistry();
    if ((ctx.endpoint as ClientEndpoint | undefined)?.kind === "remote-view") {
      // A remote client may stop only its own project's clone, by id, through
      // the scoped registry. Cancel-all is this machine's own UI's alone.
      if (requested === null) {
        throw new AppError({
          code: "VALIDATION",
          message: "A remote caller must name the clone to cancel",
        });
      }
      const record = registry.get(requested);
      if (record && record.kind === "git-clone" && record.projectId === ctx.projectId) {
        registry.cancel(requested);
      }
      return;
    }
    // Without an opId every in-flight clone is cancelled — the historical
    // behaviour callers that don't name their clone still rely on.
    // A caller that joined another's clone names it by its own id.
    const opId = requested && (registry.canonicalId(requested) ?? requested);
    for (const [controller, controllerOpId] of activeControllers) {
      if (opId === null || controllerOpId === opId) controller.abort();
    }
  };

  return defineIpcNamespace({
    name: "gitClone",
    ops: {
      cloneRepo: op(CHANNELS.PROJECT_CLONE_REPO, handleProjectCloneRepo, { withContext: true }),
      cancelClone: op(CHANNELS.PROJECT_CLONE_CANCEL, handleProjectCloneCancel, {
        withContext: true,
      }),
    },
  }).register();
}
