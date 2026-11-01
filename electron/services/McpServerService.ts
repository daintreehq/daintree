// eager-import-allow: reads MCP server settings via store.get synchronously during service init
import { randomUUID } from "node:crypto";
import { store } from "../store.js";
import { CHANNELS } from "../ipc/channels.js";
import type { WindowRegistry } from "../window/WindowRegistry.js";
import { getWindowRegistry } from "../window/windowRef.js";
import { getSystemSleepService } from "./SystemSleepService.js";
import type {
  ActiveBearerRecord,
  AssistantTurnRecord,
  DisconnectBearerResult,
  HelpSessionBearerRecord,
  McpAuditRecord,
  McpAuditRecordQuery,
  McpAuditStats,
  McpDispatchHoldPhase,
  McpDispatchHoldResult,
  McpGrantLifecyclePayload,
  McpIssueGrantResult,
  McpIssueNativeGrantResult,
  McpLogRecord,
  McpRevokeNativeGrantResult,
  McpRevokeGrantResult,
  McpRuntimeSnapshot,
  McpRuntimeState,
  TerminalAdoptionEntry,
  TerminalAdoptionRefusal,
  TerminalAdoptionResult,
  TurnOutcomeClass,
} from "../../shared/types/ipc/mcpServer.js";
import { SessionStore } from "./mcp-server/sessionStore.js";
import { readClosedPanelProcess } from "./mcp-server/closedPanelProcesses.js";
import {
  resolveClosedTerminalGeneration,
  waitForClosedPanelExits,
} from "./mcp-server/closedPanelExits.js";
import { getLifecycleLedger } from "./pty/lifecycleLedger.js";
import { readPtyTerminalProcesses } from "./mcp-server/worktreeProcessGuard.js";
import { readWorktreeGitObservation } from "./mcp-server/worktreeRetirementGit.js";
import {
  helpOwnershipPrincipal,
  principalOwnerKey,
  relayOwnershipPrincipal,
} from "./mcp-server/resourceOwnership.js";
import { readRunAssistantWork, type RunAssistantWork } from "./mcp-server/workerCreationHistory.js";
import type { TerminalAdoptionRecord } from "./mcp-server/terminalAdoption.js";
import { LOCAL_HOST_ID } from "../../shared/types/remoteHosts.js";
import { getAgentAvailabilityStore } from "./AgentAvailabilityStore.js";
import { isGlobalAssistantId } from "../../shared/config/globalAssistant.js";
import { isTierPermitted } from "./mcp-server/tierAuth.js";
import type { OrchestratorPaneIdentity } from "./McpPaneConfigService.js";
import { AuditService, type McpAuditDiagnosticsSnapshot } from "./mcp-server/auditLog.js";
import { TurnOutcomeService } from "./mcp-server/turnOutcomeLog.js";
import { createRendererBridge } from "./mcp-server/rendererBridge.js";
import { onMcpDriveTargetChange } from "./mcp-server/driveTarget.js";
import { getEndpointRegistry } from "../ipc/endpointRegistry.js";
import { onRendererScopeChanged } from "../window/webContentsRegistry.js";
import { handleWaitUntilIdle, handleWaitUntilIdleBatch } from "./mcp-server/waitUntilIdle.js";
import { handleSkillsSearch, handleSkillsLoad } from "./mcp-server/skills.js";
import { handleProjectRunCheck } from "./mcp-server/projectCheck.js";
import { handleProjectRunCommand } from "./mcp-server/projectCommand.js";
import {
  handleTerminalGetStatusViewless,
  isAgentPaneInWorkspace,
} from "./mcp-server/terminalStatus.js";
import { handleTerminalReadLastMessageOwned } from "./mcp-server/terminalLastMessage.js";
import {
  TerminalNotifyService,
  helpNotifyKey,
  paneNotifyKey,
  relayNotifyKey,
  type LaneWake,
  type OwnPane,
} from "./mcp-server/terminalNotify.js";
import type { ListenerRoute } from "./mcp-server/listenerHold.js";
import { ReplyWaiterService } from "./mcp-server/replyWaiter.js";
import { createApprovalWake } from "./mcp-server/approvalWake.js";
import type { AssistantApproval } from "./mcp-server/noticeFormat.js";
import type { PaneNotifyState } from "../../shared/types/terminalNotify.js";
import { broadcastToProjectRenderers } from "../ipc/utils.js";
import { cleanupResourceSubscriptions } from "./mcp-server/sessionServer.js";
import { HttpLifecycle, sendToPinnedView } from "./mcp-server/httpLifecycle.js";
import { AbusePolicy } from "./mcp-server/abusePolicy.js";
import { WorkspaceViewLeaseRegistry } from "./mcp-server/workspaceViewLease.js";
import { routedViewWorktreePort } from "./mcp-server/worktreeViewPort.js";
import { createPluginMcpRoute } from "./pluginAgentMcp/pluginMcpRoute.js";
import {
  observeAssistantPluginToolCall,
  type AssistantPluginLane,
} from "./mcp-server/assistantPluginActivity.js";
import type * as PluginServiceModule from "./PluginService.js";
import { getPtyClient, setMcpServerServiceRef } from "../window/serviceRefs.js";
import { machineDisplayName } from "../utils/machineName.js";
import type {
  PendingRequest,
  DispatchEnvelope,
  HelpTokenValidator,
  HelpSessionWebContentsResolver,
  HelpSessionViewlessProjectResolver,
  HelpSessionActionContextResolver,
  HelpSessionIdResolver,
  PaneWorkspaceBindingResolver,
  PaneOwnershipPrincipalResolver,
  PaneTerminalResolver,
  HelpSessionTerminalResolver,
  AssistantControlBinding,
} from "./mcp-server/shared.js";
import type { ActionManifestEntry } from "../../shared/types/actions.js";
import { events } from "./events.js";
import { wireMcpServerToConnectivityRegistry } from "./connectivity/index.js";

// PluginService is loaded lazily, like every other main-side caller: it pulls in
// the whole plugin host, and only a request on the plugin MCP route needs it.
type PluginServiceSingleton = typeof PluginServiceModule.pluginService;
let pluginServicePromise: Promise<PluginServiceSingleton> | null = null;
/** Read once: a Mac's computer name costs a subprocess. */
let localMachineName: string | undefined;
function loadPluginService(): Promise<PluginServiceSingleton> {
  pluginServicePromise ??= import("./PluginService.js").then(
    (m) => m.pluginService,
    (err: unknown) => {
      pluginServicePromise = null;
      throw err;
    }
  );
  return pluginServicePromise;
}

type ContributedServerEndpointsInstance =
  import("./pluginAgentMcp/contributedServerEndpoint.js").ContributedServerEndpoints;
let contributedServerEndpointsPromise: Promise<ContributedServerEndpointsInstance> | null = null;

/**
 * Register a plugin's agentMcp endpoint that serves tools from its own
 * contributed MCP server, on the first list or call that needs it. The adapter
 * and the supervisor load only for an instance that declares one.
 */
async function ensureContributedServerEndpoint(
  pluginService: PluginServiceSingleton,
  pluginInstanceId: string
): Promise<void> {
  if (!pluginService.findAgentMcpServerSource(pluginInstanceId)) return;
  contributedServerEndpointsPromise ??= Promise.all([
    import("./pluginAgentMcp/contributedServerEndpoint.js"),
    import("./PluginMcpSupervisor.js"),
  ]).then(
    ([adapter, supervisor]) =>
      new adapter.ContributedServerEndpoints({
        findSource: (id) => pluginService.findAgentMcpServerSource(id),
        resolveSettings: (id, settingId) => pluginService.resolveSettingTemplate(id, settingId),
        supervisor: supervisor.getPluginMcpSupervisor(),
      }),
    (err: unknown) => {
      contributedServerEndpointsPromise = null;
      throw err;
    }
  );
  try {
    await (await contributedServerEndpointsPromise).ensure(pluginInstanceId);
  } catch (err) {
    // An endpoint whose server can't be served has no roster, which the
    // session reads as no tools; the reason stays in the main-process log.
    console.error(
      `[PluginAgentMcp] contributed MCP server for "${pluginInstanceId}" could not be served:`,
      err
    );
  }
}

// Re-export types for backward compatibility with existing importers.
export type { HelpTokenValidator } from "./mcp-server/shared.js";
export type McpAuthClass = import("./mcp-server/shared.js").McpAuthClass;
export type McpTier = import("./mcp-server/shared.js").McpTier;
type HelpAssistantTier = import("../../shared/types/ipc/maps.js").HelpAssistantTier;
export type { ListenerRoute } from "./mcp-server/listenerHold.js";

/**
 * A feature's hold on the loopback listener and the terminal wake engine
 * (#15999), from {@link McpServerService.holdListener}.
 */
