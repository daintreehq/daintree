import type { PluginUIPromptDispatcher } from "./PluginUIPromptDispatcher.js";
import { assertPluginCallerDrives } from "./pluginDriveLease.js";
import {
  interruptLaunchedAgent,
  launchedAgentProject,
  type LaunchedAgentPty,
  sendKeysToLaunchedAgent,
  submitToLaunchedAgent,
  validateLaunchedAgentId,
  validateSendKeysCall,
} from "./pluginLaunchedAgents.js";
import { createListenerFailureState, invokeTrackedListener } from "./pluginCallbackUtils.js";
import {
  WorktreeChangeTracker,
  createSubscriptionCoalescer,
  resolveSubscriptionDebounceMs,
  resolveSubscriptionDebounceMsOr,
} from "./pluginSubscriptionCoalescing.js";

import { events } from "../events.js";
import { getPtyClient } from "../../window/serviceRefs.js";
import {
  PLUGIN_TERMINAL_SCREEN_DEFAULT_LINES,
  PLUGIN_TERMINAL_SCREEN_MAX_LINES,
} from "../../../shared/config/pluginBudgets.js";
import {
  admitPluginTerminalScreenRead,
  readPluginTerminalScreen,
} from "./pluginTerminalScreenRead.js";
import { isAssistantTerminalRecord } from "../assistantTerminal.js";
import { toPluginWorktreeStatus } from "../../../shared/utils/pluginWorktreeSnapshot.js";
import type { AgentStateChangePayload } from "../../../shared/utils/pluginAgentSnapshot.js";
import {
  toPluginTerminalLifecycleEvent,
  type TerminalLifecycleObservation,
} from "../../../shared/utils/pluginTerminalLifecycle.js";
import {
  toPluginAllAgentsSnapshot,
  UNAVAILABLE_PLUGIN_ALL_AGENTS_SNAPSHOT,
} from "../../../shared/utils/pluginAllAgentsSnapshot.js";
import {
  NO_FOCUSED_PANEL,
  pluginFocusedPanelEquals,
} from "../../../shared/utils/pluginFocusedPanel.js";
import { PLUGIN_FOCUSED_PANEL_DEFAULT_DEBOUNCE_MS } from "../../../shared/config/pluginBudgets.js";
import { getFocusedPanelTracker, type FocusedPanelState } from "../FocusedPanelTracker.js";
import { getProjectPresenceTracker } from "../ProjectPresenceTracker.js";
import { type PluginWorktreeEventPayload } from "./pluginEventScope.js";
import type { WorktreeSnapshot } from "../../../shared/types/workspace-host.js";
import { type PluginSendToAgentRequest } from "../../../shared/types/pluginUiPrompt.js";
import { SEND_TO_AGENT_MAX_ID_LENGTH, SEND_TO_AGENT_REFUSAL_REASONS } from "./sendToAgentLimits.js";
import {
  AGENT_CONTEXT_MAX_TEXT_LENGTH,
  AGENT_CONTEXT_MAX_TITLE_LENGTH,
  sanitizeAgentContextSourceLabel,
  validateAgentContextPayload,
} from "../../../shared/utils/agentContextDrag.js";
import type {
  PluginHostApi,
  PluginWorktreesResult,
  PluginAgentInputResult,
  PluginAgentSnapshot,
  PluginAllAgentsSnapshot,
  PluginFocusedPanel,
  PluginProjectPresence,
  PluginProjectPresenceState,
  PluginSendToAgentRefusalReason,
  PluginSendToAgentResult,
  PluginPanelLifecycleEvent,
  PluginHostBinding,
} from "../../../shared/types/plugin.js";
import {
  type PluginHostFactoryDeps,
  trackPluginDisposer,
  ensureCapabilityConsent,
  isProjectViewUnavailable,
} from "./pluginHostDeps.js";
import type { PluginEventScope } from "./pluginEventScope.js";
import type { PluginRendererDispatcher } from "./PluginRendererDispatcher.js";

const SEND_TO_AGENT_REFUSAL_REASON_SET = new Set<string>(SEND_TO_AGENT_REFUSAL_REASONS);

function validateOptionalId(pluginId: string, name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > SEND_TO_AGENT_MAX_ID_LENGTH
  ) {
    throw new Error(
      `Plugin "${pluginId}" sendToAgent: options.${name} must be a non-empty string of at most ${SEND_TO_AGENT_MAX_ID_LENGTH} characters`
    );
  }
  return value;
}

/** Check a `host.terminals.readScreen` call and resolve its line count. */
function validateReadScreenCall(pluginId: string, terminalId: unknown, options: unknown): number {
  if (
    typeof terminalId !== "string" ||
    terminalId.length === 0 ||
    terminalId.length > SEND_TO_AGENT_MAX_ID_LENGTH
  ) {
    throw new Error(
      `Plugin "${pluginId}" terminals.readScreen: terminalId must be a non-empty string of at most ${SEND_TO_AGENT_MAX_ID_LENGTH} characters`
    );
  }
  if (options === undefined) return PLUGIN_TERMINAL_SCREEN_DEFAULT_LINES;
  if (options === null || typeof options !== "object") {
    throw new Error(`Plugin "${pluginId}" terminals.readScreen: options must be an object`);
  }
  const lines = (options as { lines?: unknown }).lines;
  if (lines === undefined) return PLUGIN_TERMINAL_SCREEN_DEFAULT_LINES;
  if (
    typeof lines !== "number" ||
    !Number.isInteger(lines) ||
    lines < 1 ||
    lines > PLUGIN_TERMINAL_SCREEN_MAX_LINES
  ) {
    throw new Error(
      `Plugin "${pluginId}" terminals.readScreen: options.lines must be an integer from 1 to ${PLUGIN_TERMINAL_SCREEN_MAX_LINES}`
    );
  }
  return lines;
}

