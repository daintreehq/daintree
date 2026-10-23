/**
 * In-memory `PluginHostApi` implementation for unit tests. Records every host
 * call into a recording array so a plugin's `activate()` can be exercised
 * without booting Electron, the renderer, or the real contribution registries.
 *
 * Why the intersection return type — `PluginHostApi & MockHostState` makes the
 * recording arrays and `simulate*` helpers visible to callers while still
 * giving TypeScript a compile error the moment `PluginHostApi` gains a new
 * method this mock doesn't implement.
 */

import {
  PLUGIN_NOTIFY_MAX_ACTIONS,
  PLUGIN_PANEL_ACTIVITY_MAX_PANELS,
  PLUGIN_TASK_MAX_LIVE,
  PLUGIN_TERMINAL_STATUS_MAX_PER_PROJECT,
  pluginManifestIdFromInstanceKey,
  projectIdFromPluginInstanceKey,
} from "../types/plugin.js";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { validateRenderPdfOptions } from "../utils/pluginPdfOptions.js";
import { parsePluginExternalUrl } from "../utils/pluginExternalUrl.js";
import {
  validatePluginTaskProgress,
  validatePluginTaskResult,
  validatePluginTaskStart,
  type VettedPluginTaskStart,
} from "../utils/pluginTasks.js";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { join as joinPath } from "node:path";
import { databaseError, openPluginDatabase } from "../utils/pluginDatabaseHandle.js";
import { validateAgentContextPayload } from "../utils/agentContextDrag.js";
import { normalizePluginAllAgentsSnapshot } from "../utils/pluginAllAgentsSnapshot.js";
import { pluginFocusedPanelEquals, toPluginFocusedPanel } from "../utils/pluginFocusedPanel.js";
import { toPluginProjectPresence } from "../utils/pluginProjectPresence.js";
import { toPluginTerminalLifecycleEvent } from "../utils/pluginTerminalLifecycle.js";
import { isProjectWorkspaceId } from "../utils/workspaceIds.js";
import { toRuntimePanelKindId } from "../config/panelKindRegistry.js";
import { normalizePanelMenuItems } from "../utils/pluginPanelMenuItems.js";
import { applyPluginContextEntry, validatePluginContextEntry } from "../utils/pluginContextKeys.js";
import { validatePluginWorktreeCardStatus } from "../utils/pluginWorktreeCardStatus.js";
import { validatePluginWorktreeReviewChecks } from "../utils/pluginWorktreeReviewChecks.js";
import { validatePluginTerminalStatus } from "../utils/pluginTerminalStatus.js";
import { validatePluginPanelActivity } from "../utils/pluginPanelActivity.js";
import {
  PLUGIN_INVOKE_MAX_RESULT_BYTES,
  PLUGIN_SUBSCRIPTION_DEFAULT_DEBOUNCE_MS,
  PLUGIN_FOCUSED_PANEL_DEFAULT_DEBOUNCE_MS,
  PLUGIN_TERMINAL_SCREEN_DEFAULT_LINES,
  PLUGIN_TERMINAL_SCREEN_MAX_LINES,
} from "../config/pluginBudgets.js";
import type {
  ActionDispatchResult,
  ActionId,
  PluginActionManifestEntry,
  PluginCanDispatchResult,
} from "../types/actions.js";
import type {
  FileDecorationProviderDescriptor,
  FileDecorationProviderImpl,
  ForgeProviderDescriptor,
  AnyForgeProviderImpl,
} from "../types/forge.js";
import type {
  ContextProviderDescriptor,
  ContextProviderImpl,
} from "../types/pluginContextProvider.js";
import type { NotificationType } from "../types/notification.js";
import type {
  ActionHandler,
  PluginSearchProvider,
  PanelMenuItemContribution,
  PluginActionContribution,
  PluginRenderPdfOptions,
  PluginArtifact,
  PluginChannelSchema,
  PluginConfirmOptions,
  PluginDatabaseLocation,
  PluginHostApi,
  PluginDispatchOptions,
  PluginIdentity,
  PluginInputBoxOptions,
  PluginIpcHandler,
  PluginMcpToolDefinition,
  PluginProcessHandle,
  PluginProcessSpawnOptions,
  PluginProcessApi,
  PluginDuplexProcessHandle,
  PluginDuplexProcessSpawnOptions,
  PluginPtyProcessHandle,
  PluginPtyProcessSpawnOptions,
  PluginQuickPickItem,
  PluginQuickPickOptions,
  PluginHostCallOptions,
  PluginSettingsScope,
  PluginStorageScope,
  PluginToastOptions,
  PluginNotifyOptions,
  PluginNotifyResult,
  PluginTaskHandle,
  PluginTaskProgress,
  PluginTaskResult,
  PluginTypedIpcHandler,
  PluginHandlerOptions,
  PluginWorktreeSnapshot,
  PluginWorktreeSetupStepHandler,
  PluginWorktreesChange,
  PluginFsApi,
  PluginFsReadFilesEntry,
  PluginFsReadFilesOptions,
  PluginFsWalkEntry,
  PluginFsWalkOptions,
  PluginFsWalkResult,
  PluginWorktreesResult,
  PluginAgentSnapshot,
  PluginTerminalLifecycleEvent,
  PluginAgentPane,
  PluginAllAgentsSnapshot,
  PluginFocusedPanel,
  PluginProjectPresence,
  PluginProjectPresenceState,
  PluginSendToAgentOptions,
  PluginSendToAgentResult,
  PluginRunRecipeOptions,
  PluginRunRecipeResult,
  PluginTerminalScreenResult,
  PluginAgentInputResult,
  PluginAgentInterruptResult,
  PluginAgentKeysInput,
  PluginAgentKeysResult,
  PluginPanelLifecycleEvent,
  PanelReloadResult,
  WorkerRestartResult,
  PluginSystemWakeEvent,
  PluginAccountAccessToken,
  PluginAccountState,
  PluginGitCommitResult,
  PluginPanelBadge,
  PluginToolbarButtonRuntimeState,
  PluginContextValue,
  PluginWorktreeCardStatus,
  PluginWorktreeReviewCheck,
  WorktreeDeleteNotesProviderDescriptor,
  WorktreeDeleteNotesProviderImpl,
  PluginTerminalStatus,
  PluginPanelActivity,
  SettingDefinition,
  SettingsApi,
  StorageApi,
} from "../types/plugin.js";

export interface RegisteredActionRecord {
  descriptor: PluginActionContribution;
  handler: ActionHandler;
}

export interface RegisteredHandlerRecord {
  channel: string;
  handler: PluginIpcHandler;
}

export interface BroadcastRecord {
  channel: string;
  payload: unknown;
}

/** Captured `host.postToPanel(channel, payload, panelId?)` calls — the post-activation push path. */
export interface PostToPanelRecord {
  channel: string;
  payload: unknown;
  /** Per-instance target (#10618): a panel id, or `null` for a broadcast. */
  panelId: string | null;
}

export interface ShownToastRecord {
  message: string;
  type: NotificationType | undefined;
  durationMs: number | undefined;
}

/** Captured `host.notify(options)` calls that passed validation (#13505). */
export interface NotificationRecord {
  id: string;
  options: PluginNotifyOptions;
}

/**
 * One task started through `host.tasks.start` (#13819), kept up to date as the
 * plugin reports and finishes it. `state` is where the host would show it:
 * `"cancelling"` once {@link MockHostState.simulateTaskCancel} asked, then the
 * outcome the plugin finished with.
 */
export interface MockTaskRecord {
  readonly id: string;
  readonly options: VettedPluginTaskStart;
  state: "working" | "cancelling" | "succeeded" | "failed" | "cancelled";
  fraction: number | null;
  detail: string | undefined;
  /** Every accepted `report()`, in order. The mock applies each at once; the host coalesces. */
  readonly reports: PluginTaskProgress[];
  result: PluginTaskResult | undefined;
}

/** Captured `host.process.spawn(command, options)` calls. */
export interface SpawnRecord {
  command: string;
  options:
    | PluginProcessSpawnOptions
    | PluginDuplexProcessSpawnOptions
    | PluginPtyProcessSpawnOptions
    | undefined;
}

export interface DispatchedActionRecord {
  actionId: ActionId;
  args: unknown;
  /** The third `dispatch` argument, when the call passed one. */
  options?: PluginDispatchOptions;
}

/** Captured `host.sendToActiveAgent(text, options)` calls. */
export interface SentToActiveAgentRecord {
  text: string;
  submit: boolean;
}

/** Captured `host.sendToAgent(text, options)` calls, with what each resolved. */
export interface SentToAgentRecord {
  text: string;
  options: PluginSendToAgentOptions | undefined;
  result: PluginSendToAgentResult;
}

/** Captured `host.runRecipe(recipeId, options)` calls, with what each resolved. */
export interface RunRecipeRecord {
  recipeId: string;
  options: PluginRunRecipeOptions | undefined;
  result: PluginRunRecipeResult;
}

/**
 * Captured `host.agents.interrupt` / `sendKeys` / `submit` calls that got past
 * validation, with what each resolved.
 */
export interface AgentInputRecord {
  method: "interrupt" | "sendKeys" | "submit";
  terminalId: string;
  /** What `sendKeys` pressed, or the text `submit` sent. */
  input?: PluginAgentKeysInput | string;
  result: PluginAgentInputResult | PluginAgentInterruptResult | PluginAgentKeysResult;
}

/** Captured `host.terminals.readScreen(terminalId, options)` calls, with what each resolved. */
export interface ReadScreenRecord {
  terminalId: string;
  lines: number;
  result: PluginTerminalScreenResult;
}

export interface RegisteredForgeProviderRecord {
  descriptor: ForgeProviderDescriptor;
  impl: AnyForgeProviderImpl;
}

export interface RegisteredFileDecorationProviderRecord {
  descriptor: FileDecorationProviderDescriptor;
  impl: FileDecorationProviderImpl;
}

/** A live `host.registerSearchProvider` binding; call `provider` to drive it in a test. */
export interface RegisteredSearchProviderRecord {
  id: string;
  provider: PluginSearchProvider;
}

/** A provider bound through `host.registerContextProvider`; call `impl` directly to test it. */
export interface RegisteredContextProviderRecord {
  descriptor: ContextProviderDescriptor;
  impl: ContextProviderImpl;
}

/**
 * A handler bound through `host.registerWorktreeSetupStep`. Call `handler`
 * with a context of your own to run the step as the host would.
 */
export interface RegisteredWorktreeSetupStepRecord {
  stepId: string;
  handler: PluginWorktreeSetupStepHandler;
}

export interface RegisteredWorktreeDeleteNotesProviderRecord {
  descriptor: WorktreeDeleteNotesProviderDescriptor;
  impl: WorktreeDeleteNotesProviderImpl;
}

/**
 * A roster bound through `host.mcp.registerTools`. `tools` is the plugin's own
 * roster, `execute` functions included, so a test can call a tool directly with
 * a caller and signal of its choosing.
 */
export interface RegisteredMcpToolsRecord {
  endpointId: string;
  tools: Record<string, PluginMcpToolDefinition>;
}

export interface InvalidationRecord {
  scope: string;
  paths: string[] | undefined;
}

/** Captured `host.setToolbarButtonBadge(buttonId, badge)` calls. `null` clears. */
export interface SetToolbarButtonBadgeRecord {
  buttonId: string;
  badge: PluginPanelBadge | null;
}

/** Captured `host.setToolbarButtonState(buttonId, state)` calls. `null` clears. */
export interface SetToolbarButtonStateRecord {
  buttonId: string;
  state: PluginToolbarButtonRuntimeState | null;
}

/** Captured `host.setContext(key, value)` calls. `null` clears. */
export interface SetContextRecord {
  key: string;
  value: PluginContextValue | null;
}

/**
 * Captured `host.setWorktreeReviewChecks(worktreeId, checks)` calls, as the
 * host stores them (`worktreeId` is the snapshot's `id`). `null` clears.
 */
export interface SetWorktreeReviewChecksRecord {
  worktreeId: string;
  checks: PluginWorktreeReviewCheck[] | null;
}

/**
 * Captured `host.setWorktreeCardStatus(worktreeId, status)` calls, as the host
 * stores them (`worktreeId` is the snapshot's `id`). `null` clears.
 */
export interface SetWorktreeCardStatusRecord {
  worktreeId: string;
  status: PluginWorktreeCardStatus | null;
}

/** Captured `host.setTerminalStatus(terminalId, status)` calls. `null` clears. */
export interface SetTerminalStatusRecord {
  terminalId: string;
  status: PluginTerminalStatus | null;
}

/** Captured `host.setPanelActivity(panelId, activity)` calls. `null` clears. */
export interface SetPanelActivityRecord {
  panelId: string;
  activity: PluginPanelActivity | null;
}

/** Captured `host.setPanelBadge(panelId, badge)` calls. `null` clears. */
export interface SetPanelBadgeRecord {
  panelId: string;
  badge: PluginPanelBadge | null;
}

/**
 * Captured `host.setPanelMenuItems(panelId, items)` calls, items as the plugin
 * wrote them. `null` (or `[]`) clears.
 */
export interface SetPanelMenuItemsRecord {
  panelId: string;
  items: readonly PanelMenuItemContribution[] | null;
}

/** Captured `host.showQuickPick(items, options)` calls. */
export interface ShowQuickPickRecord {
  items: PluginQuickPickItem[];
  options: PluginQuickPickOptions | undefined;
}

/** Captured `host.showInputBox(options)` calls. */
export interface ShowInputBoxRecord {
  options: PluginInputBoxOptions | undefined;
}

/** Captured `host.showConfirm(options)` calls. */
export interface ShowConfirmRecord {
  options: PluginConfirmOptions;
}

/**
 * Captured `host.fs.writeFile(path, contents)` calls — and, in
 * {@link MockHostState.fsAppendCalls}, `host.fs.appendFile(path, contents)`
 * calls, where `contents` is the appended text alone.
 */
export interface FsWriteRecord {
  path: string;
  contents: string;
}

/** A coalesced host subscription, with the window the host resolves for it. */
export interface MockSubscriptionRecord {
  kind:
    | "worktrees"
    | "active-worktree"
    | "agent-state"
    | "all-agents"
    | "focused-panel"
    | "project-presence";
  /** Effective window in ms: the 100ms default (250ms for `focused-panel`), `0` for raw, else clamped to 50–60000. */
  debounceMs: number;
}

/** Captured `host.git.commit(worktreePath, options)` calls. */
export interface GitCommitRecord {
  worktreePath: string;
  message: string;
}

export interface MockHostState {
  readonly registeredActions: ReadonlyArray<RegisteredActionRecord>;
  readonly registeredHandlers: ReadonlyArray<RegisteredHandlerRecord>;
  readonly broadcastCalls: ReadonlyArray<BroadcastRecord>;
  readonly postToPanelCalls: ReadonlyArray<PostToPanelRecord>;
  readonly shownToasts: ReadonlyArray<ShownToastRecord>;
  /** Every `host.notify` call that got past validation, in order. */
  readonly notifications: ReadonlyArray<NotificationRecord>;
  readonly dispatchedActions: ReadonlyArray<DispatchedActionRecord>;
  readonly sentToActiveAgentCalls: ReadonlyArray<SentToActiveAgentRecord>;
  /** Every `host.sendToAgent` call that got past validation, in order. */
  readonly sentToAgentCalls: ReadonlyArray<SentToAgentRecord>;
  /** Every `host.runRecipe` call that got past validation, in order. */
  readonly runRecipeCalls: ReadonlyArray<RunRecipeRecord>;
  /** Every `host.terminals.readScreen` call that got past validation, in order. */
  readonly readScreenCalls: ReadonlyArray<ReadScreenRecord>;
  /** Every `host.agents` input call that got past validation, in order. */
  readonly agentInputCalls: ReadonlyArray<AgentInputRecord>;
  readonly registeredForgeProviders: ReadonlyArray<RegisteredForgeProviderRecord>;
  readonly registeredFileDecorationProviders: ReadonlyArray<RegisteredFileDecorationProviderRecord>;
  /** Live `host.registerWorktreeSetupStep` bindings, one per step id. */
  readonly registeredWorktreeSetupSteps: ReadonlyArray<RegisteredWorktreeSetupStepRecord>;
  /** Live `host.registerSearchProvider` bindings, one per provider id. */
  readonly registeredSearchProviders: ReadonlyArray<RegisteredSearchProviderRecord>;
  readonly registeredContextProviders: ReadonlyArray<RegisteredContextProviderRecord>;
  /** Live `host.registerWorktreeDeleteNotesProvider` bindings, one per id. */
  readonly registeredWorktreeDeleteNotesProviders: ReadonlyArray<RegisteredWorktreeDeleteNotesProviderRecord>;
  /** Live `host.mcp.registerTools` rosters, one per endpoint id. */
  readonly registeredMcpTools: ReadonlyArray<RegisteredMcpToolsRecord>;
  readonly invalidationCalls: ReadonlyArray<InvalidationRecord>;
  readonly setPanelBadgeCalls: ReadonlyArray<SetPanelBadgeRecord>;
  readonly setToolbarButtonBadgeCalls: ReadonlyArray<SetToolbarButtonBadgeRecord>;
  readonly setToolbarButtonStateCalls: ReadonlyArray<SetToolbarButtonStateRecord>;
  /** Accepted `host.setContext` calls, in order. */
  readonly setContextCalls: ReadonlyArray<SetContextRecord>;
  /**
   * The context keys this plugin holds right now, bare (not namespaced) — what
   * its `when` clauses would read under `{publisher.name}.{key}`.
   */
  readonly contextKeys: ReadonlyMap<string, PluginContextValue>;
  /** Accepted `host.setWorktreeCardStatus` calls, in order. */
  readonly setWorktreeCardStatusCalls: ReadonlyArray<SetWorktreeCardStatusRecord>;
  /** The card statuses this plugin shows right now, keyed by worktree `id`. */
  readonly worktreeCardStatuses: ReadonlyMap<string, PluginWorktreeCardStatus>;
  /** Accepted `host.setWorktreeReviewChecks` calls, in order. */
  readonly setWorktreeReviewChecksCalls: ReadonlyArray<SetWorktreeReviewChecksRecord>;
  /** The readiness checks this plugin shows right now, keyed by worktree `id`. */
  readonly worktreeReviewChecks: ReadonlyMap<string, readonly PluginWorktreeReviewCheck[]>;
  /** Accepted `host.setTerminalStatus` calls, in order. */
  readonly setTerminalStatusCalls: ReadonlyArray<SetTerminalStatusRecord>;
  /** The terminal chips this plugin shows right now, keyed by `terminalId`. */
  readonly terminalStatuses: ReadonlyMap<string, PluginTerminalStatus>;
  /**
   * Every task started through `host.tasks.start`, in order (#13819). A failed
   * task's error notification, and a success's passive one, land in
   * {@link notifications} as the real host raises them.
   */
  readonly startedTasks: ReadonlyArray<MockTaskRecord>;
  /** Accepted `host.setPanelActivity` calls, in order. */
  readonly setPanelActivityCalls: ReadonlyArray<SetPanelActivityRecord>;
  /** The activity this plugin reports right now, keyed by `panelId`. */
  readonly panelActivity: ReadonlyMap<string, PluginPanelActivity>;
  readonly setPanelMenuItemsCalls: ReadonlyArray<SetPanelMenuItemsRecord>;
  /**
   * Panel ids passed to `host.reloadPanel(panelId)`, in order (#12610). Only
   * calls that got past argument validation are recorded.
   */
  readonly reloadPanelCalls: ReadonlyArray<string>;
  /** What each `host.restartWorker()` call answered, in the order they settled (#13410). */
  readonly restartWorkerCalls: ReadonlyArray<WorkerRestartResult>;
  readonly showQuickPickCalls: ReadonlyArray<ShowQuickPickRecord>;
  readonly showInputBoxCalls: ReadonlyArray<ShowInputBoxRecord>;
  readonly showConfirmCalls: ReadonlyArray<ShowConfirmRecord>;
  readonly spawnCalls: ReadonlyArray<SpawnRecord>;
  readonly fsWriteCalls: ReadonlyArray<FsWriteRecord>;
  /** Captured `host.fs.appendFile(path, contents)` calls, in order. */
  readonly fsAppendCalls: ReadonlyArray<FsWriteRecord>;
  /** Captured `host.fs.mkdir(path)` calls, in order. */
  readonly fsMkdirCalls: ReadonlyArray<string>;
  readonly gitCommitCalls: ReadonlyArray<GitCommitRecord>;
  /** Captured `host.clipboard.writeText(text)` calls, in order. */
  readonly clipboardWriteCalls: ReadonlyArray<string>;
  /**
   * Captured `host.clipboard.writeImage(pngData)` calls, in order. Records the
   * byte length rather than the bytes: a test asserts that an image of the
   * right size was written, and holding multi-MiB buffers alive for the
   * lifetime of the mock is a memory trap in a suite that builds many hosts.
   */
  readonly clipboardWriteImageCalls: ReadonlyArray<number>;
  /** Captured `host.system.openPath(path)` calls, in order. */
  readonly systemOpenPathCalls: ReadonlyArray<string>;
  /** Captured `host.system.showItemInFolder(path)` calls, in order. */
  readonly systemShowItemCalls: ReadonlyArray<string>;
  /**
   * Captured `host.system.openExternal(url)` calls, in order, as the normalised
   * URL the real host would hand to the browser. Only URLs that passed the real
   * validator are recorded; no consent prompt or rate limit is simulated.
   */
  readonly systemOpenExternalCalls: ReadonlyArray<string>;
  /**
   * Captured `host.documents.renderPdf(options)` calls, in order, as a shallow
   * copy of the options. Only calls that passed the mock's validation are
   * recorded; each one also leaves a placeholder PDF in the mock filesystem.
   */
  readonly documentsRenderPdfCalls: ReadonlyArray<PluginRenderPdfOptions>;
  /**
   * Live `host.artifacts` handles, by id (#14100). Imports read the mock
   * filesystem, downloads answer from {@link CreateMockHostOptions.artifactDownloads},
   * and nothing expires unless {@link MockHostState.simulateArtifactExpiry} says so.
   */
  readonly artifactRecords: ReadonlyMap<string, PluginArtifact>;
  /** Captured `host.artifacts.upload` calls, in order. */
  readonly artifactUploadCalls: ReadonlyArray<{
    artifactId: string;
    url: string;
    method: "PUT" | "POST";
  }>;
  /** Drop an artifact as its expiry would: `stat` answers null and `upload` rejects. */
  simulateArtifactExpiry(artifactId: string): void;

