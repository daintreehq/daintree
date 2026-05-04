import { app } from "electron";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { summarizeMcpArgs } from "../../../shared/utils/mcpArgsSummary.js";
import { getAgentAvailabilityStore } from "../AgentAvailabilityStore.js";
import { events } from "../events.js";
import type { AuditOutcome } from "./auditLog.js";
import type {
  McpTier,
  ParsedResourceUri,
  PromptDefinition,
  PromptRenderContext,
  DispatchEnvelope,
} from "./shared.js";
import {
  TERMINAL_WAIT_UNTIL_IDLE_TOOL,
  WAIT_UNTIL_IDLE_DESCRIPTION,
  WAIT_UNTIL_IDLE_INPUT_SCHEMA,
  WAIT_UNTIL_IDLE_OUTPUT_SCHEMA,
  PROMPT_DEFINITIONS,
  PROMPT_TERMINAL_OUTPUT_MAX_CHARS,
  RESOURCE_SCROLLBACK_TAIL_LINES,
  parseResourceUri,
  serializeResourcePayload,
  unwrapDispatchResult,
  truncateText,
  safeSerializeToolResult,
  readStringField,
  RESOURCE_BACKING_ACTIONS,
  TIER_NOT_PERMITTED_CODE,
  CONFIRMATION_TIMEOUT_CODE,
  USER_REJECTED_CODE,
  ELICITATION_FAILED_CODE,
} from "./shared.js";
import {
  shouldExposeTool,
  isTierPermitted,
  buildToolDescription,
  buildToolInputSchema,
  buildAnnotations,
  buildToolOutputSchema,
  buildStructuredContent,
  parseToolArguments,
} from "./tierAuth.js";
import type { SessionStore } from "./sessionStore.js";

export interface SessionServerDeps {
  sessionStore: SessionStore;
  requestManifest: () => Promise<import("../../../shared/types/actions.js").ActionManifestEntry[]>;
  dispatchAction: (
    actionId: string,
    args: unknown,
    confirmed?: boolean
  ) => Promise<DispatchEnvelope>;
  handleWaitUntilIdle: (
    rawArgs: unknown,
    signal: AbortSignal
  ) => Promise<import("./shared.js").WaitUntilIdleResult>;
  appendAuditRecord: (input: {
    toolId: string;
    sessionId: string;
    tier: McpTier;
    args: unknown;
    durationMs: number;
    outcome: AuditOutcome;
    confirmationDecision?: import("../../../shared/types/ipc/mcpServer.js").McpConfirmationDecision;
  }) => void;
  getCachedManifest: () => import("../../../shared/types/actions.js").ActionManifestEntry[] | null;
  getFullToolSurface: () => boolean;
}

