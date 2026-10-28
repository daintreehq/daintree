import { resolveContainedPath, PluginPathNotAllowedError } from "./pluginFsContainment.js";
import { PluginHostGit, resolveAddPathspecs } from "./pluginHostGit.js";
import { assertPluginCallerDrives } from "./pluginDriveLease.js";

import type {
  PluginGitApi,
  PluginGitStatus,
  PluginGitCommitOptions,
  PluginGitCommitResult,
} from "../../../shared/types/plugin.js";
import { type PluginHostFactoryDeps, ensureCapabilityConsent } from "./pluginHostDeps.js";

/**
 * Build the host-mediated `host.git` surface for one plugin. The
 * `worktreePath` is realpath-contained to the declared `scopes.fs.allowedPaths`
 * before any git work; reads gate on `git:read`, mutations on `git:write`.
 * `commit` enforces the host-side change-preview safeguard (#7880 / D2).
 * Implemented over the existing hardened simple-git layer via {@link PluginHostGit}.
 */
export function buildGitApi(deps: PluginHostFactoryDeps, pluginId: string): PluginGitApi {
  const requireLoaded = (op: string): void => {
    if (!deps.plugins.has(pluginId)) {
      throw new Error(
        `PLUGIN_UNLOADED: plugin "${pluginId}" git.${op}: plugin is no longer loaded`
      );
    }
  };
  const requireReadCap = (op: string): void => {
    if (!deps.declaredCapabilities(pluginId).has("git:read")) {
      throw new Error(
        `PERMISSION_REQUIRED: plugin "${pluginId}" git.${op} requires the "git:read" capability, which is not declared in manifest.capabilities`
      );
    }
  };
  const requireWriteCap = (op: string): void => {
    if (!deps.declaredCapabilities(pluginId).has("git:write")) {
      throw new Error(
        `PERMISSION_REQUIRED: plugin "${pluginId}" git.${op} requires the "git:write" capability, which is not declared in manifest.capabilities`
      );
    }
  };
  // Staging and committing change the worktree's project, so a call from a
  // view must drive it.
  const requireCallerDrives = async (op: string, resolved: string): Promise<void> => {
    await assertPluginCallerDrives(pluginId, `git.${op}`, { paths: [resolved] });
    requireLoaded(op);
  };
  // A worktree the plugin may access = one contained inside its declared
  // allowedPaths (with `${project}` / `${worktree}` tokens expanded at call
  // time). We resolve the worktree root itself (not a child) so the git ops
  // run against the realpath-verified directory. The implicit per-plugin data
  // dir is NOT an allowed git root — git ops gate on git:read/git:write and
  // should never reach into a plugin's private scratch space.
  const containWorktree = async (worktreePath: string): Promise<string> => {
    const entries = await deps.expandAllowedPathEntries(pluginId, { includeDataDir: false });
    let lastErr: unknown;
    for (const entry of entries) {
      try {
        return await resolveContainedPath(pluginId, worktreePath, [entry.path]);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new PluginPathNotAllowedError(pluginId, worktreePath);
  };
  const git = new PluginHostGit(pluginId, deps.getHostGitFactory());

  return {
    status: async (worktreePath, options): Promise<PluginGitStatus> => {
      options?.signal?.throwIfAborted();
      requireLoaded("status");
      requireReadCap("status");
      const resolved = await containWorktree(worktreePath);
      requireLoaded("status");
      return git.status(resolved, options?.signal);
    },
    diff: async (worktreePath, filePath, options): Promise<string> => {
      options?.signal?.throwIfAborted();
      requireLoaded("diff");
      requireReadCap("diff");
      const resolved = await containWorktree(worktreePath);
      requireLoaded("diff");
      return git.diff(resolved, filePath, options?.signal);
    },
    add: async (worktreePath, paths, options): Promise<void> => {
      options?.signal?.throwIfAborted();
      requireLoaded("add");
      requireWriteCap("add");
      // The checked copy is what runs, so a caller mutating its array during
      // the consent await cannot swap in a pathspec that was never checked.
      const targets = resolveAddPathspecs(pluginId, paths);
      const resolved = await containWorktree(worktreePath);
      requireLoaded("add");
      await requireCallerDrives("add", resolved);
      // Consent fires after containment + pathspec validation so a doomed call
      // never banks a git:write grant (#10524). Re-check liveness after the
      // prompt await.
      await ensureCapabilityConsent(deps, pluginId, "git:write");
      requireLoaded("add");
      await requireCallerDrives("add", resolved);
      await git.add(resolved, targets, options?.signal);
      deps.safeAppendAudit({
        pluginId,
        actionId: `git.add:${resolved}`,
        recordType: "ipc-invoke",
        channel: "plugin:git-add",
        result: "success",
        errorMessage: "",
        argsHash: deps.safeArgsHash([{ worktreePath: resolved, paths: paths ?? ["."] }]),
        durationMs: 0,
      });
    },
    commit: async (
      worktreePath,
      options: PluginGitCommitOptions,
      callOptions
    ): Promise<PluginGitCommitResult> => {
      callOptions?.signal?.throwIfAborted();
      requireLoaded("commit");
      requireWriteCap("commit");
      // commit returns the staged diff as its change-preview, so it discloses
      // repo content — require read alongside write.
      requireReadCap("commit");
      // Reject an empty message BEFORE prompting for consent, mirroring the
      // #7880 no-silent-fallback guard git.commit enforces internally, so a
      // doomed commit can't bank a git:write grant (#10524).
      if (!options || typeof options.message !== "string" || options.message.trim().length === 0) {
        throw new Error(
          `COMMIT_MESSAGE_REQUIRED: plugin "${pluginId}" git.commit requires a non-empty message`
        );
      }
      const resolved = await containWorktree(worktreePath);
      requireLoaded("commit");
      await requireCallerDrives("commit", resolved);
      // Consent fires after containment + message validation so a doomed call
      // never banks a grant (#10524). Re-check liveness after the prompt await.
      await ensureCapabilityConsent(deps, pluginId, "git:write");
      requireLoaded("commit");
      await requireCallerDrives("commit", resolved);
      const result = await git.commit(resolved, options, callOptions?.signal);
      deps.safeAppendAudit({
        pluginId,
        actionId: `git.commit:${resolved}`,
        recordType: "ipc-invoke",
        channel: "plugin:git-commit",
        result: "success",
        errorMessage: "",
        argsHash: deps.safeArgsHash([{ worktreePath: resolved, commit: result.commit }]),
        durationMs: 0,
      });
      return result;
    },
  };
}
