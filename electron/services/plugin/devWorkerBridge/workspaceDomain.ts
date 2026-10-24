// Worktrees, agents, terminals and the workbench UI a dev worker drives
// (#14332): reads, prompts, status surfaces, action dispatch, the workspace
// event subscriptions, and the plugin's logger.

import type { PluginHostApi } from "../../../../shared/types/plugin.js";
import type {
  ActionsGetParams,
  AgentsInterruptParams,
  AgentsSendKeysParams,
  AgentsSubmitParams,
  DispatchParams,
  LoggerParams,
  NotifyParams,
  PluginHostCallMethod,
  PluginHostNotifyMethod,
  PluginWorkerSubscriptionKind,
  PluginWorkerWorktreesEvent,
  ReloadPanelParams,
  RunRecipeParams,
  SendToActiveAgentParams,
  SendToAgentParams,
  SetContextParams,
  SetPanelActivityParams,
  SetTerminalStatusParams,
  SetToolbarButtonStateParams,
  SetWorktreeCardStatusParams,
  SetWorktreeReviewChecksParams,
  ShowConfirmParams,
  ShowInputBoxParams,
  ShowQuickPickParams,
  ShowToastParams,
  TerminalsReadScreenParams,
} from "../../../../shared/types/pluginDevWorker.js";
import type {
  DevWorkerBridgeContext,
  HostCallHandler,
  HostNotifyHandler,
  SubscribeHandler,
} from "./bridgeContext.js";

/** A worker's prompt may only opt in to waiting; any other value is the default. */
function promptQueueOption(value: unknown): { whenNoFrontend?: "queue" } {
  return value === "queue" ? { whenNoFrontend: "queue" } : {};
}

export class WorkspaceDomain {
  constructor(private readonly ctx: DevWorkerBridgeContext) {}

  readonly hostCalls = {
    getActiveWorktree: async () => {
      return this.ctx.host.getActiveWorktree();
    },
    getWorktrees: async () => {
      return this.ctx.host.getWorktrees();
    },
    getWorktreesResult: async () => {
      return this.ctx.host.getWorktreesResult();
    },
    getWorktreeStatus: async (params, signal) => {
      return this.ctx.host.getWorktreeStatus(params as string, { signal });
    },
    getAgentState: async () => {
      return this.ctx.host.getAgentState();
    },
    showToast: async (params) => {
      const p = params as ShowToastParams;
      // `type` is validated against the NotificationType enum by the host's
      // PluginToastOptionsSchema, so an invalid value rejects there.
      await this.ctx.host.showToast({
        message: p.message,
        type: p.type as Parameters<PluginHostApi["showToast"]>[0]["type"],
        durationMs: p.durationMs,
      });
      return undefined;
    },
    notify: async (params) => {
      const p = params as NotifyParams;
      return this.ctx.host.notify(p.options as Parameters<PluginHostApi["notify"]>[0]);
    },
    dispatch: async (params) => {
      const p = params as DispatchParams;
      return this.ctx.host.dispatch(
        p.actionId,
        p.args,
        p.options as Parameters<PluginHostApi["dispatch"]>[2]
      );
    },
    reloadPanel: async (params) => {
      const p = params as ReloadPanelParams;
      return this.ctx.host.reloadPanel(p.panelId);
    },
    setContext: async (params) => {
      const p = params as SetContextParams;
      await this.ctx.host.setContext(p.key, p.value);
      return undefined;
    },
    setToolbarButtonState: async (params) => {
      const p = params as SetToolbarButtonStateParams;
      await this.ctx.host.setToolbarButtonState(p.buttonId, p.state);
      return undefined;
    },
    setWorktreeCardStatus: async (params) => {
      const p = params as SetWorktreeCardStatusParams;
      await this.ctx.host.setWorktreeCardStatus(p.worktreeId, p.status);
      return undefined;
    },
    setWorktreeReviewChecks: async (params) => {
      const p = params as SetWorktreeReviewChecksParams;
      await this.ctx.host.setWorktreeReviewChecks(p.worktreeId, p.checks);
      return undefined;
    },
    setTerminalStatus: async (params) => {
      const p = params as SetTerminalStatusParams;
      await this.ctx.host.setTerminalStatus(p.terminalId, p.status);
      return undefined;
    },
    setPanelActivity: async (params) => {
      const p = params as SetPanelActivityParams;
      await this.ctx.host.setPanelActivity(p.panelId, p.activity);
      return undefined;
    },
    restartWorker: async () => {
      // The host defers the restart past this result's post, so the worker
      // hears "scheduled" before it is torn down (#13410).
      return this.ctx.host.restartWorker();
    },
    "actions.list": async () => {
      return this.ctx.host.actions.list();
    },
    "actions.get": async (params) => {
      const p = params as ActionsGetParams;
      return this.ctx.host.actions.get(p.actionId);
    },
    sendToActiveAgent: async (params) => {
      const p = params as SendToActiveAgentParams;
      await this.ctx.host.sendToActiveAgent(p.text, p.options);
      return undefined;
    },
    "agents.list": async () => {
      return this.ctx.host.agents.list();
    },
    "agents.listAll": async () => {
      return this.ctx.host.agents.listAll();
    },
    "agents.interrupt": async (params) => {
      const p = params as AgentsInterruptParams;
      return this.ctx.host.agents.interrupt(p.terminalId);
    },
    "agents.sendKeys": async (params) => {
      const p = params as AgentsSendKeysParams;
      return this.ctx.host.agents.sendKeys(p.terminalId, p.input);
    },
    "agents.submit": async (params) => {
      const p = params as AgentsSubmitParams;
      return this.ctx.host.agents.submit(p.terminalId, p.text);
    },
    "terminals.readScreen": async (params) => {
      const p = params as TerminalsReadScreenParams;
      return this.ctx.host.terminals.readScreen(p.terminalId, p.options);
    },
    sendToAgent: async (params, signal) => {
      // `signal` ties an open picker to this generation, like showQuickPick:
      // a retired worker's question comes off the screen with it.
      const p = params as SendToAgentParams;
      return this.ctx.host.sendToAgent(p.text, p.options, { signal });
    },
    runRecipe: async (params, signal) => {
      // Same as sendToAgent: the dialog belongs to this generation.
      const p = params as RunRecipeParams;
      return this.ctx.host.runRecipe(p.recipeId, p.options, { signal });
    },
    showQuickPick: async (params, signal) => {
      // Reuse the real host so validation/provenance/cancellation all match
      // the installed-plugin path. `signal` is what ties the dialog to this
      // generation: retiring one aborts every in-flight host call, which
      // dismisses the question rather than leaving it on screen owned by a
      // worker that no longer exists (#12279).
      const p = params as ShowQuickPickParams;
      return this.ctx.host.showQuickPick(p.items, p.options ?? {}, {
        signal,
        ...promptQueueOption(p.whenNoFrontend),
      });
    },
    showInputBox: async (params, signal) => {
      const p = params as ShowInputBoxParams;
      return this.ctx.host.showInputBox(p.options, {
        signal,
        ...promptQueueOption(p.whenNoFrontend),
      });
    },
    showConfirm: async (params, signal) => {
      const p = params as ShowConfirmParams;
      return this.ctx.host.showConfirm(p.options, {
        signal,
        ...promptQueueOption(p.whenNoFrontend),
      });
    },
  } satisfies Partial<Record<PluginHostCallMethod, HostCallHandler>>;