export function createSessionServer(sessionId: string, deps: SessionServerDeps): Server {
  const {
    sessionStore,
    requestManifest,
    dispatchAction,
    handleWaitUntilIdle: waitUntilIdle,
    appendAuditRecord,
    getCachedManifest,
    getFullToolSurface,
  } = deps;

  const server = new Server(
    { name: "Daintree", version: app.getVersion() },
    {
      capabilities: {
        tools: {},
        resources: { subscribe: true, listChanged: false },
        prompts: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const manifest = await requestManifest();
    const tier = sessionStore.getTier(sessionId);
    const fullToolSurface = getFullToolSurface();
    const tools = manifest
      .filter((entry) => shouldExposeTool(entry, tier, fullToolSurface))
      .map((entry) => {
        const outputSchema = buildToolOutputSchema(entry);
        return {
          name: entry.id,
          description: buildToolDescription(entry),
          inputSchema: buildToolInputSchema(entry),
          annotations: buildAnnotations(entry),
          ...(outputSchema ? { outputSchema } : {}),
        };
      });

    if (isTierPermitted(tier, TERMINAL_WAIT_UNTIL_IDLE_TOOL, fullToolSurface)) {
      tools.push({
        name: TERMINAL_WAIT_UNTIL_IDLE_TOOL,
        description: WAIT_UNTIL_IDLE_DESCRIPTION,
        inputSchema: WAIT_UNTIL_IDLE_INPUT_SCHEMA,
        annotations: {
          title: "Wait until terminal idle",
          readOnlyHint: true,
          idempotentHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        outputSchema: WAIT_UNTIL_IDLE_OUTPUT_SCHEMA,
      });
    }

    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const actionId = request.params.name;
    const { args } = parseToolArguments(request.params.arguments);
    const startedAt = Date.now();
    const tier = sessionStore.getTier(sessionId);
    const fullToolSurface = getFullToolSurface();

    if (!isTierPermitted(tier, actionId, fullToolSurface)) {
      try {
        appendAuditRecord({
          toolId: actionId,
          sessionId,
          tier,
          args,
          durationMs: Date.now() - startedAt,
          outcome: { kind: "unauthorized" },
        });
      } catch (err) {
        console.error("[MCP] Failed to append audit record:", err);
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Error [${TIER_NOT_PERMITTED_CODE}]: action '${actionId}' is not permitted for the '${tier}' tier.`,
          },
        ],
        isError: true,
      };
    }

    if (actionId === TERMINAL_WAIT_UNTIL_IDLE_TOOL) {
      let nativeOutcome:
        | { kind: "result"; value: import("../../../shared/types/actions.js").ActionDispatchResult }
        | { kind: "throw"; error: unknown }
        | undefined;
      try {
        const result = await waitUntilIdle(args, extra.signal);
        nativeOutcome = { kind: "result", value: { ok: true, result } };
        return {
          content: [{ type: "text" as const, text: safeSerializeToolResult(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (err) {
        nativeOutcome = { kind: "throw", error: err };
        if (err instanceof McpError) {
          throw err;
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${formatErrorMessage(err, "waitUntilIdle failed")}`,
            },
          ],
          isError: true,
        };
      } finally {
        try {
          appendAuditRecord({
            toolId: actionId,
            sessionId,
            tier,
            args,
            durationMs: Date.now() - startedAt,
            outcome: nativeOutcome ?? { kind: "throw", error: new Error("unknown") },
          });
        } catch (auditErr) {
          console.error("[MCP] Failed to append audit record:", auditErr);
        }
      }
    }

    let outcome:
      | { kind: "result"; value: import("../../../shared/types/actions.js").ActionDispatchResult }
      | { kind: "throw"; error: unknown };
    let confirmationDecision:
      | import("../../../shared/types/ipc/mcpServer.js").McpConfirmationDecision
      | undefined;
    let dispatchConfirmed = false;

    try {
      const entry = await lookupManifestEntry(actionId, getCachedManifest, requestManifest);
      if (!dispatchConfirmed && entry?.danger === "confirm") {
        const supportsForm = server.getClientCapabilities()?.elicitation?.form !== undefined;
        if (supportsForm) {
          const elicitationOutcome = await runElicitationConfirmation(server, entry, args);
          if (elicitationOutcome.kind === "throw") {
            const failureMessage = formatErrorMessage(
              elicitationOutcome.error,
              "Elicitation request failed"
            );
            const value: import("../../../shared/types/actions.js").ActionDispatchResult = {
              ok: false,
              error: {
                code: ELICITATION_FAILED_CODE,
                message: failureMessage,
              },
            };
            outcome = { kind: "result", value };
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error [${ELICITATION_FAILED_CODE}]: ${failureMessage}`,
                },
              ],
              isError: true,
            };
          }
          if (elicitationOutcome.kind === "rejected") {
            outcome = { kind: "result", value: elicitationOutcome.value };
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error [${elicitationOutcome.value.error.code}]: ${elicitationOutcome.value.error.message}`,
                },
              ],
              isError: true,
            };
          }
          dispatchConfirmed = true;
          confirmationDecision = "approved";
        }
      }

      try {
        const envelope = await dispatchAction(actionId, args, dispatchConfirmed);
        outcome = { kind: "result", value: envelope.result };
        confirmationDecision = confirmationDecision ?? envelope.confirmationDecision;
      } catch (err) {
        outcome = { kind: "throw", error: err };
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${formatErrorMessage(err, "Action dispatch failed")}`,
            },
          ],
          isError: true,
        };
      }

      if (outcome.value.ok) {
        const structuredContent = buildStructuredContent(entry, outcome.value.result);
        return {
          content: [
            {
              type: "text" as const,
              text:
                outcome.value.result !== undefined && outcome.value.result !== null
                  ? safeSerializeToolResult(outcome.value.result)
                  : "OK",
            },
          ],
          ...(structuredContent ? { structuredContent } : {}),
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Error [${outcome.value.error.code}]: ${outcome.value.error.message}`,
          },
        ],
        isError: true,
      };
    } finally {
      try {
        appendAuditRecord({
          toolId: actionId,
          sessionId,
          tier,
          args,
          durationMs: Date.now() - startedAt,
          outcome: outcome!,
          confirmationDecision,
        });
      } catch (err) {
        console.error("[MCP] Failed to append audit record:", err);
      }
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources: await listConcreteResources(sessionId, deps) };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return { resourceTemplates: listResourceTemplates(sessionId, deps) };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const parsed = parseResourceUri(uri);
    if (!parsed) {
      throw new McpError(ErrorCode.InvalidRequest, `Unknown resource URI: ${uri}`);
    }
    if (!isResourcePermitted(sessionId, deps, parsed.kind)) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Resource '${uri}' is not permitted for the '${sessionStore.getTier(sessionId)}' tier.`
      );
    }
    const contents = await readResourceContents(uri, parsed, dispatchAction);
    return { contents: [contents] };
  });

  server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    const uri = request.params.uri;
    const parsed = parseResourceUri(uri);
    if (!parsed) {
      throw new McpError(ErrorCode.InvalidRequest, `Unknown resource URI: ${uri}`);
    }
    if (!isResourcePermitted(sessionId, deps, parsed.kind)) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Resource '${uri}' is not permitted for the '${sessionStore.getTier(sessionId)}' tier.`
      );
    }
    subscribeResource(sessionId, server, uri, parsed, sessionStore);
    return {};
  });

  server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    unsubscribeResource(sessionId, request.params.uri, sessionStore);
    return {};
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: PROMPT_DEFINITIONS.map((def) => ({
        name: def.name,
        description: def.description,
        arguments: def.arguments,
      })),
    };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const name = request.params.name;
    const definition = PROMPT_DEFINITIONS.find((def) => def.name === name);
    if (!definition) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
    }

    const args: Record<string, string> = (request.params.arguments ?? {}) as Record<string, string>;

    for (const arg of definition.arguments) {
      if (arg.required && !args[arg.name]?.trim()) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Missing required argument for prompt '${name}': ${arg.name}`
        );
      }
    }

    const context = await collectPromptContext(definition, args, dispatchAction);
    const text = definition.render(args, context);

    return {
      description: definition.description,
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text },
        },
      ],
    };
  });

  return server;
}

// --- Resource helpers ---

async function listConcreteResources(
  sessionId: string,
  deps: SessionServerDeps
): Promise<Array<{ uri: string; name: string; mimeType: string; description?: string }>> {
  const resources: Array<{ uri: string; name: string; mimeType: string; description?: string }> =
    [];
  if (isResourcePermitted(sessionId, deps, "issues")) {
    resources.push({
      uri: "daintree://project/current/issues",
      name: "Current project — open issues",
      mimeType: "application/json",
      description: "Open GitHub issues for the active project.",
    });
  }
  if (isResourcePermitted(sessionId, deps, "pulse")) {
    const worktrees = await tryDispatchList("worktree.list", deps.dispatchAction);
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
  if (
    isResourcePermitted(sessionId, deps, "scrollback") ||
    isResourcePermitted(sessionId, deps, "agentState")
  ) {
    const terminals = await tryDispatchList("terminal.list", deps.dispatchAction);
    for (const term of terminals) {
      const id = readStringField(term, ["id", "terminalId"]);
      const label = readStringField(term, ["title", "name"]) ?? id;
      if (id && isResourcePermitted(sessionId, deps, "scrollback")) {
        resources.push({
          uri: `daintree://terminal/${encodeURIComponent(id)}/scrollback`,
          name: `Terminal scrollback — ${label ?? id}`,
          mimeType: "text/plain",
          description: `Last ${RESOURCE_SCROLLBACK_TAIL_LINES} lines of terminal output.`,
        });
      }
      const agentId = readStringField(term, ["agentId"]);
      if (agentId && isResourcePermitted(sessionId, deps, "agentState")) {
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
  sessionId: string,
  deps: SessionServerDeps
): Array<{ uriTemplate: string; name: string; mimeType: string; description?: string }> {
  const templates: Array<{
    uriTemplate: string;
    name: string;
    mimeType: string;
    description?: string;
  }> = [];
  if (isResourcePermitted(sessionId, deps, "pulse")) {
    templates.push({
      uriTemplate: "daintree://worktree/{id}/pulse",
      name: "Worktree pulse",
      mimeType: "application/json",
      description: "Git status summary, recent commits, and pull-request signal.",
    });
  }
  if (isResourcePermitted(sessionId, deps, "scrollback")) {
    templates.push({
      uriTemplate: "daintree://terminal/{id}/scrollback",
      name: "Terminal scrollback",
      mimeType: "text/plain",
      description: `Last ${RESOURCE_SCROLLBACK_TAIL_LINES} lines of terminal output.`,
    });
  }
  if (isResourcePermitted(sessionId, deps, "agentState")) {
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
  dispatchAction: SessionServerDeps["dispatchAction"]
): Promise<{ uri: string; mimeType: string; text: string }> {
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
    const text = typeof value === "string" ? value : serializeResourcePayload(value);
    return { uri, mimeType: "text/plain", text: truncateText(text) };
  }
  if (parsed.kind === "agentState") {
    const state = getAgentAvailabilityStore().getState(parsed.id);
    const text = JSON.stringify({ agentId: parsed.id, state: state ?? null });
    return { uri, mimeType: "application/json", text };
  }
  if (parsed.kind === "issues") {
    const envelope = await dispatchAction("github.listIssues", {});
    const text = serializeResourcePayload(unwrapDispatchResult(envelope));
    return { uri, mimeType: "application/json", text: truncateText(text) };
  }
  throw new McpError(ErrorCode.InvalidRequest, `Unknown resource URI: ${uri}`);
}