  /**
   * One entry per `onDidChangeWorktrees` / `onDidChangeActiveWorktree` /
   * `onDidChangeAgentState` subscription, in order, with the coalescing
   * window the host would apply — so a test can assert a plugin kept the
   * default or opted out with `debounceMs: 0`. The mock itself always
   * delivers synchronously.
   */
  readonly subscriptionOptions: ReadonlyArray<MockSubscriptionRecord>;

  /**
   * Replace the active worktree and notify every `onDidChangeActiveWorktree`
   * subscriber. Helpers are top-level on the {@link MockHostState} side of the
   * intersection so they cannot drift into the production `PluginHostApi`.
   */
  simulateActiveWorktreeChange(snapshot: PluginWorktreeSnapshot | null): void;
  simulateWorktreesChange(snapshots: PluginWorktreeSnapshot[]): void;

  /**
   * Push an agent-state snapshot to every `onDidChangeAgentState` subscriber and
   * update the value `getAgentState()` returns. Mirrors the production host's
   * cache-then-notify behaviour. Include `terminalId` and `workspaceId` to
   * drive a plugin that routes by where the transition came from.
   */
  simulateAgentStateChange(snapshot: PluginAgentSnapshot): void;

  /**
   * Push a terminal lifecycle event to every `onDidChangeTerminalLifecycle`
   * subscriber, frozen and re-projected through the production allowlist. A
   * project plugin's mock drops events from any other workspace, as the real
   * host does — and, failing closed, events with no `workspaceId` at all.
   */
  simulateTerminalLifecycleChange(event: PluginTerminalLifecycleEvent): void;

  /**
   * Push a panel lifecycle transition to every `onDidChangePanelLifecycle`
   * subscriber. Use it to prove a plugin releases durable resources on
   * `"removed"` and survives `"hidden"` — the distinction the single
   * `disposeSignal` could not express (#11301).
   */
  simulatePanelLifecycleChange(event: PluginPanelLifecycleEvent): void;

  /**
   * Push a machine wake to every `onDidWake` subscriber (#12175). Use it to
   * prove a plugin re-validates state it cached before a sleep, rather than
   * waiting for a window to regain focus.
   */
  simulateSystemWake(event: PluginSystemWakeEvent): void;

  /**
   * Press a task's Cancel as the user would (#13819): the task turns
   * `"cancelling"` and its `signal` aborts. Throws for a task that isn't
   * running or wasn't started `cancellable`, which the host's button would
   * never offer.
   */
  simulateTaskCancel(taskId: string): void;

  /**
   * Set what `host.hasListeners(channel)` answers and, when that changes it,
   * call every `onDidChangeListeners(channel, …)` callback. Every channel
   * starts out listened to — the answer a real host gives before it has heard
   * from a renderer — so a plugin that never asks is unaffected.
   */
  simulateListenersChange(channel: string, hasListeners: boolean): void;

  /**
   * Connect or disconnect the plugin's `host.account` as the user would from
   * the settings row, and call every `account.onDidChange` subscriber. Pass an
   * `accessToken` to change what `getAccessToken()` answers while connected.
   */
  simulateAccountChange(
    account:
      | ({ connected: true; identity?: string | null } & Partial<PluginAccountAccessToken>)
      | { connected: false }
  ): void;

  /**
   * Pre-seed a deterministic `dispatch()` result for one action id. Overrides
   * the default in-memory routing (which resolves the registered handler).
   */
  setDispatchResult(actionId: ActionId, result: ActionDispatchResult): void;

  /**
   * Replace the action catalog that backs `host.actions.list/get/canDispatch`.
   * Mirrors a snapshot of `ActionService.list()`: pass the slim
   * {@link PluginActionManifestEntry} entries a plugin would discover, then
   * assert how the plugin reacts. Replaces (does not merge) any prior seed;
   * call with `[]` to reset. `canDispatch` derives its verdict from each
   * entry's `danger` the same way production does — `"safe"` → `"ok"`,
   * `"confirm"` → `"confirm"`, unknown id → `"restricted"`.
   */
  seedActionCatalog(entries: PluginActionManifestEntry[]): void;

  /**
   * Fire the active `host.fs.watch` callbacks that would observe a change at
   * `changedPath`: a watcher sees its watched path itself and that path's
   * direct children, and — registered with `recursive: true` — anything
   * beneath it. A watcher registered with `debounceMs` coalesces a burst into
   * one trailing callback with the latest path after that delay (drive it with
   * fake timers). Callback errors propagate so a test sees them; a debounced
   * callback's error surfaces from the timer instead.
   */
  simulateFsWatch(changedPath: string): void;

  /**
   * Configure what `showQuickPick` resolves to. Default is `undefined` (the
   * dismiss value a user-cancel produces). Pass a single item or an array for a
   * `canSelectMany` pick. Lets a test drive a plugin's handling of a real
   * selection without wrapping the host.
   */
  simulateQuickPickResponse(result: PluginQuickPickItem | PluginQuickPickItem[] | undefined): void;
  /** Configure what `showInputBox` resolves to (default `undefined` = dismissed). */
  simulateInputBoxResponse(result: string | undefined): void;
  /**
   * Force what `getWorktreesResult()` answers, or pass `null` to go back to the
   * `ok` result derived from the mock's current worktrees.
   */
  simulateWorktreesResult(result: PluginWorktreesResult | null): void;
  /** Configure what `showConfirm` resolves to (default `false` = cancelled). */
  simulateConfirmResponse(result: boolean): void;
  /** Replace the agent panes `agents.list()` reports and `sendToAgent` targets. */
  simulateAgentsChange(agents: PluginAgentPane[]): void;
  /**
   * Count `terminalId` as an agent this plugin launched, so the `host.agents`
   * input methods reach it. A `dispatch("agent.launch")` whose result reports
   * `launched: true` with a terminal id counts on its own, as in production,
   * unless the launch named its own `requestedId`.
   */
  simulateAgentLaunched(terminalId: string): void;
  /**
   * Replace what `agents.listAll()` reports and push it, frozen and reduced to
   * the allowlist like production, to every `onDidChangeAllAgents` subscriber.
   */
  simulateAllAgentsChange(snapshot: PluginAllAgentsSnapshot): void;
  /**
   * Move focus and push it, reduced to the allowlist and frozen like
   * production, to every `onDidChangeFocusedPanel` subscriber. A value equal to
   * the one a subscriber last received is not repeated, as in production.
   */
  simulateFocusedPanelChange(focus: PluginFocusedPanel): void;
  /**
   * Move a project and push it, frozen, to every `onDidChangeProjectPresence`
   * subscriber that sees it — a project plugin only its own project. `"closed"`
   * drops it from what a later subscription replays. A state equal to the one
   * a subscriber last received for that project is not repeated, and an
   * installed plugin is not told a project it never saw open has closed, as in
   * production.
   */
  simulateProjectPresenceChange(presence: PluginProjectPresence): void;
  /**
   * Configure what the user picks when `sendToAgent` is called without a
   * `terminalId`: a pane id drafts there, `null` (the default) dismisses the
   * picker and resolves `{ status: "cancelled" }`.
   */
  simulateSendToAgentPick(terminalId: string | null): void;
  /**
   * Configure how the user answers `runRecipe`'s confirmation. The default,
   * `{ status: "cancelled" }`, is the user dismissing it.
   */
  simulateRunRecipeResult(result: PluginRunRecipeResult): void;
  /**
   * Set what `terminals.readScreen(terminalId)` finds, or pass `null` to forget
   * the terminal so it reads `not-found`. An `ok` screen's `text` is trimmed to
   * the call's last `lines` lines, as the host does.
   */
  simulateTerminalScreen(terminalId: string, screen: PluginTerminalScreenResult | null): void;
}

export interface CreateMockHostOptions {
  pluginId?: string;
  /**
   * Bodies `host.artifacts.download` answers with, by exact URL. A URL not
   * listed rejects with `ARTIFACT_TRANSFER_FAILED`, as an unreachable provider
   * would.
   */
  artifactDownloads?: Record<string, string | Uint8Array>;
  /**
   * Project root for a project-owned `pluginId` (one shaped
   * `project__{projectId}__{manifestId}`). Defaults to a synthetic path; ignored
   * for an app-global plugin, which has no project.
   */
  projectRoot?: string;
  /**
   * The plugin's implicit data dir, inside which `fs.appendFile` grows
   * missing parents the way the host does. Defaults to the same place the
   * host uses: `~/.daintree/plugin-data/{pluginId}`.
   */
  pluginDataDir?: string;
  activeWorktree?: PluginWorktreeSnapshot | null;
  worktrees?: PluginWorktreeSnapshot[];
  /**
   * Seed `getWorktreesResult()` with a specific outcome (#12174) — an
   * `unavailable` reason, or an `ok` result naming a particular project. Omit
   * it and the mock derives `{ status: "ok", projectId: "test-project" }` from
   * `worktrees`, so an author who only cares about the happy path gets the
   * authoritative answer for free. Override it with
   * {@link MockHostState.simulateWorktreesResult} to exercise the guards a
   * plugin should have around an unavailable read.
   *
   * While an override is set the legacy `getWorktrees()` / `getActiveWorktree()`
   * project from it too — the real host derives all three from one read, so a
   * mock that answered `unavailable` here while still handing back a populated
   * list there would let a plugin's fallback pass a test it cannot pass in
   * production.
   */
  worktreesResult?: PluginWorktreesResult;
  /**
   * `host.db` backing. Every database id resolves to a real SQLite file under
   * `directory` (a fresh temp directory when omitted), so a plugin's queries,
   * migrations and change handling run against the same `node:sqlite` the real
   * host uses. `declared` restricts which ids resolve, the way
   * `contributes.databases` does in production; omit it to accept any id.
   */
  databases?: {
    directory?: string;
    declared?: readonly string[];
    journalMode?: "delete" | "wal";
  };
  settings?: {
    user?: Record<string, unknown>;
    project?: Record<string, unknown>;
    /** Per-project, per-machine scope — a flat map here, like the other two. */
    local?: Record<string, unknown>;
  };
  /**
   * Opt-in `contributes.settings` declarations (`id` + `scope` are what matter)
   * so the mock's `settings.get` resolves a key's declared scope the way the real
   * host does (#10586): a `scope: "project"` key reads from the project store when
   * no scope arg is given, and an explicit conflicting scope throws. Omitted by
   * default — the mock has no manifest model (#9878), so loose mode keeps the
   * `scope ?? "user"` default and existing manifest-free tests are unaffected.
   */
  manifestSettings?: SettingDefinition[];
  /**
   * Opt-in `contributes.toolbarButtons[].id` list, so `setToolbarButtonBadge`
   * and `setToolbarButtonState` reject an id the plugin did not contribute, as the real host does. Omitted
   * by default (the mock has no manifest model), which accepts any non-empty id.
   */
  toolbarButtonIds?: readonly string[];
  /**
   * Opt-in `contributes.panels[].id` list of the kinds declaring
   * `reportsActivity: true`, so `setPanelActivity` rejects when none does, or
   * when a panel pushed through `simulatePanelLifecycleChange` is of another
   * kind, as the real host does. Omitted by default (the mock has no manifest
   * model), which accepts any panel not reported as another plugin's.
   */
  reportsActivityPanelIds?: readonly string[];
  /**
   * Seed `host.account`. Omitted, the account starts disconnected. The mock
   * models a plugin that declares `contributes.account`.
   */
  account?: {
    identity?: string | null;
    accessToken?: string;
    expiresAt?: number | null;
  };
  /** Pre-seed private `host.storage` values per scope. */
  storage?: {
    user?: Record<string, unknown>;
    project?: Record<string, unknown>;
    worktree?: Record<string, unknown>;
  };
  /**
   * Custom resolver for `host.dispatch`. The default routes the call to a
   * matching `registerAction` handler, returning `NOT_FOUND` otherwise — which
   * mirrors `ActionService.dispatch` closely enough for activation-time tests.
   */
  dispatch?: (
    actionId: ActionId,
    args?: unknown,
    options?: PluginDispatchOptions
  ) => Promise<ActionDispatchResult>;
  /**
   * Custom resolver for `host.reloadPanel` (#12610). The default answers from
   * the phases pushed through `simulatePanelLifecycleChange`, like the real
   * host answers from its lifecycle broker: `"mounted"` → `"scheduled"`,
   * `"render-failed"` → `"unavailable"`, any other known phase or an unknown
   * id → `"not-mounted"`, and a panel reported for another plugin rejects.
   */
  reloadPanel?: (panelId: string) => PanelReloadResult | Promise<PanelReloadResult>;
  /**
   * Custom resolver for `host.restartWorker` (#13410). The default answers
   * `"scheduled"` every time; the mock has no worker, so nothing restarts.
   */
  restartWorker?: () => WorkerRestartResult | Promise<WorkerRestartResult>;
  /**
   * Declared plugin capabilities (`manifest.capabilities`), gating the agent
   * APIs the way production does (#10617). `getAgentState` requires `agent:read`
   * and `sendToActiveAgent` requires `agent:input`; without the capability the
   * call rejects with `PERMISSION_REQUIRED`, exactly as the real host. Defaults
   * to a permissive set (`agent:read` + `agent:input`) so existing manifest-free
   * tests keep working — pass a restricted list (or `[]`) to assert the
   * rejection a plugin missing the capability would hit.
   */
  capabilities?: readonly string[];
  /**
   * Whether an agent terminal is currently active. When `false`,
   * `sendToActiveAgent` rejects `NO_ACTIVE_AGENT`, mirroring production's "no
   * resolvable active agent" path. Defaults to `true`.
   */
  hasActiveAgent?: boolean;
  /**
   * The agent panes `agents.list()` reports and `sendToAgent` resolves a
   * `terminalId` against. A pane with `canDraft: false` refuses with its
   * `draftRefusal`. Defaults to none.
   */
  agents?: PluginAgentPane[];
  /**
   * What `agents.listAll()` reports. Defaults to a healthy, empty app
   * (`{ agents: [], degraded: false, lastSuccessfulAt: 0 }`).
   */
  allAgents?: PluginAllAgentsSnapshot;
  /**
   * The focus `onDidChangeFocusedPanel` replays on subscribe. Defaults to no
   * focused panel (`kind: null`). For a project plugin it is taken to be inside
   * its own project; `"portal"` reads as `kind: null`, as in production.
   */
  focusedPanel?: PluginFocusedPanel;
  /**
   * The open projects `onDidChangeProjectPresence` replays on subscribe. A
   * project plugin's mock defaults to its own project in the foreground and
   * replays its own project only, `"closed"` when it is not listed; an
   * installed plugin's defaults to none.
   */
  projectPresence?: PluginProjectPresence[];
  /**
   * What `terminals.readScreen` finds, by terminal id. An id not listed reads
   * `not-found`. Defaults to none. The mock neither rate limits nor applies
   * the host's 16 KiB byte cap.
   */
  terminalScreens?: Record<string, PluginTerminalScreenResult>;
}

/**
 * Mirrors the action-id regex and kind/danger sets in
 * `electron/services/PluginService.ts` `PLUGIN_ACTION_ID_RE` /
 * `PLUGIN_ACTION_KINDS` / `PLUGIN_ACTION_DANGERS`. The mock can't import
 * those (cross-process boundary), so the values are duplicated here and the
 * production constants are the source of truth. If the production regex or
 * sets change, mirror the change here.
 */
// The `_` in the leading segment is load-bearing and was missing here until
// #12215: a project plugin's ids are instance-qualified
// (`project__{projectId}__{publisher}.{name}.{action}`), so without it this
// mock rejected every `registerAction` a project plugin makes — the one kind of
// plugin the agent brief tells authors to write — while production accepted it.
const PLUGIN_ACTION_ID_RE = /^[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-zA-Z0-9._-]*$/;
const PLUGIN_ACTION_KINDS = new Set(["command", "query"]);
const PLUGIN_ACTION_DANGERS = new Set(["safe", "confirm"]);

/**
 * Mirrors `PLUGIN_PANEL_BADGE_LABEL_MAX` in `shared/types/plugin.ts` and the
 * toast/badge enums in `electron/schemas/plugin.ts`. Duplicated (not imported)
 * for the same reason as the action constants above — the mock validates with
 * plain JS rather than pulling the cross-process Zod schemas — and the
 * production definitions remain the source of truth. Mirror any change here.
 */
/** The key names `host.agents.sendKeys` takes, as production's schema allows them. */
const MOCK_AGENT_KEY = /^(Up|Down|Left|Right|Enter|Escape|Tab|Space|Backspace|[a-z0-9])$/;
const MOCK_PANEL_BADGE_LABEL_MAX = 6;
const MOCK_TOAST_TYPES = new Set(["info", "success", "warning", "error"]);
const MOCK_BADGE_COLORS = new Set(["default", "success", "warning", "error"]);
// Allowed-key sets mirroring the production `.strict()` schemas — unknown keys
// are rejected, not silently dropped.
const TOAST_OPTION_KEYS = new Set(["message", "type", "durationMs"]);
const BADGE_DOT_KEYS = new Set(["kind", "color", "tooltip"]);
const BADGE_LABEL_KEYS = new Set(["kind", "text", "color", "tooltip"]);

/**
 * Validate `showToast` options against the same constraints as production's
 * `PluginToastOptionsSchema` (message length, type enum, durationMs bounds,
 * strict unknown-key rejection). Throws a parity-style aggregated error so a
 * plugin tested against the mock fails on a shape the real host would reject
 * (#10617).
 */
function validateToastOptions(opts: PluginToastOptions): void {
  const issues: string[] = [];
  // Production's schema is `.strict()` — unknown keys are rejected, not dropped.
  if (opts && typeof opts === "object") {
    for (const key of Object.keys(opts)) {
      if (!TOAST_OPTION_KEYS.has(key)) issues.push(`${key}: unrecognized option`);
    }
  }
  const message = opts?.message;
  if (typeof message !== "string" || message.trim().length < 1) {
    issues.push("message: must be a non-empty string");
  } else if (message.trim().length > 2000) {
    issues.push("message: must be at most 2000 characters");
  }
  if (opts?.type !== undefined && !MOCK_TOAST_TYPES.has(opts.type)) {
    issues.push("type: must be one of info, success, warning, error");
  }
  if (opts?.durationMs !== undefined) {
    const d = opts.durationMs;
    if (typeof d !== "number" || !Number.isInteger(d) || d <= 0 || d > 60_000) {
      issues.push("durationMs: must be a positive integer at most 60000");
    }
  }
  if (issues.length > 0) {
    throw new Error(`showToast: invalid options — ${issues.join("; ")}`);
  }
}

const NOTIFY_OPTION_KEYS = new Set([
  "title",
  "body",
  "severity",
  "delivery",
  "target",
  "actions",
  "os",
  "dedupeKey",
]);
const NOTIFY_SEVERITIES = new Set(["info", "warning", "error"]);
const NOTIFY_DELIVERIES = new Set(["active", "passive"]);
const NOTIFY_ACTION_KEYS = new Set(["id", "label", "actionId", "args"]);
const NOTIFY_ARGS_MAX_BYTES = 4096;

function isNotifyArgs(args: unknown): boolean {
  if (args === null || typeof args !== "object") return false;
  const proto: unknown = Object.getPrototypeOf(args);
  if (proto !== Object.prototype && proto !== null) return false;
  try {
    const json = JSON.stringify(args);
    return json !== undefined && new TextEncoder().encode(json).length <= NOTIFY_ARGS_MAX_BYTES;
  } catch {
    return false;
  }
}