/**
 * Check a `host.sendToAgent` call against the drag payload's own limits and
 * return the normalised text and title. Throws so an authoring mistake fails
 * loudly, like the other host APIs, rather than reaching the user as a picker
 * that drafts nothing.
 */
function validateSendToAgentCall(
  pluginId: string,
  text: unknown,
  options: unknown
): Omit<PluginSendToAgentRequest, "sourceLabel"> {
  if (options !== undefined && (typeof options !== "object" || options === null)) {
    throw new Error(`Plugin "${pluginId}" sendToAgent: options must be an object`);
  }
  const opts = (options ?? {}) as Record<string, unknown>;
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error(
      `Plugin "${pluginId}" sendToAgent: text must be a non-empty, non-whitespace string`
    );
  }
  if (opts.title !== undefined && typeof opts.title !== "string") {
    throw new Error(`Plugin "${pluginId}" sendToAgent: options.title must be a string`);
  }
  const payload = validateAgentContextPayload({ v: 1, text, title: opts.title });
  if (payload === null) {
    throw new Error(
      `Plugin "${pluginId}" sendToAgent: text must hold printable content and be at most ${AGENT_CONTEXT_MAX_TEXT_LENGTH} characters, and options.title at most ${AGENT_CONTEXT_MAX_TITLE_LENGTH}`
    );
  }
  const terminalId = validateOptionalId(pluginId, "terminalId", opts.terminalId);
  const worktreeId = validateOptionalId(pluginId, "worktreeId", opts.worktreeId);
  return {
    text: payload.text,
    ...(payload.title !== undefined ? { title: payload.title } : {}),
    ...(terminalId !== undefined ? { terminalId } : {}),
    ...(worktreeId !== undefined ? { worktreeId } : {}),
  };
}

/**
 * The renderer's answer, narrowed to the public result. Anything malformed
 * reads as a dismissal: the renderer is ours, so this only guards against a
 * response from a build that disagrees about the shape.
 */
function toSendToAgentResult(value: unknown): PluginSendToAgentResult {
  if (typeof value === "object" && value !== null) {
    const result = value as Record<string, unknown>;
    if (result.status === "drafted" && typeof result.terminalId === "string") {
      return { status: "drafted", terminalId: result.terminalId };
    }
    if (
      result.status === "refused" &&
      typeof result.reason === "string" &&
      SEND_TO_AGENT_REFUSAL_REASON_SET.has(result.reason as PluginSendToAgentRefusalReason)
    ) {
      return {
        status: "refused",
        reason: result.reason as PluginSendToAgentRefusalReason,
        ...(typeof result.worktreeId === "string" && result.worktreeId.length > 0
          ? { worktreeId: result.worktreeId.slice(0, SEND_TO_AGENT_MAX_ID_LENGTH) }
          : {}),
      };
    }
  }
  return { status: "cancelled" };
}

/**
 * Resolve the terminal id of the "active agent" for `host.sendToActiveAgent`
 * (#10558). Centralised here so plugins stop reinventing `terminal.list`-based
 * selection heuristics that drift. Ranks focused/visible agent
 * (`activityTier: "active"`) first, then a `waiting` agent, then the most
 * recently active by output — with a deterministic id tiebreak. Terminals with
 * no agent or in an ended state (`exited` / `completed`, or no live PTY) are
 * excluded.
 *
 * So is the Daintree Assistant (#13494), whatever the plugin's consent: it runs
 * a real agent CLI, so it passes every other test, and a waiting assistant
 * outscores a busy grid agent. It holds the project's full MCP surface, which
 * consent to "send text to the active agent" never covered. Filtered before
 * ranking, so a project whose only agent is the assistant takes the same
 * no-agent path as one with none.
 *
 * `boundProjectId` is the host's binding. Bound: only that project's terminals
 * are eligible, and `null` comes back when it has none, so the caller can
 * no-op instead of injecting into a project the user never consented to.
 * Unbound (`null`): deliberately ambient — it scopes to whatever project the
 * PTY host last saw focused, since "the active agent" an app-global plugin
 * means is the one in front of the user, and considers all terminals only when
 * no project is active at all (e.g. before any project loads).
 *
 * @throws {Error} `NO_ACTIVE_AGENT:` when the terminal host is unavailable, or
 *   when an unbound host finds no eligible agent terminal.
 */
