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

// The recorded-call, state and option types of `createMockHost`. Types only,
// so the SDK's declaration bundle and the facets share them without pulling
// any implementation along.

import type { VettedPluginTaskStart } from "../../utils/pluginTasks.js";
import type {
  ActionDispatchResult,
  ActionId,
  PluginActionManifestEntry,
} from "../../types/actions.js";
import type {
  FileDecorationProviderDescriptor,
  FileDecorationProviderImpl,
  ForgeProviderDescriptor,
  AnyForgeProviderImpl,
} from "../../types/forge.js";
import type {
  ContextProviderDescriptor,
  ContextProviderImpl,
} from "../../types/pluginContextProvider.js";
import type { PluginServiceCallContext } from "../../types/pluginServices.js";
import type { NotificationType } from "../../types/notification.js";
import type {
  ActionHandler,
  PluginSearchProvider,
  PanelMenuItemContribution,
  PluginActionContribution,
  PluginRenderPdfOptions,
  PluginArtifact,
  PluginConfirmOptions,
  PluginHostApi,
  PluginDispatchOptions,
  PluginInputBoxOptions,
  PluginIpcHandler,
  PluginMcpToolDefinition,
  PluginProcessSpawnOptions,
  PluginDuplexProcessSpawnOptions,
  PluginPtyProcessSpawnOptions,
  PluginQuickPickItem,
  PluginQuickPickOptions,
  PluginNotifyOptions,
  PluginTaskProgress,
  PluginTaskResult,
  PluginWorktreeSnapshot,
  PluginWorktreeSetupStepHandler,
  PluginWorktreesResult,
  PluginAgentSnapshot,
  PluginTerminalLifecycleEvent,
  PluginAgentPane,
  PluginAllAgentsSnapshot,
  PluginFocusedPanel,
  PluginProjectPresence,
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
} from "../../types/plugin.js";

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
 * outcome the plugin finished with — or `"interrupted"` once
 * {@link MockHostState.simulateTaskInterrupt} stopped it, after which nothing
 * the plugin does changes it.
 */
export interface MockTaskRecord {
  readonly id: string;
  readonly options: VettedPluginTaskStart;
  state: "working" | "cancelling" | "succeeded" | "failed" | "cancelled" | "interrupted";
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

/** A service bound through `host.registerService`; call its `handlers` directly to test them. */
export interface RegisteredServiceRecord {
  name: string;
  handlers: Record<string, unknown>;
}

/** One `host.services.call` the plugin made, in order. */
export interface ServiceCallRecord {
  name: string;
  method: string;
  args: unknown;
}

/** Another plugin's service, as `CreateMockHostOptions.services` stands it in. */
export interface MockServiceProvider {
  /** What `services.status` reports. Defaults to `"1.0.0"`. */
  version?: string;
  capabilities?: string[];
  /** Run for `host.services.call`, with this plugin as the caller. */
  methods: Record<string, (args: unknown, ctx: PluginServiceCallContext) => unknown>;
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
  /** Live `host.registerService` bindings, one per service name. */
  readonly registeredServices: ReadonlyArray<RegisteredServiceRecord>;
  /** Every `host.services.call`, in order, whatever it answered. */
  readonly serviceCalls: ReadonlyArray<ServiceCallRecord>;
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
   * Interrupt a running task as the host does when the plugin unloads,
   * restarts or crashes: the task turns `"interrupted"` and its `signal`
   * aborts with the `"interrupted"` cause. A later `report` or `finish` is
   * ignored. Throws for a task that isn't running.
   */
  simulateTaskInterrupt(taskId: string): void;

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
    account: (
      | ({ connected: true; identity?: string | null } & Partial<PluginAccountAccessToken>)
      | { connected: false }
    ) & {
      /** Which connection changes. Defaults to `"default"`, `contributes.account`'s. */
      connection?: string;
    }
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
   * Other plugins' services, by full name, that `host.services.call` and
   * `status` reach. A name not listed answers `unavailable`, as a provider that
   * isn't installed does. The mock has no manifest model, so it never answers
   * `not-declared` or `incompatible`.
   */
  services?: Record<string, MockServiceProvider>;
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
   * `schemaVersions` declares a `schemaVersion` per id, so a writable open
   * whose migrations disagree with it fails `VALIDATION` here as it does in
   * the real host.
   */
  databases?: {
    directory?: string;
    declared?: readonly string[];
    journalMode?: "delete" | "wal";
    schemaVersions?: Readonly<Record<string, number>>;
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
   * models a plugin that declares `contributes.account`, or with `connection`
   * one of its `contributes.connections`; a call without `ref.connection`
   * reads `"default"`. It has no project bindings.
   */
  account?: {
    connection?: string;
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

export type MockHost = PluginHostApi & MockHostState;