/**
 * Validate `host.notify` options against the constraints production's
 * `PluginNotifyOptionsSchema` and namespace check apply (#13505), so a plugin
 * tested against the mock fails on a shape the real host would reject.
 */
function validateNotifyOptions(
  opts: PluginNotifyOptions,
  manifestId: string,
  capabilities: ReadonlySet<string>
): void {
  const issues: string[] = [];
  if (!opts || typeof opts !== "object") {
    throw new Error("notify: invalid options — (root): must be an object");
  }
  for (const key of Object.keys(opts)) {
    if (!NOTIFY_OPTION_KEYS.has(key)) issues.push(`${key}: unrecognized option`);
  }
  const text = (name: string, value: unknown, max: number) => {
    if (typeof value !== "string" || value.trim().length < 1) {
      issues.push(`${name}: must be a non-empty string`);
    } else if (value.trim().length > max) {
      issues.push(`${name}: must be at most ${max} characters`);
    }
  };
  text("title", opts.title, 200);
  text("body", opts.body, 2000);
  if (opts.actions !== undefined) {
    if (!Array.isArray(opts.actions)) {
      issues.push("actions: must be an array");
    } else {
      if (opts.actions.length > PLUGIN_NOTIFY_MAX_ACTIONS) {
        issues.push(`actions: at most ${PLUGIN_NOTIFY_MAX_ACTIONS} entries`);
      }
      const ids = new Set<string>();
      for (let i = 0; i < opts.actions.length; i++) {
        const action = opts.actions[i];
        if (!action || typeof action !== "object") {
          issues.push(`actions.${i}: must be an object`);
          continue;
        }
        for (const key of Object.keys(action)) {
          if (!NOTIFY_ACTION_KEYS.has(key)) issues.push(`actions.${i}.${key}: unrecognized option`);
        }
        text(`actions.${i}.id`, action.id, 64);
        text(`actions.${i}.label`, action.label, 40);
        if (typeof action.id === "string") {
          const id = action.id.trim();
          if (ids.has(id)) issues.push("actions: action ids must be unique");
          ids.add(id);
        }
        const actionId: unknown = action.actionId;
        if (
          typeof actionId !== "string" ||
          actionId.length > 200 ||
          !actionId.startsWith(`${manifestId}.`) ||
          actionId.length === manifestId.length + 1
        ) {
          issues.push(
            `actions.${i}.actionId: must be one of this plugin's own actions, written "${manifestId}.<id>"`
          );
        }
        if (action.args !== undefined && !isNotifyArgs(action.args)) {
          issues.push(
            `actions.${i}.args: must be a JSON-serializable object of at most ${NOTIFY_ARGS_MAX_BYTES} bytes`
          );
        }
      }
    }
  }
  if (opts.os !== undefined && typeof opts.os !== "boolean") issues.push("os: must be a boolean");
  if (opts.dedupeKey !== undefined) text("dedupeKey", opts.dedupeKey, 200);
  if (opts.severity !== undefined && !NOTIFY_SEVERITIES.has(opts.severity)) {
    issues.push('severity: must be "info", "warning" or "error"');
  }
  if (opts.delivery !== undefined && !NOTIFY_DELIVERIES.has(opts.delivery)) {
    issues.push('delivery: must be "active" or "passive"');
  }
  // Only the target's shape: whether the panel is the plugin's own and the
  // worktree one it can see is the real host's to check (#13818).
  if (opts.target !== undefined) {
    const target: unknown = opts.target;
    const keys = target && typeof target === "object" ? Object.keys(target) : [];
    const [key] = keys;
    const value = key ? (target as Record<string, unknown>)[key] : undefined;
    if (
      keys.length !== 1 ||
      (key !== "panelId" && key !== "worktreeId") ||
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > (key === "panelId" ? 256 : 4096)
    ) {
      issues.push("target: must be { panelId } or { worktreeId } with a non-empty string");
    }
  }
  if (opts.severity === "error" && (!Array.isArray(opts.actions) || opts.actions.length !== 1)) {
    issues.push('actions: an "error" notification needs exactly one action, the way out of it');
  }
  if (opts.delivery === "passive" && opts.severity === "error") {
    issues.push('delivery: an "error" notification can\'t be passive');
  }
  if (opts.delivery === "passive" && opts.os === true) {
    issues.push("os: a passive notification stays in the inbox and can't page the OS");
  }
  if (issues.length > 0) {
    throw new Error(`notify: invalid options — ${issues.join("; ")}`);
  }
  if (opts.os && !capabilities.has("notification:os")) {
    throw new Error(
      'PERMISSION_REQUIRED: notify with os: true requires "notification:os", which is not declared in manifest.capabilities'
    );
  }
}

/**
 * Validate a `setPanelBadge` badge against the same constraints as production's
 * `PluginPanelBadgeSchema` (discriminated on `kind`; label `text` rejected past
 * the length cap rather than truncated). `null` (clear) is handled at the call
 * site. Throws on an invalid shape (#10617).
 */
function validatePanelBadge(badge: PluginPanelBadge): void {
  if (!badge || typeof badge !== "object") {
    throw new Error("setPanelBadge: invalid badge — badge must be an object");
  }
  const color = (badge as { color?: unknown }).color;
  if (color !== undefined && !MOCK_BADGE_COLORS.has(color as string)) {
    throw new Error("setPanelBadge: invalid badge — color: must be a known badge color");
  }
  const tooltip = (badge as { tooltip?: unknown }).tooltip;
  if (
    tooltip !== undefined &&
    (typeof tooltip !== "string" || tooltip.trim().length < 1 || tooltip.trim().length > 200)
  ) {
    throw new Error(
      "setPanelBadge: invalid badge — tooltip: must be a non-empty string at most 200 characters"
    );
  }
  if (badge.kind === "dot") {
    rejectUnknownBadgeKeys(badge, BADGE_DOT_KEYS);
    return;
  }
  if (badge.kind === "label") {
    const text = (badge as { text?: unknown }).text;
    if (typeof text !== "string" || text.trim().length < 1) {
      throw new Error("setPanelBadge: invalid badge — text: must be a non-empty string");
    }
    if (text.trim().length > MOCK_PANEL_BADGE_LABEL_MAX) {
      throw new Error(
        `setPanelBadge: invalid badge — text: must be at most ${MOCK_PANEL_BADGE_LABEL_MAX} characters`
      );
    }
    rejectUnknownBadgeKeys(badge, BADGE_LABEL_KEYS);
    return;
  }
  throw new Error('setPanelBadge: invalid badge — kind: must be "dot" or "label"');
}

const TOOLBAR_STATE_BOOLEAN_KEYS = ["pressed", "disabled", "busy"] as const;
const TOOLBAR_STATE_TEXT_KEYS = ["disabledReason", "tooltip"] as const;
const TOOLBAR_STATE_KEYS: ReadonlySet<string> = new Set([
  ...TOOLBAR_STATE_BOOLEAN_KEYS,
  ...TOOLBAR_STATE_TEXT_KEYS,
  "iconId",
  "menu",
]);
/** Mirrors `PLUGIN_TOOLBAR_BUTTON_STATE_TEXT_MAX` in `shared/types/plugin.ts`. */
const MOCK_TOOLBAR_STATE_TEXT_MAX = 200;

/** Mirror production's `PluginToolbarButtonRuntimeStateSchema` (#13785). */
function validateToolbarButtonState(
  state: PluginToolbarButtonRuntimeState,
  manifestId: string,
  pluginId: string
): void {
  const fail = (message: string): never => {
    throw new Error(`setToolbarButtonState: invalid state — ${message}`);
  };
  if (!state || typeof state !== "object" || Array.isArray(state)) fail("state must be an object");
  for (const key of Object.keys(state)) {
    if (!TOOLBAR_STATE_KEYS.has(key)) fail(`${key}: unrecognized key`);
  }
  for (const key of TOOLBAR_STATE_BOOLEAN_KEYS) {
    const value = (state as Record<string, unknown>)[key];
    if (value !== undefined && typeof value !== "boolean") fail(`${key}: must be a boolean`);
  }
  for (const key of TOOLBAR_STATE_TEXT_KEYS) {
    const value = (state as Record<string, unknown>)[key];
    if (
      value !== undefined &&
      (typeof value !== "string" ||
        value.trim().length < 1 ||
        value.trim().length > MOCK_TOOLBAR_STATE_TEXT_MAX)
    ) {
      fail(`${key}: must be a non-empty string at most ${MOCK_TOOLBAR_STATE_TEXT_MAX} characters`);
    }
  }
  const iconId = (state as { iconId?: unknown }).iconId;
  if (
    iconId !== undefined &&
    (typeof iconId !== "string" || iconId.length < 1 || iconId.length > 256)
  ) {
    fail("iconId: must be a non-empty string at most 256 characters");
  }
  if (state.menu !== undefined) {
    if (!Array.isArray(state.menu)) fail("menu: must be an array");
    // Production's strict item schema: only `actionId` and a 1 to 80 character label.
    for (const item of state.menu) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
      for (const key of Object.keys(item)) {
        if (key !== "actionId" && key !== "label") fail(`menu: ${key}: unrecognized key`);
      }
      const label = (item as { label?: unknown }).label;
      if (
        label !== undefined &&
        (typeof label !== "string" || label.trim().length < 1 || label.trim().length > 80)
      ) {
        fail("menu: label: must be a non-empty string at most 80 characters");
      }
    }
    // The host's own vetting, so a menu it refuses rejects here too.
    const menu = normalizePanelMenuItems(state.menu, manifestId, pluginId);
    if (!menu.ok) fail(`menu: ${menu.error}`);
  }
  if (state.disabled === true && state.disabledReason === undefined) {
    fail("disabledReason: a disabled button needs a disabledReason");
  }
  if (state.disabled !== true && state.disabledReason !== undefined) {
    fail("disabledReason: disabledReason is only valid with disabled: true");
  }
}

/** Production badge schemas are `.strict()`: reject any key outside the variant's set. */
function rejectUnknownBadgeKeys(badge: object, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(badge)) {
    if (!allowed.has(key)) {
      throw new Error(`setPanelBadge: invalid badge — ${key}: unrecognized key`);
    }
  }
}

/**
 * Mirror production's `validateQuickPickItems`: items must be an array of objects
 * with a non-empty string `id` (unique) and a string `label`. Returns the
 * normalized items. Throws on a violation (#10617).
 */
function validateQuickPickItems(items: PluginQuickPickItem[]): PluginQuickPickItem[] {
  if (!Array.isArray(items)) {
    throw new Error("showQuickPick: items must be an array");
  }
  const seen = new Set<string>();
  return items.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`showQuickPick: items[${index}] must be an object`);
    }
    if (typeof item.id !== "string" || item.id.length === 0) {
      throw new Error(`showQuickPick: items[${index}].id must be a non-empty string`);
    }
    if (typeof item.label !== "string") {
      throw new Error(`showQuickPick: items[${index}].label must be a string`);
    }
    if (seen.has(item.id)) {
      throw new Error(`showQuickPick: duplicate item id "${item.id}" (ids must be unique)`);
    }
    seen.add(item.id);
    return {
      id: item.id,
      label: item.label,
      ...(item.description !== undefined ? { description: String(item.description) } : {}),
      ...(item.detail !== undefined ? { detail: String(item.detail) } : {}),
    };
  });
}

/** One `host.fs.watch` registration in the mock. */
interface MockFsWatcher {
  readonly paths: string[];
  readonly callback: (changedPath: string) => void;
  readonly recursive: boolean;
  readonly debounceMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  pending: string | null;
}

/** Refuse a registerHandler/postToPanel/broadcastToRenderer channel the way production does. */
function isInvalidChannel(channel: unknown, allowEmpty: boolean): boolean {
  if (typeof channel !== "string") return true;
  if (!allowEmpty && channel.length === 0) return true;
  return channel.includes(":");
}

/**
 * The revision the mock reports for a text: sha256 hex of its UTF-8 bytes,
 * the same shape the real host returns, so a plugin can hand it straight back
 * as `expectedRevision`.
 */
/**
 * The host's subscription-window rule (electron/services/plugin/
 * pluginSubscriptionCoalescing.ts), duplicated rather than imported so the SDK
 * bundle never pulls a main-process module. Pinned against it by a parity test.
 */
const MOCK_SUBSCRIPTION_MIN_DEBOUNCE_MS = 50;
const MOCK_SUBSCRIPTION_MAX_DEBOUNCE_MS = 60_000;
function mockResolveSubscriptionDebounceMs(
  value: unknown,
  defaultMs: number = PLUGIN_SUBSCRIPTION_DEFAULT_DEBOUNCE_MS
): number {
  // Every call site passes `value` explicitly, never via `Array#map`.
  if (typeof value !== "number" || Number.isNaN(value)) {
    return defaultMs;
  }
  if (value <= 0) return 0;
  return Math.min(
    Math.max(value, MOCK_SUBSCRIPTION_MIN_DEBOUNCE_MS),
    MOCK_SUBSCRIPTION_MAX_DEBOUNCE_MS
  );
}

/** The host's worktree fingerprint, duplicated for the same reason and pinned the same way. */
function mockWorktreeFingerprint(snapshot: PluginWorktreeSnapshot): string {
  const status = snapshot.status;
  const setup = snapshot.setup;
  return JSON.stringify([
    snapshot.worktreeId,
    snapshot.path,
    snapshot.name,
    snapshot.customTitle ?? null,
    snapshot.isCurrent,
    snapshot.branch ?? null,
    snapshot.isMainWorktree ?? null,
    snapshot.aheadCount ?? null,
    snapshot.behindCount ?? null,
    snapshot.mood ?? null,
    snapshot.lastActivityTimestamp ?? null,
    snapshot.createdAt ?? null,
    snapshot.linked,
    status === null
      ? null
      : [
          status.changedFileCount,
          status.counts,
          status.files.map((file) => `${file.state}\u0000${file.path}`),
        ],
    snapshot.headOid ?? null,
    snapshot.gitOperation ?? null,
    setup == null ? null : [setup.state, setup.stage ?? null],
  ]);
}

/** One subscriber's view of the worktree set: what it was last handed. */
function mockWorktreeChange(
  previous: Map<string, string>,
  snapshots: readonly PluginWorktreeSnapshot[]
): { change: PluginWorktreesChange; current: Map<string, string> } {
  const current = new Map<string, string>();
  const added: string[] = [];
  const changed: string[] = [];
  for (const snapshot of snapshots) {
    if (current.has(snapshot.id)) continue;
    const fingerprint = mockWorktreeFingerprint(snapshot);
    current.set(snapshot.id, fingerprint);
    const before = previous.get(snapshot.id);
    if (before === undefined) added.push(snapshot.id);
    else if (before !== fingerprint) changed.push(snapshot.id);
  }
  const removed = [...previous.keys()].filter((id) => !current.has(id));
  return {
    change: Object.freeze({
      added: Object.freeze(added),
      removed: Object.freeze(removed),
      changed: Object.freeze(changed),
    }),
    current,
  };
}

/** The host's `fs.walk` bounds (electron/services/plugin/pluginFsWalk.ts). */
const MOCK_WALK_DEFAULT_LIMIT = 10_000;
const MOCK_WALK_MAX_LIMIT = 50_000;
const MOCK_WALK_MAX_DEPTH = 64;
const MOCK_WALK_MAX_PATTERNS = 64;

/** The host's walk ordering: by path, with `/` before every other character. */
function compareWalkPaths(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca === cb) continue;
    if (ca === 47) return -1;
    if (cb === 47) return 1;
    return ca - cb;
  }
  return a.length - b.length;
}

/** The host's `fs.readFiles` bounds (electron/services/plugin/pluginFsReadFiles.ts). */
const MOCK_READ_FILES_MAX_PATHS = 1024;
const MOCK_READ_FILES_MAX_TOTAL_BYTES = PLUGIN_INVOKE_MAX_RESULT_BYTES / 2;

