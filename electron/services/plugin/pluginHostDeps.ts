import { isAppError } from "../../utils/errorTypes.js";
import { getPluginCapabilityConsentService } from "../plugin-capability/instances.js";
import type { PluginArtifactService } from "./PluginArtifactService.js";
import { type HostGitFactory } from "./pluginHostGit.js";
import type { PluginProcessManager } from "./PluginProcessManager.js";
import type { PluginContributionBroadcaster } from "./PluginContributionBroadcaster.js";
import type { PluginPanelLifecycleBroker } from "./PluginPanelLifecycleBroker.js";
import type { PluginRendererDispatcher } from "./PluginRendererDispatcher.js";
import type { PluginPanelReloadDispatcher } from "./PluginPanelReloadDispatcher.js";
import type { PluginUIPromptDispatcher } from "./PluginUIPromptDispatcher.js";
import { type PluginSettingsManager } from "./PluginSettingsManager.js";
import type { PluginAccountService } from "./PluginAccountService.js";
import type { PluginServiceBroker } from "./PluginServiceBroker.js";
import { type PluginStorageManager } from "./PluginStorageManager.js";
import { type PluginPanelActivityReport } from "../../../shared/types/plugin.js";
import type { PluginTaskRegistry } from "./PluginTaskRegistry.js";

import { getPluginActionAuditService } from "../PluginActionAuditService.js";
import { type PublishedPanelMenuItem } from "../../../shared/utils/pluginPanelMenuItems.js";
import {
  type PluginWorktreeEventPayload,
  type PluginWorktreeSnapshotFetchResult,
} from "./pluginEventScope.js";
import type { FleetSnapshotService } from "../FleetSnapshotService.js";
import type { PluginDiagnosticsLogLine } from "../../../shared/types/ipc/pluginDiagnostics.js";
import type {
  PluginIpcHandler,
  PluginActionContribution,
  PluginActionDescriptor,
  PluginChannelSchema,
  PluginTypedIpcHandler,
  ActionHandler,
  BuiltInPluginCapability,
  PluginPanelBadge,
  PluginToolbarButtonRuntimeState,
  PluginContextValue,
  PluginWorktreeCardStatus,
  PluginWorktreeReviewCheck,
  PluginTerminalStatus,
  WorkerRestartResult,
} from "../../../shared/types/plugin.js";
import type {
  LoadedPlugin,
  ValidateFn,
  ExpandedFsPath,
  WorkspaceWorktreeEvent,
} from "./PluginServiceTypes.js";

/**
 * Live collaborators and shared registries `createHost` and the fs/git/process/
 * clipboard API builders read and write. Every Map/Set/collaborator field here
 * is the SAME live reference `PluginService` holds — never a snapshot — so the
 * post-await `plugins.get(id) === boundPlugin` / `plugins.has(id)` liveness
 * checks inside these closures keep observing concurrent unload races
 * correctly (#9428, #5638, #9322). Built fresh on each `createHost` call from
 * inside `PluginService`'s class body, where private field access is legal.
 */
