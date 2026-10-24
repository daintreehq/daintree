/**
 * Worktrees, agents, terminals and host events for `createMockHost`: the
 * snapshots a test seeds or simulates, every subscription that hears them, and
 * the agent input and screen-read calls made against them.
 */

import { validateAgentContextPayload } from "../../utils/agentContextDrag.js";
import { normalizePluginAllAgentsSnapshot } from "../../utils/pluginAllAgentsSnapshot.js";
import { pluginFocusedPanelEquals, toPluginFocusedPanel } from "../../utils/pluginFocusedPanel.js";
import { toPluginProjectPresence } from "../../utils/pluginProjectPresence.js";
import { toPluginTerminalLifecycleEvent } from "../../utils/pluginTerminalLifecycle.js";
import { isProjectWorkspaceId } from "../../utils/workspaceIds.js";
import {
  PLUGIN_SUBSCRIPTION_DEFAULT_DEBOUNCE_MS,
  PLUGIN_FOCUSED_PANEL_DEFAULT_DEBOUNCE_MS,
  PLUGIN_TERMINAL_SCREEN_DEFAULT_LINES,
  PLUGIN_TERMINAL_SCREEN_MAX_LINES,
} from "../../config/pluginBudgets.js";
import type { ActionDispatchResult, ActionId } from "../../types/actions.js";
import type {
  PluginWorktreeSnapshot,
  PluginWorktreesChange,
  PluginWorktreesResult,
  PluginAgentSnapshot,
  PluginTerminalLifecycleEvent,
  PluginAgentPane,
  PluginAllAgentsSnapshot,
  PluginFocusedPanel,
  PluginProjectPresence,
  PluginProjectPresenceState,
  PluginSendToAgentResult,
  PluginRunRecipeResult,
  PluginTerminalScreenResult,
  PluginAgentInputResult,
  PluginAgentInterruptResult,
  PluginAgentKeysResult,
  PluginPanelLifecycleEvent,
  PluginSystemWakeEvent,
} from "../../types/plugin.js";
import type { MockHostIdentity } from "./identity.js";
import type {
  SentToActiveAgentRecord,
  SentToAgentRecord,
  RunRecipeRecord,
  AgentInputRecord,
  ReadScreenRecord,
  MockSubscriptionRecord,
  CreateMockHostOptions,
  MockHost,
} from "./types.js";

export type WorkspaceMembers = Pick<
  MockHost,
  | "getActiveWorktree"
  | "getWorktrees"
  | "getWorktreesResult"
  | "getWorktreeStatus"
  | "onDidChangeActiveWorktree"
  | "onDidChangeWorktrees"
  | "getAgentState"
  | "sendToActiveAgent"
  | "agents"
  | "terminals"
  | "sendToAgent"
  | "runRecipe"
  | "onDidChangeAgentState"
  | "onDidChangeTerminalLifecycle"
  | "onDidChangeAllAgents"
  | "onDidChangeFocusedPanel"
  | "onDidChangeProjectPresence"
  | "onDidChangePanelLifecycle"
  | "onDidWake"
  | "sentToActiveAgentCalls"
  | "sentToAgentCalls"
  | "runRecipeCalls"
  | "readScreenCalls"
  | "agentInputCalls"
  | "subscriptionOptions"
  | "simulateActiveWorktreeChange"
  | "simulateWorktreesChange"
  | "simulateWorktreesResult"
  | "simulateAgentStateChange"
  | "simulateTerminalLifecycleChange"
  | "simulatePanelLifecycleChange"
  | "simulateSystemWake"
  | "simulateAgentsChange"
  | "simulateAgentLaunched"
  | "simulateAllAgentsChange"
  | "simulateFocusedPanelChange"
  | "simulateProjectPresenceChange"
  | "simulateSendToAgentPick"
  | "simulateRunRecipeResult"
  | "simulateTerminalScreen"
>;

/** The key names `host.agents.sendKeys` takes, as production's schema allows them. */
const MOCK_AGENT_KEY = /^(Up|Down|Left|Right|Enter|Escape|Tab|Space|Backspace|[a-z0-9])$/;
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

export interface WorkspaceFacet {
  members: WorkspaceMembers;
  /** The active worktree's path, or undefined with none active. */
  activeWorktreePath(): string | undefined;
  /** Every worktree path the mock knows of, the active one first. */
  worktreeRoots(): string[];
  /** What `getWorktreesResult()` answers right now. */
  resolveWorktreesResult(): PluginWorktreesResult;
  /** The panes `agents.list()` answers right now. */
  agentPanes(): readonly PluginAgentPane[];
  /** Latest simulated lifecycle event per panel id. */
  panelPhases: ReadonlyMap<string, PluginPanelLifecycleEvent>;
  /** Records the agent a dispatched `agent.launch` started. */
  recordMockLaunch(
    actionId: ActionId,
    args: unknown,
    result: ActionDispatchResult
  ): ActionDispatchResult;
}

export function createWorkspaceFacet(
  identity: MockHostIdentity,
  options: CreateMockHostOptions
): WorkspaceFacet {
  const { projectId: mockProjectId, capabilities, hasActiveAgent } = identity;
  let activeWorktree: PluginWorktreeSnapshot | null = options.activeWorktree ?? null;
  let worktrees: PluginWorktreeSnapshot[] = options.worktrees ?? [];
  let worktreesResult: PluginWorktreesResult | null = options.worktreesResult ?? null;
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
  /** Latest simulated lifecycle event per panel id, for `reloadPanel`. */
  const panelPhases = new Map<string, PluginPanelLifecycleEvent>();
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

  const members: WorkspaceMembers = {
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
    sentToActiveAgentCalls,
    sentToAgentCalls,
    runRecipeCalls,
    readScreenCalls,
    agentInputCalls,
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
    simulateSystemWake(event) {
      // Frozen like production delivery, for the same reason.
      const frozen = Object.freeze({ ...event });
      for (const cb of [...systemWakeSubs]) cb(frozen);
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

  return {
    members,
    activeWorktreePath: () => activeWorktree?.path,
    worktreeRoots: () =>
      [activeWorktree?.path, ...worktrees.map((w) => w.path)].filter(
        (root): root is string => root !== undefined
      ),
    resolveWorktreesResult: () =>
      worktreesResult ?? { status: "ok", projectId: "test-project", worktrees },
    agentPanes: () => agentPanes,
    panelPhases,
    recordMockLaunch,
  };
}
