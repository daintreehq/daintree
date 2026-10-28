import {
  pluginManifestIdFromInstanceKey,
  projectIdFromPluginInstanceKey,
} from "./projectPluginIdentity.js";
import { toRuntimePanelKindId } from "../../../shared/config/panelKindRegistry.js";
import type { PluginUIPromptDispatcher } from "./PluginUIPromptDispatcher.js";

import { broadcastToRenderer, broadcastToProjectRenderers } from "../../ipc/utils.js";
import { flushPluginPushes, withPushFlushBarrier } from "./pluginPushBatcher.js";
import {
  createPluginEventScope,
  type PluginWorktreeEventPayload,
  type PluginWorktreeSnapshotFetchResult,
} from "./pluginEventScope.js";
import type { WorktreeSnapshot } from "../../../shared/types/workspace-host.js";
import {
  promptOpensDialog,
  type PluginUiPromptResultValue,
} from "../../../shared/types/pluginUiPrompt.js";
import type {
  PluginHostApi,
  PluginIdentity,
  PluginWorktreesResult,
  PluginHostBinding,
} from "../../../shared/types/plugin.js";
import { type PluginHostFactoryDeps } from "./pluginHostDeps.js";
import { buildProcessApi } from "./pluginHostProcessApi.js";
import { buildFsApi } from "./pluginHostFsApi.js";
import { buildGitApi } from "./pluginHostGitApi.js";
import { buildClipboardApi } from "./pluginHostClipboardApi.js";
import { buildSystemApi } from "./pluginHostSystemApi.js";
import { buildDocumentsApi } from "./pluginHostDocumentsApi.js";
import { buildArtifactsApi } from "./pluginHostArtifactsApi.js";
import { buildSettingsHostApi, noteNewestPluginInstance } from "./pluginHostSettingsApi.js";
import { buildObservationHostApi } from "./pluginHostObservationApi.js";
import { buildContributionsHostApi } from "./pluginHostContributionsApi.js";
import { buildPresentationHostApi } from "./pluginHostPresentationApi.js";
import { buildNotificationsHostApi } from "./pluginHostNotificationsApi.js";
import { pushListenerObservers } from "./pluginInternalApprovers.js";

export { buildFsApi } from "./pluginHostFsApi.js";
export type { PluginHostFactoryDeps } from "./pluginHostDeps.js";
export { noteNewestPluginInstance } from "./pluginHostSettingsApi.js";

export type { PluginWorktreeEventPayload, PluginWorktreeSnapshotFetchResult };

/**
 * Build one plugin's host object.
 *
 * `binding` names the project this host acts for and is captured here, once —
 * every closure below reads the captured values, never the focused project
 * view, so "which project?" is answered at construction rather than at call
 * time. An unbound binding (`projectId: null`) is the app-global default for
 * installed and builtin plugins and leaves every surface exactly as it was.
 */

