import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  AGENT_MCP_CALL_TIMEOUT_MS,
  AGENT_MCP_MAX_RESULT_BYTES,
  type PluginMcpCaller,
} from "../../../shared/types/plugin.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { agentMcpEndpointRegistry, type AgentMcpEndpointRegistry } from "./endpointRegistry.js";
import {
  DATABASE_ENDPOINT_ID,
  RESERVED_AGENT_MCP_TOOL_NAMES,
  type AgentMcpEndpointRegistration,
  type AgentMcpToolScope,
} from "./types.js";

export const PLUGIN_MCP_SESSION_SERVER_VERSION = "1.0.0";

/**
 * Tool calls one session may have in flight. Each holds a timer, listeners and
 * (for a worker plugin) a pending invoke; a client that fires calls without
 * awaiting them gets a tool error past this rather than unbounded growth.
 */
export const MAX_CONCURRENT_PLUGIN_TOOL_CALLS = 16;

/** Longest tool-error message relayed to the agent, in characters. */
const MAX_ERROR_MESSAGE_CHARS = 2_000;

export interface PluginSessionServerOptions {
  pluginInstanceId: string;
  /** The rosters this session serves, from its grant. */
  scope: AgentMcpToolScope;
  /** The key the agent was handed this server under, reported as `serverInfo.name`. */
  serverName: string;
  /** Frozen provenance from the session's grant. Never the bearer. */
  caller: PluginMcpCaller;
  /** Aborts when the session closes — revocation, idle expiry, DELETE, listener stop. */
  sessionSignal: AbortSignal;
  /** Workers activate lazily and register their rosters inside `activate()`. */
  activatePlugin: (pluginInstanceId: string) => Promise<void>;
  endpointRegistry?: AgentMcpEndpointRegistry;
  callTimeoutMs?: number;
  maxResultBytes?: number;
  /** How long a list or call waits for a roster that is not registered yet. */
  rosterWaitMs?: number;
}

/** Long enough for a respawned worker to re-register; short enough to stay inside a call's budget. */
const DEFAULT_ROSTER_WAIT_MS = 5_000;

type AbortCause = "timeout" | "cancelled" | "session-closed" | "endpoint-changed";

