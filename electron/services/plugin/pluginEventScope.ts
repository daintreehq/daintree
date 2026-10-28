import path from "path";
import { getPtyClient } from "../../window/serviceRefs.js";
import { toPluginWorktreeSnapshot } from "../../../shared/utils/pluginWorktreeSnapshot.js";
import {
  toPluginAgentSnapshot,
  type AgentStateChangePayload,
} from "../../../shared/utils/pluginAgentSnapshot.js";
import { isProjectWorkspaceId } from "../../../shared/utils/workspaceIds.js";
import type { WorktreeSnapshot } from "../../../shared/types/workspace-host.js";
import type {
  BuiltInPluginCapability,
  PluginAgentSnapshot,
  PluginHostBinding,
  PluginWorktreeSnapshot,
  PluginWorktreesUnavailableReason,
} from "../../../shared/types/plugin.js";
import type { LoadedPlugin } from "./PluginServiceTypes.js";

/**
 * A worktree read the factory's dependencies performed, keeping the reason it
 * came back with nothing (#12174).
 *
 * The internal twin of {@link PluginWorktreesResult}: same discriminant, but
 * carrying raw `WorktreeSnapshot`s, which the factory projects through
 * `toPluginWorktreeSnapshot` before a plugin ever sees them. `plugin-unloaded`
 * is excluded because only the factory can observe it.
 */
export type PluginWorktreeSnapshotFetchResult =
  | { status: "ok"; projectId: string; snapshots: WorktreeSnapshot[] }
  | {
      status: "unavailable";
      reason: Exclude<PluginWorktreesUnavailableReason, "plugin-unloaded">;
    };

/**
 * The slice of a `WorkspaceClient` worktree event a plugin subscription reads.
 * Only the owning project's path matters here — it is what lets a project-bound
 * host drop another project's worktree churn instead of waking on all of it.
 */
export interface PluginWorktreeEventPayload {
  projectPath?: string;
}

/** The collaborators a {@link PluginEventScope} reads; `PluginHostFactoryDeps` supplies them. */
export interface PluginEventScopeDeps {
  plugins: Map<string, LoadedPlugin>;
  declaredCapabilities: (pluginId: string) => Set<BuiltInPluginCapability>;
  fetchWorktreeSnapshotsResult: () => Promise<PluginWorktreeSnapshotFetchResult>;
  fetchWorktreeSnapshotsForProjectResult: (
    projectId: string,
    projectRoot: string
  ) => Promise<PluginWorktreeSnapshotFetchResult>;
  getWorktreeCustomTitles: (projectId: string) => Readonly<Record<string, string>>;
}

/** One agent transition as a plugin bound to this scope may see it. */
export interface ScopedAgentTransition {
  readonly snapshot: PluginAgentSnapshot;
  /** Coalescing key: the terminal, else the agent, else one shared bucket. */
  readonly key: string;
}

/**
 * Compare two project paths the way the workspace-host pool keys them
 * (`path.resolve`, plus win32's case-insensitive filesystem) so a binding's
 * realpath-resolved root matches the path an event carries.
 */
