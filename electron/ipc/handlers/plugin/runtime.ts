import { AppError } from "../../../utils/errorTypes.js";
import { consumeArtifactSelectionGrant } from "../../../services/plugin/artifactSelectionGrants.js";
import type {
  PluginArtifact,
  PluginArtifactSource,
} from "../../../../shared/types/pluginArtifacts.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import {
  projectIdFromRuntimePanelKindId,
  isProjectQualifiedPanelKindId,
} from "../../../../shared/config/panelKindRegistry.js";
import {
  parsePluginHostedViewKindId,
  type PluginActivationResult,
  type PluginRuntimeStatus,
  type PluginPanelLifecycleEvent,
} from "../../../../shared/types/plugin.js";
import type { IpcContext } from "../../types.js";
import {
  isSafePluginInstanceId,
  projectIdFromPluginInstanceKey,
  PROJECT_PLUGIN_INSTANCE_PREFIX,
} from "../../../services/plugin/projectPluginIdentity.js";
import { panelLifecycleSourceFor } from "../pluginPanelLifecycleSource.js";
import { getPluginService } from "./service.js";
import { isRemoteCaller, remoteUnsupportedError } from "./senderScope.js";

/**
 * Hold the user's Cancel or Dismiss on a plugin task (#13819) to the ownership
 * rule a worker restart follows: a renderer reaches an app-wide plugin's tasks,
 * or its own project's plugin's, never another project's.
 */
function checkTaskTarget(ctx: IpcContext, pluginId: unknown, taskId: unknown, what: string): void {
  // `op` performs no runtime argument validation.
  if (typeof pluginId !== "string" || !isSafePluginInstanceId(pluginId)) {
    throw new Error(`plugin task ${what}: malformed plugin id`);
  }
  if (typeof taskId !== "string" || taskId.length === 0 || taskId.length > 64) {
    throw new Error(`plugin task ${what}: malformed task id`);
  }
  const owningProjectId = projectIdFromPluginInstanceKey(pluginId);
  if (owningProjectId === null && pluginId.startsWith(PROJECT_PLUGIN_INSTANCE_PREFIX)) {
    throw new Error(`plugin task ${what}: malformed project instance key`);
  }
  if (owningProjectId !== null && owningProjectId !== ctx.projectId) {
    throw new Error(`plugin task ${what}: sender belongs to a different project`);
  }
}

/** Ask a plugin to stop a task. False when it isn't running or can't be cancelled. */
export async function handleTaskCancel(
  ctx: IpcContext,
  pluginId: string,
  taskId: string
): Promise<boolean> {
  checkTaskTarget(ctx, pluginId, taskId, "cancel");
  return (await getPluginService()).cancelPluginTask(pluginId, taskId);
}

/** Clear an interrupted task from the list. False for any task that isn't interrupted. */
export async function handleTaskDismiss(
  ctx: IpcContext,
  pluginId: string,
  taskId: string
): Promise<boolean> {
  checkTaskTarget(ctx, pluginId, taskId, "dismiss");
  return (await getPluginService()).dismissPluginTask(pluginId, taskId);
}

/**
 * The sender may act for this plugin's artifacts: a well-formed instance id,
 * a project plugin only from its own project's views, and a view on this
 * machine. A remote-bound view's files and playback live on the machine it
 * sits at, which this host's cache cannot reach (#14100).
 */
function checkArtifactTarget(ctx: IpcContext, pluginId: unknown, what: string): void {
  if (typeof pluginId !== "string" || !isSafePluginInstanceId(pluginId)) {
    throw new Error(`plugin artifact ${what}: malformed plugin id`);
  }
  const owningProjectId = projectIdFromPluginInstanceKey(pluginId);
  if (owningProjectId === null && pluginId.startsWith(PROJECT_PLUGIN_INSTANCE_PREFIX)) {
    throw new Error(`plugin artifact ${what}: malformed project instance key`);
  }
  if (owningProjectId !== null && owningProjectId !== ctx.projectId) {
    throw new Error(`plugin artifact ${what}: sender belongs to a different project`);
  }
  if (ctx.endpoint.kind !== "local-view") {
    throw new AppError({
      code: "UNSUPPORTED",
      message: `ARTIFACT_REMOTE_UNSUPPORTED: plugin artifact ${what} is not available in a window attached to a remote host`,
    });
  }
}

/** Import the files the view's person chose as the plugin's artifacts. */
export async function handleArtifactsImport(
  ctx: IpcContext,
  pluginId: string,
  paths: string[]
): Promise<PluginArtifact[]> {
  checkArtifactTarget(ctx, pluginId, "import");
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 64) {
    throw new Error("plugin artifact import: between 1 and 64 paths");
  }
  for (const filePath of paths) {
    if (
      typeof filePath !== "string" ||
      !consumeArtifactSelectionGrant(ctx.webContentsId, filePath)
    ) {
      throw new AppError({
        code: "PERMISSION",
        message: "plugin artifact import: only a file chosen in this view can be imported",
      });
    }
  }
  const projectId = projectIdFromPluginInstanceKey(pluginId) ?? ctx.projectId;
  return (await getPluginService()).importArtifactSelection(pluginId, projectId, paths);
}

