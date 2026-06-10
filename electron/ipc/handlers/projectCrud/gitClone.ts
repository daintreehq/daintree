import path from "path";
import { spawnSync } from "child_process";
import { CHANNELS } from "../../channels.js";
import { defineIpcNamespace, op } from "../../define.js";
import { getWindowForWebContents } from "../../../window/webContentsRegistry.js";
import { broadcastToRenderer, sendToRenderer } from "../../utils.js";
import { createAuthenticatedGit } from "../../../utils/hardenedGit.js";
import {
  getActiveProvider,
  getForgeProviderImpl,
} from "../../../services/forgeProviderRegistry.js";
import { makeForgeProviderId } from "../../../../shared/utils/forgeProviderIds.js";
import type { CloneAuthProbe, CloneCapability } from "../../../../shared/types/forge.js";
import type {
  CloneRepoOptions,
  CloneRepoResult,
  CloneRepoProgressEvent,
} from "../../../../shared/types/ipc/gitClone.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import { validateFolderName } from "../../../../shared/utils/folderName.js";
import { classifyGitError } from "../../../../shared/utils/gitOperationErrors.js";
import { AppError, GitOperationError } from "../../../utils/errorTypes.js";

/**
 * Resolve the clone capability of the forge provider matching the URL's
 * hostname. `undefined` when no provider matches, the matching plugin hasn't
 * bound an impl yet, or the impl doesn't implement `clone`.
 */
function resolveCloneCapability(url: string): CloneCapability | undefined {
  const provider = getActiveProvider(url);
  if (!provider) return undefined;
  const impl = getForgeProviderImpl(
    makeForgeProviderId(provider.pluginId, provider.contribution.id)
  );
  return impl?.clone;
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

export function registerGitCloneHandlers(): () => void {
  // Track every in-flight clone so cancel aborts each one independently.
  // Electron's ipcMain.handle permits concurrent invocations from multiple
  // senders; sharing a single controller would let a later clone overwrite an
  // earlier one's cancel target.
  const activeControllers = new Set<AbortController>();

  const handleProjectCloneRepo = async (
    ctx: import("../../types.js").IpcContext,
    options: CloneRepoOptions
  ): Promise<CloneRepoResult> => {
    if (!options || typeof options !== "object") {
      throw new Error("Invalid options object");
    }

    const senderWindow = getWindowForWebContents(ctx.event.sender);

    const { url, parentPath, folderName, shallowClone } = options;

    if (typeof url !== "string" || !url.trim()) {
      throw new Error("Repository URL is required");
    }
    if (!/^https?:\/\//i.test(url) && !/^git@/i.test(url)) {
      throw new Error("Only HTTP(S) and SSH (git@) URLs are supported");
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
        stage,
        progress,
        message,
        timestamp: Date.now(),
      };
      if (senderWindow && !senderWindow.isDestroyed()) {
        sendToRenderer(senderWindow, CHANNELS.PROJECT_CLONE_PROGRESS, progressEvent);
      } else {
        broadcastToRenderer(CHANNELS.PROJECT_CLONE_PROGRESS, progressEvent);
      }
    };

    const localController = new AbortController();
    activeControllers.add(localController);

    // Resolve the URL's forge provider and probe its clone auth — an
    // authenticated probe picks the provider's clone path below. Probe
    // failures mean "no authenticated path", never a clone failure.
    const cloneCapability = resolveCloneCapability(url);
    let authProbe: CloneAuthProbe = { authenticated: false };
    if (cloneCapability) {
      try {
        authProbe = await cloneCapability.probeAuth(localController.signal);
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
      if (localController.signal.aborted) {
        throw new AppError({ code: "CANCELLED", message: "Clone cancelled" });
      }

      // No "starting" event here on purpose: emitting one would populate the
      // renderer's progress list immediately and defeat the Doherty gate that
      // suppresses the connecting placeholder for sub-400ms clones. The
      // renderer owns that phase via `isCloning` + `useDohertyGate`.

      if (authProbe.authenticated && cloneCapability?.cloneRepository) {
        // Provider-owned clone (e.g. `gh repo clone`). Failures surface
        // directly — no plain-git retry, matching the historical gh path.
        await cloneCapability.cloneRepository(url, targetPath, {
          shallow: Boolean(shallowClone),
          signal: localController.signal,
          onProgress: emitProgress,
        });
      } else {
        let cloneUrl = url;
        if (authProbe.authenticated && cloneCapability?.getAuthenticatedCloneUrl) {
          // May embed credentials — never log it; error context below already
          // omits the URL for the same reason.
          cloneUrl = (await cloneCapability.getAuthenticatedCloneUrl(url).catch(() => null)) ?? url;
        }
        const git = createAuthenticatedGit(parentPath, {
          signal: localController.signal,
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

        await git.clone(cloneUrl, trimmedFolder, shallowClone ? ["--depth", "1"] : []);
      }

      emitProgress("complete", 100, "Clone complete");
      return { clonedPath: targetPath };
    } catch (error) {
      const wasCancelled =
        localController.signal.aborted ||
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

      const errorMessage = formatErrorMessage(error, "Failed to clone repository");
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
    } finally {
      activeControllers.delete(localController);
    }
  };

  const handleProjectCloneCancel = async (): Promise<void> => {
    // Cancel every in-flight clone. The renderer's clone dialog is the only
    // surface that fires this channel, and a per-clone identifier isn't
    // plumbed through, so all-or-nothing matches the historical UX.
    for (const controller of activeControllers) {
      controller.abort();
    }
  };

  return defineIpcNamespace({
    name: "gitClone",
    ops: {
      cloneRepo: op(CHANNELS.PROJECT_CLONE_REPO, handleProjectCloneRepo, { withContext: true }),
      cancelClone: op(CHANNELS.PROJECT_CLONE_CANCEL, handleProjectCloneCancel),
    },
  }).register();
}