function mockRevision(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function fsWriteError(code: string, message: string): Error & { code: string } {
  const error = new Error(`${code}: ${message}`) as Error & { code: string };
  error.code = code;
  return error;
}

const MOCK_ARTIFACT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export function createMockHost(options: CreateMockHostOptions = {}): PluginHostApi & MockHostState {
  const pluginId = options.pluginId ?? "test.mock";
  let activeWorktree: PluginWorktreeSnapshot | null = options.activeWorktree ?? null;
  let worktrees: PluginWorktreeSnapshot[] = options.worktrees ?? [];
  let worktreesResult: PluginWorktreesResult | null = options.worktreesResult ?? null;

  const registeredActions: RegisteredActionRecord[] = [];
  const registeredHandlers: RegisteredHandlerRecord[] = [];
  const broadcastCalls: BroadcastRecord[] = [];
  const postToPanelCalls: PostToPanelRecord[] = [];
  const shownToasts: ShownToastRecord[] = [];
  const notifications: NotificationRecord[] = [];
  const dispatchedActions: DispatchedActionRecord[] = [];
  const sentToActiveAgentCalls: SentToActiveAgentRecord[] = [];
  const sentToAgentCalls: SentToAgentRecord[] = [];
  const runRecipeCalls: RunRecipeRecord[] = [];
  let runRecipeResult: PluginRunRecipeResult = { status: "cancelled" };
  let agentPanes: PluginAgentPane[] = options.agents ?? [];
  let allAgentsSnapshot: PluginAllAgentsSnapshot = normalizePluginAllAgentsSnapshot(
    options.allAgents ?? { agents: [], degraded: false, lastSuccessfulAt: 0 }
  );
  const allAgentsSubs = new Set<(snapshot: PluginAllAgentsSnapshot) => void>();
  let focusedPanel: PluginFocusedPanel = toPluginFocusedPanel(options.focusedPanel);
  const focusedPanelSubs = new Set<(focus: PluginFocusedPanel) => void>();
  let sendToAgentPick: string | null = null;
  const readScreenCalls: ReadScreenRecord[] = [];
  const agentInputCalls: AgentInputRecord[] = [];
  const launchedAgents = new Set<string>();
  const terminalScreens = new Map<string, PluginTerminalScreenResult>(
    Object.entries(options.terminalScreens ?? {})
  );
  const registeredForgeProviders: RegisteredForgeProviderRecord[] = [];
  const registeredFileDecorationProviders: RegisteredFileDecorationProviderRecord[] = [];
  const registeredWorktreeSetupSteps: RegisteredWorktreeSetupStepRecord[] = [];
  const registeredSearchProviders: RegisteredSearchProviderRecord[] = [];
  const registeredContextProviders: RegisteredContextProviderRecord[] = [];
  const registeredWorktreeDeleteNotesProviders: RegisteredWorktreeDeleteNotesProviderRecord[] = [];
  const registeredMcpTools: RegisteredMcpToolsRecord[] = [];
  const invalidationCalls: InvalidationRecord[] = [];
  const setPanelBadgeCalls: SetPanelBadgeRecord[] = [];
  const setToolbarButtonBadgeCalls: SetToolbarButtonBadgeRecord[] = [];
  const setToolbarButtonStateCalls: SetToolbarButtonStateRecord[] = [];
  const setContextCalls: SetContextRecord[] = [];
  const contextKeys = new Map<string, PluginContextValue>();
  const setWorktreeCardStatusCalls: SetWorktreeCardStatusRecord[] = [];
  const worktreeCardStatuses = new Map<string, PluginWorktreeCardStatus>();
  const setWorktreeReviewChecksCalls: SetWorktreeReviewChecksRecord[] = [];
  const worktreeReviewChecks = new Map<string, readonly PluginWorktreeReviewCheck[]>();
  const setTerminalStatusCalls: SetTerminalStatusRecord[] = [];
  const terminalStatuses = new Map<string, PluginTerminalStatus>();
  const setPanelActivityCalls: SetPanelActivityRecord[] = [];
  const tasks: MockTaskRecord[] = [];
  const taskControllers = new Map<string, AbortController>();
  const panelActivity = new Map<string, PluginPanelActivity>();
  const setPanelMenuItemsCalls: SetPanelMenuItemsRecord[] = [];
  const reloadPanelCalls: string[] = [];
  const restartWorkerCalls: WorkerRestartResult[] = [];
  /** Latest simulated lifecycle event per panel id, for `reloadPanel`. */
  const panelPhases = new Map<string, PluginPanelLifecycleEvent>();
  const showQuickPickCalls: ShowQuickPickRecord[] = [];
  const showInputBoxCalls: ShowInputBoxRecord[] = [];
  const showConfirmCalls: ShowConfirmRecord[] = [];
  const spawnCalls: SpawnRecord[] = [];
  const fsFiles = new Map<string, string>();
  const fsWriteCalls: FsWriteRecord[] = [];
  const fsAppendCalls: FsWriteRecord[] = [];
  const fsMkdirCalls: string[] = [];
  // Directories made through `mkdir`; directories implied by a written file's
  // path are derived from `fsFiles` instead, as before.
  const fsDirs = new Set<string>();
  const gitCommitCalls: GitCommitRecord[] = [];
  const clipboardWriteCalls: string[] = [];
  const clipboardWriteImageCalls: number[] = [];
  const systemOpenPathCalls: string[] = [];
  const systemShowItemCalls: string[] = [];
  const systemOpenExternalCalls: string[] = [];
  const documentsRenderPdfCalls: PluginRenderPdfOptions[] = [];
  const artifacts = new Map<string, PluginArtifact>();
  const artifactUploadCalls: { artifactId: string; url: string; method: "PUT" | "POST" }[] = [];
  let artifactSeq = 0;
  const mockArtifact = (
    origin: PluginArtifact["origin"],
    rawName: string,
    size: number,
    artifactOptions?: { projectId?: string; mimeType?: string; ttlMs?: number }
  ): PluginArtifact => {
    // As the real host does: a project plugin's artifacts are its project's,
    // and it can't name another.
    if (
      mockProjectId !== null &&
      artifactOptions?.projectId !== undefined &&
      artifactOptions.projectId !== mockProjectId
    ) {
      throw new Error(
        "VALIDATION: mock artifacts: a project plugin's artifacts belong to its own project"
      );
    }
    const name = rawName.split(/[\\/]/).pop() || "artifact";
    const ext = name.toLowerCase().split(".").pop() ?? "";
    const createdAt = Date.now();
    const artifact: PluginArtifact = {
      id: (++artifactSeq).toString(16).padStart(32, "0"),
      projectId: artifactOptions?.projectId ?? mockProjectId,
      name,
      mimeType: artifactOptions?.mimeType ?? MOCK_ARTIFACT_TYPES[ext] ?? "application/octet-stream",
      size,
      createdAt,
      expiresAt: createdAt + (artifactOptions?.ttlMs ?? 24 * 60 * 60 * 1000),
      origin,
    };
    artifacts.set(artifact.id, artifact);
    return artifact;
  };
  let clipboardText = "";

  const activeWorktreeSubs = new Set<(snapshot: PluginWorktreeSnapshot | null) => void>();
  // Each subscriber keeps the fingerprints it was last handed, so its change
  // argument is computed against its own history, as the host does.
  const worktreesSubs = new Map<
    (snapshots: PluginWorktreeSnapshot[], change: PluginWorktreesChange) => void,
    { previous: Map<string, string> }
  >();
  const subscriptionOptions: MockSubscriptionRecord[] = [];

  let lastAgentSnapshot: PluginAgentSnapshot | null = null;
  const agentStateSubs = new Set<(snapshot: PluginAgentSnapshot) => void>();
  const terminalLifecycleSubs = new Set<(event: PluginTerminalLifecycleEvent) => void>();
  const panelLifecycleSubs = new Set<(event: PluginPanelLifecycleEvent) => void>();
  const systemWakeSubs = new Set<(event: PluginSystemWakeEvent) => void>();
  const accountSubs = new Set<(state: PluginAccountState) => unknown>();
  let accountToken: PluginAccountAccessToken | null = options.account?.accessToken
    ? { accessToken: options.account.accessToken, expiresAt: options.account.expiresAt ?? null }
    : null;
  let accountIdentity: string | null = accountToken ? (options.account?.identity ?? null) : null;
  /** Channels a test marked as having no listener; every other channel has one. */
  const unlistenedChannels = new Set<string>();
  const listenerSubs = new Map<string, Set<(hasListeners: boolean) => void>>();
  const assertListenerChannel = (method: string, channel: unknown): string => {
    if (isInvalidChannel(channel, false)) {
      throw new Error(
        `${method}: channel must be a non-empty string without colons: ${String(channel)}`
      );
    }
    return channel as string;
  };

  // Capability gating + active-agent presence for the agent APIs (#10617).
  // Default permissive so manifest-free tests are unaffected; restrict to assert
  // the PERMISSION_REQUIRED / NO_ACTIVE_AGENT rejections production enforces.
  const capabilities = new Set<string>(options.capabilities ?? ["agent:read", "agent:input"]);
  const hasActiveAgent = options.hasActiveAgent ?? true;

  // Configurable answers for the imperative UI prompts. Default to the dismiss
  // value (cancel) a user produces; `simulate*Response` overrides per test.
  let quickPickResponse: PluginQuickPickItem | PluginQuickPickItem[] | undefined;
  let inputBoxResponse: string | undefined;
  let confirmResponse = false;

  const settingsStore: Record<PluginSettingsScope, Map<string, unknown>> = {
    user: new Map(Object.entries(options.settings?.user ?? {})),
    project: new Map(Object.entries(options.settings?.project ?? {})),
    local: new Map(Object.entries(options.settings?.local ?? {})),
  };

  const settingsSubs: Record<PluginSettingsScope, Map<string, Set<(value: unknown) => void>>> = {
    user: new Map(),
    project: new Map(),
    local: new Map(),
  };

  // `user`/`project` scopes are flat maps; `worktree` scope is isolated per
  // active worktree path (#10578). Production resolves a different storage file
  // per worktree, so a value written under worktree A is invisible after
  // `simulateActiveWorktreeChange(B)`. The sub-map is created lazily on first
  // write; the read path returns `undefined` for an unseen worktree.
  const userProjectStore: Record<"user" | "project", Map<string, unknown>> = {
    user: new Map(Object.entries(options.storage?.user ?? {})),
    project: new Map(Object.entries(options.storage?.project ?? {})),
  };
  const worktreeStorageByPath = new Map<string, Map<string, unknown>>();
  // Seed the worktree scope into the initial active worktree's sub-map. With no
  // active worktree there is no target (production would throw on `set`), so the
  // seed is silently dropped rather than placed in an anonymous map.
  if (activeWorktree && options.storage?.worktree) {
    worktreeStorageByPath.set(
      activeWorktree.path,
      new Map(Object.entries(options.storage.worktree))
    );
  }
  /** The storage sub-map for the active worktree, created on demand. */
  const worktreeStore = (): Map<string, unknown> | null => {
    if (!activeWorktree) return null;
    let store = worktreeStorageByPath.get(activeWorktree.path);
    if (!store) {
      store = new Map();
      worktreeStorageByPath.set(activeWorktree.path, store);
    }
    return store;
  };

  // Subscriptions stay keyed by storage key (not worktree path) for every
  // scope, matching production: a worktree-scope `onDidChange` survives a
  // worktree switch and then fires for the now-active worktree's value.
  const storageSubs: Record<PluginStorageScope, Map<string, Set<(value: unknown) => void>>> = {
    user: new Map(),
    project: new Map(),
    worktree: new Map(),
  };

  const dispatchOverrides = new Map<ActionId, ActionDispatchResult>();
  const actionCatalog = new Map<string, PluginActionManifestEntry>();
  // Active `host.fs.watch` registrations; a watcher's disposer removes its
  // record, and `simulateFsWatch` fires each one's callback.
  const fsWatchers = new Set<MockFsWatcher>();

  const parentOf = (target: string): string => {
    const slash = Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\"));
    return slash <= 0 ? "/" : target.slice(0, slash);
  };
  const trimDir = (dir: string): string =>
    dir.length > 1 && dir.endsWith("/") ? dir.slice(0, -1) : dir;
  // A directory exists when `mkdir` made it, when a stored file or directory
  // sits beneath it, or when it is (or contains) a worktree the mock was given.
  // A path holding a file is never a directory.
  const mockDirExists = (dir: string): boolean => {
    if (dir === "/") return true;
    if (fsFiles.has(dir)) return false;
    if (fsDirs.has(dir)) return true;
    const prefix = `${dir}/`;
    for (const key of fsFiles.keys()) if (key.startsWith(prefix)) return true;
    for (const made of fsDirs) if (made.startsWith(prefix)) return true;
    const roots = [activeWorktree?.path, ...worktrees.map((w) => w.path)];
    return roots.some((root) => root !== undefined && (root === dir || root.startsWith(prefix)));
  };
  // Every ancestor of `dir`, outermost first, then `dir` itself; "/" excluded.
  const dirChain = (dir: string): string[] => {
    const chain: string[] = [];
    for (let current = trimDir(dir); current !== "/"; current = parentOf(current)) {
      chain.unshift(current);
    }
    return chain;
  };
  // The host's implicit per-plugin data dir grows missing parents for a write
  // inside it — and only inside it, so the match is anchored at the root, not
  // found anywhere in the path. Separators are compared as "/" so a Windows
  // root matches either spelling.
  const toSlashes = (target: string): string => target.replace(/\\/g, "/");
  const mockDataDir = trimDir(
    toSlashes(options.pluginDataDir ?? joinPath(homedir(), ".daintree", "plugin-data", pluginId))
  );
  const isMockDataDirPath = (target: string): boolean =>
    toSlashes(target).startsWith(`${mockDataDir}/`);
  // A path is a file or a directory, never both. The host refuses a regular
  // file standing where a directory chain it grows must go: TARGET_EXISTS at
  // the directory it was asked for (or the data dir it bootstraps), and the
  // lookup's own ENOTDIR for anything beneath a file.
  const refuseFileInChain = (dir: string): void => {
    const blocked = dirChain(dir).find((candidate) => fsFiles.has(candidate));
    if (blocked === undefined) return;
    const atTarget = blocked === trimDir(dir) || toSlashes(blocked) === mockDataDir;
    throw fsWriteError(
      atTarget ? "TARGET_EXISTS" : "ENOTDIR",
      `mock fs: "${blocked}" is a file, not a directory`
    );
  };
  // Outside the data dir nothing is grown, and a file among the ancestors
  // fails the host's own lookup of the leaf.
  const refuseFileAncestor = (target: string): void => {
    const blocked = dirChain(parentOf(target)).find((candidate) => fsFiles.has(candidate));
    if (blocked !== undefined) {
      throw fsWriteError("ENOTDIR", `mock fs: "${blocked}" is a file, not a directory`);
    }
  };

  // Resolve the declared scope for a key from the opt-in `manifestSettings`,
  // mirroring PluginSettingsManager.getDeclaredScope. Returns undefined when no
  // declarations are provided (loose mode) or the key is undeclared.
  const getDeclaredSettingScope = (key: string): PluginSettingsScope | undefined => {
    const def = options.manifestSettings?.find((s) => s.id === key);
    return def ? ((def.scope ?? "user") as PluginSettingsScope) : undefined;
  };

  // The scope a call targets: the declared one when omitted; a conflicting
  // explicit scope throws, as the real host's write and subscribe guards do.
  const resolveSettingScope = (
    method: string,
    key: string,
    requested: PluginSettingsScope | undefined
  ): PluginSettingsScope => {
    const declared = getDeclaredSettingScope(key);
    if (requested !== undefined && declared !== undefined && requested !== declared) {
      throw new Error(
        `settings.${method}: key "${key}" is declared in "${declared}" scope, not "${requested}"`
      );
    }
    return requested ?? declared ?? "user";
  };

  const getDeclaredSettingDefault = (key: string): unknown => {
    const declared = options.manifestSettings?.find((s) => s.id === key)?.default;
    return declared === undefined ? undefined : (JSON.parse(JSON.stringify(declared)) as unknown);
  };

  const settings: SettingsApi = {
    async get<T = unknown>(key: string, scope?: PluginSettingsScope): Promise<T | undefined> {
      // Manifest-aware mode: a declared key resolves to its declared scope, and an
      // explicit conflicting scope throws — matching the real host (#10586). Loose
      // mode (no manifestSettings) keeps the `scope ?? "user"` default.
      const declaredScope = getDeclaredSettingScope(key);
      if (scope !== undefined && declaredScope !== undefined && declaredScope !== scope) {
        throw new Error(
          `settings.get: key "${key}" is declared in "${declaredScope}" scope, not "${scope}"`
        );
      }
      const effectiveScope = declaredScope ?? scope ?? "user";
      const stored = settingsStore[effectiveScope].get(key);
      return (stored !== undefined ? stored : getDeclaredSettingDefault(key)) as T | undefined;
    },
    async set<T = unknown>(
      key: string,
      value: T,
      requestedScope?: PluginSettingsScope
    ): Promise<void> {
      const scope = resolveSettingScope("set", key, requestedScope);
      if (value === undefined) {
        throw new Error("settings.set: value cannot be undefined");
      }
      const prev = settingsStore[scope].get(key);
      settingsStore[scope].set(key, value);
      if (!Object.is(prev, value)) {
        const subs = settingsSubs[scope].get(key);
        if (subs) {
          for (const cb of subs) cb(value as unknown);
        }
      }
    },
    onDidChange<T = unknown>(
      key: string,
      callback: (value: T | undefined) => void,
      requestedScope?: PluginSettingsScope
    ): Promise<() => void> {
      const scope = resolveSettingScope("onDidChange", key, requestedScope);
      let subs = settingsSubs[scope].get(key);
      if (!subs) {
        subs = new Set();
        settingsSubs[scope].set(key, subs);
      }
      const cb = callback as (value: unknown) => void;
      subs.add(cb);
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        const set = settingsSubs[scope].get(key);
        if (set) {
          set.delete(cb);
          if (set.size === 0) settingsSubs[scope].delete(key);
        }
      };
      return Promise.resolve(dispose);
    },
    // Recorded as the dispatch the real host sends, so a test asserts it the
    // same way it asserts any other `host.dispatch`.
    async open(key?: string): Promise<void> {
      if (key !== undefined && (typeof key !== "string" || key.length === 0)) {
        throw new Error("settings.open: key must be a non-empty string when given");
      }
      dispatchedActions.push({
        actionId: "plugin.openSettings",
        args: key === undefined ? { pluginId } : { pluginId, key },
      });
    },
    // Declared keys only, as the real host: the declared scope is the target,
    // and subscribers hear the declared default when something was removed.
    async unset(key: string, requestedScope?: PluginSettingsScope): Promise<void> {
      const declaredScope = getDeclaredSettingScope(key);
      if (declaredScope === undefined) {
        throw new Error(`settings.unset: key "${key}" is not declared in contributes.settings`);
      }
      if (requestedScope !== undefined && requestedScope !== declaredScope) {
        throw new Error(
          `settings.unset: key "${key}" is declared in "${declaredScope}" scope, not "${requestedScope}"`
        );
      }
      if (!settingsStore[declaredScope].delete(key)) return;
      const subs = settingsSubs[declaredScope].get(key);
      if (subs) {
        // As the real host: one throwing listener does not hide the rest or fail the clear.
        for (const cb of subs) {
          try {
            cb(getDeclaredSettingDefault(key));
          } catch {
            /* isolated */
          }
        }
      }
    },
    // Manifest-aware only: with no `manifestSettings` nothing is declared, so
    // nothing can be required. A default never satisfies a required key.
    async missingRequired(): Promise<string[]> {
      return (options.manifestSettings ?? [])
        .filter((def) => def.required === true)
        .filter((def) => {
          const store = settingsStore[(def.scope ?? "user") as PluginSettingsScope];
          // As the real host: a secret is set once anything is stored — it is
          // never decrypted to look — while other values must be non-empty.
          if (def.type === "secret" || def.secret === true) return !store.has(def.id);
          const value = store.get(def.id);
          return value === undefined || value === null || value === "";
        })
        .map((def) => def.id);
    },
  };

  // Private machine-owned storage (#10556). Mirrors the settings mock but adds
  // the "worktree" scope and a `delete` method, and never gates on declared keys.
  // The "worktree" scope resolves its target from the current active worktree
  // (#10578): set with no active worktree throws (matching production's "no
  // active worktree" guard), get resolves undefined, and delete no-ops.
  const storage: StorageApi = {
    async get<T = unknown>(
      key: string,
      scope: PluginStorageScope = "user"
    ): Promise<T | undefined> {
      const store = scope === "worktree" ? worktreeStore() : userProjectStore[scope];
      // No active worktree resolves to undefined rather than throwing, matching
      // production's "unset key" return.
      if (!store) return undefined;
      return store.get(key) as T | undefined;
    },
    async set<T = unknown>(
      key: string,
      value: T,
      scope: PluginStorageScope = "user"
    ): Promise<void> {
      if (value === undefined) {
        throw new Error("storage.set: value cannot be undefined");
      }
      const store = scope === "worktree" ? worktreeStore() : userProjectStore[scope];
      if (!store) {
        // worktree scope with no active worktree — mirror production's message.
        throw new Error(
          `Plugin "${pluginId}" storage.set: no active ${scope} — "${scope}" scope has no target`
        );
      }
      const prev = store.get(key);
      const had = store.has(key);
      store.set(key, value);
      // Mirror the real store's `valuesEqual` (JSON) change detection rather than
      // `Object.is`, so two equal-but-distinct object literals fire onDidChange
      // exactly once — matching production, not reference identity.
      const changed = !had || !jsonEqual(prev, value);
      if (changed) {
        const subs = storageSubs[scope].get(key);
        if (subs) {
          for (const cb of subs) cb(value as unknown);
        }
      }
    },
    async delete(key: string, scope: PluginStorageScope = "user"): Promise<void> {
      const store = scope === "worktree" ? worktreeStore() : userProjectStore[scope];
      // No active worktree — a delete is a no-op rather than a throw (matching
      // production and the "already absent" return of the store).
      if (!store) return;
      const had = store.has(key);
      store.delete(key);
      if (had) {
        const subs = storageSubs[scope].get(key);
        if (subs) {
          for (const cb of subs) cb(undefined);
        }
      }
    },
    onDidChange<T = unknown>(
      key: string,
      callback: (value: T | undefined) => void,
      scope: PluginStorageScope = "user"
    ): Promise<() => void> {
      let subs = storageSubs[scope].get(key);
      if (!subs) {
        subs = new Set();
        storageSubs[scope].set(key, subs);
      }
      const cb = callback as (value: unknown) => void;
      subs.add(cb);
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        const set = storageSubs[scope].get(key);
        if (set) {
          set.delete(cb);
          if (set.size === 0) storageSubs[scope].delete(key);
        }
      };
      return Promise.resolve(dispose);
    },
  };

  // Identity mirrors the real host: derived from the id via the canonical
  // parser, so a mock built with a project instance key answers exactly as
  // production does.
  const mockManifestId = pluginManifestIdFromInstanceKey(pluginId);
  const mockProjectId = projectIdFromPluginInstanceKey(pluginId);
  // `projectRoot` is null iff `projectId` is — a mock that claimed a project
  // with no root would hand plugin authors a shape production never produces.
  const mockProjectRoot =
    mockProjectId === null ? null : (options.projectRoot ?? `/projects/${mockProjectId}`);
  const pluginInfo: PluginIdentity = Object.freeze({
    instanceId: pluginId,
    manifestId: mockManifestId,
    origin: mockProjectId === null ? ("global" as const) : ("project" as const),
    projectId: mockProjectId,
    projectRoot: mockProjectRoot,
  });
  const projectPresence = new Map<string, PluginProjectPresenceState>();
  for (const entry of options.projectPresence ??
    (mockProjectId === null ? [] : [{ projectId: mockProjectId, state: "foreground" as const }])) {
    const open = toPluginProjectPresence(entry);
    if (open && open.state !== "closed") projectPresence.set(open.projectId, open.state);
  }
  const projectPresenceSubs = new Set<(presence: PluginProjectPresence) => void>();

  // Same gates as production: `agent:read`, and never for a project plugin.
  const assertMockCanReadAllAgents = (method: string): void => {
    if (!capabilities.has("agent:read")) {
      throw new Error(
        `PERMISSION_REQUIRED: ${method} requires "agent:read", which is not declared in manifest.capabilities`
      );
    }
    if (mockProjectId !== null) {
      throw new Error(
        `PERMISSION_REQUIRED: ${method} lists agents in every project, which is not available to a project plugin`
      );
    }
  };
  const assertMockAgentInput = (op: string, terminalId: unknown): void => {
    if (!capabilities.has("agent:input")) {
      throw new Error(
        `PERMISSION_REQUIRED: agents.${op} requires "agent:input", which is not declared in manifest.capabilities`
      );
    }
    // Same bound as production's `SEND_TO_AGENT_MAX_ID_LENGTH`.
    if (typeof terminalId !== "string" || terminalId.length === 0 || terminalId.length > 512) {
      throw new Error(
        `agents.${op}: terminalId must be a non-empty string of at most 512 characters`
      );
    }
  };
  // The agent this plugin's own `agent.launch` started, as production records
  // it: never one whose panel id the launch named itself.
  const recordMockLaunch = (
    actionId: ActionId,
    args: unknown,
    result: ActionDispatchResult
  ): ActionDispatchResult => {
    const launch = result.ok
      ? (result.result as { launched?: unknown; terminalId?: unknown } | null)
      : null;
    if (
      actionId === "agent.launch" &&
      !(args !== null && typeof args === "object" && "requestedId" in args) &&
      launch?.launched === true &&
      typeof launch.terminalId === "string" &&
      launch.terminalId.length > 0
    ) {
      launchedAgents.add(launch.terminalId);
    }
    return result;
  };

  let mockDatabaseDir: string | null = options.databases?.directory ?? null;
  const resolveMockDatabase = async (
    id: string,
    readonly = false
  ): Promise<PluginDatabaseLocation> => {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`Plugin "${pluginId}" db: id must be a non-empty string`);
    }
    const declared = options.databases?.declared;
    if (declared && !declared.includes(id)) {
      throw new Error(
        `DB_NOT_DECLARED: plugin "${pluginId}" db: "${id}" is not declared in contributes.databases`
      );
    }
    // Readonly locates an existing file and creates nothing, as the host does.
    const notFound = () => databaseError("DB_NOT_FOUND", `database "${id}" does not exist yet`);
    if (readonly && mockDatabaseDir === null) throw notFound();
    mockDatabaseDir ??= mkdtempSync(path.join(tmpdir(), "daintree-mock-db-"));
    if (!readonly) mkdirSync(mockDatabaseDir, { recursive: true });
    // Canonical, as the host's is: a directory swapped for a link after the
    // handle opened resolves elsewhere, and the handle then refuses to reopen.
    let realDir: string;
    try {
      realDir = realpathSync(mockDatabaseDir);
    } catch (error) {
      if (readonly && (error as NodeJS.ErrnoException).code === "ENOENT") throw notFound();
      throw error;
    }
    const target = path.join(realDir, `${id}.db`);
    const leaf = lstatSync(target, { throwIfNoEntry: false });
    if (leaf?.isSymbolicLink()) {
      throw databaseError("TARGET_IS_SYMLINK", `database "${id}" file is a symlink`);
    }
    if (leaf && !leaf.isFile()) {
      throw databaseError("TARGET_UNAVAILABLE", `database "${id}" is not a regular file`);
    }
    if (!leaf && readonly) throw notFound();
    return Object.freeze({
      id,
      location: "local" as const,
      path: target,
      projectRelativePath: null,
      journalMode: options.databases?.journalMode ?? "delete",
    });
  };

  const host: PluginHostApi & MockHostState = {
    pluginId,
    pluginInfo,
    db: {
      resolve: (id, resolveOptions) => resolveMockDatabase(id, resolveOptions?.readonly === true),
      open: async (id, openOptions) =>
        openPluginDatabase(await resolveMockDatabase(id, openOptions?.readonly === true), {
          ...openOptions,
          revalidate: () => resolveMockDatabase(id, openOptions?.readonly === true),
          // The mock has no fs gate; it approves any absolute destination.
          prepareBackup: async (destPath) => {
            if (!path.isAbsolute(destPath)) {
              throw new Error(`Plugin "${pluginId}" db.backup: destination must be absolute`);
            }
            // The real host returns the realpath form, which the handle checks.
            return path.join(realpathSync(path.dirname(destPath)), path.basename(destPath));
          },
        }),
    },
    panelKindId(bareId: string) {
      if (typeof bareId !== "string" || bareId.length === 0) {
        throw new Error(`Plugin "${pluginId}" panelKindId: bareId must be a non-empty string`);
      }
      const qualified = toRuntimePanelKindId(
        { origin: pluginInfo.origin, pluginId: mockManifestId, kindId: bareId },
        mockProjectId
      );
      if (qualified === null) {
        throw new Error(
          `Plugin "${pluginId}" panelKindId: cannot qualify panel kind "${bareId}" for this plugin`
        );
      }
      return qualified;
    },
    registerAction(descriptor, handler) {
      // Mirrors PluginService.createHost L1577-L1631. Validation order matches
      // production: non-object descriptor, non-function handler, non-empty
      // string id, plugin-prefix not already in id, then the
      // validateAndBuildActionDescriptor checks (L2686-L2723) applied to the
      // namespaced id (since production namespaces before that step).
      // Re-registering the same id replaces the prior descriptor + handler
      // (replace-by-id, see host-api.md). A plugin test that calls
      // registerAction with the same id twice should see the second call win,
      // not accumulate two entries.
      if (!descriptor || typeof descriptor !== "object") {
        throw new Error("registerAction: descriptor must be an object");
      }
      if (typeof handler !== "function") {
        throw new Error("registerAction: handler must be a function");
      }
      if (typeof descriptor.id !== "string" || descriptor.id.length === 0) {
        throw new Error("registerAction: descriptor.id must be a non-empty string");
      }
      if (descriptor.id.startsWith(`${pluginId}.`)) {
        throw new Error(
          `registerAction: descriptor.id "${descriptor.id}" must not include the plugin prefix`
        );
      }
      // Mirrors validateAndBuildActionDescriptor (L2697-L2723). The mock
      // namespaces the id the same way production does and runs the same
      // checks against the namespaced form, so a plugin test that registers
      // an action the production host would reject fails the mock in the
      // same way — no "passes the mock, throws at activation" gap.
      const namespacedId = `${pluginId}.${descriptor.id}`;
      if (!PLUGIN_ACTION_ID_RE.test(namespacedId)) {
        throw new Error(
          `registerAction: descriptor.id "${descriptor.id}" (namespaced to "${namespacedId}") is invalid. Expected "{pluginId}.{actionId}" (lowercase start, alphanumerics, dot/dash/underscore).`
        );
      }
      if (typeof descriptor.title !== "string" || !descriptor.title.trim()) {
        throw new Error("registerAction: descriptor.title must be a non-empty string");
      }
      if (typeof descriptor.description !== "string") {
        throw new Error("registerAction: descriptor.description must be a string");
      }
      if (typeof descriptor.category !== "string" || !descriptor.category.trim()) {
        throw new Error("registerAction: descriptor.category must be a non-empty string");
      }
      if (!PLUGIN_ACTION_KINDS.has(descriptor.kind)) {
        throw new Error(
          `registerAction: descriptor.kind "${descriptor.kind}" is invalid (must be one of: ${[
            ...PLUGIN_ACTION_KINDS,
          ].join(", ")})`
        );
      }
      if (!PLUGIN_ACTION_DANGERS.has(descriptor.danger)) {
        throw new Error(
          `registerAction: descriptor.danger "${descriptor.danger}" is invalid (must be one of: ${[
            ...PLUGIN_ACTION_DANGERS,
          ].join(", ")})`
        );
      }
      const existing = registeredActions.findIndex((r) => r.descriptor.id === descriptor.id);
      if (existing >= 0) {
        registeredActions[existing] = { descriptor, handler };
      } else {
        registeredActions.push({ descriptor, handler });
      }
      // Validation/registry mutation runs synchronously above (sync throws still
      // surface at the call site); only the return value is a resolved promise.
      return Promise.resolve();
    },
    registerHandler<TArgs = unknown, TResult = unknown>(
      channel: string,
      schemaOrHandler: PluginChannelSchema<TArgs, TResult> | PluginIpcHandler,
      handlerOrOptions?: PluginTypedIpcHandler<TArgs, TResult> | PluginHandlerOptions,
      _options?: PluginHandlerOptions
    ): Promise<void> {
      // The host's channel guard, thrown at the call as an in-process host
      // throws it: a colon collides with the `{pluginId}:{channel}` transport.
      // Production accepts an empty channel here, so only the colon and
      // non-string checks apply.
      if (isInvalidChannel(channel, true)) {
        throw new Error(`Plugin channel must not contain colons: ${String(channel)}`);
      }
      // Handle both overloads, each with an optional trailing options bag:
      // 1. registerHandler(channel, schema, handler, options?) — typed
      // 2. registerHandler(channel, handler, options?) — untyped
      if (typeof handlerOrOptions === "function" || typeof schemaOrHandler !== "function") {
        // Typed overload: schemaOrHandler is a schema, the third arg the typed handler.
        // The cast is necessary because PluginTypedIpcHandler is structurally compatible
        // with PluginIpcHandler and we're storing it in a untyped recording array.
        registeredHandlers.push({
          channel,
          handler: handlerOrOptions as unknown as PluginIpcHandler,
        });
      } else {
        registeredHandlers.push({
          channel,
          handler: schemaOrHandler as PluginIpcHandler,
        });
      }
      return Promise.resolve();
    },
    broadcastToRenderer(channel, payload) {
      // Mirror production's channel-format guard (#10617): a colon would collide
      // with the `plugin:{id}:{channel}` transport. Reject (not throw) so the
      // mock matches the host's Promise contract. Production allows an empty
      // broadcast channel, so only the colon/non-string checks apply here.
      if (isInvalidChannel(channel, true)) {
        return Promise.reject(
          new Error(
            `broadcastToRenderer: channel must be a string without colons: ${String(channel)}`
          )
        );
      }
      broadcastCalls.push({ channel, payload });
      return Promise.resolve();
    },
    postToPanel(channel, payload, panelId) {
      if (isInvalidChannel(channel, false)) {
        return Promise.reject(
          new Error(
            `postToPanel: channel must be a non-empty string without colons: ${String(channel)}`
          )
        );
      }
      if (panelId !== undefined && panelId !== null) {
        if (typeof panelId !== "string" || panelId.length === 0) {
          throw new Error(
            `postToPanel: panelId must be a non-empty string, null, or undefined: ${String(panelId)}`
          );
        }
      }
      postToPanelCalls.push({ channel, payload, panelId: panelId ?? null });
      return Promise.resolve();
    },
    hasListeners(channel) {
      return !unlistenedChannels.has(assertListenerChannel("hasListeners", channel));
    },
    onDidChangeListeners(channel, callback) {
      const name = assertListenerChannel("onDidChangeListeners", channel);
      if (typeof callback !== "function") {
        throw new Error("onDidChangeListeners: callback must be a function");
      }
      let subs = listenerSubs.get(name);
      if (!subs) {
        subs = new Set();
        listenerSubs.set(name, subs);
      }
      const registered = (hasListeners: boolean): void => callback(hasListeners);
      subs.add(registered);
      return () => {
        listenerSubs.get(name)?.delete(registered);
      };
    },
    async getActiveWorktree() {
      if (worktreesResult) {
        return worktreesResult.status === "ok"
          ? (worktreesResult.worktrees.find((w) => w.isCurrent) ?? null)
          : null;
      }
      return activeWorktree;
    },
    async getWorktrees() {
      // Projected from the override when one is set: the real host derives all
      // three getters from a single read, so a mock that let `getWorktrees()`
      // stay populated while the result says `unavailable` would bless a
      // fallback that cannot work in production.
      if (worktreesResult) {
        return worktreesResult.status === "ok" ? worktreesResult.worktrees : [];
      }
      return worktrees;
    },
    async getWorktreesResult() {
      return worktreesResult ?? { status: "ok", projectId: "test-project", worktrees };
    },
    async getWorktreeStatus(path, options) {
      options?.signal?.throwIfAborted();
      const match =
        worktrees.find((w) => w.path === path) ??
        (activeWorktree?.path === path ? activeWorktree : null);
      return match?.status ?? null;
    },
    onDidChangeActiveWorktree(callback, subscribeOptions) {
      subscriptionOptions.push({
        kind: "active-worktree",
        debounceMs: mockResolveSubscriptionDebounceMs(subscribeOptions?.debounceMs),
      });
      activeWorktreeSubs.add(callback);
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        activeWorktreeSubs.delete(callback);
      };
      return Promise.resolve(dispose);
    },
    onDidChangeWorktrees(callback, subscribeOptions) {
      // The window is resolved and recorded exactly as the host resolves it,
      // but delivery stays synchronous: timing is a host concern, unit-tested
      // there, and a test driving `simulateWorktreesChange` wants the callback
      // now. The change argument is real.
      subscriptionOptions.push({
        kind: "worktrees",
        debounceMs: mockResolveSubscriptionDebounceMs(subscribeOptions?.debounceMs),
      });
      worktreesSubs.set(callback, { previous: new Map() });
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        worktreesSubs.delete(callback);
      };
      return Promise.resolve(dispose);
    },
    async getAgentState() {
      // Capability gating mirrors production (#10617): without "agent:read" the
      // call rejects PERMISSION_REQUIRED, so a plugin that forgot to declare the
      // capability fails the mock the same way the real host fails it.
      if (!capabilities.has("agent:read")) {
        throw new Error(
          'PERMISSION_REQUIRED: getAgentState requires "agent:read", which is not declared in manifest.capabilities'
        );
      }
      return lastAgentSnapshot;
    },
    async sendToActiveAgent(text, options) {
      // Capability first, then text validation, then active-agent resolution —
      // the same order production enforces (#10617). Whitespace-only text is
      // rejected (a no-op stage can't bank consent, and submit:true can't fire a
      // bare Enter). The mock has no PTY, so a valid call just records its intent.
      if (!capabilities.has("agent:input")) {
        throw new Error(
          'PERMISSION_REQUIRED: sendToActiveAgent requires "agent:input", which is not declared in manifest.capabilities'
        );
      }
      if (typeof text !== "string" || text.trim().length === 0) {
        throw new Error("sendToActiveAgent: text must be a non-empty, non-whitespace string");
      }
      if (!hasActiveAgent) {
        throw new Error("NO_ACTIVE_AGENT: no active agent terminal to receive input");
      }
      sentToActiveAgentCalls.push({ text, submit: options?.submit === true });
    },
    agents: {
      async list() {
        if (!capabilities.has("agent:read")) {
          throw new Error(
            'PERMISSION_REQUIRED: agents.list requires "agent:read", which is not declared in manifest.capabilities'
          );
        }
        return agentPanes.map((pane) => ({ ...pane }));
      },
      async listAll() {
        assertMockCanReadAllAgents("agents.listAll");
        return allAgentsSnapshot;
      },
      // Same order as production: capability, then argument validation, then
      // whether this plugin launched the agent. No consent prompt and no PTY —
      // a valid call on a launched agent records its intent and answers `sent`.
      async interrupt(terminalId) {
        assertMockAgentInput("interrupt", terminalId);
        const result: PluginAgentInterruptResult = launchedAgents.has(terminalId)
          ? { status: "sent", cancelKey: "advertised" }
          : { status: "not-found" };
        agentInputCalls.push({ method: "interrupt", terminalId, result });
        return result;
      },
      async sendKeys(terminalId, input) {
        assertMockAgentInput("sendKeys", terminalId);
        const { keys, choose } = (input ?? {}) as { keys?: unknown; choose?: unknown };
        const validKeys =
          Array.isArray(keys) &&
          keys.length >= 1 &&
          keys.length <= 16 &&
          // A dense copy, so a sparse array's holes fail as production's do.
          Array.from(keys as unknown[]).every(
            (key) => typeof key === "string" && MOCK_AGENT_KEY.test(key)
          );
        const validChoose =
          typeof choose === "string" && choose.length >= 1 && choose.length <= 200;
        if (keys !== undefined && choose !== undefined) {
          throw new Error("agents.sendKeys: pass exactly one of keys or choose");
        }
        if (!(keys !== undefined ? validKeys : validChoose)) {
          throw new Error(
            "agents.sendKeys: pass keys (1 to 16 key names) or choose (1 to 200 characters)"
          );
        }
        // The mock has no screen to plan a `choose` against, so it presses nothing.
        const result: PluginAgentKeysResult = launchedAgents.has(terminalId)
          ? { status: "sent", keys: validKeys ? [...(keys as string[])] : [] }
          : { status: "not-found" };
        agentInputCalls.push({ method: "sendKeys", terminalId, input, result });
        return result;
      },
      async submit(terminalId, text) {
        assertMockAgentInput("submit", terminalId);
        if (typeof text !== "string" || text.trim().length === 0) {
          throw new Error("agents.submit: text must be a non-empty, non-whitespace string");
        }
        const result: PluginAgentInputResult = launchedAgents.has(terminalId)
          ? { status: "sent" }
          : { status: "not-found" };
        agentInputCalls.push({ method: "submit", terminalId, input: text, result });
        return result;
      },
    },
    terminals: {
      async readScreen(terminalId, options) {
        // Same order as production: capability, then argument validation. No
        // consent prompt and no rate limit — a test grants by declaring.
        if (!capabilities.has("terminal:read")) {
          throw new Error(
            'PERMISSION_REQUIRED: terminals.readScreen requires "terminal:read", which is not declared in manifest.capabilities'
          );
        }
        if (typeof terminalId !== "string" || terminalId.length === 0 || terminalId.length > 512) {
          throw new Error(
            "terminals.readScreen: terminalId must be a non-empty string of at most 512 characters"
          );
        }
        if (options !== undefined && (options === null || typeof options !== "object")) {
          throw new Error("terminals.readScreen: options must be an object");
        }
        const lines =
          options?.lines === undefined ? PLUGIN_TERMINAL_SCREEN_DEFAULT_LINES : options.lines;
        if (
          typeof lines !== "number" ||
          !Number.isInteger(lines) ||
          lines < 1 ||
          lines > PLUGIN_TERMINAL_SCREEN_MAX_LINES
        ) {
          throw new Error(
            `terminals.readScreen: options.lines must be an integer from 1 to ${PLUGIN_TERMINAL_SCREEN_MAX_LINES}`
          );
        }
        const screen = terminalScreens.get(terminalId);
        let result: PluginTerminalScreenResult = screen ?? { status: "not-found" };
        if (screen?.status === "ok" && screen.text.length > 0) {
          const all = screen.text.split("\n");
          const kept = all.slice(-lines);
          result = {
            status: "ok",
            text: kept.join("\n"),
            lineCount: kept.length,
            truncated: screen.truncated || all.length > kept.length,
          };
        } else if (screen) {
          result = { ...screen };
        }
        readScreenCalls.push({ terminalId, lines, result });
        return result;
      },
    },
    async sendToAgent(text, options, callOptions) {
      // Same order as production: capability, then argument validation. The
      // mock has no renderer, so a named pane resolves against `agents` and a
      // picker resolves to `simulateSendToAgentPick`.
      if (!capabilities.has("agent:input")) {
        throw new Error(
          'PERMISSION_REQUIRED: sendToAgent requires "agent:input", which is not declared in manifest.capabilities'
        );
      }
      if (typeof text !== "string" || text.trim().length === 0) {
        throw new Error("sendToAgent: text must be a non-empty, non-whitespace string");
      }
      if (options !== undefined && (typeof options !== "object" || options === null)) {
        throw new Error("sendToAgent: options must be an object");
      }
      if (options?.title !== undefined && typeof options.title !== "string") {
        throw new Error("sendToAgent: options.title must be a string");
      }
      if (validateAgentContextPayload({ v: 1, text, title: options?.title }) === null) {
        throw new Error("sendToAgent: text or options.title is over its length limit");
      }
      for (const key of ["terminalId", "worktreeId"] as const) {
        const value = options?.[key];
        // Same bound as production's `SEND_TO_AGENT_MAX_ID_LENGTH`.
        if (
          value !== undefined &&
          (typeof value !== "string" || value.length === 0 || value.length > 512)
        ) {
          throw new Error(
            `sendToAgent: options.${key} must be a non-empty string of at most 512 characters`
          );
        }
      }
      if (callOptions?.signal?.aborted) return { status: "cancelled" };
      const target = options?.terminalId ?? sendToAgentPick;
      let result: PluginSendToAgentResult;
      if (target === null) {
        result = { status: "cancelled" };
      } else {
        const pane = agentPanes.find((candidate) => candidate.terminalId === target);
        if (!pane) {
          result = { status: "refused", reason: "unknown-terminal" };
        } else if (!pane.canDraft) {
          result = { status: "refused", reason: pane.draftRefusal ?? "not-agent" };
        } else {
          result = { status: "drafted", terminalId: pane.terminalId };
        }
      }
      sentToAgentCalls.push({ text, options, result });
      return result;
    },
    async runRecipe(recipeId, options, callOptions) {
      // The mock has no recipe registry or dialog: it checks the call's shape
      // as production does, then answers what `simulateRunRecipeResult` set.
      if (typeof recipeId !== "string" || recipeId.length === 0) {
        throw new Error(
          "runRecipe: recipeId must be the id of one of this plugin's contributes.recipes"
        );
      }
      if (options !== undefined && (typeof options !== "object" || options === null)) {
        throw new Error("runRecipe: options must be an object");
      }
      const variables: unknown = options?.variables;
      if (variables !== undefined) {
        if (typeof variables !== "object" || variables === null || Array.isArray(variables)) {
          throw new Error("runRecipe: variables must be an object of strings");
        }
        for (const [name, value] of Object.entries(variables)) {
          if (typeof value !== "string") throw new Error(`runRecipe: "${name}" must be a string`);
        }
      }
      if (callOptions?.signal?.aborted) return { status: "cancelled" };
      const result = { ...runRecipeResult };
      runRecipeCalls.push({ recipeId, options, result });
      return result;
    },
    onDidChangeAgentState(callback, subscribeOptions) {
      subscriptionOptions.push({
        kind: "agent-state",
        debounceMs: mockResolveSubscriptionDebounceMs(subscribeOptions?.debounceMs),
      });
      agentStateSubs.add(callback);
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        agentStateSubs.delete(callback);
      };
      return Promise.resolve(dispose);
    },
    onDidChangeTerminalLifecycle(callback) {
      if (!capabilities.has("agent:read")) {
        throw new Error(
          `PERMISSION_REQUIRED: onDidChangeTerminalLifecycle requires "agent:read", which is not declared in manifest.capabilities`
        );
      }
      // A wrapper per subscription, so the same callback subscribed twice is
      // two independent subscriptions, as in production.
      const subscription = (event: PluginTerminalLifecycleEvent) => callback(event);
      terminalLifecycleSubs.add(subscription);
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        terminalLifecycleSubs.delete(subscription);
      };
      return Promise.resolve(dispose);
    },
    onDidChangeAllAgents(callback, subscribeOptions) {
      assertMockCanReadAllAgents("onDidChangeAllAgents");
      subscriptionOptions.push({
        kind: "all-agents",
        debounceMs: mockResolveSubscriptionDebounceMs(subscribeOptions?.debounceMs),
      });
      // A wrapper per subscription, so the same callback subscribed twice is
      // two independent subscriptions, as in production.
      const subscription = (snapshot: PluginAllAgentsSnapshot) => callback(snapshot);
      allAgentsSubs.add(subscription);
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        allAgentsSubs.delete(subscription);
      };
      return Promise.resolve(dispose);
    },
    onDidChangeFocusedPanel(callback, subscribeOptions) {
      if (!capabilities.has("panel:focus-read")) {
        throw new Error(
          `PERMISSION_REQUIRED: onDidChangeFocusedPanel requires "panel:focus-read", which is not declared in manifest.capabilities`
        );
      }
      subscriptionOptions.push({
        kind: "focused-panel",
        debounceMs: mockResolveSubscriptionDebounceMs(
          subscribeOptions?.debounceMs,
          PLUGIN_FOCUSED_PANEL_DEFAULT_DEBOUNCE_MS
        ),
      });
      let delivered: PluginFocusedPanel | null = null;
      let disposed = false;
      const subscription = (raw: PluginFocusedPanel) => {
        if (disposed) return;
        // A project plugin's simulated focus is taken to be inside its own
        // project, except the Portal, which production never attributes to one.
        const focus =
          mockProjectId !== null && raw.kind === "portal" ? toPluginFocusedPanel(null) : raw;
        if (delivered !== null && pluginFocusedPanelEquals(delivered, focus)) return;
        delivered = focus;
        // Logged and swallowed, sync or async, as the host does for a listener.
        const report = (err: unknown) =>
          console.error("[createMockHost] onDidChangeFocusedPanel callback failed:", err);
        try {
          const result: unknown = callback(focus);
          if (result instanceof Promise) result.catch(report);
        } catch (err) {
          report(err);
        }
      };
      focusedPanelSubs.add(subscription);
      // The current focus is replayed, asynchronously like production.
      queueMicrotask(() => subscription(focusedPanel));
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        focusedPanelSubs.delete(subscription);
      };
      return Promise.resolve(dispose);
    },
    onDidChangeProjectPresence(callback, subscribeOptions) {
      subscriptionOptions.push({
        kind: "project-presence",
        debounceMs: mockResolveSubscriptionDebounceMs(subscribeOptions?.debounceMs),
      });
      const delivered = new Map<string, PluginProjectPresenceState>();
      let disposed = false;
      const subscription = (presence: PluginProjectPresence) => {
        if (disposed) return;
        // A project plugin sees its own project only; an installed one every
        // project and never a scratch, as in production.
        if (mockProjectId !== null && presence.projectId !== mockProjectId) return;
        if (mockProjectId === null && !isProjectWorkspaceId(presence.projectId)) return;
        const previous = delivered.get(presence.projectId);
        if (previous === presence.state) return;
        if (presence.state === "closed" && mockProjectId === null) {
          if (previous === undefined) return;
          delivered.delete(presence.projectId);
        } else {
          delivered.set(presence.projectId, presence.state);
        }
        // Logged and swallowed, sync or async, as the host does for a listener.
        const report = (err: unknown) =>
          console.error("[createMockHost] onDidChangeProjectPresence callback failed:", err);
        try {
          const result: unknown = callback(presence);
          if (result instanceof Promise) result.catch(report);
        } catch (err) {
          report(err);
        }
      };
      projectPresenceSubs.add(subscription);
      // The current state is replayed, asynchronously like production.
      queueMicrotask(() => {
        if (mockProjectId !== null) {
          const state = projectPresence.get(mockProjectId) ?? "closed";
          subscription(Object.freeze({ projectId: mockProjectId, state }));
          return;
        }
        for (const [projectId, state] of projectPresence) {
          subscription(Object.freeze({ projectId, state }));
        }
      });
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        projectPresenceSubs.delete(subscription);
      };
      return Promise.resolve(dispose);
    },
    onDidChangePanelLifecycle(callback) {
      // No capability gate and no replay: the mock holds no panel registry, so
      // tests drive phases explicitly via `simulatePanelLifecycleChange`.
      panelLifecycleSubs.add(callback);
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        panelLifecycleSubs.delete(callback);
      };
      return Promise.resolve(dispose);
    },
    onDidWake(callback) {
      // No capability gate and no replay, matching production: a wake is a
      // one-shot pulse, so tests drive it explicitly via `simulateSystemWake`.
      systemWakeSubs.add(callback);
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        systemWakeSubs.delete(callback);
      };
      return Promise.resolve(dispose);
    },
    registerForgeProvider(descriptor, impl) {
      // Mirrors PluginService.createHost L1738-L1817. Validation order matches
      // production: non-object descriptor, non-empty string id, non-object impl.
      // The manifest-declared-id check is intentionally skipped — the mock has
      // no manifest model (see issue #9878). Re-registering the same id
      // replaces the prior binding (replace-by-id). The disposer's identity
      // guard compares the captured `impl` reference against the currently
      // active entry's `impl`, matching `unregisterForgeProviderImpl`'s
      // `expected` argument: a stale disposer from a re-bound id is a no-op.
      if (!descriptor || typeof descriptor !== "object") {
        throw new Error("registerForgeProvider: descriptor must be an object");
      }
      if (typeof descriptor.id !== "string" || descriptor.id.length === 0) {
        throw new Error("registerForgeProvider: descriptor.id must be a non-empty string");
      }
      if (!impl || typeof impl !== "object") {
        throw new Error("registerForgeProvider: impl must be an object");
      }
      const contributionId = descriptor.id;
      const existing = registeredForgeProviders.findIndex(
        (r) => r.descriptor.id === contributionId
      );
      if (existing >= 0) {
        registeredForgeProviders[existing] = { descriptor, impl };
      } else {
        registeredForgeProviders.push({ descriptor, impl });
      }
      let disposed = false;
      // Disposer captured synchronously (registry mutation already done above) —
      // only the return value is a resolved promise, never a deferred write.
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        // Identity guard: only remove if the currently active entry is still
        // the one this disposer was captured against. A re-registration with a
        // different impl invalidates the prior disposer (matches production).
        const i = registeredForgeProviders.findIndex(
          (r) => r.descriptor.id === contributionId && r.impl === impl
        );
        if (i >= 0) registeredForgeProviders.splice(i, 1);
      };
      return Promise.resolve(dispose);
    },
    registerFileDecorationProvider(descriptor, impl) {
      // Mirrors PluginService.createHost L1818-L1875. Validation order matches
      // production: non-object descriptor, non-empty string id, impl must be
      // an object exposing `provideDecorations()`. The manifest-declared-id
      // check is intentionally skipped — the mock has no manifest model (see
      // issue #9878). Re-registering the same id replaces the prior binding
      // (replace-by-id). The disposer's identity guard mirrors
      // `unregisterFileDecorationProviderImpl`'s `expected` argument.
      if (!descriptor || typeof descriptor !== "object") {
        throw new Error("registerFileDecorationProvider: descriptor must be an object");
      }
      if (typeof descriptor.id !== "string" || descriptor.id.length === 0) {
        throw new Error("registerFileDecorationProvider: descriptor.id must be a non-empty string");
      }
      if (!impl || typeof impl !== "object" || typeof impl.provideDecorations !== "function") {
        throw new Error("registerFileDecorationProvider: impl must expose provideDecorations()");
      }
      const contributionId = descriptor.id;
      const existing = registeredFileDecorationProviders.findIndex(
        (r) => r.descriptor.id === contributionId
      );
      if (existing >= 0) {
        registeredFileDecorationProviders[existing] = { descriptor, impl };
      } else {
        registeredFileDecorationProviders.push({ descriptor, impl });
      }
      let disposed = false;
      // Disposer captured synchronously (registry mutation already done above).
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        // Identity guard: only remove if the currently active entry is still
        // the one this disposer was captured against. A re-registration with a
        // different impl invalidates the prior disposer (matches production).
        const i = registeredFileDecorationProviders.findIndex(
          (r) => r.descriptor.id === contributionId && r.impl === impl
        );
        if (i >= 0) registeredFileDecorationProviders.splice(i, 1);
      };
      return Promise.resolve(dispose);
    },
    registerWorktreeSetupStep(stepId, handler) {
      // Validation order matches production. As for decoration providers, the
      // manifest-declared-id check is skipped: the mock has no manifest model.
      if (typeof stepId !== "string" || stepId.length === 0) {
        throw new Error("registerWorktreeSetupStep: stepId must be a non-empty string");
      }
      if (typeof handler !== "function") {
        throw new Error("registerWorktreeSetupStep: handler must be a function");
      }
      const existing = registeredWorktreeSetupSteps.findIndex((r) => r.stepId === stepId);
      if (existing >= 0) {
        registeredWorktreeSetupSteps[existing] = { stepId, handler };
      } else {
        registeredWorktreeSetupSteps.push({ stepId, handler });
      }
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        const i = registeredWorktreeSetupSteps.findIndex(
          (r) => r.stepId === stepId && r.handler === handler
        );
        if (i >= 0) registeredWorktreeSetupSteps.splice(i, 1);
      };
      return Promise.resolve(dispose);
    },
    registerSearchProvider(id, provider) {
      // Structural checks only; the mock has no manifest model (#9878), so an
      // id need not name a declared runtime provider here. Replace-by-id, with
      // an identity-guarded disposer, as in production.
      if (typeof id !== "string" || id.length === 0) {
        throw new Error("registerSearchProvider: id must be a non-empty string");
      }
      if (typeof provider !== "function") {
        throw new Error("registerSearchProvider: provider must be a function");
      }
      const existing = registeredSearchProviders.findIndex((r) => r.id === id);
      if (existing >= 0) registeredSearchProviders[existing] = { id, provider };
      else registeredSearchProviders.push({ id, provider });
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        const i = registeredSearchProviders.findIndex(
          (r) => r.id === id && r.provider === provider
        );
        if (i >= 0) registeredSearchProviders.splice(i, 1);
      };
      return Promise.resolve(dispose);
    },
    async registerContextProvider(descriptor, impl) {
      // Structural checks in the host's order; the declared-id check is skipped
      // because the mock has no manifest model (#9878). Replace-by-id, with an
      // identity-guarded disposer, as in production.
      if (!descriptor || typeof descriptor !== "object") {
        throw new Error("registerContextProvider: descriptor must be an object");
      }
      if (typeof descriptor.id !== "string" || descriptor.id.length === 0) {
        throw new Error("registerContextProvider: descriptor.id must be a non-empty string");
      }
      if (
        !impl ||
        typeof impl !== "object" ||
        typeof impl.search !== "function" ||
        typeof impl.resolve !== "function"
      ) {
        throw new Error("registerContextProvider: impl must expose search() and resolve()");
      }
      const providerId = descriptor.id;
      const existing = registeredContextProviders.findIndex((r) => r.descriptor.id === providerId);
      if (existing >= 0) registeredContextProviders[existing] = { descriptor, impl };
      else registeredContextProviders.push({ descriptor, impl });
      return () => {
        const i = registeredContextProviders.findIndex(
          (r) => r.descriptor.id === providerId && r.impl === impl
        );
        if (i >= 0) registeredContextProviders.splice(i, 1);
      };
    },
    registerWorktreeDeleteNotesProvider(descriptor, impl) {
      // Structural checks in production's order. The manifest-declared-id
      // check is skipped: the mock has no manifest model (#9878). Re-registering
      // an id replaces the binding, and the replaced one's disposer is inert.
      if (!descriptor || typeof descriptor !== "object") {
        throw new Error("registerWorktreeDeleteNotesProvider: descriptor must be an object");
      }
      if (typeof descriptor.id !== "string" || descriptor.id.length === 0) {
        throw new Error(
          "registerWorktreeDeleteNotesProvider: descriptor.id must be a non-empty string"
        );
      }
      if (!impl || typeof impl !== "object" || typeof impl.provideNotes !== "function") {
        throw new Error("registerWorktreeDeleteNotesProvider: impl must expose provideNotes()");
      }
      const contributionId = descriptor.id;
      const existing = registeredWorktreeDeleteNotesProviders.findIndex(
        (r) => r.descriptor.id === contributionId
      );
      if (existing >= 0) {
        registeredWorktreeDeleteNotesProviders[existing] = { descriptor, impl };
      } else {
        registeredWorktreeDeleteNotesProviders.push({ descriptor, impl });
      }
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        const i = registeredWorktreeDeleteNotesProviders.findIndex(
          (r) => r.descriptor.id === contributionId && r.impl === impl
        );
        if (i >= 0) registeredWorktreeDeleteNotesProviders.splice(i, 1);
      };
      return Promise.resolve(dispose);
    },
    mcp: {
      registerTools(endpointId, tools) {
        // Structural checks only. The mock has no manifest model (#9878), so the
        // `mcp:expose` and declared-endpoint gates are skipped, and the roster
        // budget (tool count, name grammar, description and schema sizes) is
        // enforced by the real host rather than duplicated here. Re-registering
        // an endpoint replaces its roster; a replaced roster's disposer is inert.
        if (typeof endpointId !== "string" || endpointId.length === 0) {
          throw new Error("mcp.registerTools: endpointId must be a non-empty string");
        }
        if (!tools || typeof tools !== "object") {
          throw new Error("mcp.registerTools: tools must be an object keyed by tool name");
        }
        for (const [name, tool] of Object.entries(tools)) {
          if (!tool || typeof tool !== "object" || typeof tool.execute !== "function") {
            throw new Error(`mcp.registerTools: tool "${name}" must provide an execute() function`);
          }
        }
        const record: RegisteredMcpToolsRecord = { endpointId, tools };
        const existing = registeredMcpTools.findIndex((r) => r.endpointId === endpointId);
        if (existing >= 0) {
          registeredMcpTools[existing] = record;
        } else {
          registeredMcpTools.push(record);
        }
        let disposed = false;
        const dispose = () => {
          if (disposed) return;
          disposed = true;
          const i = registeredMcpTools.indexOf(record);
          if (i >= 0) registeredMcpTools.splice(i, 1);
        };
        return Promise.resolve(dispose);
      },
    },
    invalidateFileDecorations(scope, paths) {
      // Mirror production's non-empty-scope guard (#10617): reject (not throw),
      // matching the host's Promise contract. The declared-scope gate production
      // also applies is intentionally skipped — the mock has no manifest model
      // (#9878), so it can't know which scopes a plugin declared.
      if (typeof scope !== "string" || scope.length === 0) {
        return Promise.reject(
          new Error("invalidateFileDecorations: scope must be a non-empty string")
        );
      }
      invalidationCalls.push({ scope, paths });
      return Promise.resolve();
    },
    setPanelBadge(panelId, badge) {
      // Validate to production parity (#10617): non-empty panelId, and a badge
      // shape the real host's Zod schema would accept. Reject (not throw) so the
      // mock matches the host's Promise contract. `null`/`undefined` clears.
      if (typeof panelId !== "string" || panelId.length === 0) {
        return Promise.reject(new Error("setPanelBadge: panelId must be a non-empty string"));
      }
      if (badge !== null && badge !== undefined) {
        try {
          validatePanelBadge(badge);
        } catch (err) {
          // validatePanelBadge only throws Error; re-reject it so the validation
          // error stays inside the Promise contract (not a sync throw).
          return Promise.reject(err);
        }
      }
      setPanelBadgeCalls.push({ panelId, badge: badge ?? null });
      return Promise.resolve();
    },
    setToolbarButtonBadge(buttonId, badge) {
      if (typeof buttonId !== "string" || buttonId.length === 0) {
        return Promise.reject(
          new Error("setToolbarButtonBadge: buttonId must be a non-empty string")
        );
      }
      if (options.toolbarButtonIds && !options.toolbarButtonIds.includes(buttonId)) {
        return Promise.reject(
          new Error(
            `setToolbarButtonBadge: "${buttonId}" is not one of this plugin's contributes.toolbarButtons`
          )
        );
      }
      if (badge !== null && badge !== undefined) {
        try {
          validatePanelBadge(badge);
        } catch (err) {
          return Promise.reject(
            new Error((err as Error).message.replace(/^setPanelBadge:/, "setToolbarButtonBadge:"))
          );
        }
      }
      setToolbarButtonBadgeCalls.push({ buttonId, badge: badge ?? null });
      return Promise.resolve();
    },
    setToolbarButtonState(buttonId, state) {
      if (typeof buttonId !== "string" || buttonId.length === 0) {
        return Promise.reject(
          new Error("setToolbarButtonState: buttonId must be a non-empty string")
        );
      }
      if (options.toolbarButtonIds && !options.toolbarButtonIds.includes(buttonId)) {
        return Promise.reject(
          new Error(
            `setToolbarButtonState: "${buttonId}" is not one of this plugin's contributes.toolbarButtons`
          )
        );
      }
      if (state !== null && state !== undefined) {
        try {
          validateToolbarButtonState(state, mockManifestId, pluginId);
        } catch (err) {
          return Promise.reject(err);
        }
      }
      setToolbarButtonStateCalls.push({ buttonId, state: state ?? null });
      return Promise.resolve();
    },
    setContext(key, value) {
      // The host's own validator and cap, so a call the real host refuses
      // rejects here too.
      const entry = validatePluginContextEntry(key, value);
      if (!entry.ok) return Promise.reject(new Error(`setContext: ${entry.error}`));
      const applied = applyPluginContextEntry(contextKeys, entry.key, entry.value);
      if (!applied.ok) return Promise.reject(new Error(`setContext: ${applied.error}`));
      setContextCalls.push({ key: entry.key, value: entry.value });
      return Promise.resolve();
    },
    async setWorktreeCardStatus(worktreeId, status) {
      // The host's own validator and worktree check, against whatever
      // `getWorktreesResult()` answers right now.
      const entry = validatePluginWorktreeCardStatus(worktreeId, status, mockManifestId, pluginId);
      if (!entry.ok) throw new Error(`setWorktreeCardStatus: ${entry.error}`);
      const result: PluginWorktreesResult = worktreesResult ?? {
        status: "ok",
        projectId: "test-project",
        worktrees,
      };
      if (result.status !== "ok") {
        throw new Error(`setWorktreeCardStatus: worktrees are unavailable (${result.reason})`);
      }
      const target = result.worktrees.find(
        (w) => w.id === entry.worktreeId || w.worktreeId === entry.worktreeId
      );
      if (!target) {
        throw new Error(
          `setWorktreeCardStatus: "${entry.worktreeId}" is not a worktree this plugin can see`
        );
      }
      if (entry.status === null) worktreeCardStatuses.delete(target.id);
      else worktreeCardStatuses.set(target.id, entry.status);
      setWorktreeCardStatusCalls.push({ worktreeId: target.id, status: entry.status });
    },
    async setWorktreeReviewChecks(worktreeId, checks) {
      const entry = validatePluginWorktreeReviewChecks(
        worktreeId,
        checks,
        mockManifestId,
        pluginId
      );
      if (!entry.ok) throw new Error(`setWorktreeReviewChecks: ${entry.error}`);
      const result: PluginWorktreesResult = worktreesResult ?? {
        status: "ok",
        projectId: "test-project",
        worktrees,
      };
      if (result.status !== "ok") {
        throw new Error(`setWorktreeReviewChecks: worktrees are unavailable (${result.reason})`);
      }
      const target = result.worktrees.find(
        (w) => w.id === entry.worktreeId || w.worktreeId === entry.worktreeId
      );
      if (!target) {
        throw new Error(
          `setWorktreeReviewChecks: "${entry.worktreeId}" is not a worktree this plugin can see`
        );
      }
      if (entry.checks === null) worktreeReviewChecks.delete(target.id);
      else worktreeReviewChecks.set(target.id, entry.checks);
      setWorktreeReviewChecksCalls.push({ worktreeId: target.id, checks: entry.checks });
    },
    async setTerminalStatus(terminalId, status) {
      // Same order as production: capability, then the shared validator, then
      // membership in whatever `agents.list()` answers right now.
      if (!capabilities.has("agent:read")) {
        throw new Error(
          'PERMISSION_REQUIRED: setTerminalStatus requires "agent:read", which is not declared in manifest.capabilities'
        );
      }
      const entry = validatePluginTerminalStatus(terminalId, status, mockManifestId, pluginId);
      if (!entry.ok) throw new Error(`setTerminalStatus: ${entry.error}`);
      if (!agentPanes.some((pane) => pane.terminalId === entry.terminalId)) {
        throw new Error(
          `setTerminalStatus: "${entry.terminalId}" is not a terminal this plugin can see`
        );
      }
      if (entry.status === null) terminalStatuses.delete(entry.terminalId);
      else {
        if (
          !terminalStatuses.has(entry.terminalId) &&
          terminalStatuses.size >= PLUGIN_TERMINAL_STATUS_MAX_PER_PROJECT
        ) {
          throw new Error(
            `setTerminalStatus: at most ${PLUGIN_TERMINAL_STATUS_MAX_PER_PROJECT} terminals can hold a status at once`
          );
        }
        terminalStatuses.set(entry.terminalId, entry.status);
      }
      setTerminalStatusCalls.push({ terminalId: entry.terminalId, status: entry.status });
    },
    async setPanelActivity(panelId, activity) {
      // Same order as production: the shared validator, then the declaration,
      // then whose the panel is as far as the simulated lifecycle says.
      const entry = validatePluginPanelActivity(panelId, activity);
      if (!entry.ok) throw new Error(`setPanelActivity: ${entry.error}`);
      if (entry.activity === null) {
        panelActivity.delete(entry.panelId);
        setPanelActivityCalls.push({ panelId: entry.panelId, activity: null });
        return;
      }
      const declared = options.reportsActivityPanelIds;
      if (declared && declared.length === 0) {
        throw new Error(
          "setPanelActivity: none of this plugin's contributes.panels declares reportsActivity: true"
        );
      }
      const known = panelPhases.get(entry.panelId);
      if (known && known.pluginId !== pluginId) {
        throw new Error(`setPanelActivity: panel "${entry.panelId}" belongs to another plugin`);
      }
      if (
        known &&
        declared &&
        !declared.some(
          (id) =>
            known.panelKindId === id ||
            known.panelKindId ===
              toRuntimePanelKindId(
                { origin: pluginInfo.origin, pluginId: mockManifestId, kindId: id },
                mockProjectId
              )
        )
      ) {
        throw new Error(
          `setPanelActivity: panel kind "${known.panelKindId}" does not declare reportsActivity: true`
        );
      }
      if (
        !panelActivity.has(entry.panelId) &&
        panelActivity.size >= PLUGIN_PANEL_ACTIVITY_MAX_PANELS
      ) {
        throw new Error(
          `setPanelActivity: activity is already reported on ${PLUGIN_PANEL_ACTIVITY_MAX_PANELS} panels — clear a closed panel's with null`
        );
      }
      panelActivity.set(entry.panelId, entry.activity);
      setPanelActivityCalls.push({ panelId: entry.panelId, activity: entry.activity });
    },
    setPanelMenuItems(panelId, items) {
      // Vetted by the host's own normalizer, so a list the real host refuses
      // rejects here too.
      if (typeof panelId !== "string" || panelId.length === 0) {
        return Promise.reject(new Error("setPanelMenuItems: panelId must be a non-empty string"));
      }
      const result = normalizePanelMenuItems(items, mockManifestId, pluginId);
      if (!result.ok) {
        return Promise.reject(new Error(`setPanelMenuItems: invalid items — ${result.error}`));
      }
      setPanelMenuItemsCalls.push({ panelId, items: items ?? null });
      return Promise.resolve();
    },
    async reloadPanel(panelId) {
      if (typeof panelId !== "string" || panelId.trim().length === 0) {
        throw new Error("reloadPanel: panelId must be a non-empty string");
      }
      reloadPanelCalls.push(panelId);
      if (options.reloadPanel) return options.reloadPanel(panelId);
      const known = panelPhases.get(panelId);
      if (!known) return "not-mounted";
      if (known.pluginId !== pluginId) {
        throw new Error(`reloadPanel: panel "${panelId}" belongs to another plugin`);
      }
      if (known.phase === "mounted") return "scheduled";
      if (known.phase === "render-failed") return "unavailable";
      return "not-mounted";
    },
    async restartWorker() {
      const result = options.restartWorker ? await options.restartWorker() : "scheduled";
      restartWorkerCalls.push(result);
      return result;
    },
    async showToast(opts: PluginToastOptions) {
      // Full production parity (#10617): message length, type enum, durationMs
      // bounds — not just a truthy-message check. A shape the real host rejects
      // now fails the mock too.
      validateToastOptions(opts);
      shownToasts.push({
        message: opts.message,
        type: opts.type,
        durationMs: opts.durationMs,
      });
    },
    async notify(opts: PluginNotifyOptions): Promise<PluginNotifyResult> {
      validateNotifyOptions(opts, mockManifestId, capabilities);
      const id = `mock-notification-${notifications.length + 1}`;
      notifications.push({ id, options: opts });
      return { id };
    },
    tasks: {
      async start(startOptions): Promise<PluginTaskHandle> {
        const vetted = validatePluginTaskStart(startOptions);
        if (!vetted.ok) throw new Error(`tasks.start: ${vetted.error}`);
        const { actionId } = vetted.value.retry;
        if (!actionId.startsWith(`${mockManifestId}.`) || actionId === `${mockManifestId}.`) {
          throw new Error(
            `tasks.start: retry.actionId "${actionId}" must be one of this plugin's own actions, written "${mockManifestId}.<id>"`
          );
        }
        const live = tasks.filter((t) => t.state === "working" || t.state === "cancelling");
        if (live.length >= PLUGIN_TASK_MAX_LIVE) {
          throw new Error(
            `tasks.start: already has ${PLUGIN_TASK_MAX_LIVE} unfinished tasks — finish one before starting another`
          );
        }
        const record: MockTaskRecord = {
          id: `mock-task-${tasks.length + 1}`,
          options: vetted.value,
          state: "working",
          fraction: vetted.value.fraction,
          detail: vetted.value.detail,
          reports: [],
          result: undefined,
        };
        tasks.push(record);
        const controller = new AbortController();
        taskControllers.set(record.id, controller);
        const running = () => record.state === "working" || record.state === "cancelling";
        return {
          id: record.id,
          signal: controller.signal,
          report(progress) {
            const vettedProgress = validatePluginTaskProgress(progress);
            if (!vettedProgress.ok) throw new Error(`task.report: ${vettedProgress.error}`);
            if (!running()) return;
            record.reports.push(vettedProgress.value);
            if (vettedProgress.value.fraction !== undefined) {
              record.fraction = vettedProgress.value.fraction;
            }
            if (vettedProgress.value.detail !== undefined) {
              record.detail = vettedProgress.value.detail || undefined;
            }
          },
          async finish(result) {
            const vettedResult = validatePluginTaskResult(result);
            if (!vettedResult.ok) throw new Error(`task.finish: ${vettedResult.error}`);
            if (!running()) return;
            const cancelRequested = record.state === "cancelling";
            const outcome = vettedResult.value;
            record.state = outcome.outcome;
            record.result = outcome;
            taskControllers.delete(record.id);
            // The same notifications the real host raises; a task the user
            // cancelled shows nothing, however it ended.
            if (cancelRequested) return;
            if (outcome.outcome === "failed") {
              await host.notify({
                title: `${record.options.title} failed`,
                body: outcome.message,
                severity: "error",
                actions: [{ id: "retry", label: "Retry", ...record.options.retry }],
                dedupeKey: `task:${record.id}`,
              });
            } else if (outcome.outcome === "succeeded" && outcome.message !== undefined) {
              await host.notify({
                title: record.options.title,
                body: outcome.message,
                delivery: "passive",
                dedupeKey: `task:${record.id}`,
              });
            }
          },
        };
      },
    },
    async dispatch(actionId, args, dispatchOptions) {
      dispatchedActions.push(
        dispatchOptions === undefined
          ? { actionId, args }
          : { actionId, args, options: dispatchOptions }
      );
      const override = dispatchOverrides.get(actionId);
      if (override) return recordMockLaunch(actionId, args, override);
      if (options.dispatch) {
        return recordMockLaunch(
          actionId,
          args,
          await (dispatchOptions === undefined
            ? options.dispatch(actionId, args)
            : options.dispatch(actionId, args, dispatchOptions))
        );
      }
      // Match the real host's contract: dispatch ids are always fully
      // namespaced as `{pluginId}.{descriptor.id}`. Looking up by the full
      // form means a plugin calling `host.dispatch("greet")` against a
      // registered action also id'd `"greet"` returns NOT_FOUND in the mock
      // exactly as it would in production where ActionService never sees an
      // unprefixed id.
      const reg = registeredActions.find((r) => actionId === `${pluginId}.${r.descriptor.id}`);
      if (!reg) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: `Action not found: ${actionId}` },
        };
      }
      try {
        const result = await reg.handler(args);
        return { ok: true, result };
      } catch (err) {
        return {
          ok: false,
          error: {
            code: "EXECUTION_ERROR",
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    },
    // Imperative UI prompts (#10522, hardened in #10617). The mock has no
    // renderer to drive a dialog, so each prompt validates its arguments to
    // production parity, records the call for assertions, then resolves the
    // configured `simulate*Response` value (default = the user-cancel dismiss
    // value). A shape the real host rejects now fails the mock too.
    // An already-aborted signal dismisses without recording a call, matching
    // production — a plugin test must not get a configured answer to a question
    // the real host would never have asked (#12279).
    showQuickPick: (async (
      items: PluginQuickPickItem[],
      options?: PluginQuickPickOptions,
      callOptions?: PluginHostCallOptions
    ) => {
      const validItems = validateQuickPickItems(items);
      if (callOptions?.signal?.aborted) return undefined;
      showQuickPickCalls.push({ items: validItems, options });
      return quickPickResponse;
    }) as PluginHostApi["showQuickPick"],
    async showInputBox(options, callOptions) {
      if (callOptions?.signal?.aborted) return undefined;
      showInputBoxCalls.push({ options });
      return inputBoxResponse;
    },
    async showConfirm(options, callOptions) {
      if (!options || typeof options !== "object" || typeof options.title !== "string") {
        throw new Error("showConfirm: options.title must be a string");
      }
      if (callOptions?.signal?.aborted) return false;
      showConfirmCalls.push({ options });
      return confirmResponse;
    },
    actions: {
      // Backed by the catalog seeded via `seedActionCatalog`. With no seed the
      // catalog is empty — `list()` resolves `[]`, `get()` resolves `null`, and
      // `canDispatch()` resolves `"restricted"`, matching an unloaded plugin.
      async list() {
        return Array.from(actionCatalog.values());
      },
      async get(actionId) {
        return actionCatalog.get(actionId) ?? null;
      },
      async canDispatch(actionId): Promise<PluginCanDispatchResult> {
        const entry = actionCatalog.get(actionId);
        // Mirror production: unknown/absent → "restricted", danger "safe" → "ok",
        // danger "confirm" → "confirm" (dispatch would reject it), anything else
        // (e.g. a "restricted" entry that slipped in) → "restricted".
        if (!entry) return "restricted";
        if (entry.danger === "safe") return "ok";
        if (entry.danger === "confirm") return "confirm";
        return "restricted";
      },
    },
    process: {
      async spawn(
        command: string,
        options?:
          PluginProcessSpawnOptions | PluginDuplexProcessSpawnOptions | PluginPtyProcessSpawnOptions
      ): Promise<PluginProcessHandle | PluginDuplexProcessHandle | PluginPtyProcessHandle> {
        spawnCalls.push({ command, options });
        // A no-op handle: the mock records the call without spawning anything.
        // Lifecycle and data callbacks never fire (no real process), and
        // kill/restart/write/resize are inert — tests that exercise real process
        // behavior use PluginProcessManager directly with an injected fake spawner.
        const base: PluginProcessHandle = {
          id: `mock-process-${spawnCalls.length}`,
          kill: () => {},
          restart: async () => {},
          onExit: () => () => {},
          onCrash: () => () => {},
          onData: () => () => {},
        };
        // Shape matches the real host: `write` exists only for a writable mode
        // (duplex or PTY) and `resize` only for a PTY, so a test asserting "pipe
        // mode has no writable input" stays honest.
        if (options?.mode === "duplex") return { ...base, write: () => {} };
        if (options?.mode !== "pty") return base;
        return { ...base, write: () => {}, resize: () => {} };
      },
    } as PluginProcessApi,
    // In-memory fs mock: writes land in `fsFiles` and are recorded; reads return
    // a previously-written value or reject ENOENT. No containment is modeled
    // (containment lives in pluginFsContainment and is unit-tested directly) —
    // this mock is for exercising a plugin's activate()/handlers, not the guard.
    fs: {
      async readFile(filePath, options) {
        options?.signal?.throwIfAborted();
        const v = fsFiles.get(filePath);
        if (v === undefined) {
          throw new Error(`ENOENT: mock fs has no file "${filePath}"`);
        }
        return v;
      },
      async readFileBytes(filePath, options) {
        options?.signal?.throwIfAborted();
        const v = fsFiles.get(filePath);
        if (v === undefined) {
          throw new Error(`ENOENT: mock fs has no file "${filePath}"`);
        }
        // The mock stores text, so bytes are the UTF-8 encoding of it — enough
        // to exercise a plugin's byte path without modelling binary storage.
        return new TextEncoder().encode(v);
      },
      async readFileWithRevision(filePath, options) {
        options?.signal?.throwIfAborted();
        const v = fsFiles.get(filePath);
        if (v === undefined) {
          throw new Error(`ENOENT: mock fs has no file "${filePath}"`);
        }
        return { contents: v, revision: mockRevision(v) };
      },
      // Same validation, bounds and per-entry results as the host; a path the
      // mock fs does not hold is `NOT_FOUND`.
      readFiles: (async (
        paths: readonly string[],
        readOptions?: PluginFsReadFilesOptions
      ): Promise<PluginFsReadFilesEntry<string | Uint8Array>[]> => {
        const fail = (why: string): never => {
          throw new Error(`VALIDATION: plugin "${pluginId}" fs.readFiles: ${why}`);
        };
        if (!Array.isArray(paths)) fail("paths must be an array of strings");
        if (paths.length > MOCK_READ_FILES_MAX_PATHS) {
          fail(`at most ${MOCK_READ_FILES_MAX_PATHS} paths per call (got ${paths.length})`);
        }
        if (paths.some((p) => typeof p !== "string" || p.length === 0)) {
          fail("every path must be a non-empty string");
        }
        const encoding = readOptions?.encoding ?? "utf-8";
        if (encoding !== "utf-8" && encoding !== "bytes") {
          fail('encoding must be "utf-8" or "bytes"');
        }
        const max = readOptions?.maxBytesPerFile;
        if (max !== undefined && (!Number.isSafeInteger(max) || max < 0)) {
          fail("maxBytesPerFile must be a non-negative integer");
        }
        readOptions?.signal?.throwIfAborted();
        let remaining = MOCK_READ_FILES_MAX_TOTAL_BYTES;
        return paths.map((filePath): PluginFsReadFilesEntry<string | Uint8Array> => {
          const v = fsFiles.get(filePath);
          if (v === undefined) {
            return {
              path: filePath,
              ok: false,
              error: { code: "NOT_FOUND", message: `ENOENT: mock fs has no file "${filePath}"` },
            };
          }
          const bytes = new TextEncoder().encode(v);
          if (max !== undefined && max <= remaining && bytes.length > max) {
            return {
              path: filePath,
              ok: false,
              error: { code: "TOO_LARGE", message: `larger than maxBytesPerFile (${max})` },
            };
          }
          if (bytes.length > remaining) {
            return {
              path: filePath,
              ok: false,
              error: {
                code: "RESULT_TOO_LARGE",
                message: "the call's content budget is spent; read this path in another call",
              },
            };
          }
          remaining -= bytes.length;
          return { path: filePath, ok: true, content: encoding === "bytes" ? bytes : v };
        });
      }) as NonNullable<PluginFsApi["readFiles"]>,
      async mkdir(dirPath) {
        if (typeof dirPath !== "string" || dirPath.length === 0) {
          throw new Error(`Plugin "${pluginId}" fs.mkdir: path must be a non-empty string`);
        }
        refuseFileInChain(dirPath);
        // Recursive, like the host: every missing ancestor is created too.
        for (const dir of dirChain(dirPath)) fsDirs.add(dir);
        fsMkdirCalls.push(dirPath);
      },
      async appendFile(filePath, contents) {
        if (typeof contents !== "string") {
          throw new Error(`Plugin "${pluginId}" fs.appendFile: contents must be a string`);
        }
        const parent = parentOf(filePath);
        if (!mockDirExists(parent)) {
          if (!isMockDataDirPath(filePath)) {
            refuseFileAncestor(filePath);
            throw new Error(`ENOENT: mock fs: parent directory "${parent}" does not exist`);
          }
          refuseFileInChain(parent);
          for (const dir of dirChain(parent)) fsDirs.add(dir);
        }
        if (!fsFiles.has(filePath) && mockDirExists(filePath)) {
          throw fsWriteError("TARGET_UNAVAILABLE", `mock fs: "${filePath}" is not a regular file`);
        }
        fsFiles.set(filePath, (fsFiles.get(filePath) ?? "") + contents);
        fsAppendCalls.push({ path: filePath, contents });
      },
      async writeFile(filePath, contents, options) {
        // The checked-write contract (#12323), modelled just far enough for a
        // plugin's conflict path to be exercised: `expectedRevision` compares
        // against the stored text's revision, `null` means create-new.
        const existing = fsFiles.get(filePath);
        if (isMockDataDirPath(filePath)) refuseFileInChain(parentOf(filePath));
        else refuseFileAncestor(filePath);
        if (existing === undefined && mockDirExists(filePath)) {
          // Create-new sees any entry as taken; every other write fails on
          // the directory itself.
          if (options?.expectedRevision === null) {
            throw fsWriteError("TARGET_EXISTS", `mock fs: "${filePath}" already exists`);
          }
          throw new Error(`EISDIR: mock fs: "${filePath}" is a directory`);
        }
        if (options !== undefined) {
          const expected = options.expectedRevision;
          if (expected === null && existing !== undefined) {
            throw fsWriteError("TARGET_EXISTS", `mock fs: "${filePath}" already exists`);
          }
          if (typeof expected === "string") {
            if (existing === undefined) {
              throw fsWriteError("TARGET_UNAVAILABLE", `mock fs: "${filePath}" does not exist`);
            }
            const currentRevision = mockRevision(existing);
            if (currentRevision !== expected) {
              throw Object.assign(
                fsWriteError(
                  "REVISION_MISMATCH",
                  `mock fs: "${filePath}" changed since it was read`
                ),
                { currentRevision }
              );
            }
          }
        }
        fsFiles.set(filePath, contents);
        fsWriteCalls.push({ path: filePath, contents });
        return { revision: mockRevision(contents) };
      },
      async readdir(dirPath, options) {
        options?.signal?.throwIfAborted();
        // Derive entries from files written via writeFile whose parent directory
        // is `dirPath` (#10617). Previously always returned [], so a plugin that
        // wrote files then listed the dir saw nothing — a false-green gap. Each
        // immediate child name is reported once: a name with a deeper path
        // segment is a directory, a name that is itself a written file is a file
        // (basename only, like a real readdir).
        const prefix = dirPath.endsWith("/") ? dirPath : `${dirPath}/`;
        const isDir = new Map<string, boolean>();
        for (const made of fsDirs) {
          if (!made.startsWith(prefix)) continue;
          const rest = made.slice(prefix.length);
          const slash = rest.indexOf("/");
          const name = slash === -1 ? rest : rest.slice(0, slash);
          if (name.length > 0) isDir.set(name, true);
        }
        for (const filePath of fsFiles.keys()) {
          if (!filePath.startsWith(prefix)) continue;
          const rest = filePath.slice(prefix.length);
          const slash = rest.indexOf("/");
          if (slash === -1) {
            if (rest.length > 0 && !isDir.has(rest)) isDir.set(rest, false);
          } else {
            isDir.set(rest.slice(0, slash), true);
          }
        }
        const entries = [...isDir.entries()].map(([name, directory]) => ({
          name,
          isDirectory: directory,
          isFile: !directory,
          isSymbolicLink: false,
          // A detailed read promises size and mtime, so the mock supplies them
          // rather than letting a plugin that reads `entry.size` pass here and
          // fail against the real host. Written files have a real byte length;
          // directories carry no size, matching the production listing. There
          // are no symlinks to classify in an in-memory filesystem.
          ...(options?.detail === true &&
            !directory && { size: fsFiles.get(`${prefix}${name}`)?.length ?? 0 }),
          ...(options?.detail === true && { mtimeMs: 0 }),
        }));
        if (options?.detail !== true) return entries;
        // Same ordering the production listing applies: directories first, then
        // a numeric-aware name collation.
        const collator = new Intl.Collator(undefined, { numeric: true });
        return entries.sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return collator.compare(a.name, b.name);
        });
      },
      // Same validation, ordering, pruning and truncation as the host, over the
      // mock's files and directories. There is no git here, so
      // `respectGitignore` is accepted and has nothing to act on; nor are there
      // symlinks to skip.
      async walk(root: string, walkOptions?: PluginFsWalkOptions): Promise<PluginFsWalkResult> {
        const fail = (why: string): never => {
          throw new Error(`VALIDATION: plugin "${pluginId}" fs.walk: ${why}`);
        };
        if (typeof root !== "string" || root.length === 0) fail("root must be a non-empty string");
        if (
          walkOptions !== undefined &&
          (walkOptions === null || typeof walkOptions !== "object")
        ) {
          fail("options must be an object");
        }
        const opts = walkOptions ?? {};
        const patterns = (name: string, value: unknown): readonly string[] | null => {
          if (value === undefined) return null;
          if (!Array.isArray(value)) return fail(`${name} must be an array of glob strings`);
          if (value.length > MOCK_WALK_MAX_PATTERNS) {
            fail(`${name} takes at most ${MOCK_WALK_MAX_PATTERNS} patterns (got ${value.length})`);
          }
          if (value.some((p) => typeof p !== "string" || p.length === 0 || p.length > 1024)) {
            fail(`every ${name} pattern must be a non-empty string of at most 1024 characters`);
          }
          return value as string[];
        };
        const integer = (name: string, value: unknown, max: number, fallback: number): number => {
          if (value === undefined) return fallback;
          if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
            return fail(`${name} must be an integer from 1 to ${max}`);
          }
          return value;
        };
        const include = patterns("include", opts.include);
        const exclude = patterns("exclude", opts.exclude) ?? [];
        const maxDepth = integer(
          "maxDepth",
          opts.maxDepth,
          MOCK_WALK_MAX_DEPTH,
          MOCK_WALK_MAX_DEPTH
        );
        const limit = integer("limit", opts.limit, MOCK_WALK_MAX_LIMIT, MOCK_WALK_DEFAULT_LIMIT);
        for (const name of ["respectGitignore", "includeSize"] as const) {
          if (opts[name] !== undefined && typeof opts[name] !== "boolean") {
            fail(`${name} must be a boolean`);
          }
        }
        opts.signal?.throwIfAborted();
        const base = trimDir(root);
        if (!mockDirExists(base)) {
          throw new Error(`ENOENT: mock fs has no directory "${root}"`);
        }
        const prefix = base === "/" ? "/" : `${base}/`;
        const types = new Map<string, "file" | "dir">();
        const addDirs = (rel: string): void => {
          const parts = rel.split("/");
          for (let i = 1; i < parts.length; i++) types.set(parts.slice(0, i).join("/"), "dir");
        };
        for (const made of fsDirs) {
          if (!made.startsWith(prefix)) continue;
          const rel = made.slice(prefix.length);
          if (rel.length === 0) continue;
          addDirs(rel);
          types.set(rel, "dir");
        }
        for (const [filePath] of fsFiles) {
          if (!filePath.startsWith(prefix)) continue;
          const rel = filePath.slice(prefix.length);
          addDirs(rel);
          if (!types.has(rel)) types.set(rel, "file");
        }
        const matches = (list: readonly string[], rel: string): boolean =>
          list.some((pattern) => path.posix.matchesGlob(rel, pattern));
        const depthOf = (rel: string): number => rel.split("/").length;
        // Breadth-first, like the host: truncation keeps the shallowest entries.
        const candidates = [...types.entries()]
          .filter(([rel]) => depthOf(rel) <= maxDepth)
          .filter(([rel]) => {
            // An excluded entry is left out, and so is everything under an
            // excluded directory.
            const parts = rel.split("/");
            for (let i = 1; i <= parts.length; i++) {
              if (matches(exclude, parts.slice(0, i).join("/"))) return false;
            }
            return true;
          })
          .sort(([a], [b]) => depthOf(a) - depthOf(b) || compareWalkPaths(a, b));
        const entries: PluginFsWalkEntry[] = [];
        let truncated = false;
        for (const [rel, type] of candidates) {
          if (include !== null && !matches(include, rel)) continue;
          if (entries.length >= limit) {
            truncated = true;
            break;
          }
          const size =
            opts.includeSize === true && type === "file"
              ? new TextEncoder().encode(fsFiles.get(`${prefix}${rel}`) ?? "").length
              : undefined;
          entries.push(size === undefined ? { path: rel, type } : { path: rel, type, size });
        }
        entries.sort((a, b) => compareWalkPaths(a.path, b.path));
        return { entries, truncated };
      },
      async stat(targetPath, options) {
        options?.signal?.throwIfAborted();
        return {
          isDirectory: fsDirs.has(targetPath),
          isFile: fsFiles.has(targetPath),
          isSymbolicLink: false,
          size: fsFiles.get(targetPath)?.length ?? 0,
          mtimeMs: 0,
        };
      },
      async watch(paths, callback, options) {
        options?.signal?.throwIfAborted();
        // Mirror PluginService.createHost fs.watch validation order so a watch
        // call the production host would reject fails the mock the same way.
        if (typeof callback !== "function") {
          throw new Error(`Plugin "${pluginId}" fs.watch: callback must be a function`);
        }
        const recursive = options?.recursive;
        if (recursive !== undefined && typeof recursive !== "boolean") {
          throw new Error(`Plugin "${pluginId}" fs.watch: recursive must be a boolean`);
        }
        const debounceMs = options?.debounceMs;
        if (
          debounceMs !== undefined &&
          (typeof debounceMs !== "number" || !Number.isFinite(debounceMs) || debounceMs < 0)
        ) {
          throw new Error(
            `Plugin "${pluginId}" fs.watch: debounceMs must be a finite, non-negative number`
          );
        }
        const allowMissing = options?.allowMissing;
        if (allowMissing !== undefined && typeof allowMissing !== "boolean") {
          throw new Error(`Plugin "${pluginId}" fs.watch: allowMissing must be a boolean`);
        }
        if (!Array.isArray(paths) || paths.length === 0) {
          throw new Error(`Plugin "${pluginId}" fs.watch: paths must be a non-empty array`);
        }
        // Record the watcher so `simulateFsWatch` can fire it. The disposer
        // removes the record (idempotent) — once disposed the watcher no longer
        // receives simulated changes, and a pending debounced one is dropped.
        const record: MockFsWatcher = {
          paths: paths.map(trimDir),
          callback,
          recursive: recursive === true,
          // Same floor and ceiling as the host.
          debounceMs:
            debounceMs === undefined || debounceMs === 0
              ? 0
              : Math.min(Math.max(debounceMs, 50), 60_000),
          timer: null,
          pending: null,
        };
        fsWatchers.add(record);
        let disposed = false;
        return () => {
          if (disposed) return;
          disposed = true;
          if (record.timer !== null) clearTimeout(record.timer);
          record.timer = null;
          fsWatchers.delete(record);
        };
      },
    },
    // In-memory git mock. `commit` mirrors the host's #7880 guard — an empty
    // message rejects — so a plugin tested against the mock sees the same
    // no-silent-fallback contract as production.
    git: {
      async status(worktreePath, options) {
        options?.signal?.throwIfAborted();
        return { worktreePath, files: [], changedFileCount: 0 };
      },
      async diff(_worktreePath, _filePath, options) {
        options?.signal?.throwIfAborted();
        return "";
      },
      async add(_worktreePath, _paths, options) {
        options?.signal?.throwIfAborted();
      },
      async commit(worktreePath, options, callOptions): Promise<PluginGitCommitResult> {
        callOptions?.signal?.throwIfAborted();
        const message = typeof options?.message === "string" ? options.message : "";
        if (message.trim().length === 0) {
          throw new Error(
            `COMMIT_MESSAGE_REQUIRED: mock git.commit requires an explicit non-empty message`
          );
        }
        gitCommitCalls.push({ worktreePath, message });
        return { commit: `mock-${gitCommitCalls.length}`, message, preview: "" };
      },
    },
    // In-memory clipboard mock. `writeText` records the text and updates the
    // in-memory buffer `readText` returns, so a round-trip works in tests. No
    // capability gating is modeled (matches the fs/git mocks — gating lives in
    // PluginService and is unit-tested there); `readText` returns "" until the
    // first write, mirroring Electron's empty-clipboard behaviour.
    clipboard: {
      async writeText(text) {
        clipboardWriteCalls.push(text);
        clipboardText = text;
      },
      async writeImage(pngData) {
        clipboardWriteImageCalls.push(pngData.byteLength);
        // A real image write replaces the clipboard, so text no longer reads
        // back — leaving the buffer intact would let a test pass that the
        // real host would fail.
        clipboardText = "";
      },
      async readText() {
        return clipboardText;
      },
    },
    // Records only — a mock must never actually launch a file or open a
    // Finder window, which is exactly what the real implementation does.
    // Containment and capability gating live in PluginService and are unit
    // tested there, matching the fs/git/clipboard mocks.
    system: {
      async openPath(targetPath) {
        systemOpenPathCalls.push(targetPath);
      },
      async showItemInFolder(targetPath) {
        systemShowItemCalls.push(targetPath);
      },
      async openExternal(url) {
        const parsed = parsePluginExternalUrl(url);
        if (!parsed.ok) {
          throw new Error(`INVALID_URL: system.openExternal: ${parsed.reason}`);
        }
        systemOpenExternalCalls.push(parsed.link.href);
      },
    },
    // No Chromium here, so nothing is rendered: the call is recorded and a
    // placeholder PDF lands in the in-memory fs, so a plugin that reads,
    // lists or opens its export afterwards sees a file. Options go through
    // the real host's validator and an `htmlPath` must exist in the mock fs;
    // containment and gating live in the real host and are tested there.
    documents: {
      async renderPdf(options) {
        // The real host's own validator, so a plugin's export test fails on
        // exactly what Daintree refuses.
        validateRenderPdfOptions(pluginId, options);
        if (options.htmlPath !== undefined && !fsFiles.has(options.htmlPath)) {
          throw new Error(`INVALID_PATH: mock fs has no file "${options.htmlPath}"`);
        }
        documentsRenderPdfCalls.push({ ...options });
        const placeholder = `%PDF-1.4\n% createMockHost placeholder\n%%EOF\n`;
        fsFiles.set(options.outputPath, placeholder);
        return {
          path: options.outputPath,
          bytes: new TextEncoder().encode(placeholder).byteLength,
          revision: mockRevision(placeholder),
        };
      },
    },
    account: {
      getState: async () => ({ connected: accountToken !== null, identity: accountIdentity }),
      getAccessToken: async () => (accountToken ? { ...accountToken } : null),
      onDidChange(callback) {
        if (typeof callback !== "function") {
          throw new Error("account.onDidChange: callback must be a function");
        }
        const registered = (state: PluginAccountState): unknown => callback(state);
        accountSubs.add(registered);
        return () => {
          accountSubs.delete(registered);
        };
      },
    },
    // No disk and no network: an artifact is a record, its size the bytes the
    // mock fs or `artifactDownloads` held. Only argument shapes are checked —
    // capability, containment and URL scope are the real host's, tested there.
    artifacts: {
      async import(source, artifactOptions) {
        const filePath = source?.path;
        if (typeof filePath !== "string") {
          throw new Error("VALIDATION: mock artifacts.import: source.path must be a string");
        }
        const text = fsFiles.get(filePath);
        if (text === undefined) throw new Error(`INVALID_PATH: mock fs has no file "${filePath}"`);
        return mockArtifact(
          "import",
          artifactOptions?.name ?? filePath,
          new TextEncoder().encode(text).byteLength,
          artifactOptions
        );
      },
      async download(request, artifactOptions) {
        artifactOptions?.signal?.throwIfAborted();
        const body = options.artifactDownloads?.[request?.url];
        if (body === undefined) {
          throw new Error(
            `ARTIFACT_TRANSFER_FAILED: mock artifacts.download has no body for that URL`
          );
        }
        const size =
          typeof body === "string" ? new TextEncoder().encode(body).byteLength : body.byteLength;
        artifactOptions?.onProgress?.({ transferredBytes: size, totalBytes: size, attempt: 1 });
        const name = new URL(request.url).pathname.split("/").filter(Boolean).pop() ?? "artifact";
        return mockArtifact("download", artifactOptions?.name ?? name, size, artifactOptions);
      },
      async upload(artifactId, request, uploadOptions) {
        uploadOptions?.signal?.throwIfAborted();
        const artifact = artifacts.get(artifactId);
        if (!artifact) throw new Error(`ARTIFACT_NOT_FOUND: mock has no artifact "${artifactId}"`);
        const method = request?.method ?? "PUT";
        artifactUploadCalls.push({ artifactId, url: request.url, method });
        uploadOptions?.onProgress?.({
          transferredBytes: artifact.size,
          totalBytes: artifact.size,
          attempt: 1,
        });
        return { status: 200, headers: {}, body: "", bodyTruncated: false };
      },
      async stat(artifactId) {
        return artifacts.get(artifactId) ?? null;
      },
      async list(listOptions) {
        return [...artifacts.values()].filter(
          (a) => listOptions?.projectId === undefined || a.projectId === listOptions.projectId
        );
      },
      async release(artifactId) {
        return artifacts.delete(artifactId);
      },
    },
    settings,
    storage,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },

    registeredActions,
    registeredHandlers,
    broadcastCalls,
    postToPanelCalls,
    shownToasts,
    notifications,
    dispatchedActions,
    sentToActiveAgentCalls,
    sentToAgentCalls,
    runRecipeCalls,
    readScreenCalls,
    agentInputCalls,
    registeredForgeProviders,
    registeredFileDecorationProviders,
    registeredWorktreeSetupSteps,
    registeredSearchProviders,
    registeredContextProviders,
    registeredWorktreeDeleteNotesProviders,
    registeredMcpTools,
    invalidationCalls,
    setPanelBadgeCalls,
    setToolbarButtonBadgeCalls,
    setToolbarButtonStateCalls,
    setContextCalls,
    contextKeys,
    setWorktreeCardStatusCalls,
    worktreeCardStatuses,
    setWorktreeReviewChecksCalls,
    worktreeReviewChecks,
    setTerminalStatusCalls,
    terminalStatuses,
    startedTasks: tasks,
    setPanelActivityCalls,
    panelActivity,
    setPanelMenuItemsCalls,
    reloadPanelCalls,
    restartWorkerCalls,
    showQuickPickCalls,
    showInputBoxCalls,
    showConfirmCalls,
    spawnCalls,
    fsWriteCalls,
    fsAppendCalls,
    fsMkdirCalls,
    gitCommitCalls,
    clipboardWriteCalls,
    clipboardWriteImageCalls,
    systemOpenPathCalls,
    systemShowItemCalls,
    systemOpenExternalCalls,
    documentsRenderPdfCalls,
    artifactRecords: artifacts,
    artifactUploadCalls,
    simulateArtifactExpiry(artifactId) {
      artifacts.delete(artifactId);
    },
    subscriptionOptions,

    simulateActiveWorktreeChange(snapshot) {
      activeWorktree = snapshot;
      for (const cb of activeWorktreeSubs) cb(snapshot);
    },
    simulateWorktreesChange(snapshots) {
      worktrees = snapshots;
      for (const [cb, sub] of [...worktreesSubs]) {
        if (!worktreesSubs.has(cb)) continue;
        const { change, current } = mockWorktreeChange(sub.previous, snapshots);
        sub.previous = current;
        cb(snapshots, change);
      }
    },
    simulateWorktreesResult(result) {
      worktreesResult = result;
    },
    simulateAgentStateChange(snapshot) {
      lastAgentSnapshot = snapshot;
      for (const cb of agentStateSubs) cb(snapshot);
    },
    simulateTerminalLifecycleChange(event) {
      const projected = toPluginTerminalLifecycleEvent(event);
      if (projected === null) {
        throw new Error("simulateTerminalLifecycleChange: not a well-formed lifecycle event");
      }
      if (mockProjectId !== null && projected.workspaceId !== mockProjectId) return;
      for (const cb of [...terminalLifecycleSubs]) cb(projected);
    },
    simulatePanelLifecycleChange(event) {
      // Frozen like production delivery, so a plugin that mutates the event
      // fails in tests rather than in the wild.
      const frozen = Object.freeze({ ...event });
      if (frozen.phase === "removed") panelPhases.delete(frozen.panelId);
      else if (frozen.phase !== "restored") panelPhases.set(frozen.panelId, frozen);
      for (const cb of [...panelLifecycleSubs]) cb(frozen);
    },
    simulateListenersChange(channel, hasListeners) {
      const was = !unlistenedChannels.has(channel);
      if (hasListeners) unlistenedChannels.delete(channel);
      else unlistenedChannels.add(channel);
      if (was === hasListeners) return;
      for (const cb of [...(listenerSubs.get(channel) ?? [])]) cb(hasListeners);
    },
    simulateAccountChange(account) {
      if (account.connected) {
        accountToken = {
          accessToken: account.accessToken ?? accountToken?.accessToken ?? "mock-access-token",
          expiresAt: account.expiresAt ?? null,
        };
        accountIdentity = account.identity ?? null;
      } else {
        accountToken = null;
        accountIdentity = null;
      }
      const state = { connected: accountToken !== null, identity: accountIdentity };
      // One failing subscriber doesn't stop the rest, as in the real host.
      for (const cb of [...accountSubs]) {
        try {
          const result: unknown = cb({ ...state });
          if (result instanceof Promise) {
            result.catch((err: unknown) =>
              console.error("account.onDidChange callback failed", err)
            );
          }
        } catch (err) {
          console.error("account.onDidChange callback failed", err);
        }
      }
    },
    simulateTaskCancel(taskId) {
      const record = tasks.find((t) => t.id === taskId);
      if (!record || record.state !== "working" || !record.options.cancellable) {
        throw new Error(`simulateTaskCancel: "${taskId}" is not a running cancellable task`);
      }
      record.state = "cancelling";
      taskControllers.get(taskId)?.abort();
    },
    simulateSystemWake(event) {
      // Frozen like production delivery, for the same reason.
      const frozen = Object.freeze({ ...event });
      for (const cb of [...systemWakeSubs]) cb(frozen);
    },
    setDispatchResult(actionId, result) {
      dispatchOverrides.set(actionId, result);
    },
    seedActionCatalog(entries) {
      actionCatalog.clear();
      for (const entry of entries) actionCatalog.set(entry.id, entry);
    },
    simulateFsWatch(changedPath) {
      // Snapshot before firing so a callback that registers/disposes a watcher
      // doesn't mutate the set mid-iteration.
      for (const record of [...fsWatchers]) {
        if (!fsWatchers.has(record)) continue;
        // The paths the real watcher would report: the watched path itself, a
        // direct child, or — only for a recursive watch — anything beneath it.
        const covered = record.paths.some(
          (watched) =>
            changedPath === watched ||
            parentOf(changedPath) === watched ||
            (record.recursive && changedPath.startsWith(watched === "/" ? "/" : `${watched}/`))
        );
        if (!covered) continue;
        if (record.debounceMs === 0) {
          record.callback(changedPath);
          continue;
        }
        // One trailing callback per burst, carrying the latest path — drive it
        // with fake timers or a real wait.
        record.pending = changedPath;
        if (record.timer !== null) clearTimeout(record.timer);
        record.timer = setTimeout(() => {
          record.timer = null;
          const latest = record.pending;
          record.pending = null;
          if (latest !== null && fsWatchers.has(record)) record.callback(latest);
        }, record.debounceMs);
      }
    },
    simulateQuickPickResponse(result) {
      quickPickResponse = result;
    },
    simulateInputBoxResponse(result) {
      inputBoxResponse = result;
    },
    simulateConfirmResponse(result) {
      confirmResponse = result;
    },
    simulateAgentsChange(agents) {
      agentPanes = agents;
    },
    simulateAgentLaunched(terminalId) {
      launchedAgents.add(terminalId);
    },
    simulateAllAgentsChange(snapshot) {
      allAgentsSnapshot = normalizePluginAllAgentsSnapshot(snapshot);
      for (const cb of [...allAgentsSubs]) cb(allAgentsSnapshot);
    },
    simulateFocusedPanelChange(focus) {
      focusedPanel = toPluginFocusedPanel(focus);
      for (const cb of [...focusedPanelSubs]) cb(focusedPanel);
    },
    simulateProjectPresenceChange(change) {
      const presence = toPluginProjectPresence(change);
      if (!presence) {
        throw new Error(
          "simulateProjectPresenceChange: expected { projectId, state: foreground | background | closed }"
        );
      }
      if (presence.state === "closed") projectPresence.delete(presence.projectId);
      else projectPresence.set(presence.projectId, presence.state);
      for (const cb of [...projectPresenceSubs]) cb(presence);
    },
    simulateSendToAgentPick(terminalId) {
      sendToAgentPick = terminalId;
    },
    simulateRunRecipeResult(result) {
      runRecipeResult = { ...result };
    },
    simulateTerminalScreen(terminalId, screen) {
      if (screen === null) terminalScreens.delete(terminalId);
      else terminalScreens.set(terminalId, screen);
    },
  };

  return host;
}

/**
 * Value equality matching `PluginSettingsStore.valuesEqual`: reference-equal or
 * JSON-equal. Used by the storage mock so its change detection (and therefore
 * its onDidChange firing) matches the real store rather than reference identity.
 */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