export interface McpListenerHold {
  /** The listener's port while it is open for this hold; null otherwise. */
  readonly port: number | null;
  /**
   * Queue a wake on `pane`'s notice line, accepted whether or not the server
   * is on; outcomes reach `wake.report` as {@link McpServerService.queueLaneWake}'s do.
   */
  queueWake(pane: OwnPane, projectId: string, wake: LaneWake): void;
  /** Idempotent. Ends the hold's queued wakes and, with the server off, closes a listener only it held. */
  release(): Promise<void>;
}

export class McpServerService {
  // Mutable reference updated by start(); read by bridge's getActiveProjectWebContents.
  private _registry: WindowRegistry | null = null;

  private readonly sessionStore: SessionStore;
  private readonly auditService: AuditService;
  private readonly turnOutcomeService: TurnOutcomeService;
  private readonly httpLifecycle: HttpLifecycle;
  /** Notices an orchestrating pane asked for, and the lines that deliver them. */
  private readonly terminalNotify: TerminalNotifyService;
  private readonly replyWaiter: ReplyWaiterService;
  /**
   * Resolver injected by `HelpSessionService` after construction. Returns
   * the help-session id bound to a terminal id, or null when the terminal
   * isn't a help session. Held as a function so the MCP service doesn't
   * import `HelpSessionService` (which would create a cycle).
   */
  private getSessionIdForTerminal: (terminalId: string) => string | null = () => null;
  /**
   * The Daintree Assistant lane a terminal serves, for reporting its plugin
   * tool calls. Injected by whoever launches the Assistant, for the same
   * reason as the resolver above.
   */
  private resolveAssistantPluginLane: (terminalId: string) => AssistantPluginLane | null = () =>
    null;
  private readonly pendingManifests = new Map<string, PendingRequest<ActionManifestEntry[]>>();
  private readonly pendingDispatches = new Map<string, PendingRequest<DispatchEnvelope>>();
  private readonly cleanupListeners: Array<() => void> = [];
  /**
   * Long-lived event subscriptions (agent state, agent output, terminal
   * lifecycle) that must survive `HttpLifecycle.stop()` / restart. Kept
   * separate from `cleanupListeners` because that array is owned by
   * `HttpLifecycle` and zeroed on every stop or unexpected close —
   * placing these subscriptions there would silently disable turn-outcome
   * recording the first time the MCP server restarts.
   */
  private readonly persistentListeners: Array<() => void> = [];
  private hostBridgeListenersInstalled = false;
  private readonly bridge;
  /**
   * Views with an MCP operation in flight (#11790). Instance-owned rather than
   * module-global so the service-class suites, which construct several
   * instances, cannot leak leases into one another.
   */
  private readonly viewLeases = new WorkspaceViewLeaseRegistry();
  /** Live holds' wake scopes, ended at shutdown along with everything else. */
  private readonly heldWakeScopes = new Set<() => void>();
  private readonly statusListeners = new Set<(running: boolean) => void>();
  private readonly runtimeStateListeners = new Set<(snapshot: McpRuntimeSnapshot) => void>();