export interface PluginHostFactoryDeps {
  plugins: Map<string, LoadedPlugin>;
  pluginEventCleanups: Map<string, Array<() => void>>;
  pluginActions: Map<string, PluginActionDescriptor>;
  pluginActionHandlers: Map<string, ActionHandler>;
  pluginActionOwners: Map<string, Set<string>>;
  actionValidators: Map<string, ValidateFn>;
  pluginBadges: Map<string, Map<string, PluginPanelBadge>>;
  /** Live toolbar-button badges set via `host.setToolbarButtonBadge`, `pluginId → buttonId → badge`. */
  pluginToolbarBadges: Map<string, Map<string, PluginPanelBadge>>;
  /** Publish one plugin's complete toolbar-badge map to the views entitled to it. */
  emitToolbarBadges: (pluginId: string) => void;
  /** Activity reports set via `host.setPanelActivity`, `pluginId → panelId → report` (#13820). */
  pluginPanelActivity: Map<string, Map<string, PluginPanelActivityReport>>;
  /** Publish one plugin's complete activity map to the views entitled to it. */
  emitPanelActivity: (pluginId: string) => void;
  /** A revision for an accepted activity change, never handed out twice in this process. */
  nextPanelActivityRevision: () => number;
  /** Every plugin's tasks started via `host.tasks.start` (#13819), and their transitions. */
  pluginTasks: PluginTaskRegistry;
  /** Live toolbar-button state set via `host.setToolbarButtonState`, `pluginId → buttonId → state`. */
  pluginToolbarStates: Map<string, Map<string, PluginToolbarButtonRuntimeState>>;
  /** Publish one plugin's complete toolbar-state map to the views entitled to it. */
  emitToolbarStates: (pluginId: string) => void;
  /** Context keys set via `host.setContext`, `pluginId → key → value`. */
  pluginContextKeys: Map<string, Map<string, PluginContextValue>>;
  /** Publish one plugin's complete context-key map to the views entitled to it. */
  emitContextKeys: (pluginId: string) => void;
  /**
   * Worktree card statuses set via `host.setWorktreeCardStatus`, `pluginId →
   * projectId → worktreeId → status`. Bucketed by project because an
   * app-global plugin can mark worktrees in several projects over its life.
   */
  pluginWorktreeCardStatuses: Map<string, Map<string, Map<string, PluginWorktreeCardStatus>>>;
  /** Publish one plugin's complete status map for one project to that project's views. */
  emitWorktreeCardStatuses: (pluginId: string, projectId: string) => void;
  /**
   * Bumped whenever a plugin's statuses are cleared (unload, worker swap), so
   * a call its previous generation left in flight lands on nothing.
   */
  worktreeCardStatusGeneration: (pluginId: string) => number;
  /**
   * Readiness checks set via `host.setWorktreeReviewChecks`, `pluginId →
   * projectId → worktreeId → checks` (#13806), bucketed like the card statuses.
   */
  pluginWorktreeReviewChecks: Map<
    string,
    Map<string, Map<string, readonly PluginWorktreeReviewCheck[]>>
  >;
  /** Publish one plugin's complete checks map for one project to that project's views. */
  emitWorktreeReviewChecks: (pluginId: string, projectId: string) => void;
  /** Bumped whenever a plugin's checks are cleared (unload, worker swap). */
  worktreeReviewChecksGeneration: (pluginId: string) => number;
  /** Bumped on every worktree removal and project close. */
  worktreeCardTargetRevision: () => number;
  /**
   * Whether the worktree was removed, or its project closed, after the call
   * taken at `since` (or within the read-coalescing grace before it). A read
   * that started before either can still name it.
   */
  isWorktreeCardTargetRetired: (
    projectId: string,
    worktreeId: string,
    since: { revision: number; at: number }
  ) => boolean;
  /**
   * Terminal header statuses set via `host.setTerminalStatus`, `pluginId →
   * projectId → terminalId → status` (#13802).
   */
  pluginTerminalStatuses: Map<string, Map<string, Map<string, PluginTerminalStatus>>>;
  /** Publish one plugin's complete terminal-status map for one project to that project's views. */
  emitTerminalStatuses: (pluginId: string, projectId: string) => void;
  /** Bumped whenever a plugin's terminal statuses are cleared (unload, worker swap). */
  terminalStatusGeneration: (pluginId: string) => number;
  /** Bumped on every project close. */
  terminalStatusCloseRevision: () => number;
  /** Whether the project closed after the call taken at `sinceRevision`. */
  isTerminalStatusProjectClosed: (projectId: string, sinceRevision: number) => boolean;
  /** Runtime panel menus set via `host.setPanelMenuItems`, `pluginId → panelId → items`. */
  pluginPanelMenus: Map<string, Map<string, readonly PublishedPanelMenuItem[]>>;
  pluginFsWatchers: Map<string, Set<() => void>>;
  broadcaster: PluginContributionBroadcaster;
  panelLifecycleBroker: PluginPanelLifecycleBroker;
  dispatcher: PluginRendererDispatcher;
  panelReloadDispatcher: PluginPanelReloadDispatcher;
  promptDispatcher: PluginUIPromptDispatcher;
  settings: PluginSettingsManager;
  accounts: PluginAccountService;
  /** Services between plugins (#14105): bindings and every `host.services` call. */
  services: Pick<PluginServiceBroker, "bind" | "call" | "status">;
  storage: PluginStorageManager;
  /** Live read of the mutable `hostGitFactory` field — reassignable via `_setHostGitFactoryForTests`. */
  getHostGitFactory: () => HostGitFactory | undefined;
  getProcessManager: () => PluginProcessManager;
  declaredCapabilities: (pluginId: string) => Set<BuiltInPluginCapability>;
  /**
   * Main's fleet snapshot service, read at call time — it is created by the
   * project stats handlers and may not exist yet (or any more). Behind
   * `agents.listAll` and `onDidChangeAllAgents`.
   */
  getFleetSnapshotService: () => Pick<
    FleetSnapshotService,
    "getLastBroadcast" | "subscribe"
  > | null;
  /**
   * Worktree snapshots for the host's project, carrying why there are none and
   * which project the ones there are belong to (#12174).
   *
   * Result-shaped rather than `WorktreeSnapshot[]` because `[]` is the same
   * answer for "this project has no worktrees" and for five ways of having no
   * answer at all, and the host API has to be able to tell a plugin apart. The
   * `plugin-unloaded` reason is not reachable here — liveness is the factory's
   * own concern, checked around this call — so it is excluded from the shape.
   */
  fetchWorktreeSnapshotsResult: () => Promise<PluginWorktreeSnapshotFetchResult>;
  /**
   * The same read for one named project, for a project-bound host. Reads the
   * workspace host that owns `projectRoot` directly instead of the focused
   * window's, and reports `project-unavailable` once that project closes.
   */
  fetchWorktreeSnapshotsForProjectResult: (
    projectId: string,
    projectRoot: string
  ) => Promise<PluginWorktreeSnapshotFetchResult>;
  /**
   * One project's custom worktree titles, keyed by worktree id (#14022). They
   * live in main, never in the workspace host, so every projection overlays
   * them. Never throws: an unreadable store reads as no titles.
   */
  getWorktreeCustomTitles: (projectId: string) => Readonly<Record<string, string>>;
  /** Called with the project id after any of its custom titles changes. Returns the disposer. */
  subscribeWorktreeCustomTitles: (listener: (projectId: string) => void) => () => void;
  recordPluginLog: (
    boundPlugin: LoadedPlugin,
    pluginId: string,
    level: PluginDiagnosticsLogLine["level"],
    message: string,
    fields?: Record<string, unknown>
  ) => void;
  serializePluginBadges: (pluginId: string) => Record<string, PluginPanelBadge>;
  serializePluginPanelMenus: (
    pluginId: string
  ) => Record<string, readonly PublishedPanelMenuItem[]>;
  /** User-facing name for a plugin id, for surfaces that name a plugin to a person. */
  pluginDisplayName: (pluginId: string) => string;
  pluginDataDir: (pluginId: string) => string;
  isPathUnder: (root: string, candidate: string) => boolean;
  /** The session's artifact cache behind `host.artifacts`; null once the service has shut down. */
  artifactService: () => PluginArtifactService | null;
  expandAllowedPathEntries: (
    pluginId: string,
    options: { includeDataDir: boolean }
  ) => Promise<ExpandedFsPath[]>;
  subscribeWorktreeEvent: (
    pluginId: string,
    event: WorkspaceWorktreeEvent,
    handler: (payload?: PluginWorktreeEventPayload) => void
  ) => () => void;
  registerHandler: (
    pluginId: string,
    channel: string,
    schemaOrHandler: PluginChannelSchema<unknown, unknown> | PluginIpcHandler,
    typedHandler?: PluginTypedIpcHandler<unknown, unknown>
  ) => void;
  validateAndBuildActionDescriptor: (
    pluginId: string,
    contribution: PluginActionContribution
  ) => PluginActionDescriptor;
  safeAppendAudit: (
    input: Parameters<ReturnType<typeof getPluginActionAuditService>["append"]>[0]
  ) => void;
  safeArgsHash: (args: unknown[]) => string;
  /**
   * Meter a push refused for size or cloneability. Optional because metering
   * is best-effort; a missing sink must never change what the plugin sees.
   */
  recordPushRejected?: (pluginId: string) => void;
  /**
   * Meter a host prompt the user has to answer: called as it opens, and the
   * returned function as it settles. Optional for the same reason as
   * `recordPushRejected`.
   */
  trackPromptWait?: (pluginId: string) => () => void;
  /**
   * Admit and schedule a plugin's request to restart its own worker
   * (`host.restartWorker`, #13410). Answers synchronously and starts the
   * restart only after the caller has been answered. `boundPlugin` is the
   * instance the calling host was bound to, so a request from a superseded
   * instance can never restart its successor.
   */
  requestWorkerSelfRestart: (pluginId: string, boundPlugin: LoadedPlugin) => WorkerRestartResult;
  /**
   * Whether the user has turned this plugin's toasts and notifications off
   * (#13818): the plugin silenced, or `projectId` (the project a notification
   * is about) muted. Asked before the rate budget, so a held-back call costs
   * the plugin nothing.
   */
  pluginNotificationsBlocked: (pluginId: string, projectId: string | null) => Promise<boolean>;
}