export function isSameProjectPath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * What one plugin instance may observe, decided by its binding. Shared by the
 * live subscriptions a plugin opens from its worker and the manifest event
 * routes the host holds for it (#13816), so the two can never disagree about
 * which project's events a plugin hears or what each payload contains.
 *
 * `binding` is captured once, as is the loaded instance: every reader below
 * answers for the instance that was loaded when the scope was built.
 */
export function createPluginEventScope(
  deps: PluginEventScopeDeps,
  pluginId: string,
  binding: PluginHostBinding
) {
  const { projectId: boundProjectId, projectRoot: boundProjectRoot } = binding;

  /**
   * The worktree set this host may see, with the reason it may see none.
   *
   * Unbound stays ambient on purpose: an app-global plugin has no project of
   * its own, so the focused window's worktrees are the only set its
   * argument-less getters can mean — which is exactly why the result names the
   * project it landed on, so a plugin can notice when focus moved under it.
   */
  const fetchWorktreeSnapshotsResult = async (): Promise<PluginWorktreeSnapshotFetchResult> => {
    if (boundProjectId === null) return deps.fetchWorktreeSnapshotsResult();
    // Bound with no root is a malformed binding. Fail closed rather than fall
    // back to the ambient read, which would hand this plugin whichever project
    // happens to be focused — the confused-deputy bug the binding exists for.
    if (boundProjectRoot === null) {
      return { status: "unavailable", reason: "project-unavailable" };
    }
    const result = await deps.fetchWorktreeSnapshotsForProjectResult(
      boundProjectId,
      boundProjectRoot
    );
    // Belt and braces on the binding, enforced here rather than in one getter so
    // every surface downstream of this read inherits it: a dependency answering
    // for another project would be the confused deputy (#11297) wearing the new
    // shape, and it must not reach `getWorktreeStatus`, the worktree
    // subscriptions or the default spawn cwd either.
    if (result.status === "ok" && result.projectId !== boundProjectId) {
      return { status: "unavailable", reason: "project-unavailable" };
    }
    return result;
  };

  /**
   * The plugin projection for one successful read, carrying each worktree's
   * custom title. Titles are keyed by the project the read landed on, which for
   * an unbound host is the focused window's — the project these worktrees are.
   */
  const pluginProjectionFor = (
    result: Extract<PluginWorktreeSnapshotFetchResult, { status: "ok" }>
  ): ((snapshot: WorktreeSnapshot) => PluginWorktreeSnapshot) => {
    const titles = deps.getWorktreeCustomTitles(result.projectId);
    return (snapshot: WorktreeSnapshot) =>
      toPluginWorktreeSnapshot(
        snapshot,
        Object.hasOwn(titles, snapshot.id) ? (titles[snapshot.id] ?? null) : null
      );
  };

  /**
   * Does a worktree event belong to the bound project? Unbound hosts see every
   * project's events by design. Fails open when the payload carries no project
   * path: the snapshots the callback then delivers are already project-scoped,
   * so an unrecognised payload costs a redundant callback, never another
   * project's data.
   *
   * A bound-but-rootless binding is malformed and drops every event, matching
   * `fetchWorktreeSnapshots` — waking the plugin app-wide to hand it the empty
   * list that path already returns would be pure noise.
   */
  const isEventForBoundProject = (payload?: PluginWorktreeEventPayload): boolean => {
    if (boundProjectId !== null && boundProjectRoot === null) return false;
    if (boundProjectRoot === null) return true;
    const projectPath = payload?.projectPath;
    if (typeof projectPath !== "string" || projectPath.length === 0) return true;
    return isSameProjectPath(projectPath, boundProjectRoot);
  };

  const resolveAgentEventWorkspace = (terminalId: string | undefined): string | null =>
    terminalId === undefined ? null : (getPtyClient()?.getTerminalProjectId(terminalId) ?? null);

  /**
   * Does an agent transition belong to the bound project? Unbound hosts observe
   * every agent by design — that is what `agent:read` has always meant.
   *
   * Fails CLOSED, unlike the worktree predicate: the event carries no
   * project-scoped payload for the callback to re-derive, so delivering one we
   * cannot attribute would hand a bound plugin another project's agent state
   * outright. The workspace is resolved from the raw event's terminal id, which
   * the plugin-facing projection also carries (see `toPluginAgentSnapshot`).
   */
  const isAgentEventForBoundProject = (workspaceId: string | null): boolean =>
    boundProjectId === null || (workspaceId !== null && workspaceId === boundProjectId);

  /**
   * One `agent:state-changed` payload projected for this plugin, or `null` when
   * it belongs to a project the plugin cannot see. The workspace is resolved
   * at arrival: the PTY record is gone by the time a debounced window flushes
   * for a terminal that was just killed.
   */
  const projectAgentTransition = (
    payload: AgentStateChangePayload
  ): ScopedAgentTransition | null => {
    const rawTerminalId: unknown = payload.terminalId;
    const terminalId =
      typeof rawTerminalId === "string" && rawTerminalId.length > 0 ? rawTerminalId : undefined;
    const workspaceId = resolveAgentEventWorkspace(terminalId);
    if (!isAgentEventForBoundProject(workspaceId)) return null;
    const snapshot = toPluginAgentSnapshot(payload, { workspaceId });
    // An event with neither id shares one bucket, so it still ends on its
    // latest value.
    const key =
      terminalId !== undefined
        ? `t:${terminalId}`
        : payload.agentId !== undefined
          ? `a:${payload.agentId}`
          : "unkeyed";
    return { snapshot, key };
  };

  /** Whether the plugin declared `agent:read`, which every agent observation needs. */
  const canObserveAgents = (): boolean => deps.declaredCapabilities(pluginId).has("agent:read");

  /**
   * Whether this plugin hears about a project's presence. A project plugin
   * hears about its own project only; an installed one about every project,
   * but never a scratch.
   */
  const seesProjectPresence = (projectId: string): boolean =>
    boundProjectId === null ? isProjectWorkspaceId(projectId) : projectId === boundProjectId;

  // The LoadedPlugin this scope is bound to. Identity (not just id membership)
  // so a stale timer from a pre-reload instance can't act for the current
  // same-id instance.
  const boundPlugin = deps.plugins.get(pluginId);
  const isBound = (): boolean =>
    boundPlugin !== undefined && deps.plugins.get(pluginId) === boundPlugin;

  return {
    boundPlugin,
    isBound,
    fetchWorktreeSnapshotsResult,
    pluginProjectionFor,
    isEventForBoundProject,
    resolveAgentEventWorkspace,
    isAgentEventForBoundProject,
    projectAgentTransition,
    canObserveAgents,
    seesProjectPresence,
  };
}

export type PluginEventScope = ReturnType<typeof createPluginEventScope>;
