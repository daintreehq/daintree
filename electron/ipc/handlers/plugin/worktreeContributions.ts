import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import {
  selectContributionsForProject,
  getPluginContributionScope,
} from "../../../services/plugin/PluginContributionBroadcaster.js";
import { getFileDecorationImpls } from "../../../services/fileDecorationRegistry.js";
import type { FileDecoration } from "../../../../shared/types/forge.js";
import type {
  WorktreeDeleteNoteSource,
  WorktreeDeleteNotesAnswer,
  PluginWorktreeStatus,
} from "../../../../shared/types/plugin.js";
import type { IpcContext } from "../../types.js";
import { PLUGIN_WORKTREE_DELETE_NOTES_TIMEOUT_MS } from "../../../../shared/config/pluginBudgets.js";
import { getPluginService } from "./service.js";
import { safeAppend } from "./auditAppend.js";

/**
 * Per-provider budget for a single `provideDecorations` call. A provider that
 * never settles its promise would otherwise hang the whole IPC invocation
 * (and the renderer's pull) indefinitely — `Promise.allSettled` only handles
 * rejection, not a promise that simply never resolves. On expiry the slow
 * provider is treated like a rejecting one (skipped + logged); healthy
 * providers for the same scope are unaffected.
 */
const DECORATION_PROVIDER_TIMEOUT_MS = 3000;

const DECORATION_TIMEOUT = Symbol("decoration-timeout");

/**
 * A non-empty string is "present" for merge purposes. Empty string counts as
 * absent so it can't block a later provider from supplying a real value.
 */
function presentString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Resolve per-file decorations for `scope` over the given `paths` by invoking
 * every plugin impl whose declared scopes match. Results merge with
 * first-writer-wins semantics per field (badge/tooltip/color independently):
 * the first provider in plugin load order that returns a non-empty value for a
 * field on a path keeps it. The host treats every decoration opaquely — it
 * never inspects what a badge means. A provider that throws, rejects, or
 * exceeds {@link DECORATION_PROVIDER_TIMEOUT_MS} is skipped (logged) so one
 * bad plugin can't blank or stall the whole row. Only the requested paths are
 * returned — a provider that decorates unrequested paths can't leak them.
 */
export async function handleFileDecorationsGet(
  ctx: IpcContext,
  scope: string,
  paths: string[]
): Promise<Record<string, FileDecoration>> {
  if (typeof scope !== "string" || scope.length === 0) return {};
  if (!Array.isArray(paths) || paths.length === 0) return {};
  const cleanPaths = [
    ...new Set(paths.filter((p): p is string => typeof p === "string" && p.length > 0)),
  ];
  if (cleanPaths.length === 0) return {};
  const requested = new Set(cleanPaths);

  // Implicit activation: any plugin that declares a provider for this scope is
  // forced to `activate()` before the impl lookup, so providers bound during
  // activate() are queryable on the first pull. No-op once already activated.
  // Only plugins the sender's project shows: a hidden plugin is not started by
  // that project's file views, and its decorations stay out of them.
  await (await getPluginService()).activatePluginsForFileDecorationScope(scope, ctx.projectId);

  // The merge is first-writer-per-field, so the project's own plugin goes
  // ahead of installed ones: it is the more specific source. Array#sort is
  // stable, which keeps load order within each group.
  const impls = selectContributionsForProject(
    getFileDecorationImpls(scope),
    (entry) => entry.pluginId,
    ctx.projectId
  ).sort(
    (a, b) =>
      Number(getPluginContributionScope(a.pluginId) === "global") -
      Number(getPluginContributionScope(b.pluginId) === "global")
  );
  if (impls.length === 0) return {};

  const merged: Record<string, FileDecoration> = {};
  // Per-provider start/end timestamps so audit records carry the true elapsed
  // time of *each* provider, not the wall-clock of the slowest one. `ends[i]`
  // is captured inside the race chain at the moment that provider settles,
  // before `Promise.allSettled` returns — measuring `Date.now()` in the
  // post-allSettled loop would assign every provider the same wall-clock.
  const starts: number[] = new Array(impls.length);
  const ends: number[] = new Array(impls.length);
  const results = await Promise.allSettled(
    impls.map(({ impl }, i) => {
      starts[i] = Date.now();
      return Promise.race([
        impl.provideDecorations(scope, cleanPaths),
        new Promise<typeof DECORATION_TIMEOUT>((resolve) =>
          setTimeout(() => resolve(DECORATION_TIMEOUT), DECORATION_PROVIDER_TIMEOUT_MS)
        ),
      ]).then(
        (v) => {
          ends[i] = Date.now();
          return v;
        },
        (err: unknown) => {
          ends[i] = Date.now();
          throw err;
        }
      );
    })
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const { pluginId, contributionId } = impls[i];
    const durationMs = ends[i] - starts[i];
    if (r.status === "rejected") {
      console.warn(
        `[Plugin] fileDecorationProvider "${pluginId}.${contributionId}" failed for scope "${scope}":`,
        r.reason
      );
      safeAppend({
        pluginId,
        actionId: contributionId,
        recordType: "decoration-failure",
        result: "error",
        failureMode: "rejected",
        scope,
        contributionId,
        errorMessage: formatErrorMessage(r.reason, "decoration provider rejected"),
        argsHash: "",
        durationMs,
      });
      continue;
    }
    if (r.value === DECORATION_TIMEOUT) {
      console.warn(
        `[Plugin] fileDecorationProvider "${pluginId}.${contributionId}" timed out after ${DECORATION_PROVIDER_TIMEOUT_MS}ms for scope "${scope}"`
      );
      safeAppend({
        pluginId,
        actionId: contributionId,
        recordType: "decoration-failure",
        result: "error",
        failureMode: "timeout",
        scope,
        contributionId,
        errorMessage: `timed out after ${DECORATION_PROVIDER_TIMEOUT_MS}ms`,
        argsHash: "",
        durationMs,
      });
      continue;
    }
    if (!r.value || typeof r.value !== "object") continue;
    for (const [path, decoration] of Object.entries(r.value)) {
      // Enforce the requested-paths contract at the host boundary so a
      // misbehaving provider can't widen the result set.
      if (!requested.has(path)) continue;
      if (!decoration || typeof decoration !== "object") continue;
      const target = merged[path] ?? (merged[path] = {});
      if (target.badge === undefined) {
        const badge = presentString(decoration.badge);
        if (badge !== undefined) target.badge = badge;
      }
      if (target.tooltip === undefined) {
        const tooltip = presentString(decoration.tooltip);
        if (tooltip !== undefined) target.tooltip = tooltip;
      }
      if (target.color === undefined) {
        const color = presentString(decoration.color);
        if (color !== undefined) target.color = color;
      }
      if (target.url === undefined) {
        // Issue #9953: the renderer uses `decoration.url` as the click
        // target for the review-thread badge. The IPC boundary must
        // forward the provider-authored URL — anything string-shaped is
        // accepted here; `systemClient.openExternal` (lesson #9316)
        // applies the protocol allowlist downstream so a malicious
        // provider can't reach `file://`/`javascript:`.
        const url = presentString(decoration.url);
        if (url !== undefined) target.url = url;
      }
    }
  }

  // Drop paths that ended up with no fields (a provider returned an entry but
  // every field was empty) so the renderer's "decorated?" check stays cheap.
  // `url` participates: a URL-only decoration (a future provider ships
  // just a deep-link without badge/tooltip/color) must still survive the
  // cleanup so the renderer's click target is wired.
  for (const [path, decoration] of Object.entries(merged)) {
    if (
      decoration.badge === undefined &&
      decoration.tooltip === undefined &&
      decoration.color === undefined &&
      decoration.url === undefined
    ) {
      delete merged[path];
    }
  }

  return merged;
}

