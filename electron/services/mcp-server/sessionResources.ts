import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { getAgentAvailabilityStore } from "../AgentAvailabilityStore.js";
import { events } from "../events.js";
import { onWorkspaceResidencyChanged, readWorkspaceBindingState } from "../workspaceResidency.js";
import type { McpTier, ParsedResourceUri } from "./shared.js";
import {
  RESOURCE_SCROLLBACK_TAIL_LINES,
  parseResourceUri,
  serializeResourcePayload,
  unwrapDispatchResult,
  truncateText,
  truncateTextTail,
  readStringField,
  RESOURCE_BACKING_ACTIONS,
  TIER_NOT_PERMITTED_CODE,
  buildMcpErrorPayload,
  WORKSPACE_BINDING_RESOURCE_URI,
} from "./shared.js";
import { WorkspaceBindingError } from "./rendererBridge.js";
import { isTierPermitted } from "./tierAuth.js";
import { safeSerializeToolResultCompact } from "../../utils/safeSerializeToolResult.js";
import type { SessionStore } from "./sessionStore.js";
import type { SessionContext } from "./sessionContext.js";
import { routeBindingMcpError, sessionGoneError } from "./sessionRouteErrors.js";
import type { SessionServerDeps } from "./sessionServerDepsContract.js";

export function registerResourceHandlers(server: Server, session: SessionContext): void {
  const { sessionId, deps, mayNameTerminal } = session;
  const { sessionStore, dispatchAction, workspaceBinding } = deps;

  // Each resource handler resolves the tier once at entry and threads it down
  // (#11799). One capture per request: the listing helpers await dispatches
  // mid-enumeration, and re-reading across those awaits would let one response
  // mix two authorization lifetimes.
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const tier = sessionStore.getTier(sessionId);
    if (tier === null) throw sessionGoneError();
    return { resources: await listConcreteResources(tier, deps) };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    const tier = sessionStore.getTier(sessionId);
    if (tier === null) throw sessionGoneError();
    return { resourceTemplates: listResourceTemplates(tier) };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const tier = sessionStore.getTier(sessionId);
    if (tier === null) throw sessionGoneError();
    const uri = request.params.uri;
    const parsed = parseResourceUri(uri);
    if (!parsed) {
      throw new McpError(ErrorCode.InvalidRequest, `Unknown resource URI: ${uri}`);
    }
    if (!isResourcePermitted(tier, parsed.kind)) {
      const message = `Resource '${uri}' is not permitted for the '${tier}' tier.`;
      throw new McpError(
        ErrorCode.InvalidRequest,
        message,
        buildMcpErrorPayload({ code: TIER_NOT_PERMITTED_CODE, message })
      );
    }
    if (parsed.kind === "scrollback" && !mayNameTerminal(tier, parsed.id)) {
      throw new McpError(ErrorCode.InvalidRequest, `Unknown resource URI: ${uri}`);
    }
    // `agentState` deliberately has no view-residency probe (#12316). It answers
    // from the process-global `AgentAvailabilityStore` with no renderer
    // involved, so requiring the bound workspace to hold a live view made an
    // orchestrator's reach a function of the user's navigation — the whole
    // complaint. The probe #12082 added closed only half of a gap it could not
    // close: which workspace an agent belongs to is not checked here either
    // way, because that needs an agent→workspace map this layer does not have,
    // and a bound session with a live view could always read across it. Closing
    // it properly is #11789's own scoping work, and it has to apply to both.
    //
    // `binding` never needed one: it dispatches nothing, so there is no route
    // for a probe to be protecting. That is the whole point — it is the one
    // read a session whose workspace is gone can still make (#12313).
    try {
      return {
        contents: [
          await readResourceContents(
            uri,
            parsed,
            dispatchAction,
            workspaceBinding?.workspaceId,
            deps.preferredWebContentsId
          ),
        ],
      };
    } catch (err) {
      const routed = routeBindingMcpError(err);
      if (routed) throw routed;
      throw err;
    }
  });

  server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    // Gated before `subscribeResource` can install an event listener, so a
    // revoked session never leaves a subscription behind for a transport that
    // is already gone.
    const tier = sessionStore.getTier(sessionId);
    if (tier === null) throw sessionGoneError();
    const uri = request.params.uri;
    const parsed = parseResourceUri(uri);
    if (!parsed) {
      throw new McpError(ErrorCode.InvalidRequest, `Unknown resource URI: ${uri}`);
    }
    if (!isResourcePermitted(tier, parsed.kind)) {
      const message = `Resource '${uri}' is not permitted for the '${tier}' tier.`;
      throw new McpError(
        ErrorCode.InvalidRequest,
        message,
        buildMcpErrorPayload({ code: TIER_NOT_PERMITTED_CODE, message })
      );
    }
    subscribeResource(sessionId, server, uri, parsed, sessionStore, workspaceBinding?.workspaceId);
    return {};
  });

  server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    unsubscribeResource(sessionId, request.params.uri, sessionStore);
    return {};
  });
}