  readonly notifications = {
    "logger.info": (params, method) => this.log(method, params),
    "logger.warn": (params, method) => this.log(method, params),
    "logger.error": (params, method) => this.log(method, params),
  } satisfies Partial<Record<PluginHostNotifyMethod, HostNotifyHandler>>;

  // An absent `debounceMs` is passed through as undefined, which the host
  // reads as "use the default window" — the same as an in-process plugin.
  readonly subscriptions = {
    "active-worktree": async (msg, push) =>
      this.ctx.host.onDidChangeActiveWorktree((snapshot) => push(snapshot), {
        debounceMs: msg.debounceMs,
      }),
    worktrees: async (msg, push) =>
      this.ctx.host.onDidChangeWorktrees(
        (snapshots, change) => push({ snapshots, change } satisfies PluginWorkerWorktreesEvent),
        { debounceMs: msg.debounceMs }
      ),
    "agent-state": async (msg, push) =>
      this.ctx.host.onDidChangeAgentState((snapshot) => push(snapshot), {
        debounceMs: msg.debounceMs,
      }),
    "terminal-lifecycle": async (_msg, push) =>
      this.ctx.host.onDidChangeTerminalLifecycle((event) => push(event)),
    "all-agents": async (msg, push) =>
      this.ctx.host.onDidChangeAllAgents((snapshot) => push(snapshot), {
        debounceMs: msg.debounceMs,
      }),
    "focused-panel": async (msg, push) =>
      this.ctx.host.onDidChangeFocusedPanel((focus) => push(focus), {
        debounceMs: msg.debounceMs,
      }),
    "project-presence": async (msg, push) =>
      this.ctx.host.onDidChangeProjectPresence((presence) => push(presence), {
        debounceMs: msg.debounceMs,
      }),
    "panel-lifecycle": async (_msg, push) =>
      this.ctx.host.onDidChangePanelLifecycle((event) => push(event)),
    "system-wake": async (_msg, push) => this.ctx.host.onDidWake((event) => push(event)),
  } satisfies Partial<Record<PluginWorkerSubscriptionKind, SubscribeHandler>>;

  private async log(method: string, params: unknown): Promise<void> {
    const p = params as LoggerParams;
    const level = method.split(".")[1] as "info" | "warn" | "error";
    // Logger stays synchronous fire-and-forget (the #10519 carve-out).
    this.ctx.host.logger[level](p.message, p.fields);
    return;
  }
}