export function createHost(
  deps: PluginHostFactoryDeps,
  pluginId: string,
  binding: PluginHostBinding
): { host: PluginHostApi; revoke: () => void } {
  let revoked = false;
  const { projectId: boundProjectId, projectRoot: boundProjectRoot } = binding;
  // Which project's events and worktrees this host sees, and what each payload
  // holds — shared with the manifest event routes held for the same instance,
  // so the two can never disagree (#13816).
  const {
    boundPlugin,
    isBound,
    fetchWorktreeSnapshotsResult,
    pluginProjectionFor,
    isEventForBoundProject,
    isAgentEventForBoundProject,
    projectAgentTransition,
    canObserveAgents,
    seesProjectPresence,
  } = createPluginEventScope(deps, pluginId, binding);

  /**
   * The array-shaped read the pre-#12174 surfaces still use. Every unavailable
   * reason flattens back to `[]` here, which is the fail-closed sentinel those
   * surfaces are built on: `${worktree}` and `${project}` allowlist roots drop
   * so containment denies (#9492), `getWorktreeStatus` answers `null`, and the
   * default spawn cwd falls back rather than pointing into another project.
   *
   * Not every worktree-derived surface routes through here — worktree-scoped
   * *storage* resolves its target through `resolveBoundWorktreeTarget`, which
   * reads the projected `getWorktreesResult` so it can name one worktree rather
   * than flatten the set (#12229). Unbound storage skips both and stays on the
   * manager's own app-global lookup.
   */
  const fetchWorktreeSnapshots = async (): Promise<WorktreeSnapshot[]> => {
    const result = await fetchWorktreeSnapshotsResult();
    return result.status === "ok" ? result.snapshots : [];
  };

  /**
   * Renderer push for this host: the bound project's views only.
   *
   * Unbound reaches every renderer on purpose — an app-global plugin's panels,
   * badges and toasts belong to no single project. The bound path widens to a
   * full broadcast only while no project view is registered anywhere (boot, or
   * a window that never routes through ProjectViewManager); in that state there
   * is no other project's view for it to reach.
   */
  const sendToScope: (channel: string, ...args: unknown[]) => void =
    boundProjectId === null
      ? broadcastToRenderer
      : (channel, ...args) => broadcastToProjectRenderers(boundProjectId, channel, ...args);
  // Every direct renderer delivery from this host — badges, decoration
  // invalidations and toasts here, and dispatches, prompts and panel reloads
  // through the wrapped collaborators below — first delivers what this plugin
  // already pushed: a renderer must never see a toast, a prompt or a reload
  // before the panel update that preceded it.
  const pushToRenderers = (channel: string, ...args: unknown[]): void => {
    flushPluginPushes();
    sendToScope(channel, ...args);
  };
  const dispatcher = withPushFlushBarrier(deps.dispatcher);
  const promptDispatcher = withPromptWaitTracking(
    withPushFlushBarrier(deps.promptDispatcher),
    deps.trackPromptWait
  );

  // A host made before its instance was registered has no frozen manifest and
  // falls back to the live one (`undefined` takes the lookup's default).
  const declaring = boundPlugin?.manifest;
  if (boundPlugin !== undefined) noteNewestPluginInstance(deps.plugins, pluginId, boundPlugin);

  /**
   * The availability- and scope-aware worktree read behind
   * {@link PluginHostApi.getWorktreesResult}, and the single source the
   * `[]`/`null`-shaped `getWorktrees` and `getActiveWorktree` project from, so
   * the three can never disagree about what this host can see (#12174).
   */
  const getWorktreesResult = async (): Promise<PluginWorktreesResult> => {
    if (!isBound()) return { status: "unavailable", reason: "plugin-unloaded" };
    try {
      const result = await fetchWorktreeSnapshotsResult();
      // Re-checked after the await: an unload (or a same-id reload) that landed
      // while the read was in flight makes these snapshots the previous
      // instance's, so they are discarded rather than handed to whatever still
      // holds this stale host.
      if (!isBound()) return { status: "unavailable", reason: "plugin-unloaded" };
      if (result.status !== "ok") return { status: "unavailable", reason: result.reason };
      // Projection is inside the boundary too: toPluginWorktreeSnapshot throws
      // on a malformed snapshot, and this method's contract is to answer with
      // data rather than reject into whatever timer called it.
      return {
        status: "ok",
        projectId: result.projectId,
        worktrees: result.snapshots.map(pluginProjectionFor(result)),
      };
    } catch {
      return isBound()
        ? { status: "unavailable", reason: "fetch-failed" }
        : { status: "unavailable", reason: "plugin-unloaded" };
    }
  };

  // Identity is derived once, here, from the id and binding this host was built
  // with. Deriving it host-side — through the canonical parser that owns the key
  // format — is the whole point: it is what lets a plugin stop splitting its own
  // id apart to find its manifest id or its project (#12211).
  const manifestId = pluginManifestIdFromInstanceKey(pluginId);
  // Origin comes from the KEY, not the binding. The key states what the plugin
  // *is*; the binding states which project this host acts for, and the two
  // disagreeing is a malformed binding, not a global plugin. Reading origin off
  // the binding would silently downgrade such a host to "global" and hand back
  // a dotted id that aliases a project kind onto a global one — the exact
  // collision `toRuntimePanelKindId` refuses to mint.
  const pluginInfo: PluginIdentity = Object.freeze({
    instanceId: pluginId,
    manifestId,
    origin:
      projectIdFromPluginInstanceKey(pluginId) === null
        ? ("global" as const)
        : ("project" as const),
    projectId: boundProjectId,
    projectRoot: boundProjectRoot,
  });

  const fsApi = buildFsApi(deps, pluginId);

  // What every domain reads. `revoked` stays owned here: activation-only
  // registrations ask through `isRevoked`, so `revoke()` reaches all of them.
  const scope = {
    deps,
    pluginId,
    boundProjectId,
    boundPlugin,
    isBound,
    isRevoked: () => revoked,
    manifestId,
  };
  const observation = buildObservationHostApi({
    ...scope,
    boundProjectRoot,
    fetchWorktreeSnapshotsResult,
    pluginProjectionFor,
    isEventForBoundProject,
    isAgentEventForBoundProject,
    projectAgentTransition,
    canObserveAgents,
    seesProjectPresence,
    fetchWorktreeSnapshots,
    getWorktreesResult,
    dispatcher,
    promptDispatcher,
  });
  const contributions = buildContributionsHostApi(scope);
  const presentation = buildPresentationHostApi({
    ...scope,
    getWorktreesResult,
    dispatcher,
    sendToScope,
    pushToRenderers,
  });
  const notifications = buildNotificationsHostApi({
    ...scope,
    fetchWorktreeSnapshotsResult,
    dispatcher,
    promptDispatcher,
    pushToRenderers,
    // Looked up on the composed host at call time, as a task's own
    // notification always has been.
    notifyViaHost: (options) => host.notify(options),
  });
  const settings = buildSettingsHostApi({
    ...scope,
    boundProjectRoot,
    declaring,
    getWorktreesResult,
    dispatcher,
    fsApi,
  });

  const host: PluginHostApi = {
    get pluginId() {
      return pluginId;
    },
    pluginInfo,
    panelKindId: (bareId: string) => {
      if (typeof bareId !== "string" || bareId.length === 0) {
        throw new Error(`Plugin "${pluginId}" panelKindId: bareId must be a non-empty string`);
      }
      const qualified = toRuntimePanelKindId(
        { origin: pluginInfo.origin, pluginId: manifestId, kindId: bareId },
        boundProjectId
      );
      // Only reachable for a project-owned host with no project in its binding,
      // or an id carrying the `/` the qualified form delimits on. Both would
      // otherwise mint an id that resolves to no registered kind, so say so
      // rather than hand back something that silently opens nothing.
      if (qualified === null) {
        throw new Error(
          `Plugin "${pluginId}" panelKindId: cannot qualify panel kind "${bareId}" for this plugin`
        );
      }
      return qualified;
    },
    ...contributions,
    ...presentation.api,
    ...observation,
    ...notifications,
    // NOT revoke-guarded: a plugin reaches for this long after activate(),
    // when its host calls have started timing out. No capability gate — it
    // restarts only the caller's own worker, identified by this closure's
    // binding, the same restart the user's "Restart plugin" button runs.
    restartWorker: async () => {
      if (!isBound()) return "unavailable";
      return deps.requestWorkerSelfRestart(pluginId, boundPlugin!);
    },
    // NOT revoke-guarded for the same reason as showToast/dispatch: plugins
    // log from post-activation callbacks and timers. Liveness is plugin
    // membership (enforced inside recordPluginLog) — writes silently no-op
    // once the plugin unloads. Synchronous void return; never throws.
    logger: {
      info: (message, fields) => {
        if (boundPlugin) deps.recordPluginLog(boundPlugin, pluginId, "info", message, fields);
      },
      warn: (message, fields) => {
        if (boundPlugin) deps.recordPluginLog(boundPlugin, pluginId, "warn", message, fields);
      },
      error: (message, fields) => {
        if (boundPlugin) deps.recordPluginLog(boundPlugin, pluginId, "error", message, fields);
      },
    },
    // Managed child-process surface (#9234). NOT revoke-guarded — a process
    // orchestrator spawns/respawns from post-activation timers and callbacks.
    // `spawn` is the first runtime enforcement of a scope capability: it
    // rejects unless the plugin declared `shell:exec` (mirrors the channel
    // capability gate at the dispatch boundary). Liveness is plugin membership
    // — once the plugin unloads `spawn` rejects and outstanding processes are
    // torn down by `killAll` in unloadPlugin.
    process: buildProcessApi(deps, pluginId, fetchWorktreeSnapshots),
    // Host-mediated, scope-contained filesystem + git surfaces (fs-API
    // containment unit). NOT revoke-guarded — plugins read/write from
    // post-activation timers and callbacks. Every path argument is realpath-
    // contained to the declared scopes.fs.allowedPaths and capability-gated;
    // this is the runtime enforcement of allowedPaths (formerly advisory).
    fs: fsApi,
    git: buildGitApi(deps, pluginId),
    // Host-mediated OS clipboard surface backing the clipboard:read /
    // clipboard:write tokens. Runs in the main process (Electron's clipboard
    // module is unavailable in the dev-worker utility process), so it works
    // from a headless plugin with no mounted panel. NOT revoke-guarded —
    // liveness is plugin membership; once unloaded every method rejects.
    clipboard: buildClipboardApi(deps, pluginId, boundProjectId),
    // Host-mediated open/reveal, scoped to the plugin's own declared fs roots
    // (including its implicit plugin-data namespace) rather than the user's
    // project roots — the gap that pushed plugins into shelling out to
    // /usr/bin/open. NOT revoke-guarded, same as fs/clipboard.
    system: buildSystemApi(deps, pluginId, boundProjectId),
    // HTML-to-PDF export written under host.fs.writeFile's gates. NOT
    // revoke-guarded, same as fs/system.
    documents: buildDocumentsApi(deps, pluginId),
    // Large files the host holds and streams (#14100). NOT revoke-guarded,
    // same as fs/documents; unload cancels transfers and drops artifacts.
    artifacts: buildArtifactsApi(deps, pluginId, boundProjectId),
    ...settings,
  };
  // Keyed by the composed host, which is what the worker bridge holds.
  pushListenerObservers.set(host, presentation.observePushListeners);
  return {
    host,
    revoke: () => {
      revoked = true;
    },
  };
}

/**
 * Meter every prompt that puts a dialog in front of the user, so an invoke
 * whose handler awaited one is not reported as a slow handler. Only
 * `requestPrompt` is wrapped; it is the one method the host calls.
 */
function withPromptWaitTracking(
  dispatcher: PluginUIPromptDispatcher,
  track: ((pluginId: string) => () => void) | undefined
): Pick<PluginUIPromptDispatcher, "requestPrompt"> {
  // Partial test deps leave the dispatcher unset.
  if (!track || dispatcher === null || typeof dispatcher !== "object") return dispatcher;
  return {
    requestPrompt: (pluginId, params, projectId, signal) => {
      if (!promptOpensDialog(params)) {
        return dispatcher.requestPrompt(pluginId, params, projectId, signal);
      }
      let end: () => void = () => {};
      try {
        end = track(pluginId);
      } catch {
        // Metering must never change what the plugin sees.
      }
      let pending: Promise<PluginUiPromptResultValue>;
      try {
        pending = dispatcher.requestPrompt(pluginId, params, projectId, signal);
      } catch (err) {
        end();
        throw err;
      }
      return pending.finally(end);
    },
  };
}