  constructor() {
    this.auditService = new AuditService(
      (patch) => this.persistConfig(patch),
      () => this.getConfig()
    );

    // AbusePolicy must be constructed BEFORE SessionStore so the
    // store can call into it on every per-session cleanup hook. The
    // `dropAbuseState` callback ties the policy's denial counter map
    // to the same lifecycle as the rest of the per-session state.
    const abusePolicy = new AbusePolicy({
      readConfig: () => this.getConfig(),
    });

    this.sessionStore = new SessionStore(
      (sessionId) => {
        cleanupResourceSubscriptions(sessionId, this.sessionStore);
      },
      {
        emitGrantLifecycle: (sessionId, payload) => this.emitGrantLifecycle(sessionId, payload),
        launchGenerationOf: (terminalId) => getPtyClient()?.getLaunchGeneration(terminalId) ?? null,
        dropAbuseState: (sessionId) => abusePolicy.dropSession(sessionId),
        // The live bearer register is owned by `httpLifecycle` (created
        // below). The closure defers the reference until teardown time, by
        // which point the field is assigned. Mirrors `dropAbuseState`.
        dropBearerState: (sessionId) => this.httpLifecycle.detachBearerSession(sessionId),
        onTierDecayed: (sessionId, previousTier, newTier) => {
          // Tier just decayed to its pre-elevation baseline (#8462). Push a
          // tools/list_changed so the model re-fetches the now-narrowed
          // manifest instead of calling a tool it no longer has. The
          // session map is the freshness check — a transport closing
          // between the lookup and the send rejects harmlessly.
          const session =
            this.sessionStore.httpSessions.get(sessionId) ??
            this.sessionStore.sessions.get(sessionId);
          session?.server.sendToolListChanged().catch(() => {
            // Transport already closing/closed — the model will see the
            // narrowed surface on its next list call regardless.
          });
          // Positive audit trail for the decay (#9151): the elevation window
          // closed and access narrowed back to the baseline. Best-effort —
          // an audit-write failure must never block the tier rollback.
          try {
            this.auditService.appendGrantRecord({
              type: "tier.decayed",
              sessionId,
              toolId: "*",
              ttlMs: 0,
              previousTier,
              tier: newTier,
            });
          } catch (err) {
            console.error("[MCP] Failed to append tier.decayed audit record:", err);
          }
        },
      }
    );

    this.turnOutcomeService = new TurnOutcomeService({
      saveConfig: (patch) => this.persistConfig(patch),
      readConfig: () => this.getConfig(),
      getSessionIdForTerminal: (terminalId) => this.getSessionIdForTerminal(terminalId),
      getRecentAuditRecords: () => this.auditService.getRecords(),
    });

    const offStateChanged = events.on("agent:state-changed", (payload) => {
      const terminalId = payload.terminalId;
      if (!terminalId) return;
      this.turnOutcomeService.handleTransition({
        terminalId,
        state: payload.state,
        previousState: payload.previousState,
        trigger: payload.trigger,
        timestamp: payload.timestamp,
      });
    });
    this.persistentListeners.push(offStateChanged);

    const offOutput = events.on("agent:output", (payload) => {
      if (!payload.terminalId) return;
      this.turnOutcomeService.appendOutput(payload.terminalId, payload.data);
    });
    this.persistentListeners.push(offOutput);

    const offTrashed = events.on("terminal:trashed", (payload) => {
      this.turnOutcomeService.dropTerminal(payload.id);
      // Trashing is the user putting the terminal away; restoring it later
      // does not restore a hand-over they never repeated (#12490).
      this.sessionStore.terminalAdoption.release(payload.id);
    });
    this.persistentListeners.push(offTrashed);

    const offExited = events.on("terminal:exited", (payload) => {
      this.turnOutcomeService.dropTerminal(payload.terminalId);
    });
    this.persistentListeners.push(offExited);

    try {
      getSystemSleepService().onWake(() => {
        this.sessionStore.recomputeIdleTimers();
      });
    } catch {
      // SystemSleepService may not be initialized yet at early startup.
    }

    this.bridge = createRendererBridge(
      this.pendingManifests,
      this.pendingDispatches,
      () => this._registry,
      this.viewLeases,
      routedViewWorktreePort
    );

    // Subscribes to the bus and the pty-host only while a pane has a notice pending.
    this.terminalNotify = new TerminalNotifyService({
      getPtyClient: () => getPtyClient(),
      onStateChanged: (listener) =>
        events.on("agent:state-changed", (payload) => listener(payload)),
      onKilled: (listener) =>
        events.on("agent:killed", (payload) => {
          if (payload.terminalId) listener(payload.terminalId);
        }),
      onTrashed: (listener) => events.on("terminal:trashed", (payload) => listener(payload.id)),
      onHandbackObserved: (listener) =>
        events.on("agent:handback-observed", (payload) =>
          listener(payload.terminalId, payload.handback, payload.code, payload.lastStateChange)
        ),
      isEnabled: () => this.isEnabled(),
      publish: (projectId, state) =>
        broadcastToProjectRenderers(projectId, CHANNELS.EVENTS_PUSH, {
          name: "terminal:notify-state",
          payload: state,
        }),
    });

    this.replyWaiter = new ReplyWaiterService({
      getPtyClient: () => getPtyClient(),
      onStateChanged: (listener) =>
        events.on("agent:state-changed", (payload) => listener(payload)),
      onHandbackObserved: (listener) =>
        events.on("agent:handback-observed", (payload) =>
          listener(payload.terminalId, payload.handback, payload.code)
        ),
      onKilled: (listener) =>
        events.on("agent:killed", (payload) => {
          if (payload.terminalId) listener(payload.terminalId);
        }),
      onTrashed: (listener) => events.on("terminal:trashed", (payload) => listener(payload.id)),
    });

    this.httpLifecycle = new HttpLifecycle({
      sessionStore: this.sessionStore,
      auditService: this.auditService,
      turnOutcomeService: this.turnOutcomeService,
      abusePolicy,
      requestManifest: () => this.bridge.requestManifest(),
      dispatchAction: (actionId, args, confirmed, callerInfo, sessionOrigin, authorization) =>
        this.bridge.dispatchAction(
          actionId,
          args,
          confirmed,
          callerInfo,
          sessionOrigin,
          authorization
        ),
      requestManifestForWebContents: (id) => this.bridge.requestManifestForWebContents(id),
      dispatchActionForWebContents: (
        id,
        actionId,
        args,
        confirmed,
        contextOverride,
        sessionOrigin,
        approval
      ) =>
        this.bridge.dispatchActionForWebContents(
          id,
          actionId,
          args,
          confirmed,
          contextOverride,
          sessionOrigin,
          approval
        ),
      requestManifestForWorkspace: (workspaceId, preferredWebContentsId) =>
        this.bridge.requestManifestForWorkspace(workspaceId, preferredWebContentsId),
      noteToolListRoute: (sessionId, workspaceId, preferredWebContentsId) =>
        this.sessionStore.toolListRouteWatch.noteListed(sessionId, () =>
          this.bridge.describeWorkspaceRoute(workspaceId, preferredWebContentsId)
        ),
      dispatchActionForWorkspace: (
        workspaceId,
        actionId,
        args,
        confirmed,
        sessionOrigin,
        options
      ) =>
        this.bridge.dispatchActionForWorkspace(
          workspaceId,
          actionId,
          args,
          confirmed,
          sessionOrigin,
          options
        ),
      dispatchActionWithoutView: (workspaceId, actionId, args, confirmed, sessionOrigin, options) =>
        this.bridge.dispatchActionWithoutView(
          workspaceId,
          actionId,
          args,
          confirmed,
          sessionOrigin,
          options
        ),
      // Deliberately not this session's own route (#12315): a reveal runs in
      // the view that is being replaced, in the window that already holds the
      // destination workspace.
      revealOwnedRun: (
        workspaceId,
        actionId,
        args,
        confirmed,
        sessionOrigin,
        preferredWebContentsId
      ) =>
        this.bridge.revealOwnedRun(
          workspaceId,
          actionId,
          args,
          confirmed,
          sessionOrigin,
          preferredWebContentsId
        ),
      resolveWorkspaceBinding: (workspaceId) => this.bridge.resolveWorkspaceBinding(workspaceId),
      handleWaitUntilIdle: (rawArgs, signal, options) =>
        handleWaitUntilIdle(rawArgs, signal, options),
      handleWaitUntilIdleBatch: (rawArgs, signal, options) =>
        handleWaitUntilIdleBatch(rawArgs, signal, options),
      handleSkillsSearch: (rawArgs, visibility) => handleSkillsSearch(rawArgs, visibility),
      handleSkillsLoad: (rawArgs, visibility) => handleSkillsLoad(rawArgs, visibility),
      handleProjectRunCheck: (rawArgs, signal, authorize) =>
        handleProjectRunCheck(rawArgs, signal, authorize),
      handleProjectRunCommand: (rawArgs, signal, authorize) =>
        handleProjectRunCommand(rawArgs, signal, authorize),
      handleTerminalGetStatusViewless: (rawArgs, workspaceId, admittedAssistants) =>
        handleTerminalGetStatusViewless(rawArgs, workspaceId, admittedAssistants),
      machineName: () => (localMachineName ??= machineDisplayName()),
      readCodexQuota: async () => {
        const { readCodexQuota } = await import("./codex/CodexQuotaService.js");
        return readCodexQuota();
      },
      handleTerminalReadLastMessageOwned: (terminalId, options, signal) =>
        handleTerminalReadLastMessageOwned(terminalId, options, signal),
      // The pty-host's own spawn tracking spans every view, which is what a
      // collision check needs: a panel store only knows its own (#12407).
      isTerminalIdInUse: (terminalId) => getPtyClient()?.hasTerminal(terminalId) ?? false,
      // `getTerminalAsync` answers null for a failed read as well as an unknown
      // id, so the id is checked first: null for a tracked terminal is a read
      // that failed, and the assistant's close must ask rather than assume idle.
      readTerminalCloseContext: async (terminalId) => {
        const client = getPtyClient();
        if (!client) throw new Error("The pty host is not available.");
        if (!client.hasTerminal(terminalId)) return null;
        const info = await client.getTerminalAsync(terminalId);
        if (info === null) throw new Error(`Could not read terminal '${terminalId}'.`);
        return {
          ...(info.agentState !== undefined ? { agentState: info.agentState } : {}),
          ...(info.lastHandback !== undefined ? { lastHandback: info.lastHandback } : {}),
          ...(info.lastTypedInputAt !== undefined
            ? { lastTypedInputAt: info.lastTypedInputAt }
            : {}),
        };
      },
      // Strict, so a pty-host slow to answer reads as unknown, never as a
      // process that is gone or still running.
      readClosedPanelProcess: (terminalId) =>
        readClosedPanelProcess(terminalId, async (id) => {
          const client = getPtyClient();
          return client ? client.getTerminalAsync(id, undefined, { strict: true }) : null;
        }),
      readTerminalProcesses: () => readPtyTerminalProcesses(getPtyClient()),
      readWorktreeGit: (worktreePath, signal) => readWorktreeGitObservation(worktreePath, signal),
      terminalGenerationOf: (terminalId) => {
        const client = getPtyClient();
        if (!client) return undefined;
        return resolveClosedTerminalGeneration(terminalId, {
          liveGeneration: (id) => client.getLiveGeneration(id),
          latestExitGeneration: (id) => client.recentExits.latestGeneration(id),
          ledgerEntry: (id) => getLifecycleLedger().getEntry(id),
        });
      },
      // Running ones, and ones whose exit main kept, which a panel may still show.
      trackedTerminalIds: () => {
        const client = getPtyClient();
        return client
          ? [...new Set([...client.getTrackedTerminalIds(), ...client.recentExits.terminalIds()])]
          : [];
      },
      // From exits main kept and the host's own records, never a guess: a
      // record gone with no exit seen, or a host that never answered, is
      // unknown.
      waitForClosedPanelExits: (targets, options) => {
        const client = getPtyClient();
        if (!client) {
          return Promise.resolve({
            processes: targets.map(({ terminalId }) => ({
              terminalId,
              outcome: "unknown" as const,
              ...(options.endGrace ? { graceEnded: false } : {}),
            })),
          });
        }
        return waitForClosedPanelExits(targets, options, {
          findExit: (id, generation) => client.recentExits.find(id, generation),
          onExit: (listener) => client.recentExits.onExit(listener),
          readRecord: (id) => client.getTerminalAsync(id, undefined, { strict: true }),
          endTrashGrace: (id, generation) => client.endTrashGrace(id, generation),
        });
      },
      isAgentPaneInWorkspace: (terminalId, workspaceId) =>
        isAgentPaneInWorkspace(getPtyClient(), terminalId, workspaceId),
      terminalNotify: this.terminalNotify,
      replyWaiter: this.replyWaiter,
      getCachedManifest: () => this.bridge.getCachedManifest(),
      getCachedManifestForWebContents: (id) => this.bridge.getCachedManifestForWebContents(id),
      getCachedManifestForWorkspace: (workspaceId, preferredWebContentsId) =>
        this.bridge.getCachedManifestForWorkspace(workspaceId, preferredWebContentsId),
      clearCachedManifest: () => this.bridge.clearCache(),
      cleanupListeners: this.cleanupListeners,
      pendingManifests: this.pendingManifests,
      pendingDispatches: this.pendingDispatches,
      setupIpcListeners: () => {
        this.bridge.setupListeners(this.cleanupListeners);
        // Everything a bound session's route is read from: the drive lease,
        // the endpoints that can hold it, and this machine's own views.
        const recheckRoutes = () => this.sessionStore.toolListRouteWatch.check();
        this.cleanupListeners.push(
          onMcpDriveTargetChange(recheckRoutes),
          getEndpointRegistry().onChange(recheckRoutes),
          onRendererScopeChanged(recheckRoutes)
        );
      },
      emitStatusChange: () => this.emitStatusChange(),
      emitRuntimeStateChange: () => this.emitRuntimeStateChange(),
      setConfig: (patch) => this.persistConfig(patch),
    });

    this.httpLifecycle.setPluginRouteHandler(
      createPluginMcpRoute({
        isPluginLoaded: async (pluginInstanceId) =>
          (await loadPluginService()).hasPlugin(pluginInstanceId),
        activatePlugin: async (pluginInstanceId) => {
          const pluginService = await loadPluginService();
          await pluginService.activatePlugin(pluginInstanceId);
          await ensureContributedServerEndpoint(pluginService, pluginInstanceId);
        },
        observeToolCall: (grant, toolName, argNames) =>
          observeAssistantPluginToolCall(
            {
              resolveLane: (terminalId) => this.resolveAssistantPluginLane(terminalId),
              getCurrentTurnId: (helpSessionId) =>
                this.turnOutcomeService.getCurrentTurnIdForSession(helpSessionId),
              appendAuditRecord: (input) => this.auditService.appendRecord(input),
              send: (webContentsId, channel, buildPayload) => {
                sendToPinnedView(
                  webContentsId,
                  channel,
                  buildPayload,
                  "assistant-plugin-tool-call"
                );
              },
            },
            grant,
            toolName,
            argNames
          ),
      })
    );

    // Wire the live turn-outcome alert push now that both collaborators exist
    // (#10018). The service classifies `agent-stuck` / `reasoning-loop` and
    // hands the help-session id to httpLifecycle, which resolves the pinned
    // WebContents and sends. Set after construction because the send path
    // lives on httpLifecycle, built just above.
    this.turnOutcomeService.setNotifyTurnOutcomeAlert((outcome, helpSessionId, turnId) => {
      this.httpLifecycle.notifyTurnOutcomeAlert({
        helpSessionId,
        outcome,
        ...(turnId !== undefined ? { turnId } : {}),
      });
    });
  }