async function tryDispatchList(
  actionId: string,
  dispatchAction: SessionServerDeps["dispatchAction"]
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
    console.error(`[MCP] Failed to enumerate resources via ${actionId}:`, err);
    return [];
  }
}

function isResourcePermitted(sessionId: string, deps: SessionServerDeps, kind: string): boolean {
  const tier = deps.sessionStore.getTier(sessionId);
  const fullToolSurface = deps.getFullToolSurface();
  return isTierPermitted(
    tier,
    (RESOURCE_BACKING_ACTIONS as Record<string, string>)[kind],
    fullToolSurface
  );
}

function subscribeResource(
  sessionId: string,
  server: Server,
  uri: string,
  parsed: ParsedResourceUri,
  sessionStore: SessionStore
): void {
  if (parsed.kind !== "pulse" && parsed.kind !== "agentState") {
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
    if (!sessionStore.sessions.has(sessionId) && !sessionStore.httpSessions.has(sessionId)) return;
    server.sendResourceUpdated({ uri }).catch((err) => {
      console.error(`[MCP] sendResourceUpdated failed for ${uri}:`, err);
    });
  };

  let unsub: () => void;
  if (parsed.kind === "agentState") {
    unsub = events.on("agent:state-changed", (payload) => {
      if (payload.agentId === parsed.id) fire();
    });
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

// --- Prompt helpers ---

async function collectPromptContext(
  definition: PromptDefinition,
  args: Record<string, string>,
  dispatchAction: SessionServerDeps["dispatchAction"]
): Promise<PromptRenderContext> {
  const context: PromptRenderContext = {};

  const worktree = await safeDispatch("worktree.getCurrent", undefined, dispatchAction);
  if (worktree && typeof worktree === "object") {
    const w = worktree as Record<string, unknown>;
    if (typeof w.path === "string") context.worktreePath = w.path;
    if (typeof w.branch === "string") context.worktreeBranch = w.branch;
    if (typeof w.issueNumber === "number") context.worktreeIssueNumber = w.issueNumber;
  }

  if (definition.name === "triage_failed_agent") {
    const terminalId = args.terminal_id?.trim();
    if (terminalId) {
      const result = await safeDispatch(
        "terminal.getOutput",
        {
          terminalId,
          maxLines: 100,
          stripAnsi: true,
        },
        dispatchAction
      );
      if (result && typeof result === "object") {
        const r = result as Record<string, unknown>;
        if (typeof r.content === "string") {
          const content = r.content;
          if (content.length > PROMPT_TERMINAL_OUTPUT_MAX_CHARS) {
            const tail = content.slice(-PROMPT_TERMINAL_OUTPUT_MAX_CHARS);
            context.terminalOutput = `… [truncated to last ${PROMPT_TERMINAL_OUTPUT_MAX_CHARS} chars]\n${tail}`;
          } else {
            context.terminalOutput = content;
          }
        }
      }
    }
  }

  return context;
}

async function safeDispatch(
  actionId: string,
  args: unknown,
  dispatchAction: SessionServerDeps["dispatchAction"]
): Promise<unknown> {
  try {
    const envelope = await dispatchAction(actionId, args);
    if (envelope.result.ok) {
      return envelope.result.result;
    }
    return null;
  } catch {
    return null;
  }
}

async function lookupManifestEntry(
  actionId: string,
  getCachedManifest: () => import("../../../shared/types/actions.js").ActionManifestEntry[] | null,
  requestManifest: () => Promise<import("../../../shared/types/actions.js").ActionManifestEntry[]>
): Promise<import("../../../shared/types/actions.js").ActionManifestEntry | undefined> {
  let cached = getCachedManifest();
  if (!cached) {
    try {
      await requestManifest();
      cached = getCachedManifest();
    } catch {
      return undefined;
    }
  }
  return cached?.find((e) => e.id === actionId);
}

async function runElicitationConfirmation(
  server: Server,
  entry: import("../../../shared/types/actions.js").ActionManifestEntry,
  args: unknown
): Promise<
  | { kind: "approved" }
  | {
      kind: "rejected";
      value: Extract<
        import("../../../shared/types/actions.js").ActionDispatchResult,
        { ok: false }
      >;
    }
  | { kind: "throw"; error: unknown }
> {
  const argsSummary = summarizeMcpArgs(args);
  const message =
    argsSummary && argsSummary !== "{}"
      ? `Confirm ${entry.title}: ${entry.description}\n\nArguments: ${argsSummary}`
      : `Confirm ${entry.title}: ${entry.description}`;

  let result;
  try {
    result = await server.elicitInput({
      message,
      requestedSchema: {
        type: "object",
        properties: {},
      },
    });
  } catch (err) {
    return { kind: "throw", error: err };
  }

  if (result.action === "cancel") {
    return {
      kind: "rejected",
      value: {
        ok: false,
        error: {
          code: CONFIRMATION_TIMEOUT_CODE,
          message: "Confirmation request timed out before the user responded.",
        },
      },
    };
  }

  if (result.action !== "accept") {
    return {
      kind: "rejected",
      value: {
        ok: false,
        error: {
          code: USER_REJECTED_CODE,
          message: "User rejected the confirmation request.",
        },
      },
    };
  }

  return { kind: "approved" };
}