const ABORT_MESSAGES: Record<AbortCause, (timeoutMs: number) => string> = {
  timeout: (timeoutMs) => `Tool call timed out after ${timeoutMs} ms.`,
  cancelled: () => "Tool call was cancelled.",
  "session-closed": () => "The plugin MCP session closed before the tool call finished.",
  "endpoint-changed": () =>
    "The plugin's tools changed while the call was running. List tools again and retry.",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function toolError(message: string): CallToolResult {
  const text =
    message.length > MAX_ERROR_MESSAGE_CHARS
      ? `${message.slice(0, MAX_ERROR_MESSAGE_CHARS)}…`
      : message;
  return { content: [{ type: "text", text }], isError: true };
}

type Registration = AgentMcpEndpointRegistration | undefined;

/**
 * The MCP server behind one plugin session: the host's read-only tools for the
 * plugin's databases and the plugin's own tools, each as the grant's scope
 * allows, on one server. Tools only: no resources, no prompts, no
 * `instructions` — the plugin-only route must never expose any of the
 * orchestration surface, and nothing a plugin returns is ever promoted out of
 * tool-result content into something an agent reads as guidance.
 *
 * Every descriptor comes from its roster's registration, read live, so
 * `tools/list` and `tools/call` always agree on what dispatch accepts. The
 * database roster is the host's, bound at load: listing or calling it never
 * activates the plugin.
 */
export function createPluginSessionServer(options: PluginSessionServerOptions): Server {
  const {
    pluginInstanceId,
    scope,
    serverName,
    caller,
    sessionSignal,
    activatePlugin,
    endpointRegistry = agentMcpEndpointRegistry,
    callTimeoutMs = AGENT_MCP_CALL_TIMEOUT_MS,
    maxResultBytes = AGENT_MCP_MAX_RESULT_BYTES,
    rosterWaitMs = DEFAULT_ROSTER_WAIT_MS,
  } = options;

  const server = new Server(
    {
      name: serverName,
      version: PLUGIN_MCP_SESSION_SERVER_VERSION,
    },
    { capabilities: { tools: { listChanged: true } } }
  );

  const endpointIds = [
    ...(scope.databases ? [DATABASE_ENDPOINT_ID] : []),
    ...(scope.pluginEndpointId !== undefined ? [scope.pluginEndpointId] : []),
  ];
  const inScope = (changedInstance: string, changedEndpoint: string): boolean =>
    changedInstance === pluginInstanceId && endpointIds.includes(changedEndpoint);

  // A roster comes and goes with the plugin's worker — a crash respawn, a dev
  // reload, idle disposal — so tell the client when it changes rather than let
  // it keep an inventory from before. Best-effort: before the handshake
  // completes there is nobody to notify.
  const offRosterChange = endpointRegistry.onDidChange((changedInstance, changedEndpoint) => {
    if (!inScope(changedInstance, changedEndpoint)) return;
    server.sendToolListChanged().catch(() => {});
  });
  sessionSignal.addEventListener("abort", offRosterChange, { once: true });
  if (sessionSignal.aborted) offRosterChange();

  const ensureActivated = async (): Promise<void> => {
    try {
      await activatePlugin(pluginInstanceId);
    } catch (err) {
      // Activation failures are recorded by the plugin host; an unactivated
      // plugin simply has no roster, which reads as an endpoint with no tools.
      console.error("[PluginAgentMcp] plugin activation failed:", formatErrorMessage(err, "error"));
    }
  };

  /**
   * One roster, allowing a short window for it to appear. Activation can
   * return before the roster exists: a worker being respawned after a crash is
   * still marked activated while its replacement boots and re-registers. An
   * empty answer in that window reads to the client as "this server has no
   * tools", so wait briefly for the registration instead.
   */
  const awaitRegistration = (endpointId: string, signal: AbortSignal): Promise<Registration> => {
    const current = endpointRegistry.get(pluginInstanceId, endpointId);
    if (current || signal.aborted) return Promise.resolve(current);
    return new Promise<Registration>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        off();
        signal.removeEventListener("abort", finish);
        resolve(endpointRegistry.get(pluginInstanceId, endpointId));
      };
      const off = endpointRegistry.onDidChange((changedInstance, changedEndpoint) => {
        if (changedInstance !== pluginInstanceId || changedEndpoint !== endpointId) return;
        if (endpointRegistry.get(pluginInstanceId, endpointId)) finish();
      });
      const timer = setTimeout(finish, rosterWaitMs);
      timer.unref?.();
      signal.addEventListener("abort", finish, { once: true });
    });
  };

  /** The database roster, which the host owns: never activates the plugin. */
  const databaseRegistration = (signal: AbortSignal): Promise<Registration> =>
    scope.databases ? awaitRegistration(DATABASE_ENDPOINT_ID, signal) : Promise.resolve(undefined);

  /** The plugin's own roster, which only exists once the plugin has activated. */
  const pluginRegistration = async (signal: AbortSignal): Promise<Registration> => {
    if (scope.pluginEndpointId === undefined) return undefined;
    await ensureActivated();
    return awaitRegistration(scope.pluginEndpointId, signal);
  };

  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    const signal = AbortSignal.any([extra.signal, sessionSignal]);
    const [databases, own] = await Promise.all([
      databaseRegistration(signal),
      pluginRegistration(signal),
    ]);
    const tools: Tool[] = [
      ...(databases?.tools ?? []),
      // Registration already refuses the reserved names; this keeps the two
      // rosters from ever advertising one name twice regardless.
      ...(own?.tools ?? []).filter((tool) => !RESERVED_AGENT_MCP_TOOL_NAMES.has(tool.name)),
    ].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
      // A host read-only tool carries only that claim; the plugin's own hints
      // never include it (validateTools rejects a roster that tries).
      ...(tool.readOnly === true
        ? { annotations: { readOnlyHint: true } }
        : tool.annotations !== undefined
          ? { annotations: { ...tool.annotations } }
          : {}),
    }));
    return { tools };
  });

  let inFlight = 0;

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const toolName = request.params.name;
    const rawArgs: unknown = request.params.arguments ?? {};
    if (!isPlainObject(rawArgs)) {
      throw new McpError(ErrorCode.InvalidParams, "Tool arguments must be a JSON object.");
    }
    if (inFlight >= MAX_CONCURRENT_PLUGIN_TOOL_CALLS) {
      return toolError(
        `Too many plugin tool calls in flight on this session (limit ${MAX_CONCURRENT_PLUGIN_TOOL_CALLS}). Wait for one to finish and retry.`
      );
    }
    inFlight += 1;

    const controller = new AbortController();
    // Held in an object so control-flow narrowing does not pin it to `null`:
    // it is written from listeners that fire between the awaits below.
    const state: { abortCause: AbortCause | null } = { abortCause: null };
    const abort = (cause: AbortCause): void => {
      if (controller.signal.aborted) return;
      state.abortCause = cause;
      const reason = new Error(ABORT_MESSAGES[cause](callTimeoutMs));
      reason.name = "AbortError";
      controller.abort(reason);
    };
    const abortedResult = (): CallToolResult =>
      toolError(ABORT_MESSAGES[state.abortCause ?? "cancelled"](callTimeoutMs));

    // The budget and cancellation cover activation as well as the call: a slow
    // activation must not stretch the deadline the agent was promised.
    const onClientCancel = (): void => abort("cancelled");
    const onSessionClosed = (): void => abort("session-closed");
    extra.signal.addEventListener("abort", onClientCancel, { once: true });
    sessionSignal.addEventListener("abort", onSessionClosed, { once: true });
    const timer = setTimeout(() => abort("timeout"), callTimeoutMs);
    timer.unref?.();
    if (sessionSignal.aborted) abort("session-closed");
    if (extra.signal.aborted) abort("cancelled");

    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason as Error), {
        once: true,
      });
    });
    aborted.catch(() => {});
    let offRegistry: (() => void) | null = null;

    try {
      if (controller.signal.aborted) return abortedResult();

      // A database tool is the host's and is answered without the plugin; any
      // other name can only be the plugin's own. A client that cached its tool
      // list across an app restart can call before it lists, so the roster
      // must be given its chance to register.
      const ownerEndpointId = RESERVED_AGENT_MCP_TOOL_NAMES.has(toolName)
        ? scope.databases
          ? DATABASE_ENDPOINT_ID
          : undefined
        : scope.pluginEndpointId;
      if (ownerEndpointId === undefined) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${toolName}`);
      }
      let registration: Registration;
      try {
        registration = await Promise.race([
          ownerEndpointId === DATABASE_ENDPOINT_ID
            ? databaseRegistration(controller.signal)
            : pluginRegistration(controller.signal),
          aborted,
        ]);
      } catch {
        return abortedResult();
      }

      const descriptor = registration?.tools.find((tool) => tool.name === toolName);
      if (!registration || !descriptor) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${toolName}`);
      }

      // Checked before any plugin code runs, against the schema the agent was
      // shown. Answered the way McpServer answers it — an InvalidParams error
      // carried in a tool result rather than a protocol error, so the agent
      // reads what was wrong and can correct the call.
      const argsProblem = descriptor.checkInput(rawArgs);
      if (argsProblem !== null) {
        return toolError(
          new McpError(
            ErrorCode.InvalidParams,
            `Input validation error: Invalid arguments for tool ${toolName}: ${argsProblem}`
          ).message
        );
      }

      // Subscribed only after the roster was read, so the registration that
      // activation itself produced does not count as a change. A replaced or
      // dropped roster means the worker that owned this call has reloaded or
      // gone; whatever it returns now answers a tool that may no longer exist
      // in the form the agent called.
      offRegistry = endpointRegistry.onDidChange((changedInstance, changedEndpoint) => {
        if (changedInstance === pluginInstanceId && changedEndpoint === ownerEndpointId) {
          abort("endpoint-changed");
        }
      });
      if (endpointRegistry.get(pluginInstanceId, ownerEndpointId) !== registration) {
        abort("endpoint-changed");
      }
      if (controller.signal.aborted) return abortedResult();

      let invocation: Promise<unknown>;
      try {
        invocation = Promise.resolve(
          registration.invoke(toolName, rawArgs, caller, controller.signal)
        );
      } catch (err) {
        invocation = Promise.reject(err);
      }
      // Once aborted, the invocation's own settlement is discarded — a late
      // rejection must not surface as an unhandled one.
      invocation.catch(() => {});

      let value: unknown;
      try {
        value = await Promise.race([invocation, aborted]);
      } catch (err) {
        if (controller.signal.aborted) return abortedResult();
        return toolError(formatErrorMessage(err, "Tool call failed."));
      }
      // Settled, but after an abort: the late result answers a call that no
      // longer exists and is discarded.
      if (controller.signal.aborted) return abortedResult();

      let text: string | undefined;
      try {
        text = JSON.stringify(value === undefined ? null : value);
      } catch {
        text = undefined;
      }
      if (text === undefined) {
        return toolError("The tool returned a value that cannot be serialized to JSON.");
      }
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > maxResultBytes) {
        return toolError(
          `The tool result is ${bytes} bytes, over the ${maxResultBytes}-byte limit for plugin tool results.`
        );
      }

      if (descriptor.outputSchema === undefined) {
        return { content: [{ type: "text", text }] };
      }
      // A declared output schema is a client-validated contract: the SDK client
      // refuses a successful result without structured content, so a value
      // that cannot be one is the tool's error rather than a silent text-only
      // answer. The parsed copy, not the raw value, so what is structured is
      // exactly what was measured and sent as text.
      const structured: unknown = JSON.parse(text);
      if (!isPlainObject(structured)) {
        return toolError(
          "The tool declares an output schema but returned a value that is not a JSON object."
        );
      }
      const outputProblem = descriptor.checkOutput(structured);
      if (outputProblem !== null) {
        return toolError(
          `The tool returned a result that does not match its output schema: ${outputProblem}`
        );
      }
      return { content: [{ type: "text", text }], structuredContent: structured };
    } finally {
      inFlight -= 1;
      clearTimeout(timer);
      offRegistry?.();
      extra.signal.removeEventListener("abort", onClientCancel);
      sessionSignal.removeEventListener("abort", onSessionClosed);
    }
  });

  return server;
}