async function resolveActiveAgentTerminalId(boundProjectId: string | null): Promise<string | null> {
  const ptyClient = getPtyClient();
  if (!ptyClient) {
    throw new Error("NO_ACTIVE_AGENT: terminal host is not available");
  }
  const all = await ptyClient.getAllTerminalsAsync();
  type Term = (typeof all)[number];
  const eligible = (t: Term): boolean =>
    Boolean(t.detectedAgentId ?? t.launchAgentId) &&
    t.hasPty !== false &&
    t.agentState !== "exited" &&
    t.agentState !== "completed" &&
    !isAssistantTerminalRecord(t);
  // Scope to the bound project, or to the focused one; never cross into another
  // project's terminals.
  const scopeProjectId = boundProjectId ?? ptyClient.getActiveProjectId();
  const pool = scopeProjectId != null ? all.filter((t) => t.projectId === scopeProjectId) : all;
  const candidates = pool.filter(eligible);
  if (candidates.length === 0) {
    if (boundProjectId !== null) return null;
    throw new Error(
      "NO_ACTIVE_AGENT: no agent terminal is available to receive input in the current project"
    );
  }
  const score = (t: Term): number =>
    (t.activityTier === "active" ? 2 : 0) + (t.agentState === "waiting" ? 1 : 0);
  candidates.sort((a, b) => {
    const byScore = score(b) - score(a);
    if (byScore !== 0) return byScore;
    const byOutput = (b.lastOutputTime ?? 0) - (a.lastOutputTime ?? 0);
    if (byOutput !== 0) return byOutput;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return candidates[0].id;
}

/** What the observation surface reads from `createHost`: the binding, the event scope, and the shared worktree reads. */
export interface PluginHostObservationContext {
  readonly boundPlugin: PluginEventScope["boundPlugin"];
  readonly boundProjectId: PluginHostBinding["projectId"];
  readonly boundProjectRoot: PluginHostBinding["projectRoot"];
  readonly canObserveAgents: PluginEventScope["canObserveAgents"];
  readonly deps: Pick<
    PluginHostFactoryDeps,
    | "declaredCapabilities"
    | "getFleetSnapshotService"
    | "panelLifecycleBroker"
    | "pluginDisplayName"
    | "pluginEventCleanups"
    | "plugins"
    | "recordPluginLog"
    | "subscribeWorktreeCustomTitles"
    | "subscribeWorktreeEvent"
  >;
  /** Delivers this plugin's pending pushes before each renderer round-trip. */
  readonly dispatcher: PluginRendererDispatcher;
  readonly fetchWorktreeSnapshots: () => Promise<WorktreeSnapshot[]>;
  readonly fetchWorktreeSnapshotsResult: PluginEventScope["fetchWorktreeSnapshotsResult"];
  readonly getWorktreesResult: () => Promise<PluginWorktreesResult>;
  readonly isAgentEventForBoundProject: PluginEventScope["isAgentEventForBoundProject"];
  readonly isBound: PluginEventScope["isBound"];
  readonly isEventForBoundProject: PluginEventScope["isEventForBoundProject"];
  /** True once `activate()` has returned; activation-only registrations refuse after it. */
  readonly isRevoked: () => boolean;
  readonly pluginId: string;
  readonly pluginProjectionFor: PluginEventScope["pluginProjectionFor"];
  readonly projectAgentTransition: PluginEventScope["projectAgentTransition"];
  readonly promptDispatcher: Pick<PluginUIPromptDispatcher, "requestPrompt">;
  readonly seesProjectPresence: PluginEventScope["seesProjectPresence"];
}

/**
 * The host's worktree, agent and terminal reads, the agent input calls, and
 * the observation events, all held to the host's binding.
 */
export function buildObservationHostApi(
  ctx: PluginHostObservationContext
): Pick<
  PluginHostApi,
  | "getActiveWorktree"
  | "getWorktrees"
  | "getWorktreesResult"
  | "getWorktreeStatus"
  | "getAgentState"
  | "sendToActiveAgent"
  | "agents"
  | "terminals"
  | "sendToAgent"
  | "onDidChangeActiveWorktree"
  | "onDidChangeWorktrees"
  | "onDidChangeAgentState"
  | "onDidChangeTerminalLifecycle"
  | "onDidChangeAllAgents"
  | "onDidChangeFocusedPanel"
  | "onDidChangeProjectPresence"
  | "onDidChangePanelLifecycle"
  | "onDidWake"
> {
  const {
    boundPlugin,
    boundProjectId,
    boundProjectRoot,
    canObserveAgents,
    deps,
    dispatcher,
    fetchWorktreeSnapshots,
    fetchWorktreeSnapshotsResult,
    getWorktreesResult,
    isAgentEventForBoundProject,
    isBound,
    isEventForBoundProject,
    isRevoked,
    pluginId,
    pluginProjectionFor,
    projectAgentTransition,
    promptDispatcher,
    seesProjectPresence,
  } = ctx;
  // Last agent-state snapshot observed for this host since it subscribed via
  // onDidChangeAgentState. The host keeps no pre-subscription history, so
  // getAgentState() returns null until the first transition is observed.
  let lastAgentSnapshot: PluginAgentSnapshot | null = null;
  // The app-wide agent list crosses every project, so a project-bound host —
  // scoped to its own project everywhere else — is refused it outright rather
  // than handed a filtered copy that would read as "the whole app".
  const assertCanReadAllAgents = (method: string): void => {
    if (!deps.declaredCapabilities(pluginId).has("agent:read")) {
      throw new Error(
        `PERMISSION_REQUIRED: plugin "${pluginId}" ${method} requires "agent:read", which is not declared in manifest.capabilities`
      );
    }
    if (boundProjectId !== null) {
      throw new Error(
        `PERMISSION_REQUIRED: plugin "${pluginId}" ${method} lists agents in every project, which is not available to a project plugin`
      );
    }
  };
  const assertDeclaresAgentInput = (op: string): void => {
    if (!deps.declaredCapabilities(pluginId).has("agent:input")) {
      throw new Error(
        `PERMISSION_REQUIRED: plugin "${pluginId}" agents.${op} requires "agent:input", which is not declared in manifest.capabilities`
      );
    }
  };
  /**
   * Run one `host.agents` input call against an agent this plugin launched
   * (#14018), in `sendToActiveAgent`'s order: the caller has checked liveness,
   * the declared capability and its arguments. A call that would answer
   * `not-found` raises no consent prompt, and the record is read again after
   * the prompt and before every write, since the plugin can unload or the
   * terminal move while the user decides or a key sequence is paced out.
   */
  const withLaunchedAgent = async <T extends { readonly status: string }>(
    op: string,
    terminalId: string,
    run: (pty: LaunchedAgentPty, admitWrite: () => Promise<boolean>) => Promise<T>
  ): Promise<T | Exclude<PluginAgentInputResult, { readonly status: "sent" }>> => {
    const owns = (): boolean => {
      const pty = getPtyClient();
      return (
        pty !== null && launchedAgentProject(pty, pluginId, terminalId, boundProjectId) !== null
      );
    };
    if (getPtyClient() === null) return { status: "unavailable" };
    if (!owns()) return { status: "not-found" };
    await ensureCapabilityConsent(deps, pluginId, "agent:input");
    if (!isBound()) return { status: "unavailable" };
    const pty = getPtyClient();
    if (pty === null) return { status: "unavailable" };
    if (!owns()) return { status: "not-found" };
    return run(pty, async () => {
      if (!isBound() || !owns()) return false;
      // Typing into an agent is held to the lease its terminal's input is, and
      // asked again before every write, so a takeover while the call waited on
      // a read or between paced keys stops it.
      await assertPluginCallerDrives(pluginId, `agents.${op}`, { terminalId });
      return isBound() && owns();
    });
  };
  return {
    getActiveWorktree: async () => {
      const result = await getWorktreesResult();
      if (result.status !== "ok") return null;
      return result.worktrees.find((w) => w.isCurrent) ?? null;
    },
    getWorktrees: async () => {
      const result = await getWorktreesResult();
      return result.status === "ok" ? result.worktrees : [];
    },
    getWorktreesResult,
    getWorktreeStatus: async (path, options) => {
      options?.signal?.throwIfAborted();
      if (!isBound()) return null;
      if (typeof path !== "string" || path.length === 0) return null;
      const snapshots = await fetchWorktreeSnapshots();
      options?.signal?.throwIfAborted();
      if (!isBound()) return null;
      const match = snapshots.find((s) => s.path === path);
      return match ? toPluginWorktreeStatus(match.worktreeChanges) : null;
    },
    getAgentState: async () => {
      // Liveness first (mirrors getActiveWorktree/getWorktrees): once unloaded
      // the method degrades to null rather than throwing, so a plugin calling
      // it from a stray timer after unload doesn't get an unhandled rejection.
      // declaredCapabilities() also returns [] post-unload, so a capability
      // check first would mis-report PERMISSION_REQUIRED for a torn-down plugin.
      if (!isBound()) return null;
      if (!deps.declaredCapabilities(pluginId).has("agent:read")) {
        throw new Error(
          `PERMISSION_REQUIRED: plugin "${pluginId}" getAgentState requires "agent:read", which is not declared in manifest.capabilities`
        );
      }
      return lastAgentSnapshot;
    },
    sendToActiveAgent: async (text, options) => {
      // Liveness first (mirrors getAgentState): once unloaded the method
      // degrades to a no-op rather than throwing into a stray post-unload
      // timer. declaredCapabilities() also returns [] post-unload, so a
      // capability check first would mis-report PERMISSION_REQUIRED.
      if (!isBound()) return;
      if (!deps.declaredCapabilities(pluginId).has("agent:input")) {
        throw new Error(
          `PERMISSION_REQUIRED: plugin "${pluginId}" sendToActiveAgent requires "agent:input", which is not declared in manifest.capabilities`
        );
      }
      // Validate BEFORE prompting for consent so an invalid call can't bank a
      // silent grant and then inject real text unprompted (mirrors the
      // process.spawn ordering for #10524). Reject whitespace-only text too:
      // it stages to nothing but with submit:true would fire a bare Enter,
      // submitting whatever is already in the agent's input buffer — an effect
      // the consent prompt never showed the user.
      if (typeof text !== "string" || text.trim().length === 0) {
        throw new Error(
          `Plugin "${pluginId}" sendToActiveAgent: text must be a non-empty, non-whitespace string`
        );
      }
      // JIT consent fires before any side effect — first use prompts the user;
      // the grant covers later calls. Throws PERMISSION_REQUIRED on denial.
      // Re-check binding after the prompt await so a racing unload doesn't
      // inject into a torn-down session.
      await ensureCapabilityConsent(deps, pluginId, "agent:input");
      if (!isBound()) return;
      const terminalId = await resolveActiveAgentTerminalId(boundProjectId);
      if (!isBound()) return;
      if (terminalId === null) {
        // Bound host with no agent of its own: stay silent rather than reach
        // for whatever agent is focused. The user consented to this plugin
        // talking to its project's agent, never to another project's.
        if (boundPlugin) {
          deps.recordPluginLog(
            boundPlugin,
            pluginId,
            "warn",
            "sendToActiveAgent: no agent terminal is available in this plugin's project"
          );
        }
        return;
      }
      const ptyClient = getPtyClient();
      if (!ptyClient) {
        throw new Error("NO_ACTIVE_AGENT: terminal host is not available");
      }
      // Typing into an agent is held to the lease its terminal's input is.
      await assertPluginCallerDrives(pluginId, "sendToActiveAgent", { terminalId });
      if (!isBound()) return;
      // submit defaults to false — stage-only (no Enter) is the default-safe
      // mode per #10558. submit:true appends Enter and runs the text.
      if (options?.submit === true) {
        ptyClient.submit(terminalId, text);
      } else {
        ptyClient.stage(terminalId, text);
      }
    },
    // NOT revoke-guarded, like getAgentState: plugins list agents from command
    // handlers long after activation. The panes are read from the renderer that
    // owns the project's panel and worktree stores — a bound host asks its own
    // project's view and nothing else.
    agents: {
      list: async () => {
        if (!isBound()) return [];
        if (!deps.declaredCapabilities(pluginId).has("agent:read")) {
          throw new Error(
            `PERMISSION_REQUIRED: plugin "${pluginId}" agents.list requires "agent:read", which is not declared in manifest.capabilities`
          );
        }
        try {
          const agents = await dispatcher.sendAgentsListToRenderer(boundProjectId, pluginId);
          return isBound() ? agents : [];
        } catch (err) {
          if (isProjectViewUnavailable(err)) return [];
          throw err;
        }
      },
      // Answered by main from the fleet snapshot, never a renderer: per-project
      // views are LRU-evicted, and an evicted project's agents keep running.
      listAll: async () => {
        if (!isBound()) return UNAVAILABLE_PLUGIN_ALL_AGENTS_SNAPSHOT;
        assertCanReadAllAgents("agents.listAll");
        return toPluginAllAgentsSnapshot(deps.getFleetSnapshotService()?.getLastBroadcast());
      },
      // Input to the agents this plugin launched (#14018), and nothing else.
      // NOT revoke-guarded: a plugin answers its agent's dialogs from event
      // callbacks long after activation.
      interrupt: async (terminalId) => {
        if (!isBound()) return { status: "unavailable" };
        assertDeclaresAgentInput("interrupt");
        const id = validateLaunchedAgentId(pluginId, "interrupt", terminalId);
        return withLaunchedAgent("interrupt", id, (pty, admitWrite) =>
          interruptLaunchedAgent(pty, id, admitWrite)
        );
      },
      sendKeys: async (terminalId, input) => {
        if (!isBound()) return { status: "unavailable" };
        assertDeclaresAgentInput("sendKeys");
        const id = validateLaunchedAgentId(pluginId, "sendKeys", terminalId);
        const keys = validateSendKeysCall(pluginId, id, input);
        return withLaunchedAgent("sendKeys", id, (pty, admitWrite) =>
          sendKeysToLaunchedAgent(pty, id, keys, admitWrite)
        );
      },
      submit: async (terminalId, text) => {
        if (!isBound()) return { status: "unavailable" };
        assertDeclaresAgentInput("submit");
        const id = validateLaunchedAgentId(pluginId, "submit", terminalId);
        // Whitespace alone would submit to nothing but still press Enter on
        // whatever the agent's input already holds.
        if (typeof text !== "string" || text.trim().length === 0) {
          throw new Error(
            `Plugin "${pluginId}" agents.submit: text must be a non-empty, non-whitespace string`
          );
        }
        return withLaunchedAgent("submit", id, (pty, admitWrite) =>
          submitToLaunchedAgent(pty, id, text, admitWrite)
        );
      },
    },
    // NOT revoke-guarded: grid plugins poll screens from timers long after
    // activation. Answered in main from the pty-host's own mirror, so a
    // terminal in a project with no open view still reads.
    terminals: {
      readScreen: async (terminalId, options) => {
        if (!isBound()) return { status: "unavailable" };
        if (!deps.declaredCapabilities(pluginId).has("terminal:read")) {
          throw new Error(
            `PERMISSION_REQUIRED: plugin "${pluginId}" terminals.readScreen requires "terminal:read", which is not declared in manifest.capabilities`
          );
        }
        // Validated before the consent prompt, so a malformed call can't bank a
        // grant for a later one.
        const lines = validateReadScreenCall(pluginId, terminalId, options);
        await ensureCapabilityConsent(deps, pluginId, "terminal:read");
        if (!isBound()) return { status: "unavailable" };
        // Charged per consented call, whatever the id resolves to, so probing
        // ids costs the same budget as reading them.
        if (!admitPluginTerminalScreenRead(boundPlugin!, Date.now())) {
          const err = new Error(
            `RATE_LIMITED: plugin "${pluginId}" terminals.readScreen exceeded its calls-per-second limit`
          );
          (err as Error & { code?: string }).code = "RATE_LIMITED";
          throw err;
        }
        const result = await readPluginTerminalScreen(
          getPtyClient(),
          terminalId,
          boundProjectId,
          lines
        );
        return isBound() ? result : { status: "unavailable" };
      },
    },
    sendToAgent: async (text, options, callOptions) => {
      // Liveness first, for the same reason as sendToActiveAgent: an unloaded
      // plugin's declared capabilities read as empty, which would mis-report
      // PERMISSION_REQUIRED into a stray timer.
      if (!isBound()) return { status: "cancelled" };
      if (!deps.declaredCapabilities(pluginId).has("agent:input")) {
        throw new Error(
          `PERMISSION_REQUIRED: plugin "${pluginId}" sendToAgent requires "agent:input", which is not declared in manifest.capabilities`
        );
      }
      // Validated before the consent prompt, so a malformed call can't bank a
      // grant and have a later one draft unprompted.
      const request = validateSendToAgentCall(pluginId, text, options);
      await ensureCapabilityConsent(deps, pluginId, "agent:input");
      if (!isBound()) return { status: "cancelled" };
      try {
        // The prompt bridge, not a bespoke channel: without a target this is a
        // picker the user answers, and it inherits the bridge's project
        // targeting, unload drain and caller-signal dismissal. With a target it
        // answers as soon as the renderer has drafted.
        const value = await promptDispatcher.requestPrompt(
          pluginId,
          {
            kind: "sendToAgent",
            // The display name comes from the manifest unbounded; it is held to
            // the same one-line, length-capped shape as a drag's label.
            request: {
              ...request,
              sourceLabel: sanitizeAgentContextSourceLabel(deps.pluginDisplayName(pluginId)),
            },
          },
          boundProjectId,
          callOptions?.signal
        );
        return toSendToAgentResult(value);
      } catch (err) {
        if (isProjectViewUnavailable(err)) {
          return { status: "refused", reason: "project-unavailable" };
        }
        throw err;
      }
    },
    onDidChangeActiveWorktree: (callback, options) => {
      if (isRevoked()) {
        throw new Error(
          `Plugin "${pluginId}" host revoked: onDidChangeActiveWorktree called after activate() returned or timed out`
        );
      }
      // One fetch per burst rather than per activation: the snapshot is read
      // when the window closes, so it is always the worktree active at the end.
      // Serialised like onDidChangeWorktrees, so a slow read can never land
      // after a newer activation's and leave the plugin on the older one.
      let disposed = false;
      let chain: Promise<void> = Promise.resolve();
      const coalescer = createSubscriptionCoalescer(
        resolveSubscriptionDebounceMs(options?.debounceMs),
        () => {
          chain = chain.then(async () => {
            if (!isBound() || disposed) return;
            try {
              const result = await fetchWorktreeSnapshotsResult();
              // Re-check after the async fetch so a racing unload, or a
              // same-id reload, doesn't fire into the retired closure.
              if (!isBound() || disposed) return;
              const active =
                result.status === "ok"
                  ? result.snapshots.find((s) => s.isCurrent === true)
                  : undefined;
              callback(
                active && result.status === "ok" ? pluginProjectionFor(result)(active) : null
              );
            } catch (err) {
              console.error(
                `[PluginService] onDidChangeActiveWorktree callback for "${pluginId}" failed:`,
                err
              );
            }
          });
        }
      );
      // Subscription wired synchronously (revoke guard already held above);
      // only the disposer return value is wrapped in a resolved promise.
      const unsubscribe = deps.subscribeWorktreeEvent(pluginId, "worktree-activated", (event) => {
        // A bound host must not wake on another project activating a worktree:
        // "active" means active within its own project, so a foreign event is
        // not a change it can observe at all — nor may it extend a burst.
        if (!isEventForBoundProject(event)) return;
        if (!isBound()) return;
        coalescer.push();
      });
      // The whole disposer is tracked, not just the event unsubscribe: an
      // unload or activation rollback must also cancel a queued flush.
      const dispose = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () => {
        disposed = true;
        coalescer.dispose();
        unsubscribe();
      });
      return Promise.resolve(dispose);
    },
    onDidChangeWorktrees: (callback, options) => {
      if (isRevoked()) {
        throw new Error(
          `Plugin "${pluginId}" host revoked: onDidChangeWorktrees called after activate() returned or timed out`
        );
      }
      // Coalesced by default: the host re-emits the worktree set on every
      // git-status poll. `debounceMs: 0` restores one callback per event.
      const tracker = new WorktreeChangeTracker();
      // Deliveries are serialised: each fetch starts after the previous one
      // delivered, so raw mode still gets one callback per event, in order,
      // and the change tracker's base is always the list handed over last.
      let chain: Promise<void> = Promise.resolve();
      const runEmit = async (): Promise<void> => {
        if (!isBound() || disposed) return;
        try {
          const result = await fetchWorktreeSnapshotsResult();
          if (!isBound() || disposed) return;
          const list =
            result.status === "ok" ? result.snapshots.map(pluginProjectionFor(result)) : [];
          callback(list, tracker.next(list));
        } catch (err) {
          console.error(
            `[PluginService] onDidChangeWorktrees callback for "${pluginId}" failed:`,
            err
          );
        }
      };
      let disposed = false;
      const coalescer = createSubscriptionCoalescer(
        resolveSubscriptionDebounceMs(options?.debounceMs),
        () => {
          chain = chain.then(runEmit);
        }
      );
      // A foreign project's churn is dropped before the window is even armed,
      // so a bound host's trailing callback can't be pushed out by worktree
      // traffic in a project it cannot see. Churn in its own project can't
      // either: each burst fires by its deadline.
      const emit = (event?: PluginWorktreeEventPayload): void => {
        if (!isEventForBoundProject(event)) return;
        coalescer.push();
      };
      // Fires on both add/update and remove so plugins' cached lists stay
      // correct after deletions. One coalescer spans both event kinds.
      const disposeUpdate = deps.subscribeWorktreeEvent(pluginId, "worktree-update", emit);
      const disposeRemove = deps.subscribeWorktreeEvent(pluginId, "worktree-removed", emit);
      // A rename never reaches the workspace host, so main says so itself
      // (#14022). Same filter as `emit`, by id since that is what titles key on.
      const disposeTitles = deps.subscribeWorktreeCustomTitles((projectId) => {
        if (
          boundProjectId !== null &&
          (boundProjectRoot === null || projectId !== boundProjectId)
        ) {
          return;
        }
        coalescer.push();
      });
      const dispose = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () => {
        disposed = true;
        coalescer.dispose();
        disposeUpdate();
        disposeRemove();
        disposeTitles();
      });
      return Promise.resolve(dispose);
    },
    onDidChangeAgentState: (callback, options) => {
      if (isRevoked()) {
        throw new Error(
          `Plugin "${pluginId}" host revoked: onDidChangeAgentState called after activate() returned or timed out`
        );
      }
      if (!canObserveAgents()) {
        throw new Error(
          `PERMISSION_REQUIRED: plugin "${pluginId}" onDidChangeAgentState requires "agent:read", which is not declared in manifest.capabilities`
        );
      }
      // The agent:state-changed bus is a synchronous module-level singleton
      // (unlike WorkspaceClient), so we subscribe directly — no deferred
      // replay queue is needed. The cache behind getAgentState() is updated on
      // every transition; only delivery to the callback is coalesced.
      const failures = createListenerFailureState();
      // Latest transition per terminal within the window. Delete-then-set
      // keeps the map in the order of each terminal's latest transition.
      const pending = new Map<string, PluginAgentSnapshot>();
      let active = true;
      const deliver = (snapshot: PluginAgentSnapshot): void => {
        invokeTrackedListener(
          failures,
          pluginId,
          "onDidChangeAgentState",
          () => callback(snapshot),
          () => dispose()
        );
      };
      const coalescer = createSubscriptionCoalescer(
        resolveSubscriptionDebounceMs(options?.debounceMs),
        () => {
          const batch = [...pending.values()];
          pending.clear();
          for (const snapshot of batch) {
            // A listener quarantined mid-batch disposes the subscription; the
            // rest of the batch must not reach it.
            if (!active || !isBound()) return;
            deliver(snapshot);
          }
        }
      );
      const handler = (payload: AgentStateChangePayload): void => {
        const transition = projectAgentTransition(payload);
        if (transition === null) return;
        if (!isBound()) return;
        const { snapshot, key } = transition;
        lastAgentSnapshot = snapshot;
        pending.delete(key);
        pending.set(key, snapshot);
        coalescer.push();
      };
      const unsub = events.on("agent:state-changed", handler);
      const dispose = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () => {
        active = false;
        coalescer.dispose();
        pending.clear();
        unsub();
      });
      return Promise.resolve(dispose);
    },
    onDidChangeTerminalLifecycle: (callback) => {
      if (isRevoked()) {
        throw new Error(
          `Plugin "${pluginId}" host revoked: onDidChangeTerminalLifecycle called after activate() returned or timed out`
        );
      }
      if (!deps.declaredCapabilities(pluginId).has("agent:read")) {
        throw new Error(
          `PERMISSION_REQUIRED: plugin "${pluginId}" onDidChangeTerminalLifecycle requires "agent:read", which is not declared in manifest.capabilities`
        );
      }
      // Delivered one event at a time, never coalesced: these are discrete
      // facts, and a window keyed by terminal would let a short-lived
      // terminal's exit erase its spawn.
      const failures = createListenerFailureState();
      let active = true;
      const handler = (observation: TerminalLifecycleObservation): void => {
        if (!active || !isBound()) return;
        // The observer recorded the owning project at launch: the client's own
        // record is already gone by the time an exit arrives.
        const workspaceId = observation.projectId ?? null;
        if (!isAgentEventForBoundProject(workspaceId)) return;
        const event = toPluginTerminalLifecycleEvent(observation, { workspaceId });
        if (event === null) return;
        invokeTrackedListener(
          failures,
          pluginId,
          "onDidChangeTerminalLifecycle",
          () => callback(event),
          () => dispose()
        );
      };
      const unsub = events.on("terminal:lifecycle", handler);
      const dispose = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () => {
        active = false;
        unsub();
      });
      return Promise.resolve(dispose);
    },
    onDidChangeAllAgents: (callback, options) => {
      if (isRevoked()) {
        throw new Error(
          `Plugin "${pluginId}" host revoked: onDidChangeAllAgents called after activate() returned or timed out`
        );
      }
      assertCanReadAllAgents("onDidChangeAllAgents");
      const fleet = deps.getFleetSnapshotService();
      if (!fleet) {
        throw new Error(
          `FLEET_UNAVAILABLE: plugin "${pluginId}" onDidChangeAllAgents — the agent fleet is not being tracked`
        );
      }
      const failures = createListenerFailureState();
      // One slot: each publication is the whole fleet, so only the latest matters.
      let pending: PluginAllAgentsSnapshot | null = null;
      let active = true;
      const coalescer = createSubscriptionCoalescer(
        resolveSubscriptionDebounceMs(options?.debounceMs),
        () => {
          const snapshot = pending;
          pending = null;
          if (snapshot === null || !active || !isBound()) return;
          invokeTrackedListener(
            failures,
            pluginId,
            "onDidChangeAllAgents",
            () => callback(snapshot),
            () => dispose()
          );
        }
      );
      const unsub = fleet.subscribe((snapshot) => {
        if (!active || !isBound()) return;
        pending = toPluginAllAgentsSnapshot(snapshot);
        coalescer.push();
      });
      const dispose = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () => {
        active = false;
        coalescer.dispose();
        pending = null;
        unsub();
      });
      return Promise.resolve(dispose);
    },
    onDidChangeFocusedPanel: (callback, options) => {
      if (isRevoked()) {
        throw new Error(
          `Plugin "${pluginId}" host revoked: onDidChangeFocusedPanel called after activate() returned or timed out`
        );
      }
      if (!deps.declaredCapabilities(pluginId).has("panel:focus-read")) {
        throw new Error(
          `PERMISSION_REQUIRED: plugin "${pluginId}" onDidChangeFocusedPanel requires "panel:focus-read", which is not declared in manifest.capabilities`
        );
      }
      const tracker = getFocusedPanelTracker();
      // A project plugin sees focus inside its own project only; focus anywhere
      // else, the Portal included, reads as no focused panel rather than as a
      // fact about another project.
      const project = (state: FocusedPanelState): PluginFocusedPanel =>
        boundProjectId === null || state.workspaceId === boundProjectId
          ? state.panel
          : NO_FOCUSED_PANEL;
      const failures = createListenerFailureState();
      let latest: PluginFocusedPanel = project(tracker.getCurrent());
      let delivered: PluginFocusedPanel | null = null;
      let active = true;
      // The issue asks for a 250–500ms trailing window: focus flips in bursts
      // (click-through, tab cycling) and only where it settles is attention.
      const debounceMs = resolveSubscriptionDebounceMsOr(
        options?.debounceMs,
        PLUGIN_FOCUSED_PANEL_DEFAULT_DEBOUNCE_MS
      );
      const deliver = (): void => {
        if (!active || !isBound()) return;
        const value = latest;
        if (delivered !== null && pluginFocusedPanelEquals(delivered, value)) return;
        delivered = value;
        invokeTrackedListener(
          failures,
          pluginId,
          "onDidChangeFocusedPanel",
          () => callback(value),
          () => dispose()
        );
      };
      const coalescer = createSubscriptionCoalescer(debounceMs, deliver);
      const unsub = tracker.subscribe((state) => {
        if (!active || !isBound()) return;
        latest = project(state);
        coalescer.push();
      });
      const dispose = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () => {
        active = false;
        coalescer.dispose();
        unsub();
      });
      // The current focus, replayed straight away rather than after a window a
      // later change would restart. A microtask, so the plugin holds the
      // disposer first and a throwing replay can quarantine the listener.
      queueMicrotask(deliver);
      return Promise.resolve(dispose);
    },
    onDidChangeProjectPresence: (callback, options) => {
      if (isRevoked()) {
        throw new Error(
          `Plugin "${pluginId}" host revoked: onDidChangeProjectPresence called after activate() returned or timed out`
        );
      }
      // No capability gate: whether a project is shown says less than which
      // panel has focus, and an installed plugin already lists every open
      // project's worktrees. A project plugin hears about its own project only;
      // an installed one about every project, but never a scratch.
      const tracker = getProjectPresenceTracker();
      const sees = seesProjectPresence;
      const failures = createListenerFailureState();
      // Latest state per project: a burst across several projects must not
      // lose one project's change behind another's.
      const pending = new Map<string, PluginProjectPresenceState>();
      const delivered = new Map<string, PluginProjectPresenceState>();
      let active = true;
      const deliver = (): void => {
        const batch = [...pending];
        pending.clear();
        for (const [projectId, state] of batch) {
          if (!active || !isBound()) return;
          const previous = delivered.get(projectId);
          if (previous === state) continue;
          // An installed plugin was never told this project opened, so its
          // close is noise. A project plugin's own replay always answers.
          if (state === "closed" && previous === undefined && boundProjectId === null) continue;
          // Forget closed projects, so an installed plugin's bookkeeping does not
          // grow with every project ever opened; the bound plugin has one key.
          if (state === "closed" && boundProjectId === null) delivered.delete(projectId);
          else delivered.set(projectId, state);
          const presence: PluginProjectPresence = Object.freeze({ projectId, state });
          invokeTrackedListener(
            failures,
            pluginId,
            "onDidChangeProjectPresence",
            () => callback(presence),
            () => dispose()
          );
        }
      };
      const coalescer = createSubscriptionCoalescer(
        resolveSubscriptionDebounceMs(options?.debounceMs),
        deliver
      );
      // Subscribed before the replay is read, so nothing between the two is lost.
      const unsub = tracker.subscribe((changes) => {
        if (!active || !isBound()) return;
        let relevant = false;
        for (const change of changes) {
          if (!sees(change.projectId)) continue;
          pending.set(change.projectId, change.state);
          relevant = true;
        }
        if (relevant) coalescer.push();
      });
      if (boundProjectId !== null) {
        pending.set(boundProjectId, tracker.getState(boundProjectId));
      } else {
        for (const open of tracker.getOpen()) {
          if (sees(open.projectId)) pending.set(open.projectId, open.state);
        }
      }
      const dispose = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () => {
        active = false;
        coalescer.dispose();
        pending.clear();
        unsub();
      });
      // Replayed straight away rather than after a window a later change would
      // restart. A microtask, so the plugin holds the disposer first and a
      // throwing replay can quarantine the listener.
      queueMicrotask(deliver);
      return Promise.resolve(dispose);
    },
    onDidChangePanelLifecycle: (callback) => {
      if (isRevoked()) {
        throw new Error(
          `Plugin "${pluginId}" host revoked: onDidChangePanelLifecycle called after activate() returned or timed out`
        );
      }
      // No capability gate: the broker resolves panel ownership from main's own
      // kind registry, so a plugin can only ever be handed events for panel
      // instances of kinds it contributed itself (#11301).
      const failures = createListenerFailureState();
      // Teardown lives in a holder rather than a closed-over binding because,
      // unlike every other subscription here, `subscribe` REPLAYS synchronously
      // — `handler` can run before the disposer below exists. A replayed event
      // that exhausts the failure budget would otherwise touch that binding in
      // its temporal dead zone and throw ReferenceError instead of quarantining
      // the listener.
      const teardown: { dispose?: () => void; unsub?: () => void } = {};
      const handler = (event: PluginPanelLifecycleEvent): void => {
        // Runtime delivery is membership-gated, never revoke-gated (#5596):
        // these events fire for the plugin's whole life, long after activate()
        // returned, and must fall silent once it unloads.
        if (!deps.plugins.has(pluginId)) return;
        invokeTrackedListener(
          failures,
          pluginId,
          "onDidChangePanelLifecycle",
          () => callback(event),
          () => {
            // Mid-replay the tracked disposer does not exist yet, so fall back
            // to unsubscribing directly.
            if (teardown.dispose) teardown.dispose();
            else teardown.unsub?.();
          }
        );
      };
      // `subscribe` replays live panels synchronously, so a plugin activated BY
      // a view opening still sees that panel's `mounted` phase.
      teardown.unsub = deps.panelLifecycleBroker.subscribe(pluginId, handler);
      const dispose = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () =>
        teardown.unsub?.()
      );
      teardown.dispose = dispose;
      return Promise.resolve(dispose);
    },
    onDidWake: (callback) => {
      if (isRevoked()) {
        throw new Error(
          `Plugin "${pluginId}" host revoked: onDidWake called after activate() returned or timed out`
        );
      }
      // No capability gate: the payload is the machine's own suspend/resume
      // timing and nothing else — no workspace, user, or cross-plugin data. It
      // is also strictly less than every renderer window already receives
      // unconditionally on the same wake (#12175).
      const failures = createListenerFailureState();
      const handler = (payload: { sleepDuration: number; timestamp: number }): void => {
        // Deliberately NOT filtered by the host's project binding, unlike
        // `onDidChangeAgentState`: a wake is machine-scoped, so every loaded
        // instance of the plugin must hear it, including one bound to a project
        // whose window is not focused — which is exactly the stale-state case
        // this event exists for.
        if (!deps.plugins.has(pluginId)) return;
        invokeTrackedListener(
          failures,
          pluginId,
          "onDidWake",
          () =>
            callback(
              Object.freeze({
                sleepDuration: payload.sleepDuration,
                timestamp: payload.timestamp,
              })
            ),
          () => dispose()
        );
      };
      // No replay on subscribe: a wake is a one-shot pulse with no resting
      // state to hand a late subscriber.
      const unsub = events.on("sys:wake", handler);
      const dispose = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () => unsub());
      return Promise.resolve(dispose);
    },
  };
}