/** A playback source for one of the plugin's artifacts, leased to this view. */
export async function handleArtifactSource(
  ctx: IpcContext,
  pluginId: string,
  artifactId: string
): Promise<PluginArtifactSource> {
  checkArtifactTarget(ctx, pluginId, "source");
  if (typeof artifactId !== "string" || !/^[0-9a-f]{32}$/.test(artifactId)) {
    throw new Error("plugin artifact source: malformed artifact id");
  }
  return (await getPluginService()).mintArtifactSource(pluginId, artifactId, ctx.webContentsId);
}

/** End the lease in a source URL this view was given. */
export async function handleArtifactSourceRelease(ctx: IpcContext, url: string): Promise<boolean> {
  if (typeof url !== "string" || url.length > 512) return false;
  return (await getPluginService()).revokeArtifactSource(url, ctx.webContentsId);
}

/**
 * Implicit activation for contributed panel views (#10523): force the plugin
 * owning `panelKindId` to `activate()` before the renderer imports its
 * `plugin://` module, so handlers bound during `activate()` are live when the
 * view first renders. `activatePlugin` never rejects, but the service reports the
 * outcome via {@link PluginActivationResult}; on failure this handler throws an
 * {@link AppError} (#6020 — IPC handlers throw instead of returning an `{ ok }`
 * envelope) so the IPC call rejects and `PluginViewHost` surfaces the real
 * activation cause through its ErrorBoundary BEFORE importing the module (#10618),
 * instead of failing later with a generic import timeout. Resolves once the
 * owning plugin is already activated, or when the kind id is unknown.
 *
 * `requestRecoveryPath` asks main to mint a replacement `plugin://` URL on a
 * fresh view generation, for the case where the renderer's previous import of
 * this view already failed (#11728) — that specifier is permanently poisoned in
 * the module map, so recovery needs a URL V8 has never seen. Returns the
 * main-built path, or `undefined` when none applies (no recovery requested,
 * unknown kind, PTY panel, or no matching view contribution).
 */
export async function handleActivateForView(
  ctx: IpcContext,
  panelKindId: string,
  requestRecoveryPath?: boolean
): Promise<string | undefined> {
  // A view hosted outside the panel grid names its plugin instance directly
  // rather than a panel kind, so the owning project comes from the instance
  // key — the same rule, applied to the other id shape.
  const hosted = parsePluginHostedViewKindId(panelKindId);
  if (hosted !== null) {
    const hostedOwner = projectIdFromPluginInstanceKey(hosted.pluginId);
    const malformed =
      hostedOwner === null && hosted.pluginId.startsWith(PROJECT_PLUGIN_INSTANCE_PREFIX);
    if (malformed || (hostedOwner !== null && hostedOwner !== ctx.projectId)) {
      throw new AppError({
        code: "PLUGIN_ACTIVATION_FAILED",
        message: `Plugin activation rejected for view "${panelKindId}": sender belongs to a different project`,
        userMessage: "That plugin belongs to a different project.",
      });
    }
  }
  // A project-qualified kind may only be activated by a renderer belonging to
  // the project that owns it. `activatePluginForView` searches every loaded
  // instance for a matching kind, so without this a renderer could activate —
  // and thereby start the worker for — another project's plugin.
  const owningProjectId = projectIdFromRuntimePanelKindId(panelKindId);
  // Same reasoning as the action guard: a project-prefixed id that does not
  // parse is malformed, not global, and must not skip the check.
  if (owningProjectId === null && isProjectQualifiedPanelKindId(panelKindId)) {
    throw new AppError({
      code: "PLUGIN_ACTIVATION_FAILED",
      message: `Plugin activation rejected for view "${panelKindId}": malformed project panel kind id`,
      userMessage: "That panel could not be identified.",
    });
  }
  if (owningProjectId !== null && owningProjectId !== ctx.projectId) {
    throw new AppError({
      code: "PLUGIN_ACTIVATION_FAILED",
      message: `Plugin activation rejected for view "${panelKindId}": sender belongs to a different project`,
      userMessage: "That panel belongs to a different project.",
    });
  }
  const service = await getPluginService();
  // Only a window on another machine carries the gate; a local call is
  // exactly the call it always was.
  const result: PluginActivationResult = isRemoteCaller(ctx)
    ? await service.activatePluginForView(panelKindId, requestRecoveryPath === true, {
        remoteFrontend: true,
      })
    : await service.activatePluginForView(panelKindId, requestRecoveryPath === true);
  if (!result.ok && result.remoteUnsupported) {
    throw remoteUnsupportedError(result.remoteUnsupported.pluginId);
  }
  if (!result.ok) {
    throw new AppError({
      code: "PLUGIN_ACTIVATION_FAILED",
      message: `Plugin failed to activate for view "${panelKindId}": ${result.error}`,
      userMessage: result.error,
    });
  }
  return result.recoveryComponentPath;
}