/**
 * Replace the get-or-create-list/push/self-splicing-dispose boilerplate that
 * was copy-pasted across 5 host closures. `teardown` runs the closure-specific
 * unsubscribe/unregister work; the list bookkeeping is identical everywhere.
 */
export function trackPluginDisposer(
  pluginEventCleanups: Map<string, Array<() => void>>,
  pluginId: string,
  teardown: () => void
): () => void {
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    teardown();
    const list = pluginEventCleanups.get(pluginId);
    if (!list) return;
    const idx = list.indexOf(dispose);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) pluginEventCleanups.delete(pluginId);
  };
  let list = pluginEventCleanups.get(pluginId);
  if (!list) {
    list = [];
    pluginEventCleanups.set(pluginId, list);
  }
  list.push(dispose);
  return dispose;
}

/**
 * Just-in-time consent gate for a high-risk host capability (#10524).
 * Resolves silently for built-in (first-party) plugins and for capabilities
 * the user has already granted; otherwise raises a first-use prompt and
 * throws a `PERMISSION_REQUIRED:` error on denial. Callers invoke this AFTER
 * the static `manifest.capabilities` check passes, at the top of each gated
 * host API closure — the static check answers "may this plugin ever do X",
 * this answers "has the user agreed to it doing X now".
 */