async function listConcreteResources(
  tier: McpTier,
  deps: SessionServerDeps
): Promise<Array<{ uri: string; name: string; mimeType: string; description?: string }>> {
  const resources: Array<{ uri: string; name: string; mimeType: string; description?: string }> =
    [];
  // First, and before anything that dispatches. A workspace-bound session whose
  // view is gone cannot reach a renderer, so this is the only entry it is
  // guaranteed to get — and it is what makes the degraded listing below honest
  // rather than an authoritative "you have nothing" (#12313).
  if (isResourcePermitted(tier, "binding")) {
    resources.push({
      uri: WORKSPACE_BINDING_RESOURCE_URI,
      name: "This session — workspace binding",
      mimeType: "application/json",
      description:
        "Whether this session's bound workspace has a live view, when eviction last took one, and whether the user asked to keep it resident.",
    });
  }
  // Captured before the first await, so the decision below is a value this
  // function already holds rather than a state read from inside a catch
  // (lesson #10222). Its meaning is narrow: an unreachable workspace may only
  // drop the categories that needed a renderer if the client is simultaneously
  // being handed the resource that explains why they are missing.
  const bindingListed = resources.length > 0;
  if (isResourcePermitted(tier, "issues")) {
    resources.push({
      uri: "daintree://project/current/issues",
      name: "Current project — open issues",
      mimeType: "application/json",
      description: "Open issues for the active project.",
    });
  }
  if (isResourcePermitted(tier, "pulse")) {
    const worktrees = await tryDispatchList("worktree.list", deps.dispatchAction, bindingListed);
    for (const wt of worktrees) {
      const id = readStringField(wt, ["id", "worktreeId"]);
      const label = readStringField(wt, ["branch", "name", "path"]) ?? id;
      if (!id) continue;
      resources.push({
        uri: `daintree://worktree/${encodeURIComponent(id)}/pulse`,
        name: `Worktree pulse — ${label ?? id}`,
        mimeType: "application/json",
        description: "Git status summary, recent commits, and pull-request signal.",
      });
    }
  }
  if (isResourcePermitted(tier, "scrollback") || isResourcePermitted(tier, "agentState")) {
    const terminals = await tryDispatchList("terminal.list", deps.dispatchAction, bindingListed);
    // The agent-state URI is addressed by agent type, so terminals running the
    // same type all name one resource; list it once.
    const listedAgentIds = new Set<string>();
    for (const term of terminals) {
      const id = readStringField(term, ["id", "terminalId"]);
      const label = readStringField(term, ["title", "name"]) ?? id;
      if (id && isResourcePermitted(tier, "scrollback")) {
        resources.push({
          uri: `daintree://terminal/${encodeURIComponent(id)}/scrollback`,
          name: `Terminal scrollback — ${label ?? id}`,
          mimeType: "text/plain",
          description: `Last ${RESOURCE_SCROLLBACK_TAIL_LINES} lines of terminal output.`,
        });
      }
      const agentId = readStringField(term, ["agentId"]);
      if (agentId && !listedAgentIds.has(agentId) && isResourcePermitted(tier, "agentState")) {
        listedAgentIds.add(agentId);
        resources.push({
          uri: `daintree://agent/${encodeURIComponent(agentId)}/state`,
          name: `Agent state — ${label ?? agentId}`,
          mimeType: "application/json",
          description: "Current agent state-machine value (idle, working, waiting, etc.).",
        });
      }
    }
  }
  return resources;
}

function listResourceTemplates(
  tier: McpTier
): Array<{ uriTemplate: string; name: string; mimeType: string; description?: string }> {
  const templates: Array<{
    uriTemplate: string;
    name: string;
    mimeType: string;
    description?: string;
  }> = [];
  if (isResourcePermitted(tier, "pulse")) {
    templates.push({
      uriTemplate: "daintree://worktree/{id}/pulse",
      name: "Worktree pulse",
      mimeType: "application/json",
      description: "Git status summary, recent commits, and pull-request signal.",
    });
  }
  if (isResourcePermitted(tier, "scrollback")) {
    templates.push({
      uriTemplate: "daintree://terminal/{id}/scrollback",
      name: "Terminal scrollback",
      mimeType: "text/plain",
      description: `Last ${RESOURCE_SCROLLBACK_TAIL_LINES} lines of terminal output.`,
    });
  }
  if (isResourcePermitted(tier, "agentState")) {
    templates.push({
      uriTemplate: "daintree://agent/{id}/state",
      name: "Agent state",
      mimeType: "application/json",
      description: "Current agent state-machine value (idle, working, waiting, etc.).",
    });
  }
  return templates;
}