/**
 * The plugins a worktree delete confirmation in the sender's view asks for
 * notes (#13805). Nothing is activated to answer. A sender with no project has
 * no worktrees to delete, so it has no sources.
 */
export async function handleWorktreeDeleteNoteSourcesGet(
  ctx: IpcContext
): Promise<WorktreeDeleteNoteSource[]> {
  if (ctx.projectId === null) return [];
  const service = await getPluginService();
  // Bounded: at startup the dialog would otherwise sit through the scan before
  // it could even say who it is asking.
  await service.waitForCatalogWithin(PLUGIN_WORKTREE_DELETE_NOTES_TIMEOUT_MS);
  return service.listWorktreeDeleteNoteSources(ctx.projectId);
}

/**
 * One plugin's notes for a worktree in the sender's project (#13805). The
 * project comes from the sender, never the payload, so a view can only ask
 * about its own worktrees. `null` when the plugin is no longer one this view
 * asks, or the worktree isn't its project's.
 */
export async function handleWorktreeDeleteNotesGet(
  ctx: IpcContext,
  input: { worktreeId: string; pluginId: string }
): Promise<WorktreeDeleteNotesAnswer | null> {
  if (ctx.projectId === null) return null;
  const worktreeId = input?.worktreeId;
  const pluginId = input?.pluginId;
  if (typeof worktreeId !== "string" || worktreeId.length === 0) {
    throw new Error("worktreeId must be a non-empty string");
  }
  if (typeof pluginId !== "string" || pluginId.length === 0) {
    throw new Error("pluginId must be a non-empty string");
  }
  // No init wait: the sources list this view asked first already waited, and
  // waiting again would keep the row pending through every other plugin's
  // startup activation.
  const service = await getPluginService();
  return service.getWorktreeDeleteNotes(ctx.projectId, pluginId, worktreeId);
}

/**
 * Renderer-facing read of the changed-file / git-status projection for the
 * worktree at `path` — the companion to the per-plugin `host.getWorktreeStatus`
 * so a file list outside the Review Hub can scan the changed set. Reads the
 * host's already-polled status; never shells out. `null` when no worktree
 * matches or no status has been computed.
 */
export async function handleWorktreeStatusGet(path: string): Promise<PluginWorktreeStatus | null> {
  if (typeof path !== "string" || path.length === 0) return null;
  return (await getPluginService()).getWorktreeStatusForPath(path);
}