export async function ensureCapabilityConsent(
  deps: Pick<PluginHostFactoryDeps, "plugins">,
  pluginId: string,
  capability: BuiltInPluginCapability
): Promise<void> {
  const plugin = deps.plugins.get(pluginId);
  // Membership is re-checked by the caller after this await; a missing plugin
  // here means it unloaded mid-call, so skip the prompt and let the caller's
  // liveness guard reject.
  if (!plugin) return;
  // Built-ins are bundled first-party code — they skip the install-time
  // capability disclosure and likewise skip JIT consent.
  if (plugin.isBuiltin) return;
  const displayName = plugin.manifest.displayName ?? plugin.manifest.name;
  // The scope is taken from the instance's own binding, not from a parameter
  // and not from focus. `ensureAllowed`'s scope argument is optional, so nothing
  // in the type system would have caught omitting it — and omitting it keys
  // every grant under `"global"`, which would let one project's approval of
  // `shell:exec` answer for a different project's copy of the same plugin id.
  const scopeKey = plugin.binding?.projectId ?? "global";
  await getPluginCapabilityConsentService().ensureAllowed(
    pluginId,
    displayName,
    capability,
    plugin.manifest.capabilities ?? [],
    scopeKey
  );
}

/**
 * Is this the frozen `PROJECT_VIEW_UNAVAILABLE` rejection a bound renderer
 * round-trip raises? The read-only catalog surface is documented as resolving
 * empty rather than throwing when no renderer is available, so it swallows
 * exactly this failure — and nothing else, which would mask real bugs.
 */
export function isProjectViewUnavailable(error: unknown): boolean {
  return isAppError(error) && error.code === "PROJECT_VIEW_UNAVAILABLE";
}