async function readResourceContents(
  uri: string,
  parsed: ParsedResourceUri,
  dispatchAction: SessionServerDeps["dispatchAction"],
  boundWorkspaceId: string | undefined,
  preferredWebContentsId: number | undefined
): Promise<{ uri: string; mimeType: string; text: string }> {
  if (parsed.kind === "binding") {
    // Resolved fresh on every read, from the same registry routing consults, so
    // "this says available" and "a call would route" cannot drift (#7003 — never
    // a cache, and never another session's or window's state).
    const state = readWorkspaceBindingState(boundWorkspaceId ?? null, preferredWebContentsId);
    return { uri, mimeType: "application/json", text: JSON.stringify(state) };
  }
  if (parsed.kind === "pulse") {
    const envelope = await dispatchAction("git.getProjectPulse", {
      worktreeId: parsed.id,
      rangeDays: 60,
    });
    const text = serializeResourcePayload(unwrapDispatchResult(envelope));
    return { uri, mimeType: "application/json", text: truncateText(text) };
  }
  if (parsed.kind === "scrollback") {
    const envelope = await dispatchAction("terminal.getOutput", {
      terminalId: parsed.id,
      maxLines: RESOURCE_SCROLLBACK_TAIL_LINES,
      stripAnsi: true,
    });
    const value = unwrapDispatchResult(envelope);
    if (typeof value === "string") {
      return { uri, mimeType: "text/plain", text: truncateTextTail(value) };
    }
    // Compact, because `terminal.getOutput` fitted its tail to this same cap
    // measured compact (#12450): indenting a full tail would push it back over
    // and into the head-preserving cut, which leaves JSON that will not parse.
    const text =
      value === undefined || value === null ? "null" : safeSerializeToolResultCompact(value);
    return { uri, mimeType: "text/plain", text: truncateText(text) };
  }
  if (parsed.kind === "agentState") {
    // The URI names an agent type, not a terminal, so this reports the one
    // terminal of that type we heard from most recently — all of its fields
    // from that one terminal, and naming it, so a sibling's state is never
    // passed off as this one's (#12494).
    const snapshot = getAgentAvailabilityStore().getLatestSnapshotForAgent(parsed.id);
    const state = snapshot?.state;
    const waitingReason = state === "waiting" ? snapshot?.waitingReason : undefined;
    // Exit metadata only after the agent has finished. exitCode may be null
    // (signal kill), so gate on the agent being in a terminal state rather than
    // on the value being truthy.
    const hasExited = state === "completed" || state === "exited";
    const exitCode = hasExited ? snapshot?.exitCode : undefined;
    const exitSignal = hasExited ? snapshot?.exitSignal : undefined;
    const spawnedAt = snapshot?.spawnedAt;
    const lastTransitionAt = snapshot?.lastStateChange;
    const text = JSON.stringify({
      agentId: parsed.id,
      ...(snapshot ? { terminalId: snapshot.terminalId } : {}),
      state: state ?? null,
      ...(waitingReason ? { waitingReason } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(exitSignal !== undefined ? { exitSignal } : {}),
      ...(spawnedAt !== undefined ? { spawnedAt } : {}),
      ...(lastTransitionAt !== undefined ? { lastTransitionAt } : {}),
    });
    return { uri, mimeType: "application/json", text };
  }
  if (parsed.kind === "issues") {
    // Explicit rather than riding the action's default: this resource is read
    // whole and then truncated, so the compact projection is the point.
    const envelope = await dispatchAction("forge.listIssues", { view: "summary" });
    const text = serializeResourcePayload(unwrapDispatchResult(envelope));
    return { uri, mimeType: "application/json", text: truncateText(text) };
  }
  throw new McpError(ErrorCode.InvalidRequest, `Unknown resource URI: ${uri}`);
}

async function tryDispatchList(
  actionId: string,
  dispatchAction: SessionServerDeps["dispatchAction"],
  bindingResourceListed: boolean
): Promise<unknown[]> {
  try {
    const envelope = await dispatchAction(actionId, {});
    const value = unwrapDispatchResult(envelope);
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      for (const key of ["items", "results", "list", "terminals", "worktrees"]) {
        const inner = (value as Record<string, unknown>)[key];
        if (Array.isArray(inner)) return inner;
      }
    }
    return [];
  } catch (err) {
    // An unreachable route is not an empty workspace (#12082). Swallowing it
    // here would answer `resources/list` with an authoritative-looking "you
    // have nothing" for a bound session whose workspace is simply not open —
    // the same lie the terminal handshake used to tell, in a quieter place.
    // Ordinary enumeration failures keep degrading to a partial listing.
    //
    // What changed in #12313 is that the listing can now say so. When the
    // binding resource is in the response, dropping this category is not a
    // claim about the workspace's contents — the client is holding a resource
    // that reports the route is gone, when eviction took it, and that it will
    // come back. Without that resource the old refusal is still the only honest
    // answer, so the flag is checked rather than assumed.
    //
    // Narrowed to `WorkspaceBindingError` deliberately. A `SessionBindingError`
    // is a dead WebContents pin: the session's identity is a destroyed view it
    // can never re-resolve, so there is no later state in which the listing
    // fills back in, and degrading it would promise a recovery that cannot
    // happen. That one still refuses.
    if (bindingResourceListed && err instanceof WorkspaceBindingError) return [];
    const routed = routeBindingMcpError(err);
    if (routed) throw routed;
    console.error(`[MCP] Failed to enumerate resources via ${actionId}:`, err);
    return [];
  }
}