  /** The control surface is served. A listener open only for holds is not running. */
  get isRunning(): boolean {
    return this.httpLifecycle.isRunning;
  }

  get currentPort(): number | null {
    return this.httpLifecycle.currentPort;
  }

  get currentApiKey(): string | null {
    return this.httpLifecycle.currentApiKey;
  }

  onStatusChange(listener: (running: boolean) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  onRuntimeStateChange(listener: (snapshot: McpRuntimeSnapshot) => void): () => void {
    this.runtimeStateListeners.add(listener);
    return () => {
      this.runtimeStateListeners.delete(listener);
    };
  }

  setHelpTokenValidator(validator: HelpTokenValidator | null): void {
    this.httpLifecycle.setHelpTokenValidator(validator);
  }

  setHelpSessionWebContentsResolver(resolver: HelpSessionWebContentsResolver | null): void {
    this.httpLifecycle.setHelpSessionWebContentsResolver(resolver);
  }

  setHelpSessionViewlessProjectResolver(resolver: HelpSessionViewlessProjectResolver | null): void {
    this.httpLifecycle.setHelpSessionViewlessProjectResolver(resolver);
  }

  setHelpSessionActionContextResolver(resolver: HelpSessionActionContextResolver | null): void {
    this.httpLifecycle.setHelpSessionActionContextResolver(resolver);
  }

  setHelpSessionIdResolver(resolver: HelpSessionIdResolver | null): void {
    this.httpLifecycle.setHelpSessionIdResolver(resolver);
  }

  setPaneWorkspaceBindingResolver(resolver: PaneWorkspaceBindingResolver | null): void {
    this.httpLifecycle.setPaneWorkspaceBindingResolver(resolver);
  }

  setPaneOwnershipPrincipalResolver(resolver: PaneOwnershipPrincipalResolver | null): void {
    this.httpLifecycle.setPaneOwnershipPrincipalResolver(resolver);
  }

  setPaneTerminalResolver(resolver: PaneTerminalResolver | null): void {
    this.httpLifecycle.setPaneTerminalResolver(resolver);
  }

  setHelpSessionTerminalResolver(resolver: HelpSessionTerminalResolver | null): void {
    this.httpLifecycle.setHelpSessionTerminalResolver(resolver);
  }

  /** Lets assistants address one another (#13496); null takes it away again. */
  setAssistantControl(binding: AssistantControlBinding | null): void {
    this.httpLifecycle.setAssistantControl(binding);
  }

  /**
   * Which assistant created one exact run, and which holds authority over it
   * now (#14166). Display only: see {@link readRunAssistantWork}.
   */
  assistantWorkOf(terminalId: string, launchGeneration: number): RunAssistantWork {
    return readRunAssistantWork(this.sessionStore, terminalId, launchGeneration);
  }

  /** Taken before a read of what runs, to fence {@link retainWorkerCreations}. */
  workerCreationsMark(): number {
    return this.sessionStore.workerCreations.mark();
  }

  /** Forget creations noted before `mark` of runs no longer alive, after a complete read. */
  retainWorkerCreations(liveTerminalIds: ReadonlySet<string>, mark: number): void {
    this.sessionStore.workerCreations.retainOnly(liveTerminalIds, mark);
  }

  /**
   * Drop every ownership record a revoked pane or help bearer held (#12487,
   * #12993), the hand-overs it held (#12490), and the notices it has pending.
   * Called by `McpPaneConfigService` and `disconnectHelpBearer` in the same
   * step as the revocation itself.
   */
  revokeOwnershipPrincipal(principal: string): void {
    this.sessionStore.resourceOwnership.revokePrincipal(principal);
    // A relaunched pane gets a new bearer, so a terminal handed to the old one
    // is not silently handed to the new one (#12490).
    this.sessionStore.terminalAdoption.revokePrincipal(principal);
    this.terminalNotify.revokeOwner(paneNotifyKey(principal));
  }

  /**
   * A pane's bearer is gone (its terminal exited or relaunched): revoke what
   * it owns and close the sessions it holds. Pane sessions never idle out
   * (#13635), so this is what ends them.
   */
  revokePaneBearer(principal: string): void {
    const sessionIds = this.sessionStore.paneSessionsOf(principal);
    try {
      this.revokeOwnershipPrincipal(principal);
    } finally {
      for (const sessionId of sessionIds) {
        this.sessionStore.revokeSession(sessionId);
      }
    }
  }

  /**
   * Hand a running terminal to an orchestrating agent pane (#12490).
   *
   * Reached only over the renderer's IPC — never an action and never an MCP
   * tool — so the only thing that can start one is the user, in the UI. An
   * agent has no way to ask for a hand-over, and so no way to nag its way
   * through one.
   *
   * `orchestrator` is the pane's live bearer identity, resolved by the caller
   * from the pane config service with no await before this runs, or null when
   * the pane holds none. `callerWorkspaceId` is the project of the view the
   * user acted in, when main could resolve it.
   */
  adoptTerminal(request: {
    terminalId: string;
    orchestratorPaneId: string;
    orchestrator: OrchestratorPaneIdentity | null;
    callerWorkspaceId?: string;
  }): TerminalAdoptionResult {
    const { terminalId, orchestratorPaneId, orchestrator, callerWorkspaceId } = request;
    const refuse = (reason: TerminalAdoptionRefusal): TerminalAdoptionResult => ({
      status: "refused",
      reason,
    });
    if (terminalId === orchestratorPaneId) return refuse("self");
    if (orchestrator === null || !canDriveTerminals(orchestrator)) {
      return refuse("not-orchestrator");
    }
    const ptyClient = getPtyClient();
    if (!ptyClient?.hasTerminal(terminalId)) return refuse("terminal-gone");
    // An assistant is reached only through the assistant tools (#13496), whose
    // drive and settled-prompt checks a hand-over would step around.
    if (this.isAssistantTerminal(terminalId)) return refuse("assistant-terminal");
    // An orchestrator's calls land in the workspace its pane was launched in
    // (#12486), so a terminal anywhere else would be handed over in name only.
    const terminalWorkspaceId = ptyClient.getTerminalProjectId(terminalId) ?? undefined;
    const workspaces = [terminalWorkspaceId, orchestrator.workspaceId, callerWorkspaceId].filter(
      (id): id is string => id !== undefined
    );
    if (new Set(workspaces).size > 1) return refuse("other-project");
    // One driver per terminal: whoever launched it can already type into it.
    const creator = this.sessionStore.resourceOwnership.creatorOf("terminal", terminalId);
    if (creator !== undefined) {
      return refuse(
        creator === principalOwnerKey(orchestrator.principalId)
          ? "launched-by-orchestrator"
          : "launched-by-another"
      );
    }
    const workspaceId = workspaces[0];
    const launchGeneration = ptyClient.getLaunchGeneration(terminalId);
    const outcome = this.sessionStore.terminalAdoption.adopt({
      terminalId,
      orchestratorPaneId,
      principalId: orchestrator.principalId,
      ...(workspaceId !== undefined ? { workspaceId } : {}),
      ...(launchGeneration !== null ? { launchGeneration } : {}),
    });
    if (!outcome.ok) {
      return { status: "refused", reason: "already-handed", heldByPaneId: outcome.heldByPaneId };
    }
    return { status: "handed-over", adoption: toTerminalAdoptionEntry(outcome.record) };
  }

  /**
   * Whether a terminal is a Daintree Assistant's: by main's own binding of its
   * bearer to the PTY, which a headless launch never reports to a renderer,
   * or by the renderer's mark where main's isn't wired.
   */
  private isAssistantTerminal(terminalId: string): boolean {
    return (
      this.getSessionIdForTerminal(terminalId) !== null ||
      getAgentAvailabilityStore().isHelpTerminal(terminalId)
    );
  }

  /**
   * Hand a running terminal to this machine's global assistant (#14161),
   * from the same user gesture and under the same rules as a hand-over to a
   * pane. The assistant reaches a project only through `host.call`, whose
   * session there holds what it has under its local relay principal, so the
   * hand-over is held by that principal: the non-destructive `*Owned` tools
   * read it, `terminal.closeOwned` and `worktree.deleteOwned` never do.
   *
   * `global` is the assistant's live run, read by the caller with no await
   * before this runs, or null when none is running. A terminal whose launch
   * generation main can't name is refused: a hand-over must end with the
   * process it was given for.
   */
  adoptTerminalForGlobalAssistant(request: {
    terminalId: string;
    global: { sessionId: string; terminalId: string } | null;
    callerWorkspaceId?: string;
  }): TerminalAdoptionResult {
    const { terminalId, global, callerWorkspaceId } = request;
    const refuse = (reason: TerminalAdoptionRefusal): TerminalAdoptionResult => ({
      status: "refused",
      reason,
    });
    if (global === null) return refuse("not-orchestrator");
    if (terminalId === global.terminalId) return refuse("self");
    const ptyClient = getPtyClient();
    if (!ptyClient?.hasTerminal(terminalId)) return refuse("terminal-gone");
    if (this.isAssistantTerminal(terminalId)) return refuse("assistant-terminal");
    // Reached through `host.call` into the terminal's own project, so it must
    // have one, and the view the user acted in must show that one.
    const workspaceId = ptyClient.getTerminalProjectId(terminalId) ?? undefined;
    if (
      workspaceId === undefined ||
      isGlobalAssistantId(workspaceId) ||
      (callerWorkspaceId !== undefined && callerWorkspaceId !== workspaceId)
    ) {
      return refuse("other-project");
    }
    const launchGeneration = ptyClient.getLaunchGeneration(terminalId);
    if (launchGeneration === null) return refuse("terminal-gone");
    // This machine's own `host.call` is admitted under its own host id as the
    // sender (`LOCAL_RELAY_SENDER_ID`), named here without loading the gated
    // remote module into core.
    const principalId = relayOwnershipPrincipal(LOCAL_HOST_ID, global.sessionId);
    const creator = this.sessionStore.resourceOwnership.creatorOf("terminal", terminalId);
    if (creator !== undefined) {
      return refuse(
        creator === principalOwnerKey(principalId)
          ? "launched-by-orchestrator"
          : "launched-by-another"
      );
    }
    const outcome = this.sessionStore.terminalAdoption.adopt({
      terminalId,
      orchestratorPaneId: global.terminalId,
      principalId,
      workspaceId,
      launchGeneration,
      recipient: "global-assistant",
    });
    if (!outcome.ok) {
      return { status: "refused", reason: "already-handed", heldByPaneId: outcome.heldByPaneId };
    }
    return { status: "handed-over", adoption: toTerminalAdoptionEntry(outcome.record) };
  }

  /**
   * The panes the hand-over menu may offer: those whose bearer can submit
   * input and whose PTY the host is still tracking.
   */
  filterOrchestratorPanes(
    panes: ReadonlyArray<{ paneId: string } & OrchestratorPaneIdentity>
  ): string[] {
    const ptyClient = getPtyClient();
    return panes
      .filter((pane) => canDriveTerminals(pane) && ptyClient?.hasTerminal(pane.paneId) === true)
      .map((pane) => pane.paneId);
  }

  /**
   * End a hand-over when the process the user handed over has exited (#12490).
   * The exit carries no launch generation, so it is placed by what main still
   * tracks under the id. That works because `PtyEventRouter` drops the
   * `pendingSpawns` entry of a process that ended on its own before the event
   * fans out, and keeps it when a kill is queued — so a hand-over of a
   * respawned successor outlives its predecessor's late exit.
   */
  handleTerminalExit(terminalId: string): void {
    const record = this.sessionStore.terminalAdoption.getForTerminal(terminalId);
    if (record === undefined) return;
    const tracked = getPtyClient()?.getLaunchGeneration(terminalId) ?? null;
    if (tracked !== null && tracked === record.launchGeneration) return;
    this.sessionStore.terminalAdoption.release(terminalId);
  }

  /**
   * End a hand-over that a spawn result shows is no longer of the process the
   * user handed over (#12490): a later launch under the id succeeded, or a
   * launch at or after the handed-over one failed to start — crash recovery
   * included, which reports no exit for the process it lost. A refused
   * respawn (`TERMINAL_ALREADY_LIVE`) left the process running, and a result
   * for an earlier launch is stale; neither changes anything. Where either
   * generation is unknown the hand-over ends, since the result cannot be
   * placed.
   */
  handleTerminalSpawnResult(
    terminalId: string,
    result: { success: boolean; launchGeneration?: number; error?: { code?: string } }
  ): void {
    const record = this.sessionStore.terminalAdoption.getForTerminal(terminalId);
    if (record === undefined) return;
    if (!result.success && result.error?.code === "TERMINAL_ALREADY_LIVE") return;
    const adopted = record.launchGeneration;
    const reported = result.launchGeneration;
    const ends =
      adopted === undefined ||
      reported === undefined ||
      (result.success ? reported > adopted : reported >= adopted);
    if (ends) this.sessionStore.terminalAdoption.release(terminalId);
  }

  /** Take a handed-over terminal back. Resolves false when it wasn't handed over. */
  releaseTerminalAdoption(terminalId: string): boolean {
    return this.sessionStore.terminalAdoption.release(terminalId);
  }

  listTerminalAdoptions(): TerminalAdoptionEntry[] {
    return this.sessionStore.terminalAdoption.list().map(toTerminalAdoptionEntry);
  }

  onTerminalAdoptionsChange(listener: (adoptions: TerminalAdoptionEntry[]) => void): () => void {
    return this.sessionStore.terminalAdoption.onChange(() => {
      listener(this.listTerminalAdoptions());
    });
  }

  getPaneNotifyState(terminalId: string): PaneNotifyState | null {
    return this.terminalNotify.getPaneState(terminalId);
  }

  /** Queue a line for an assistant on the same line its notices use (#13500, #13496). */
  queueLaneWake(
    lane: { helpSessionId: string; terminalId: string; projectId: string },
    wake: LaneWake
  ): void {
    this.terminalNotify.enqueueWake(
      { key: helpNotifyKey(lane.helpSessionId), terminalId: lane.terminalId },
      lane.projectId,
      wake
    );
  }

  /** What automatic sleep must not drop: reply waits held, and the projects with notify work. */
  getPendingReplyWaitTerminalIds(): Array<string | undefined> {
    return this.replyWaiter.pendingTerminalIds();
  }

  getNotifyProjectIdsWithPendingWork(): string[] {
    return this.terminalNotify.projectIdsWithPendingWork();
  }

  /** The pane's own "stop": every notice it has pending goes, and nothing more is typed. */
  stopPaneNotices(terminalId: string): void {
    this.terminalNotify.stopPane(terminalId);
  }

  private emitStatusChange(): void {
    const running = this.isRunning;
    for (const listener of this.statusListeners) {
      try {
        listener(running);
      } catch (err) {
        console.error("[MCP] Status change listener threw:", err);
      }
    }
    this.emitRuntimeStateChange();
  }

  private emitRuntimeStateChange(): void {
    const snapshot = this.getRuntimeState();
    for (const listener of this.runtimeStateListeners) {
      try {
        listener(snapshot);
      } catch (err) {
        console.error("[MCP] Runtime-state listener threw:", err);
      }
    }
  }

  getRuntimeState(): McpRuntimeSnapshot {
    const enabled = this.isEnabled();
    let state: McpRuntimeState;
    if (!enabled) {
      state = "disabled";
    } else if (this.isRunning) {
      state = "ready";
    } else if (this.httpLifecycle.lastErrorState) {
      state = "failed";
    } else {
      state = "starting";
    }
    return {
      enabled,
      state,
      port: this.currentPort,
      lastError: this.httpLifecycle.lastErrorState,
    };
  }

  private getConfig() {
    return store.get("mcpServer");
  }

  private persistConfig(patch: Record<string, unknown>): void {
    // The deprecated auditLog/turnOutcomeLog config.json keys ride along via
    // the spread only while migration 022 hasn't stripped them; never re-add
    // them explicitly or settings writes resurrect the rings in config.json.
    const current = this.getConfig();
    store.set("mcpServer", {
      ...current,
      ...patch,
    });
  }

  isEnabled(): boolean {
    return this.getConfig().enabled;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    const wasEnabled = this.isEnabled();
    this.persistConfig({ enabled });
    if (enabled && this._registry && !this.isRunning) {
      await this.httpLifecycle.start(this._registry);
    } else if (enabled && !this.isRunning) {
      const registry = getWindowRegistry();
      if (registry) {
        // Through `start()`, so the capture lives in exactly one place. Handing
        // the registry to `httpLifecycle.start()` directly left `this._registry`
        // null, and that field is what the renderer bridge reads — a null one
        // silently degrades every registry-aware path, so focus-order routing
        // and the resolved-workspace stamp both fall back to the process-global
        // (last-created) view manager.
        await this.start(registry);
      } else if (wasEnabled !== enabled) {
        this.emitRuntimeStateChange();
      }
    } else if (!enabled && (this.isRunning || this.httpLifecycle.isStartInFlight)) {
      // A feature's scoped wakes, and the listener it holds, outlast the server.
      this.terminalNotify.disposeUnscoped();
      // `stop()` awaits any in-flight `start()` before closing, so a disable
      // that races a slow start still tears the server down instead of
      // leaving it listening after the user turned it off.
      await this.httpLifecycle.stop();
    } else if (wasEnabled !== enabled) {
      if (!enabled) {
        // Lane wakes can be queued while the server isn't listening.
        this.terminalNotify.disposeUnscoped();
        this.httpLifecycle.setLastError(null);
      }
      this.emitRuntimeStateChange();
    }
  }

  async setPort(port: number | null): Promise<void> {
    this.persistConfig({ port });
    // Open for the server or only for holds, the listener moves to the new port.
    if (this.httpLifecycle.isListening) await this.httpLifecycle.rebind();
  }

  private rotateInFlight: Promise<string> | null = null;

  async rotateApiKey(): Promise<string> {
    if (this.rotateInFlight) return this.rotateInFlight;
    const promise = (async (): Promise<string> => {
      const newKey = `daintree_${randomUUID().replace(/-/g, "")}`;
      const previousKey = this.httpLifecycle.currentApiKey;
      this.httpLifecycle.setApiKey(newKey);
      try {
        this.persistConfig({ apiKey: newKey });
      } catch (err) {
        this.httpLifecycle.setApiKey(previousKey);
        throw err;
      }
      return newKey;
    })();
    this.rotateInFlight = promise;
    try {
      return await promise;
    } finally {
      this.rotateInFlight = null;
    }
  }

  /**
   * The registry may be empty: a windowless Host starts the server before any
   * window exists, and tools that need a renderer refuse with their usual typed
   * error until one attaches. Without one passed in, the process registry is
   * used — it exists from the first line of main, windows or not.
   */
  async start(registry?: WindowRegistry | null): Promise<void> {
    const resolved = registry ?? this._registry ?? getWindowRegistry();
    if (!resolved) {
      console.warn("[MCP] No window registry available — skipping start");
      return;
    }
    this._registry = resolved;
    await this.httpLifecycle.start(resolved);
  }

  async ensureReady(): Promise<boolean> {
    if (!this.isEnabled()) {
      return false;
    }

    if (this.isRunning) {
      return true;
    }

    const registry = this._registry ?? getWindowRegistry();
    if (!registry) {
      return false;
    }

    await this.start(registry);
    return this.isRunning;
  }

  /**
   * Hold the loopback listener open for a feature's route, and let the feature
   * queue terminal wakes, whether or not the MCP server is on (#15999). With
   * the server off, `/mcp`, `/sse` and the plugin routes find nothing there and
   * no notice is armed or typed: only this route and these wakes go on.
   */
  async holdListener(id: string, route: ListenerRoute): Promise<McpListenerHold> {
    const listener = await this.httpLifecycle.holdListener(id, route);
    const wakes = this.terminalNotify.holdWakes();
    const endWakes = () => wakes.release();
    this.heldWakeScopes.add(endWakes);
    return {
      get port() {
        return listener.port;
      },
      queueWake: (pane, projectId, wake) => wakes.enqueueWake(pane, projectId, wake),
      release: async () => {
        this.heldWakeScopes.delete(endWakes);
        wakes.release();
        await listener.release();
      },
    };
  }

  /** The app is quitting: every hold ends with the server. */
  async stop(): Promise<void> {
    for (const endWakes of [...this.heldWakeScopes]) endWakes();
    this.heldWakeScopes.clear();
    // Nothing could read the observations a wake would point at.
    this.terminalNotify.disposeAll();
    // Open waits return what they have rather than hang on a server going away.
    this.replyWaiter.dispose();
    await this.httpLifecycle.shutdown();
    // The stop rejects every pending request, so the leases those requests own
    // have no one left to release them. Holding them would pin their views
    // against eviction for renderers that will never answer (#11790).
    this.viewLeases.clear();
  }

  /**
   * Why a project view must not be frozen or evicted right now, from MCP's side
   * (#11790). Read synchronously by `ProjectViewManager`'s freeze and eviction
   * policies through the `mcpViewActivity` callback `main.ts` injects.
   *
   * Two answers, deliberately separate because they earn different protection:
   *
   * - `dispatchLease` — an MCP request is in flight against this exact view.
   *   Destroying it strands the request and breaks the session's route, so the
   *   view is excluded from eviction outright, like a paint-gate bridge. Safe
   *   as an absolute exclusion only because it is self-expiring: every lease is
   *   held by a pending request, and those are capped by the bridge deadlines.
   * - `liveBinding` — a live session is bound to this workspace but is not
   *   mid-call. Enough to skip the efficiency freeze (a frozen renderer cannot
   *   answer at all, and skipping costs one optimization on one cached view),
   *   but NOT enough to survive memory pressure: a quiet bound view stays an
   *   eviction candidate, just the last one.
   *
   * Keyed by workspace id for the binding and WebContents id for the lease —
   * the workspace id outlives the view, the WebContents id is what identifies
   * the exact renderer a request is waiting on.
   */
  /**
   * Whether a routed MCP request is awaiting this exact view (#13348). Caching
   * then leaves its worktree port to the request, whose settle closes it.
   */
  hasDispatchLease(webContentsId: number): boolean {
    return this.viewLeases.has(webContentsId);
  }

  getWorkspaceViewActivity(
    workspaceId: string,
    webContentsId: number
  ): { dispatchLease: boolean; liveBinding: boolean } {
    return {
      dispatchLease: this.viewLeases.has(webContentsId),
      liveBinding: this.sessionStore.hasLiveWorkspaceBinding(workspaceId),
    };
  }

  listActiveClients(): import("../../shared/types/ipc/mcpServer.js").McpActiveClientInfo[] {
    return this.httpLifecycle.listActiveClients();
  }

  getStatus(): {
    enabled: boolean;
    port: number | null;
    configuredPort: number | null;
    apiKey: string;
  } {
    return this.httpLifecycle.getStatus();
  }

  getConfigSnippet(): string {
    return this.httpLifecycle.getConfigSnippet();
  }

  getAuditRecords(query?: McpAuditRecordQuery): McpAuditRecord[] {
    return this.auditService.getRecords(query);
  }

  /**
   * Newest-first view of the full union (dispatch + grant lifecycle
   * records). Reserved for the audit-log viewer, NDJSON export, and any
   * other surface that handles the discriminated union — dispatch-only
   * consumers (latency table, recent-calls popover, activity strip) keep
   * using {@link getAuditRecords} so their `result`/`durationMs` reads
   * stay type-safe.
   */
  getLogRecords(): McpLogRecord[] {
    return this.auditService.getLogRecords();
  }

  getAuditConfig(): { enabled: boolean; maxRecords: number } {
    return this.auditService.getAuditConfig();
  }

  getAuditStats(markSeen = true): McpAuditStats {
    return this.auditService.getAuditStats(markSeen);
  }

  getAuditDiagnostics(): McpAuditDiagnosticsSnapshot {
    return this.auditService.getDiagnosticsSnapshot();
  }

  clearAuditLog(): void {
    this.auditService.clear();
  }

  setAuditEnabled(enabled: boolean): { enabled: boolean; maxRecords: number } {
    return this.auditService.setEnabled(enabled);
  }

  setAuditMaxRecords(max: number): { enabled: boolean; maxRecords: number } {
    return this.auditService.setMaxRecords(max);
  }

  getTurnOutcomeRecords(): AssistantTurnRecord[] {
    return this.turnOutcomeService.getRecords();
  }

  clearTurnOutcomeLog(): void {
    this.turnOutcomeService.clear();
  }

  recordTurnOutcome(input: {
    outcome: TurnOutcomeClass;
    terminalId?: string | null;
    sessionId?: string | null;
    detail?: string;
  }): void {
    this.turnOutcomeService.recordDirectOutcome(input);
  }

  /**
   * Apply the assistant audit-log retention setting (`helpAssistant.auditRetention`,
   * in days; 0 = Off) to both assistant audit rings — the MCP dispatch log and
   * the turn-outcome log. Called when the setting changes and on the periodic
   * cleanup tick. Synchronous; both sub-services prune in-memory and flush.
   */
  pruneAuditByRetention(retentionDays: number): void {
    this.auditService.pruneByAge(retentionDays);
    this.turnOutcomeService.pruneByAge(retentionDays);
  }

  /**
   * Wires the help-session terminal↔session resolver. Called by
   * `HelpSessionService.ensureMcpServerReady()` (and equivalent sites) so
   * the turn-outcome classifier can correlate FSM transitions with the
   * help-session record without a circular import.
   */
  setSessionIdResolver(resolver: (terminalId: string) => string | null): void {
    this.getSessionIdForTerminal = resolver;
  }

  setAssistantPluginLaneResolver(
    resolver: (terminalId: string) => AssistantPluginLane | null
  ): void {
    this.resolveAssistantPluginLane = resolver;
  }

  setSessionTier(
    sessionId: string,
    tier: HelpAssistantTier,
    callerWcId?: number
  ): { sessionId: string; tier: McpTier } {
    const before = this.sessionStore.getTier(sessionId);
    const result = this.httpLifecycle.setSessionTier(sessionId, tier, callerWcId);
    if (result.tier !== before)
      this.queueApprovalLine(sessionId, { kind: "tier", tier: result.tier });
    return result;
  }

  /**
   * Mint a per-`(sessionId, toolId)` grant for the named tool (Approve
   * once). Validates caller pin against the WebContents the session was
   * minted in — only that renderer can issue grants on its behalf.
   * Returns the grant metadata so the renderer can render a countdown.
   */
  issueGrant(sessionId: string, toolId: string, callerWcId?: number): McpIssueGrantResult {
    const result = this.httpLifecycle.issueGrant(sessionId, toolId, callerWcId);
    this.queueApprovalLine(sessionId, { kind: "tool", toolId });
    return result;
  }

  /**
   * Tell the help lane's assistant what the user just approved from the
   * panel's tier banner (#14995), whose refusal it last heard. Never fails
   * the approval: the grant stands whether or not the line can be typed.
   */
  private queueApprovalLine(sessionId: string, approval: AssistantApproval): void {
    try {
      const lane = this.httpLifecycle.helpLaneFor(sessionId);
      if (lane === null) return;
      const wake = createApprovalWake(
        {
          sessionStore: this.sessionStore,
          helpLaneFor: (id) => this.httpLifecycle.helpLaneFor(id),
        },
        sessionId,
        lane,
        approval
      );
      this.queueLaneWake(lane, wake);
    } catch (err) {
      console.error("[MCP] Queueing an approval line failed:", err);
    }
  }

  /**
   * End one per-tool grant, leaving the session's other grants alone.
   * Caller-pin checked identically to {@link issueGrant}. Idempotent — a grant
   * already gone reports `revoked: false`.
   */
  revokeGrant(sessionId: string, toolId: string, callerWcId?: number): McpRevokeGrantResult {
    return this.httpLifecycle.revokeGrant(sessionId, toolId, callerWcId);
  }

  /**
   * Reset a session's denial counters without dropping its grants. Backs the
   * tier-mismatch banner's Cancel path so a dismissed banner re-arms on the
   * next out-of-tier call. Caller-pin checked.
   */
  resetDenialCounts(sessionId: string, callerWcId?: number): void {
    this.httpLifecycle.resetDenialCounts(sessionId, callerWcId);
  }

  /**
   * Live tier + per-tool grants for the help session a renderer owns, keyed
   * by its public help-session id (the one in `helpPanelStore`). Caller-pinned
   * against the WebContents the session was pinned to at handshake. Returns
   * `null` when there is no live session for that renderer — the IPC handler
   * maps that to a safe "not connected" snapshot. Delegates to
   * {@link SessionStore.getLiveStatusForHelpSession} for the transport-id
   * reverse-lookup the maps require.
   */
  getHelpSessionLiveStatus(
    helpSessionId: string,
    callerWcId: number
  ): ReturnType<SessionStore["getLiveStatusForHelpSession"]> {
    return this.sessionStore.getLiveStatusForHelpSession(helpSessionId, callerWcId);
  }

  /**
   * Approve a native session-scoped automation grant (#10648) for the help
   * session a renderer owns, addressed by its public help-session id. The
   * grant authorizes the named tools for a bounded number of uses without a
   * per-call modal. Caller-pinned against the WebContents the session was
   * pinned to at handshake. Returns the minted grant's id and scope so the
   * renderer can render its card without polling.
   */
  issueNativeGrant(
    helpSessionId: string,
    params: { allowedTools: string[]; maxUses?: number; ttlMs?: number },
    callerWcId?: number
  ): McpIssueNativeGrantResult {
    return this.httpLifecycle.issueNativeGrant(helpSessionId, params, callerWcId);
  }

  /**
   * Revoke a single native automation grant by id. Caller-pinned against the
   * session the grant belongs to. Idempotent — a grant already gone (exhausted,
   * expired, or torn down with its session) reports `revoked: false`.
   */
  revokeNativeGrant(grantId: string, callerWcId?: number): McpRevokeNativeGrantResult {
    return this.httpLifecycle.revokeNativeGrant(grantId, callerWcId);
  }

  /**
   * Snapshot of the bearers currently connected to the local MCP server for
   * the settings tab. Raw tokens are never returned — only the display suffix
   * and the hash used to target {@link disconnectBearer}.
   */
  listActiveBearers(): ActiveBearerRecord[] {
    return this.httpLifecycle.listActiveBearers();
  }

  /**
   * Read-only inventory of the renderer-pinned help-session bearers (the
   * Daintree Assistant's own internal MCP connections) for the separate
   * "Daintree Assistant connections" settings row (#10036). Display fields
   * only — no tokens or hashes cross IPC, and there is no disconnect action.
   */
  listHelpSessionBearers(): HelpSessionBearerRecord[] {
    return this.httpLifecycle.listHelpSessionBearers();
  }

  /**
   * Disconnect a single bearer: revoke every session it owns and evict it
   * from the live register, then push a runtime-state change so the settings
   * tab refreshes. Targets one token only — key rotation (revoke-all) stays a
   * separate D3 action.
   */
  disconnectBearer(tokenHash: string): DisconnectBearerResult {
    const sessionIds = this.httpLifecycle.getBearerSessionIds(tokenHash);
    if (sessionIds === null) {
      return { tokenHash, disconnected: false };
    }
    for (const sessionId of sessionIds) {
      this.sessionStore.revokeSession(sessionId);
    }
    // Clear any residual entry — `revokeSession` already detaches each
    // session via the `dropBearerState` callback, but a stale entry with no
    // live sessions (client dropped the socket) wouldn't be covered.
    this.httpLifecycle.clearBearer(tokenHash);
    this.emitRuntimeStateChange();
    return { tokenHash, disconnected: true };
  }

  /**
   * Eagerly tear down the live MCP session(s) a help-session bearer owns
   * when the help session is revoked (#9151). Resolves the raw help token to
   * its register key, then reuses {@link disconnectBearer} so tier, grants,
   * and pin drop immediately instead of lingering until the 30-minute idle
   * reaper. Wired in via `HelpSessionService.setOnMcpSessionRevoked`.
   *
   * The help session's ownership principal (#12993) is revoked first and
   * unconditionally: its records outlive every transport, so a help session
   * whose last connection already dropped still holds authority that has to
   * go with the bearer. Only the transport teardown is a no-op when the agent
   * never connected (or already disconnected).
   */
  disconnectHelpBearer(rawToken: string, helpSessionId: string): void {
    try {
      this.revokeOwnershipPrincipal(helpOwnershipPrincipal(helpSessionId));
      // The lane's own notices and wakes are held under its session id.
      this.terminalNotify.revokeOwner(helpNotifyKey(helpSessionId));
    } finally {
      const tokenHash = this.httpLifecycle.findHelpBearerHash(rawToken);
      if (tokenHash !== null) this.disconnectBearer(tokenHash);
    }
  }

  /**
   * Retire a help bearer's live transports and nothing else (#13360): a view
   * took the assistant over, and a transport's pin is fixed when it is built.
   * The bearer stays valid, so the client's next call reconnects and its
   * handshake pins it to the new view. The ownership principal is left alone
   * — the assistant is the same session, and what it launched is still its own.
   */
  resetHelpTransports(rawToken: string): void {
    const tokenHash = this.httpLifecycle.findHelpBearerHash(rawToken);
    if (tokenHash !== null) this.disconnectBearer(tokenHash);
  }

  /**
   * Emitter wired into the {@link SessionStore}'s `GrantCache` at
   * construction time. Writes an audit-log entry and pushes a targeted
   * lifecycle event to the renderer pinned at session handshake. Send
   * is always targeted — grant state is session-scoped and broadcasting
   * to every WebContents would leak security state to other windows.
   */
  private emitGrantLifecycle(sessionId: string, payload: McpGrantLifecyclePayload): void {
    // A refresh is live-only: the dispatch record that caused it is the audit.
    if (payload.type !== "grant.refreshed") {
      try {
        this.auditService.appendGrantRecord({
          type: payload.type,
          sessionId: payload.sessionId,
          toolId: payload.toolId,
          ttlMs: payload.ttlMs,
          expiresAt: payload.expiresAt,
          revokedReason: payload.revokedReason,
          grantId: payload.grantId,
          maxUses: payload.maxUses,
          remainingUses: payload.remainingUses,
          actorId: payload.actorId,
          actorType: payload.actorType,
          allowedTools: payload.allowedTools,
        });
      } catch (err) {
        console.error("[MCP] Failed to append grant audit record:", err);
      }
    }

    // Origin-gated like every other renderer push (#11789). Unreachable in
    // practice — a third-party session can never hold a grant, since
    // `issueGrant` refuses it — but stating the rule beats relying on that
    // inference holding, which is the habit this issue exists to break.
    if (!this.sessionStore.isRendererOwnedOrigin(sessionId)) return;
    const id = this.sessionStore.sessionWebContentsMap.get(sessionId);
    if (id === undefined) return;
    sendToPinnedView(id, CHANNELS.MCP_GRANT_LIFECYCLE, () => payload, "grant lifecycle");
  }

  /**
   * Remote Hosts: a host's MCP server runs an action in the local view that
   * drives one of its projects. Answered over the same renderer bridge a
   * pinned session uses, whether or not this machine's own server is on.
   */
  dispatchActionForHost(
    ...args: Parameters<typeof this.bridge.dispatchActionForWebContents>
  ): ReturnType<typeof this.bridge.dispatchActionForWebContents> {
    this.ensureHostBridgeListeners();
    return this.bridge.dispatchActionForWebContents(...args);
  }

  /**
   * A view reporting how far a confirm-gated dispatch it was sent has got
   * (#14989), which moves main's deadline for it. Answered for this machine's
   * own views only: a host's dispatch is held by the host.
   */
  holdDispatch(
    webContentsId: number,
    requestId: string,
    phase: McpDispatchHoldPhase
  ): McpDispatchHoldResult {
    return this.bridge.holdDispatch(webContentsId, requestId, phase);
  }

  /**
   * Remote Hosts (#13493): a session for another machine's assistant reaching
   * this host through its Shell, admitted through this server's own gates and
   * bound to one project. Null while the server is off.
   */
  openRelaySession(
    ...args: Parameters<HttpLifecycle["openRelaySession"]>
  ): ReturnType<HttpLifecycle["openRelaySession"]> {
    return this.httpLifecycle.openRelaySession(...args);
  }

  /**
   * Remote Hosts (#13493): another machine's assistant no longer holds what it
   * made here. Its terminals and worktrees stay; only the authority goes.
   */
  retireRelayPrincipal(senderId: string, helpSessionId: string): void {
    const principal = relayOwnershipPrincipal(senderId, helpSessionId);
    this.sessionStore.resourceOwnership.revokePrincipal(principal);
    this.sessionStore.terminalAdoption.revokePrincipal(principal);
    this.terminalNotify.revokeOwner(relayNotifyKey(principal));
  }

  /**
   * One of this machine's help sessions ended (#14161): what was handed to
   * it goes now, whether or not it ever made a call that would retire its
   * principal, so a later session never finds it.
   */
  releaseRelayAdoptions(senderId: string, helpSessionId: string): void {
    this.sessionStore.terminalAdoption.revokePrincipal(
      relayOwnershipPrincipal(senderId, helpSessionId)
    );
  }

  /**
   * Remote Hosts (#13930): the calls of another machine's assistant that
   * still have notices armed or waiting here, whichever link it is on now.
   */
  relayNoticeCallsWatching(senderId: string, helpSessionId: string): Set<string> {
    return this.terminalNotify.relayCallsWatching(
      relayNotifyKey(relayOwnershipPrincipal(senderId, helpSessionId))
    );
  }

  /** Remote Hosts: the action manifest of the local view that drives a host's project. */
  requestManifestForHost(webContentsId: number): Promise<ActionManifestEntry[]> {
    this.ensureHostBridgeListeners();
    return this.bridge.requestManifestForWebContents(webContentsId);
  }

  /**
   * The renderer answers on the bridge's response channels, which are
   * otherwise heard only while this machine's server runs. Kept for the
   * service's life: a second copy while the server also listens finds no
   * pending request and does nothing.
   */
  private ensureHostBridgeListeners(): void {
    if (this.hostBridgeListenersInstalled) return;
    this.hostBridgeListenersInstalled = true;
    this.bridge.setupListeners(this.persistentListeners);
  }

  // Delegates for test access — tests call .bind(service) on these.
  requestManifest(...args: Parameters<typeof this.bridge.requestManifest>) {
    return this.bridge.requestManifest(...args);
  }
  dispatchAction(...args: Parameters<typeof this.bridge.dispatchAction>) {
    return this.bridge.dispatchAction(...args);
  }
  createIdleTimer(sessionId: string) {
    return this.sessionStore.createIdleTimer(sessionId);
  }
  resetIdleTimer(sessionId: string) {
    return this.sessionStore.resetIdleTimer(sessionId);
  }
  createHttpIdleTimer(sessionId: string) {
    return this.sessionStore.createHttpIdleTimer(sessionId);
  }
  resetHttpIdleTimer(sessionId: string) {
    return this.sessionStore.resetHttpIdleTimer(sessionId);
  }
  handleRequest(...args: Parameters<(typeof this.httpLifecycle)["handleRequest"]>) {
    // Use explicit type to bridge private method access
    return (this.httpLifecycle as any).handleRequest?.(...args);
  }

  // Exposed for test access to internals that moved to sub-modules.
  get _sessions() {
    return this.sessionStore.sessions;
  }
  get _httpSessions() {
    return this.sessionStore.httpSessions;
  }
  get _sessionTierMap() {
    return this.sessionStore.sessionTierMap;
  }
  get _resourceSubscriptions() {
    return this.sessionStore.resourceSubscriptions;
  }
  get _pendingManifests() {
    return this.pendingManifests;
  }
  get _pendingDispatches() {
    return this.pendingDispatches;
  }
  get _auditService() {
    return this.auditService;
  }
  get _turnOutcomeService() {
    return this.turnOutcomeService;
  }
  get _sessionStore() {
    return this.sessionStore;
  }
  get _httpLifecycle() {
    return this.httpLifecycle;
  }
  get _bridge() {
    return this.bridge;
  }
  get _viewLeases() {
    return this.viewLeases;
  }
}

/**
 * Whether a pane's bearer could use a hand-over at all. Adoption widens which
 * terminals a pane may act on, never which tools: a tier that cannot submit
 * input would be handed a terminal it could only read.
 */
function canDriveTerminals(orchestrator: OrchestratorPaneIdentity): boolean {
  return (
    orchestrator.tier !== "off" && isTierPermitted(orchestrator.tier, "terminal.sendCommandOwned")
  );
}

function toTerminalAdoptionEntry(record: TerminalAdoptionRecord): TerminalAdoptionEntry {
  return {
    terminalId: record.terminalId,
    orchestratorPaneId: record.orchestratorPaneId,
    ...(record.recipient !== undefined ? { recipient: record.recipient } : {}),
    adoptedAt: record.adoptedAt,
  };
}

export const mcpServerService = new McpServerService();

// The connectivity registry deliberately never imports this module (it sits on
// the eager boot path; this stack does not). Wiring here, at module scope,
// covers every load path — deferred boot task, help-session provision,
// agent-spawn `ensureReady`, settings IPC — before any caller can `start()`
// the server, so the registry's onStatusChange subscription always lands
// before the first status event.
wireMcpServerToConnectivityRegistry(mcpServerService);

// Publish the singleton for the project-view freeze/eviction policies (#11790).
// Same reasoning as the wiring above — at module scope, so every load path
// covers it — but the direction matters more here: `electron/window/` must
// never import this module, which sits behind a dynamic import precisely to
// keep the MCP graph off eager boot. `serviceRefs` is a zero-runtime-import
// leaf, so publishing into it costs nothing and cannot cycle, and until some
// path loads this module the getter reads null and both policies fail closed
// to "not protected" — the pre-#11790 behaviour.
setMcpServerServiceRef(mcpServerService);