/**
 * Every tracked instance's current runtime health (#12278).
 *
 * The push channel is authoritative; this exists for the gap a push cannot
 * cover. `pushSnapshotTo` fires on `did-finish-load`, but the renderer store
 * initializes from a leaf component that may mount long after that, and the
 * preload buffers nothing — so a panel restored into an already-running window
 * would otherwise sit on an empty map until the plugin's next transition, which
 * for a worker that died before the panel mounted never comes.
 *
 * Project instances are filtered to their owning project. A renderer has no
 * panel on another project's instance, so withholding it costs nothing.
 */
export async function handleRuntimeStatusesGet(ctx: IpcContext): Promise<PluginRuntimeStatus[]> {
  const statuses = (await getPluginService()).listPluginRuntimeStatuses();
  return statuses.filter((status) => {
    const owningProjectId = projectIdFromPluginInstanceKey(status.pluginId);
    return owningProjectId === null || owningProjectId === ctx.projectId;
  });
}

/**
 * Retire a plugin's backend generation and start a fresh one (#12278).
 *
 * The panel-level recovery of last resort: the worker is gone or wedged, and
 * the plugin's contributions survive the teardown, so every panel on the
 * instance rebinds to the new generation instead of closing. Concurrent
 * requests from sibling panels are coalesced by the service into one restart.
 *
 * Returns the resulting status rather than throwing on a failed activation —
 * "the restart ran and the backend failed again" is a legitimate outcome the
 * banner must render, not an error dialog.
 */
export async function handleRestartWorker(
  ctx: IpcContext,
  pluginId: string
): Promise<PluginRuntimeStatus | null> {
  // `op` performs no runtime argument validation, so a malformed call would
  // otherwise reach `startsWith` on a non-string and surface as a TypeError.
  if (typeof pluginId !== "string" || !isSafePluginInstanceId(pluginId)) {
    throw new AppError({
      code: "PLUGIN_ACTIVATION_FAILED",
      message: `Plugin restart rejected: invalid instance id`,
      userMessage: "That plugin could not be identified.",
    });
  }
  // Same ownership rule as `activateForView`: without it a renderer could
  // restart — and thereby start the worker for — another project's plugin.
  const owningProjectId = projectIdFromPluginInstanceKey(pluginId);
  if (owningProjectId === null && pluginId.startsWith(PROJECT_PLUGIN_INSTANCE_PREFIX)) {
    throw new AppError({
      code: "PLUGIN_ACTIVATION_FAILED",
      message: `Plugin restart rejected for "${pluginId}": malformed project instance key`,
      userMessage: "That plugin could not be identified.",
    });
  }
  if (owningProjectId !== null && owningProjectId !== ctx.projectId) {
    throw new AppError({
      code: "PLUGIN_ACTIVATION_FAILED",
      message: `Plugin restart rejected for "${pluginId}": sender belongs to a different project`,
      userMessage: "That plugin belongs to a different project.",
    });
  }
  try {
    return await (await getPluginService()).restartPluginWorker(pluginId);
  } catch (err) {
    // The service raises plain `Error`s for its refusals (not loaded, disabled,
    // no backend). This is the layer that owns the user-facing shape, so they
    // reach the renderer with a code and a message worth rendering rather than
    // as an opaque rejection.
    if (err instanceof AppError) throw err;
    throw new AppError({
      code: "PLUGIN_ACTIVATION_FAILED",
      message: `Plugin restart failed for "${pluginId}": ${formatErrorMessage(err, "restart failed")}`,
      userMessage: "That plugin couldn't be restarted.",
    });
  }
}

/**
 * Ingest a renderer's batch of plugin panel lifecycle transitions (#11301).
 *
 * The renderer is the only process that can distinguish a temporary unmount
 * (sibling maximize, inactive dock tab) from a permanent close, so it owns the
 * phase. `sourceId` comes from the IPC context — never the payload — so each
 * project view's panels stay in their own bucket. Per-event shape validation
 * and ownership resolution happen in the broker; this handler stays a thin,
 * non-throwing sink so a lifecycle report can never surface an error dialog on
 * a background bookkeeping call.
 */
export async function handleReportPanelLifecycle(
  ctx: IpcContext,
  events: PluginPanelLifecycleEvent[]
): Promise<void> {
  // `ctx.event.sender` lets the service forget this renderer's panels when its
  // view is destroyed — otherwise a closed project view's panels linger and get
  // replayed to the next subscriber as though they were still open.
  (await getPluginService()).ingestPanelLifecycleEvents(
    ctx.webContentsId,
    events,
    panelLifecycleSourceFor(ctx)
  );
}

export async function handleReportPanelInventory(
  ctx: IpcContext,
  nonPluginPanelIds: string[]
): Promise<void> {
  // Same sender-keyed bucket as the lifecycle batch, so a destroyed view's
  // inventory is forgotten with its panels (#12610).
  (await getPluginService()).ingestPanelInventory(
    ctx.webContentsId,
    nonPluginPanelIds,
    panelLifecycleSourceFor(ctx)
  );
}