/**
 * Pure tier check — takes the tier its caller already resolved rather than
 * reading the store again (#11799). The resource handlers resolve liveness once
 * at entry, so this helper is only ever reached for a live session, and the
 * twelve call sites across the two listing helpers share that one capture
 * instead of racing the store twelve separate times.
 */
function isResourcePermitted(tier: McpTier, kind: string): boolean {
  return isTierPermitted(tier, (RESOURCE_BACKING_ACTIONS as Record<string, string>)[kind]);
}

function subscribeResource(
  sessionId: string,
  server: Server,
  uri: string,
  parsed: ParsedResourceUri,
  sessionStore: SessionStore,
  boundWorkspaceId: string | undefined
): void {
  if (parsed.kind !== "pulse" && parsed.kind !== "agentState" && parsed.kind !== "binding") {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Subscriptions are not supported for resource '${uri}'.`
    );
  }
  let bucket = sessionStore.resourceSubscriptions.get(sessionId);
  if (!bucket) {
    bucket = new Map();
    sessionStore.resourceSubscriptions.set(sessionId, bucket);
  }
  if (bucket.has(uri)) return;

  const fire = () => {
    if (!sessionStore.hasLiveTransport(sessionId)) return;
    server.sendResourceUpdated({ uri }).catch((err) => {
      console.error(`[MCP] sendResourceUpdated failed for ${uri}:`, err);
    });
  };

  let unsub: () => void;
  if (parsed.kind === "binding") {
    // Push is latency reduction, never the contract. The transport is built
    // without an `eventStore` (`httpLifecycle.ts`), and the SDK's `send()`
    // returns silently when no client is holding the standalone GET stream, so
    // a notification can be dropped with no error anywhere — which is exactly
    // why the read above is the authoritative half and this only says "read
    // again" (#12313).
    //
    // An unbound session subscribing gets a live, permanently quiet
    // subscription: it has no binding, so nothing can change about one. Cheaper
    // and more predictable than refusing, and its read still answers `unbound`.
    unsub =
      boundWorkspaceId === undefined
        ? () => {}
        : onWorkspaceResidencyChanged(boundWorkspaceId, fire);
  } else if (parsed.kind === "agentState") {
    // A spawn resets a terminal, and a kill or a hand-started agent quitting
    // to its shell drops it; any of them can change which terminal the read
    // reports without a state change of its own — killing an already-idle
    // agent emits none.
    const offs = [
      events.on("agent:state-changed", (payload) => {
        if (payload.agentId === parsed.id) fire();
      }),
      events.on("agent:spawned", (payload) => {
        if (payload.agentId === parsed.id) fire();
      }),
      events.on("agent:killed", (payload) => {
        if (payload.agentId === parsed.id) fire();
      }),
      events.on("agent:exited", (payload) => {
        if (payload.exitKind === "subcommand" && payload.agentType === parsed.id) fire();
      }),
    ];
    unsub = () => {
      for (const off of offs) off();
    };
  } else {
    unsub = events.on("sys:worktree:update", (payload) => {
      if (payload.worktreeId === parsed.id) fire();
    });
  }
  bucket.set(uri, unsub);
}

function unsubscribeResource(sessionId: string, uri: string, sessionStore: SessionStore): void {
  const bucket = sessionStore.resourceSubscriptions.get(sessionId);
  if (!bucket) return;
  const unsub = bucket.get(uri);
  if (!unsub) return;
  try {
    unsub();
  } catch (err) {
    console.error(`[MCP] Failed to unsubscribe ${uri}:`, err);
  }
  bucket.delete(uri);
  if (bucket.size === 0) {
    sessionStore.resourceSubscriptions.delete(sessionId);
  }
}

export function cleanupResourceSubscriptions(sessionId: string, sessionStore: SessionStore): void {
  const bucket = sessionStore.resourceSubscriptions.get(sessionId);
  if (!bucket) return;
  for (const unsub of bucket.values()) {
    try {
      unsub();
    } catch (err) {
      console.error("[MCP] Resource subscription teardown failed:", err);
    }
  }
  sessionStore.resourceSubscriptions.delete(sessionId);
}
